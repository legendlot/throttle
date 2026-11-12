// Podium J1b — one-way Podium → Google Directory field sync. The PURE rules (no I/O): what Google should
// hold for a person, how that merges into the Google user without clobbering anything Podium does not own,
// who is in scope, the per-field diff states and the retry backoff. index.js does the I/O.
// Plan: docs/superpowers/plans/2026-11-12-podium-j1b-google-sync.md (D1–D11) · tests: test/googlesync.test.mjs
import { WORK_DOMAIN } from './workaccount.js';

// The fields Podium pushes (D2). Never primaryEmail, password, suspension, deletion or groups.
export const SYNC_FIELDS = ['name', 'title', 'department', 'manager', 'phone', 'employee_code', 'org_unit'];
// Employee statuses that are pushed (D4). Everyone else is skipped with a reason.
export const IN_SCOPE_STATUSES = ['active', 'on_leave', 'notice'];
export const SYNC_STATUSES = ['pending', 'ok', 'failed', 'skipped'];
// ≤ 8 people per drain / per pushGoogleFields call (Google calls are per person by nature).
export const DRAIN_CAP = 8;
// One push attempt per person at a time: a claim takes the row only when no other attempt started inside this.
export const SYNC_LEASE_MS = 2 * 60 * 1000;
// Retry backoff after the 1st / 2nd / 3rd-and-later failure (D7).
export const BACKOFF_MINUTES = [1, 5, 30];
export const ORG_EXTERNAL_ID_TYPE = 'organization';
export const MOBILE_PHONE_TYPE = 'mobile';
// Each Directory GET / PUT is aborted after this, so an attempt always ends well inside its lease.
export const GOOGLE_CALL_TIMEOUT_MS = 20 * 1000;
// Founders, hard deny-list on top of users_profile.role = super_admin (Afshaan 2026-11-12: "exclude entirely").
export const FOUNDER_CODES = ['EMP-001', 'EMP-002'];

// Which SYNC_FIELDS an employees column feeds. The 0015 trigger mirrors this map: an UPDATE marks only the fields
// whose columns changed; INSERT marks every field except name + title; a work_email or status change marks nothing
// on that person (review 2026-11-13: no silent full push — alignment is the reviewed Google vs Podium push).
export const COLUMN_FIELD = {
  full_name: 'name', job_title: 'title', department_id: 'department', manager_id: 'manager', phone: 'phone',
  employee_code: 'employee_code', org_unit_path: 'org_unit',
};
export const INSERT_FIELDS = ['department', 'manager', 'phone', 'employee_code', 'org_unit'];
// R3: an INSERT dirties only the INSERT_FIELDS whose column holds a value. A NULL org_unit_path or manager_id on a new
// row means "leave Google alone" (D3) — for an inserted row that holds even for the manager.
const FIELD_COLUMN = Object.fromEntries(Object.entries(COLUMN_FIELD).map(([c, f]) => [f, c]));
// The fields an employees INSERT / UPDATE dirties (pure twin of the trigger, for tests). old/new = the rows.
export function dirtiedFields(oldRow, newRow) {
  if (!oldRow) return SYNC_FIELDS.filter(f => INSERT_FIELDS.includes(f) && !blank(newRow?.[FIELD_COLUMN[f]]));
  const changed = (c) => (oldRow[c] ?? null) !== (newRow?.[c] ?? null);
  return SYNC_FIELDS.filter(f => Object.keys(COLUMN_FIELD).some(c => COLUMN_FIELD[c] === f && changed(c)));
}

// A drain pushes ONLY the fields that changed (dirty_fields), narrowed to the claim's scope when an admin's
// pushGoogleFields picked a subset (claimed_fields). → the SYNC_FIELDS to merge, in SYNC_FIELDS order (may be []).
export function fieldsToPush(dirty, claimed = null) {
  const d = new Set(Array.isArray(dirty) ? dirty : []);
  const c = Array.isArray(claimed) ? new Set(claimed) : null;
  return SYNC_FIELDS.filter(f => d.has(f) && (!c || c.has(f)));
}

// What recording an attempt does to the row (pure twin of google_sync_record, 0015).
//   ok      — the pushed (or already-equal) fields leave dirty_fields; status ok only when NOTHING is left AND rev is
//             still the claimed one. A change that landed mid-push (rev moved) keeps every field dirty: the same
//             field may have changed again, and dropping it would lose that change.
//   failed  — dirty_fields untouched; failed (rev unchanged) or pending (rev moved).
//   skipped — dirty_fields untouched; skipped (rev unchanged) or pending.
// → { status, dirty_fields }
export function afterAttempt({ outcome, claimedRev, currentRev, dirty, done = [] }) {
  const same = Number(claimedRev) === Number(currentRev);
  const cur = SYNC_FIELDS.filter(f => (dirty || []).includes(f));
  if (outcome === 'ok') {
    const left = same ? cur.filter(f => !(done || []).includes(f)) : cur;
    return { status: same && !left.length ? 'ok' : 'pending', dirty_fields: left };
  }
  if (outcome === 'failed') return { status: same ? 'failed' : 'pending', dirty_fields: cur };
  if (outcome === 'skipped') return { status: same ? 'skipped' : 'pending', dirty_fields: cur };
  return { status: 'pending', dirty_fields: cur };
}

// Is this attempt still the owner, with at least `needMs` of its lease left? Checked right before each PUT, so a
// stale attempt (another drain took the row after the lease ran out) never writes over a newer one.
export function leaseHeld(row, attemptId, nowMs = Date.now(), needMs = GOOGLE_CALL_TIMEOUT_MS) {
  if (!row || !attemptId || row.attempt_id !== attemptId || !row.attempt_started_at) return false;
  return Date.parse(row.attempt_started_at) + SYNC_LEASE_MS - nowMs > needMs;
}

// Preview binding: the dry run returns a hash of the exact users.update body per person, Push sends it back and the
// worker refuses (stale_preview) anyone whose recomputed body differs. Keys sorted, so the hash is order-free.
export function canonicalJson(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}
export async function previewHash(body) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(body ?? null)));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const lc = (s) => String(s ?? '').trim().toLowerCase();
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const clean = (v) => (blank(v) ? null : String(v).trim().replace(/\s+/g, ' '));
// Phone numbers compare without spaces, dashes, dots or brackets ("+91 98450-12345" == "+919845012345").
export const normPhone = (v) => (blank(v) ? null : String(v).replace(/[\s\-().]/g, ''));

// D2: Google's name comes from full_name ONLY. givenName = every token but the last, familyName = the last; a
// one-word name fills both (Google requires both). Unlike workaccount.splitName nothing is dropped: Podium's
// full_name is the truth, honorifics included. → { givenName, familyName } | null
export function splitForGoogle(full) {
  const toks = String(full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  if (toks.length === 1) return { givenName: toks[0], familyName: toks[0] };
  return { givenName: toks.slice(0, -1).join(' '), familyName: toks[toks.length - 1] };
}

// Does the OU sit in (or under) an excluded OU? Shared with the Directory import preview.
export function ouExcluded(ou, excluded) {
  return (excluded || []).some(x => ou === x || (ou || '').startsWith(x + '/'));
}

// What Google should hold for this person, from Podium (D2). A null value = Podium is blank → leave Google's
// value alone — EXCEPT `manager`: null there means "Podium says no manager" → remove Google's manager relation.
// `manager` is undefined when Podium names a manager whose work email is unknown (nothing safe to push).
// emp: the employee row · opts: { departmentName, managerEmail, hasManager }
export function desiredGoogleFields(emp, { departmentName = null, managerEmail = null, hasManager = false } = {}) {
  const e = emp || {};
  const mgr = clean(managerEmail);
  return {
    name: splitForGoogle(e.full_name),
    title: clean(e.job_title),
    department: clean(departmentName),
    manager: hasManager ? (mgr ? mgr.toLowerCase() : undefined) : null,
    phone: clean(e.phone),
    employee_code: clean(e.employee_code),
    org_unit: clean(e.org_unit_path),
  };
}

// The same shape, read off a Google user (for the diff and the last-pushed comparison).
export function googleFieldsOf(gUser) {
  const g = gUser || {};
  const org = primaryOrg(g.organizations);
  const mgrs = arr(g.relations).filter(r => r && r.type === 'manager' && !blank(r.value));
  const mob = arr(g.phones).find(p => p && p.type === MOBILE_PHONE_TYPE && !blank(p.value));
  const code = arr(g.externalIds).find(x => x && x.type === ORG_EXTERNAL_ID_TYPE && !blank(x.value));
  const gn = clean(g.name?.givenName), fn = clean(g.name?.familyName);
  return {
    name: gn || fn ? { givenName: gn || '', familyName: fn || '' } : null,
    title: clean(org?.title),
    department: clean(org?.department),
    manager: mgrs.length ? lc(mgrs[0].value) : null,
    phone: clean(mob?.value),
    employee_code: clean(code?.value),
    org_unit: clean(g.orgUnitPath),
  };
}

const arr = (x) => (Array.isArray(x) ? x : []);
// Only the entry marked primary. A list with no primary has none: Podium never takes over someone else's entry.
function primaryOrg(orgs) {
  return arr(orgs).find(o => o && o.primary === true) || null;
}

// Are two values of one field the same? (name: both parts · manager: case-insensitive · phone: normalised)
export function sameValue(field, a, b) {
  if (field === 'name') {
    if (!a || !b) return !a && !b;
    return clean(a.givenName) === clean(b.givenName) && clean(a.familyName) === clean(b.familyName);
  }
  if (field === 'manager') return (a ? lc(a) : null) === (b ? lc(b) : null);
  if (field === 'phone') return normPhone(a) === normPhone(b);
  return clean(a) === clean(b);
}

// D3 — merge, never clobber. `current` = the Google user (GET ?projection=full), `desired` = desiredGoogleFields.
// Returns the users.update body carrying ONLY the top-level keys that change, or null when nothing changes
// (→ no PUT). Directory users.update replaces whole array fields, so every array sent is the full merged list
// (an unchanged array is never sent):
//   organizations — only the entry with primary=true is touched (its other keys kept, the other entries stay);
//                   with no primary entry, a new {primary:true, …} entry is APPENDED
//   relations     — every non-manager relation kept; the manager relation set, or removed when Podium has none
//   phones        — every other phone type kept; the mobile entry replaced
//   externalIds   — every id that is not type `organization` kept (the J1 podium_work_account stamp included)
// A blank Podium value leaves Google's value alone, except the manager (Podium owns reporting lines).
// opts.fields limits the merge to those SYNC_FIELDS (dirty_fields on a drain, the admin's pick on a push). Omitted =
// every field; an EMPTY list = nothing (→ null).
export function mergeGoogleUser(current, desired, { fields } = {}) {
  const cur = current || {};
  const want = desired || {};
  const on = new Set((Array.isArray(fields) ? fields : SYNC_FIELDS).filter(f => SYNC_FIELDS.includes(f)));
  const have = googleFieldsOf(cur);
  const body = {};

  if (on.has('name') && want.name && !sameValue('name', want.name, have.name)) {
    body.name = { givenName: want.name.givenName, familyName: want.name.familyName };
  }

  const setTitle = on.has('title') && want.title !== null && want.title !== undefined && !sameValue('title', want.title, have.title);
  const setDept = on.has('department') && want.department !== null && want.department !== undefined
    && !sameValue('department', want.department, have.department);
  if (setTitle || setDept) {
    const orgs = arr(cur.organizations);
    const p = primaryOrg(orgs);
    const patched = { ...(p || { primary: true }) };
    if (setTitle) patched.title = want.title;
    if (setDept) patched.department = want.department;
    body.organizations = p ? orgs.map(o => (o === p ? patched : o)) : [...orgs, patched];
  }

  if (on.has('manager') && want.manager !== undefined) {
    const rels = arr(cur.relations);
    const others = rels.filter(r => !(r && r.type === 'manager'));
    const mgrs = rels.filter(r => r && r.type === 'manager');
    if (want.manager === null) {
      if (mgrs.length) body.relations = others;
    } else if (!(mgrs.length === 1 && lc(mgrs[0].value) === lc(want.manager))) {
      body.relations = [...others, { type: 'manager', value: want.manager }];
    }
  }

  if (on.has('phone') && want.phone !== null && want.phone !== undefined) {
    const phones = arr(cur.phones);
    const mob = phones.filter(p => p && p.type === MOBILE_PHONE_TYPE);
    if (!(mob.length === 1 && normPhone(mob[0].value) === normPhone(want.phone))) {
      const entry = { type: MOBILE_PHONE_TYPE, value: want.phone };
      if (mob.some(p => p.primary)) entry.primary = true;
      body.phones = [...phones.filter(p => !(p && p.type === MOBILE_PHONE_TYPE)), entry];
    }
  }

  if (on.has('employee_code') && want.employee_code !== null && want.employee_code !== undefined) {
    const ids = arr(cur.externalIds);
    const org = ids.filter(x => x && x.type === ORG_EXTERNAL_ID_TYPE);
    if (!(org.length === 1 && clean(org[0].value) === want.employee_code)) {
      body.externalIds = [...ids.filter(x => !(x && x.type === ORG_EXTERNAL_ID_TYPE)),
        { type: ORG_EXTERNAL_ID_TYPE, value: want.employee_code }];
    }
  }

  if (on.has('org_unit') && want.org_unit !== null && want.org_unit !== undefined && want.org_unit !== clean(cur.orgUnitPath)) {
    body.orgUnitPath = want.org_unit;
  }

  return Object.keys(body).length ? body : null;
}

// The SYNC_FIELDS a merge body touches (for logs / the dry-run preview).
export function bodyFields(body) {
  if (!body) return [];
  const map = { name: 'name', relations: 'manager', phones: 'phone', externalIds: 'employee_code', orgUnitPath: 'org_unit' };
  const out = [];
  for (const k of Object.keys(body)) {
    if (k === 'organizations') out.push('title_or_department');
    else if (map[k]) out.push(map[k]);
  }
  return out;
}

// D4 — who is pushed. → { ok: true } | { ok: false, reason }. Checked in this order; nothing out of scope is
// ever written to Google.
// ctx = { superAdminAuthIds: Set, ignored: Set (lowercased emails), excludedOus: [], liveOus: Set | null,
//         impersonateEmail }
export function scopeOf(emp, gUser, ctx = {}) {
  if (!emp) return { ok: false, reason: 'not_found' };
  if (!IN_SCOPE_STATUSES.includes(emp.status)) return { ok: false, reason: emp.status === 'exited' ? 'exited' : 'status_out_of_scope' };
  const email = lc(emp.work_email);
  if (!email || !email.endsWith('@' + WORK_DOMAIN)) return { ok: false, reason: 'no_work_email' };
  // Founders and super-admins are excluded ENTIRELY (Afshaan 2026-11-12), however they are recognised.
  if ((emp.auth_user_id && ctx.superAdminAuthIds?.has(emp.auth_user_id)) || FOUNDER_CODES.includes(String(emp.employee_code || '').trim().toUpperCase())) {
    return { ok: false, reason: 'founder_or_super_admin' };
  }
  if (ctx.impersonateEmail && lc(ctx.impersonateEmail) === email) return { ok: false, reason: 'founder_or_super_admin' };
  if (ctx.ignored?.has(email)) return { ok: false, reason: 'directory_ignored' };
  if (!gUser) return { ok: false, reason: 'no_google_account' };
  // users.get also resolves aliases: only the account whose PRIMARY address is this work email is theirs.
  if (lc(gUser.primaryEmail) !== email) return { ok: false, reason: 'alias_mismatch' };
  if (gUser.isAdmin) return { ok: false, reason: 'founder_or_super_admin' };
  if (gUser.suspended) return { ok: false, reason: 'suspended' };
  // The person's CURRENT Google OU is checked unconditionally; the TARGET OU only when this attempt pushes org_unit
  // (effectiveFields, R6).
  if (ouExcluded(gUser.orgUnitPath, ctx.excludedOus)) return { ok: false, reason: 'excluded_ou' };
  return { ok: true };
}

// Does this attempt need the live OU list? Only when it pushes org_unit AND would move the person.
export function needsOuCheck(emp, gUser, fields) {
  const target = clean(emp?.org_unit_path);
  return (!Array.isArray(fields) || fields.includes('org_unit')) && !!target && target !== clean(gUser?.orgUnitPath);
}

// R6/R7: the fields this attempt really merges. A TARGET OU that is excluded, or not in the OU list (derived from
// users' orgUnitPath: the write SA has only admin.directory.user, so an org unit nobody is in yet is invisible) is a
// skip for the org_unit FIELD only, never for the person's other fields.
// fields = the attempt's fields (undefined = all) · ctx = scopeOf's ctx. → { fields: [...], fieldSkips: {org_unit?} }
export function effectiveFields(emp, gUser, fields, ctx = {}) {
  const list = (Array.isArray(fields) ? fields : SYNC_FIELDS).filter(f => SYNC_FIELDS.includes(f));
  if (!needsOuCheck(emp, gUser, list)) return { fields: list, fieldSkips: {} };
  const target = clean(emp.org_unit_path);
  const why = ouExcluded(target, ctx.excludedOus) ? 'target_ou_excluded'
    : (ctx.liveOus && !ctx.liveOus.has(target)) ? 'target_ou_unknown' : null;
  return why ? { fields: list.filter(f => f !== 'org_unit'), fieldSkips: { org_unit: why } } : { fields: list, fieldSkips: {} };
}

// R2: did the person's identity / eligibility change between the attempt's load and its PUT? (status, work email,
// Google user id). fresh = the re-read row. → true = abort with no PUT.
export function identityChanged(snap, fresh) {
  if (!snap || !fresh) return true;
  return snap.status !== fresh.status || lc(snap.work_email) !== lc(fresh.work_email)
    || (snap.google_user_id ?? null) !== (fresh.google_user_id ?? null);
}
// The short retry after an identity change (the first backoff step).
export const IDENTITY_RETRY_ATTEMPTS = 1;

// D11 — one field's diff state.
//   equal             — Google already holds Podium's value
//   podium_blank      — Podium has nothing; a push leaves Google alone (never for `manager`: no manager is a value)
//   changed_in_google — Google differs from what Podium last pushed (someone edited it in Google)
//   differs           — Google differs, and not because of an edit after our push (or we never pushed)
// lastPushed = google_sync_state.last_pushed (the desired snapshot sent), or null.
export function classifyDiff(field, podium, google, lastPushed) {
  if (field === 'manager') {
    if (podium === undefined) return 'podium_blank';
  } else if (podium === null || podium === undefined) return 'podium_blank';
  if (sameValue(field, podium, google)) return 'equal';
  if (lastPushed && Object.prototype.hasOwnProperty.call(lastPushed, field)
      && sameValue(field, lastPushed[field], podium) && !sameValue(field, lastPushed[field], google)) {
    return 'changed_in_google';
  }
  return 'differs';
}

// Every field's state for one person. → { field: { podium, google, state } }
export function diffPerson(desired, google, lastPushed) {
  const out = {};
  for (const f of SYNC_FIELDS) out[f] = { podium: desired?.[f] ?? null, google: google?.[f] ?? null, state: classifyDiff(f, desired?.[f], google?.[f] ?? null, lastPushed) };
  // `undefined` manager (unknown email) travels as null; the state already says podium_blank.
  return out;
}

// The snapshot stored as last_pushed after a successful push: the previous snapshot, overlaid with every field this
// push considered and Podium had a value for, recording what GOOGLE holds afterwards (`after` = googleFieldsOf of the
// users.update response, or of the GET when nothing needed sending). Fields Podium left blank are not recorded.
export function nextLastPushed(prev, desired, fields, after) {
  const out = { ...(prev && typeof prev === 'object' ? prev : {}) };
  for (const f of fields || []) {
    if (!SYNC_FIELDS.includes(f)) continue;
    const v = desired?.[f];
    if (v === undefined || (v === null && f !== 'manager')) continue;
    out[f] = after ? (after[f] ?? null) : v;
  }
  return out;
}

// After the Nth consecutive failure (N ≥ 1): when the next drain may retry. → ISO string
export function nextAttemptAt(attempts, nowMs = Date.now()) {
  const n = Math.max(1, Math.floor(Number(attempts) || 1));
  const min = BACKOFF_MINUTES[Math.min(n, BACKOFF_MINUTES.length) - 1];
  return new Date(nowMs + min * 60 * 1000).toISOString();
}

// PostgREST filter for the drain's claim PATCH: pending/failed, due, and not inside another attempt's lease.
export function syncClaimFilter(nowMs = Date.now()) {
  const now = encodeURIComponent(new Date(nowMs).toISOString());
  const stale = encodeURIComponent(new Date(nowMs - SYNC_LEASE_MS).toISOString());
  return `status=in.(pending,failed)&and=(or(next_attempt_at.is.null,next_attempt_at.lte.${now}),or(attempt_started_at.is.null,attempt_started_at.lt.${stale}))`;
}
// The same rule as a predicate over a row (pure, for tests).
export function canClaimSync(row, nowMs = Date.now()) {
  if (!row || !['pending', 'failed'].includes(row.status)) return false;
  if (row.next_attempt_at && Date.parse(row.next_attempt_at) > nowMs) return false;
  if (row.attempt_started_at && Date.parse(row.attempt_started_at) >= nowMs - SYNC_LEASE_MS) return false;
  return true;
}

// The pushGoogleFields `fields` argument → a clean subset of SYNC_FIELDS, or null = all. Unknown names refused.
export function cleanSyncFields(fields) {
  if (fields === undefined || fields === null) return { fields: null };
  if (!Array.isArray(fields) || !fields.length) return { error: 'bad_fields' };
  const out = [...new Set(fields.map(String))];
  if (out.some(f => !SYNC_FIELDS.includes(f))) return { error: 'bad_fields' };
  return { fields: out };
}
