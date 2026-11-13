/**
 * Podium — podiumops Cloudflare Worker
 * podiumops.afshaan.workers.dev
 *
 * API for the LOT People & Performance OS at podium.legendoftoys.com.
 * Sibling to lotopsproxy (Garage/Redline/Scanner), throttleops (Throttle),
 * csops (Pitstop), and ignitionops (Ignition).
 *
 * Pattern: GET  /?action=<actionName>            (reads)
 *          POST /  body: { action, ...params }   (writes, JWT-authenticated)
 *
 * SECURITY — this is the most confidential LOT system. The worker (service_role,
 * BYPASSRLS) is the SOLE DB client; RLS-on/no-anon-grants is the backstop. Access
 * is strictly tiered (RULE-PODIUM-001):
 *   - podium_admin / podium_hr : everything (admin = full; hr = no settings)
 *   - podium_comp              : compensation + salary bands (separate key)
 *   - podium_view              : baseline — directory + org chart + own record;
 *                                full profile/docs only for self or one's reports
 * Manager powers are derived from the org graph (manager_id chain), NOT a flat perm.
 * The absolute-salary vault (compensation_events.old_ctc/new_ctc/components) ships
 * but is gated OFF via podium.settings.comp_vault_enabled until Phase 5 hardening.
 *
 * Spec:  systems/podium.md ; docs/superpowers/specs/2026-06-02-podium-design.md
 */

import { intParam } from './params.mjs';
import { sanitizeRich } from './richtext.mjs';   // S396 — review-box HTML whitelist, see richtext.mjs
import {
  ACTIVE_APP_STATUSES, TERMINAL_APP_STATUSES, isTerminalStatus, APP_TRANSITIONS, checkTransition, APP_SOURCES,
  OPENING_STATUSES, resolveApprover, checkBandDecider, openingRoles, canSeeOpening, canEditOpening, canManageApps,
  canSeeSalary, canChangeChain, CANDIDATE_DOC_TYPES, docTier, canSeeCandidateDoc, JD_REQUIRED_MSG, jdGate,
  JD_EXTS, CANDIDATE_DOC_EXTS, fileOk, retainUntil, normEmailKey, normPhoneKey, parseBand,
  canSeeDocRow, OUTCOME_REASON_CODES, redactReason, redactEvent, candidateEventsFor, checkFileSize,
  candidateDocPath, jdPath, checkCandidateDocPath, checkJdPath, cleanSearch, safeFileName,
  // C3 offers
  canManageOffers, offerRoles, cleanOfferTerms, offerPdfPath, offerDocPath, checkOfferDocPath, offerView,
  istToday, addDaysIso, isIsoDate, OFFER_OPEN_STATUSES, OFFER_EDITABLE_STATUSES, OFFER_LIVE_STATUSES, OFFER_WITHDRAWABLE,
  OFFER_APP_STATUSES, OFFER_TEMPLATE_KEYS, OFFER_DOC_KINDS,
  offerTermsCanonical, isLatestSent, canSendOffer, needsNoLiveOffer, canMoveFrom, offerDbErrorCode,
} from './hiring.js';   // Hiring C1/C2/C3 — the pure permission + transition rules, see test/hiring.test.mjs + offers.test.mjs
import { computeAnnexure, bandCheck, needsApproval, componentsContract } from './offer-calc.js';
import {
  PROMPT_VERSION as CV_PROMPT_VERSION, MAX_ITEMS_PER_IMPORT as CV_MAX_ITEMS, IMPORT_EXTS as CV_IMPORT_EXTS,
  IMAGE_MIME as CV_IMAGE_MIME, MIN_TEXT_CHARS as CV_MIN_TEXT_CHARS, STALE_EXTRACT_MS as CV_STALE_EXTRACT_MS,
  PURGE_AFTER_DAYS as CV_PURGE_AFTER_DAYS, fileExtOf as cvFileExt, cleanText as cleanCvText,
  buildExtractRequest as buildCvExtractRequest, readUsage as readCvUsage, parseExtractResponse as parseCvExtractResponse,
  validateExtraction as validateCvExtraction, costInr as cvCostInr, estimateInr as cvEstimateInr, pickDraft as pickCvDraft,
  importItemPath, checkImportItemPath, SCAN_MAX_BYTES as CV_SCAN_MAX_BYTES,
} from './cvimport.js';   // C4 bulk CV import (test/cvimport.test.mjs)
import { cvText } from './cvtext.js';   // C3 CTC calculator (test/offer-calc.test.mjs)
import {
  WORK_DOMAIN, toEmail, splitName, proposeLocalParts, checkLocalPart, tempPassword, isOurPendingAccount,
  workAccountExternalIds, attemptClaimFilter, attemptGuard,
  candidateDocToEmployeeDocType, employeeDocPath, defaultOu, joiningOffer, checkStartDate, SUSPENDABLE_APP_STATUSES,
  workAccountDbErrorCode,
  NOT_COPIED_ON_JOINING,
} from './workaccount.js';   // J1 work accounts + confirm joining (test/workaccount.test.mjs)
import {
  EXIT_REASON_CODES, ASSET_CLOSED_STATUSES, DOCKET_OPEN_STATUSES, PR_OPEN_STATUSES, CHECKLIST_OWNERS, AUTO_SOURCES,
  exitRole, canSeeExit, canManageExit, canTickItem, buildStartExit, resolveLwd, snapshotItems, checkItemUpdate,
  closeBlockers, itemProgress, daysLeft, googleItemDue, googleItemDaysOpen, checkGoogleAction, googleUserMatches,
  driveTransferBody, projectExit, projectPaymentRequest, employeeWriteTouchesExit, exitDbErrorCode,
  GOOGLE_LIVE_STATUSES, GOOGLE_LEASE_MS, googleClaimFilter, googleClaimGuard, transferOutcome, assetsVerifiable,
  buildExitPatch, accessLeft,
} from './exits.js';   // X1 exits + no-dues (test/exits.test.mjs)
import {
  OB_OWNERS, OB_AUTO_SOURCES, OB_NOTE_MAX, JOINER_WINDOW_DAYS, DEFAULT_REQUIRED_DOC_TYPES, SALARY_PRIVATE_FIELDS, DOC_TYPE_LABELS,
  SELF_DOC_EXTS, profileMissing, completionPct, validateProfileInput, maskAccount, projectPrivate, projectChangeRequest,
  onboardingRole, canSeeOnboarding, canManageOnboarding, canTickOnboardingItem, autoStatus, itemState, onboardingBlockers,
  onboardingProgress, checkOnboardingItemUpdate, dueDate, itemOverdue, fyLabelFor, joinersWithoutOnboarding,
  snapshotOnboardingItems, policyApplies, checkAcknowledge, policyPath, selfDocTypes, selfDocPath, isSelfDocPath,
  xpayrollRow, xpayrollCsv, currentCtc, onboardingDbErrorCode,
  PAN_RE, normPan, checkStoredObject, XPAYROLL_HEADERS, XPAYROLL_TEXT_COLUMNS, CHANGE_GROUPS, groupChangeRequests,
  cleanChangeDecision, selfViewItem, selfViewOnboarding, cleanOnboardingLine,
} from './onboarding.js';   // J2 onboarding + profile completion (test/onboarding.test.mjs)
import {
  renderOfferText, renderOfferPdf, sha256Hex, validateTemplateBody, SAMPLE_OFFER, SAMPLE_SIGNATORY, OFFER_FIELDS,
  appendCertificatePage,
} from './offer-render.js';   // C3 letter + PDF renderer (test/offer-render.test.mjs)
import {
  newLinkToken, hashLinkToken, linkTokenShapeOk, namesMatch, firstName, DECLINE_REASONS, declineReasonList, TEXT_MAX,
  isLinkLive, LINK_INVALID, linkState, linkDbErrorCode, addressOk, buildOfferMime, offerSubject, offerMessageId,
  renderOfferEmail, renderConfirmationEmail, renderAlertEmail, LINK_DOC_TYPES, LINK_DOC_TYPE_KEYS, LINK_DOC_MIMES,
  LINK_BANK_CAP, candidateLinkDocPath, checkCandidateLinkDocPath, validateCandidateBank,
  maskAccount as maskBankAccount, certificateLines, istStamp, renderOfferCopyEmail, renderConfirmationCopyEmail,
  splitOfferRecipients, threadKindsFor, reconcileDue, reconcileDecision, newPathNonce, acceptedPdfPath,
} from './offerlink.js';   // O1 offer email + acceptance link (test/offerlink.test.mjs)
import {
  PANEL_DOC_TYPES, FEEDBACK_OPEN_STATUSES, MAX_PANEL, CANCEL_REASON_MAX,
  cleanRoundName, cleanScorecard, cleanPanelIds, parseScheduledAt, cleanInterviewFields, dueAt, canSchedule, verdictMove,
  verdictBlock, checkFeedback, feedbackBlock, remindAllowed, panelView, interviewSummary, myInterviewBuckets,
  panelDocs, buildReminderMail, reminderMessageId, interviewDbErrorCode, panelSelfBlock, seatState,
} from './interviews.js';   // O2 interview rounds + feedback (test/interviews.test.mjs)
import {
  SYNC_FIELDS, DRAIN_CAP as GSYNC_CAP, GOOGLE_CALL_TIMEOUT_MS, SYNC_LEASE_MS, IDENTITY_RETRY_ATTEMPTS, desiredGoogleFields,
  googleFieldsOf, mergeGoogleUser, bodyFields, scopeOf, diffPerson, nextLastPushed, nextAttemptAt, syncClaimFilter,
  cleanSyncFields, ouExcluded, fieldsToPush, leaseHeld, previewHash, needsOuCheck, effectiveFields, identityChanged,
} from './googlesync.js';   // J1b Podium → Google field sync (test/googlesync.test.mjs)
import {
  LEDGER_TYPES, TYPE_LABELS, LEAVE_COPY, LEAVE_POLICIES, DEFAULT_CUTOVER_MONTH, isIsoDay, isMonth, monthOf, yearOf,
  validateLeaveInput, accrualPlan, borrowCap, ledgerBalance, pendingDebit, splitLeave, sameSplit,
  periodUsed, optionalUsed, limitBlock, overlaps, decideBlock, cancelBlock, resolveLeaveApprover, buildLeaveMail,
  leaveMessageId, cleanAmount, cleanNote, cleanHoliday, leaveDbErrorCode, reclosePlan, splitBase, coveredFromOnChange,
  holidayListMissing, noHolidayListMessage,
  lopReport, lopDiff, exitLeaveFigures, exitLeaveBlock, grantPlan, wfhApprover, yearEndYear, yearEndPreview,
  exitLeaveStale, withOpenExit, applyOpenExitsWith, lopExportRows, canonicalJson,
} from './leave.js';   // Leave R1 + R2 (test/leave.test.mjs)
import {
  CAL_SCOPE, CAL_COPY, calendarEventIds, syncedHash, buildInternalEvent, buildCandidateEvent, conferenceOf, meetUrlOf,
  eventTimes, calendarSyncAction,
} from './calendar.js';   // O3 Calendar (test/calendar.test.mjs)

// ── CORS ────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-Match',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
function err(message, status = 400) { return json({ ok: false, error: message }, status); }
function ok(data) { return json({ ok: true, data }); }
function nowIso() { return new Date().toISOString(); }

// ── Supabase helpers ────────────────────────────────────────────────────────

async function sb(path, env, opts = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type':    'application/json',
      'apikey':          env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization':   `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept-Profile':  'podium',
      'Content-Profile': 'podium',
      'Prefer':          opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function sbStore(path, env, opts = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type':    'application/json',
      'apikey':          env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization':   `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept-Profile':  'store',
      'Content-Profile': 'store',
      'Prefer':          opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Storage REST (private bucket podium-documents). Service-role only.
async function storageFetch(path, env, opts = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1${path}`, {
    ...opts,
    headers: {
      'apikey':        env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

const DOC_BUCKET = 'podium-documents';

// ── Auth ────────────────────────────────────────────────────────────────────

async function verifyJWT(authHeader, env) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;

  const profileRes = await sbStore(
    `/rest/v1/users_profile?id=eq.${user.id}&select=role,full_name,active&limit=1`,
    env,
  );
  if (!profileRes.ok || !profileRes.data?.[0]) return null;
  const profile = profileRes.data[0];
  if (!profile.active) return null;

  // Podium permissions come from Podium's OWN layer (store.podium_user_roles →
  // store.podium_roles.permissions), NOT the shared store.roles (RULE-PODIUM-006,
  // mirrors Snorkel/RULE-SNORKEL-002). No assigned role → {} → self-only baseline
  // (own profile + own wins via /me; see the self-serve gate in handleGet/handlePost).
  const urRes = await sbStore(
    `/rest/v1/podium_user_roles?user_id=eq.${user.id}&select=role_key&limit=1`,
    env,
  );
  const podiumRole = (urRes.ok && urRes.data?.[0]?.role_key) || null;
  let permissions = {};
  if (podiumRole) {
    const prRes = await sbStore(
      `/rest/v1/podium_roles?role_key=eq.${encodeURIComponent(podiumRole)}&select=permissions&limit=1`,
      env,
    );
    permissions = (prRes.ok && prRes.data?.[0]?.permissions) || {};
  }

  // Salary access is an explicit allow-list (podium.comp_access), decoupled from
  // admin/hr (RULE-PODIUM-002, amended 2026-07-06). Resolved once per request.
  const caRes = await sb(
    `/rest/v1/comp_access?auth_user_id=eq.${user.id}&select=auth_user_id&limit=1`,
    env,
  );
  const compAccess = !!(caRes.ok && caRes.data?.[0]);

  return {
    userId: user.id,
    email: user.email,
    role: profile.role,
    podiumRole,
    fullName: profile.full_name,
    permissions,
    compAccess,
    isSuperAdmin: profile.role === 'super_admin',
    bearer: token,
  };
}

// ── Google Workspace Directory (service account + domain-wide delegation) ─────
// Read-only sync of @legendoftoys.com accounts → Podium employees. Graceful when
// the GOOGLE_* secrets are absent (the action returns google_not_configured).

function b64urlBytes(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(str) { return b64urlBytes(new TextEncoder().encode(str)); }
function pemToPkcs8(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function googleConfigured(env) { return !!(env.GOOGLE_SA_JSON && env.GOOGLE_ADMIN_IMPERSONATE_EMAIL); }

async function googleAccessToken(env, opts = {}) {
  const sa = JSON.parse(opts.saJson || env.GOOGLE_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlStr(JSON.stringify({
    iss: sa.client_email,
    // O1: opts.sub = the mailbox to act as (the offer's hiring owner / reporting manager). Default unchanged.
    sub: opts.sub || env.GOOGLE_ADMIN_IMPERSONATE_EMAIL,
    scope: opts.scope || 'https://www.googleapis.com/auth/admin.directory.user.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64urlBytes(sigBuf)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const t = await res.json();
  if (!t.access_token) throw new Error('google_token_failed: ' + JSON.stringify(t));
  return t.access_token;
}

async function fetchGoogleUsers(env) {
  const token = await googleAccessToken(env);
  const out = [];
  let pageToken = '', pages = 0;
  do {
    const u = new URL('https://admin.googleapis.com/admin/directory/v1/users');
    u.searchParams.set('customer', 'my_customer');
    u.searchParams.set('maxResults', '500');
    u.searchParams.set('orderBy', 'email');
    u.searchParams.set('projection', 'full');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!r.ok) throw new Error('google_dir_failed: ' + JSON.stringify(d));
    (d.users || []).forEach(x => out.push(x));
    pageToken = d.nextPageToken || '';
  } while (pageToken && ++pages < 10);
  return out;
}

// ── Google WRITE service account (spec v4.1 J1 gate) ─────────────────────────
// A SEPARATE SA (`podium-admin-write`) whose key lives on podiumops only, so the
// shared readonly key on odoops/csops can never create or suspend accounts.
// Only J1/J1b/X1 handlers may mint these tokens.
const GOOGLE_WRITE_SCOPES = {
  directory: 'https://www.googleapis.com/auth/admin.directory.user',
  datatransfer: 'https://www.googleapis.com/auth/admin.datatransfer',
};
function googleWriteConfigured(env) { return !!(env.GOOGLE_ADMIN_SA_JSON && env.GOOGLE_ADMIN_IMPERSONATE_EMAIL); }
async function googleWriteToken(env, which) {
  // Never fall back to the shared key or the readonly scope (googleAccessToken's defaults).
  if (!env.GOOGLE_ADMIN_SA_JSON) throw new Error('google_write_not_configured');
  const scope = GOOGLE_WRITE_SCOPES[which];
  if (!scope) throw new Error('google_write_unknown_scope: ' + which);
  return googleAccessToken(env, { saJson: env.GOOGLE_ADMIN_SA_JSON, scope });
}

// Read-only proof that the write SA's delegation works: one token per scope
// (a JWT naming an unauthorised scope fails as a whole, so separate mints say
// WHICH scope is missing), then one GET per scope. Creates/changes nothing.
async function getGoogleWriteCheck(url, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  if (!googleWriteConfigured(env)) return err('google_write_not_configured', 400);
  let sa;
  try { sa = JSON.parse(env.GOOGLE_ADMIN_SA_JSON); } catch { return err('google_write_sa_json_invalid', 500); }
  let sharedEmail = null;
  try { sharedEmail = JSON.parse(env.GOOGLE_SA_JSON || '{}').client_email || null; } catch { /* ignore */ }
  const out = { client_email: sa.client_email || null, separate_from_shared_sa: !!sa.client_email && sa.client_email !== sharedEmail };
  const probe = async (which, reqUrl, summarise) => {
    let token;
    try { token = await googleWriteToken(env, which); }
    catch (e) { return { token: false, error: String(e?.message || e).slice(0, 300) }; }
    const r = await fetch(reqUrl, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    return r.ok ? { token: true, call: true, ...summarise(d) } : { token: true, call: false, status: r.status, error: d?.error?.message || null };
  };
  out.directory = await probe('directory',
    `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(env.GOOGLE_ADMIN_IMPERSONATE_EMAIL)}?projection=basic`,
    d => ({ read_user_is_admin: !!d.isAdmin }));
  out.datatransfer = await probe('datatransfer',
    'https://admin.googleapis.com/admin/datatransfer/v1/applications',
    d => ({ applications: (d.applications || []).map(a => a.name) }));
  out.all_good = !!(out.separate_from_shared_sa && out.directory.call && out.datatransfer.call);
  return ok(out);
}

// ── RazorpayX Payroll (Opfin) ────────────────────────────────────────────────
// Auth lives in the JSON body, not a header. Graceful-until-creds: if either
// secret is absent, callers return razorpayx_not_configured (mirrors Google SA).
// One RazorpayX org = Fraternitas (white-collar internal payroll); Silverton
// (blue-collar contract) is NOT on RazorpayX and won't appear here.
const RZP_PAYROLL_BASE = 'https://payroll.razorpay.com/api/payroll';
function razorpayxConfigured(env) { return !!(env.RAZORPAYX_PAYROLL_ID && env.RAZORPAYX_PAYROLL_KEY); }

async function razorpayxCall(env, type, subType, data) {
  const res = await fetch(RZP_PAYROLL_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth: { id: env.RAZORPAYX_PAYROLL_ID, key: env.RAZORPAYX_PAYROLL_KEY },
      request: { type, 'sub-type': subType },
      data: data || {},
    }),
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

// This API has NO bulk/list/profile endpoint and the payslip carries no email — only
// employee-name. Enumeration is a sequential id-scan of view-payroll (ids are 1,2,3…);
// matching is name-based (RazorpayX employee-name → Podium full_name). Confirmed by probe.

// Normalize a name for matching: lowercase, strip punctuation, collapse whitespace.
function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

// Gross monthly earnings from a view-payroll payslip = salary + Σ additions + arrears
// (pre-employee-deduction; the SG&A basis). additions may be null / array / object.
function razorpayxGross(p) {
  const num = v => (v == null || isNaN(Number(v))) ? 0 : Number(v);
  let add = 0;
  const a = p?.additions;
  if (Array.isArray(a)) add = a.reduce((s, x) => s + num(x?.amount ?? x), 0);
  else if (a && typeof a === 'object') add = Object.values(a).reduce((s, x) => s + num(x?.amount ?? x), 0);
  return num(p?.salary) + add + num(p?.arrears);
}

// One employee's payslip for a month. Distinguishes not-found (code 8) from rate-limit (429).
async function razorpayxViewPayroll(env, id, month) {
  const r = await razorpayxCall(env, 'payroll', 'view-payroll', { 'payroll-month': month, 'employee-id': Number(id) });
  const e = r.body?.error;
  if (e) {
    const rl = r.status === 429 || /too many requests/i.test(e.description || e.message || '');
    return { id, ok: false, rate_limited: rl, not_found: !rl };
  }
  return { id, ok: true, name: r.body?.['employee-name'] || null, gross: razorpayxGross(r.body) };
}

// email(lowercased) → auth.users id, via the GoTrue admin API.
async function authEmailMap(env) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) return {};
  const d = await res.json();
  const m = {};
  (d.users || []).forEach(u => { if (u.email) m[u.email.toLowerCase()] = u.id; });
  return m;
}

async function nextEmployeeSeq(env) {
  const r = await sb(`/rest/v1/rpc/next_employee_seq`, env, { method: 'POST', body: JSON.stringify({}) });
  if (!r.ok) return null;
  const v = Array.isArray(r.data) ? r.data[0] : r.data;
  return Number(v);
}

// ── Permission tiers ─────────────────────────────────────────────────────────

function hasPerm(auth, perm) { return !!auth?.permissions?.[perm]; }
function isAdmin(auth) { return hasPerm(auth, 'podium_admin'); }
function isHr(auth)    { return isAdmin(auth) || hasPerm(auth, 'podium_hr'); }
// Salary access = explicit allow-list membership only (auth.compAccess from verifyJWT).
// NOT implied by podium_admin/podium_hr. RULE-PODIUM-002 (amended 2026-07-06).
function canComp(auth) { return auth?.compAccess === true; }

function requireHr(auth)    { return isHr(auth)    ? null : err('Forbidden — requires podium_hr', 403); }
function requireComp(auth)  { return canComp(auth) ? null : err('Forbidden — requires podium_comp', 403); }
function requireAdmin(auth) { return isAdmin(auth) ? null : err('Forbidden — requires podium_admin', 403); }
function requireSuperAdmin(auth) { return auth?.isSuperAdmin ? null : err('Forbidden — requires super_admin', 403); }

// ── Org graph (manager_id chain) — small table, loaded once per request ──────

async function loadOrgEdges(env) {
  const r = await sb(`/rest/v1/employees?select=id,manager_id,auth_user_id&limit=5000`, env);
  return r.ok ? (r.data || []) : [];
}
function callerEmployee(edges, userId) {
  return edges.find(e => e.auth_user_id === userId) || null;
}
// Is mgrEmpId == empId, or an ancestor manager of empId? (self counts as "can see self")
function inManagerChain(edges, empId, mgrEmpId) {
  if (!empId || !mgrEmpId) return false;
  const byId = Object.fromEntries(edges.map(e => [e.id, e]));
  let cur = byId[empId];
  let depth = 0;
  while (cur && depth++ < 25) {
    if (cur.id === mgrEmpId) return true;
    if (!cur.manager_id) break;
    cur = byId[cur.manager_id];
  }
  return false;
}
// Can the caller see employee E's FULL profile (contact, dates, etc.)?
function canSeeFull(auth, edges, employeeId) {
  if (isHr(auth)) return true;
  const me = callerEmployee(edges, auth.userId);
  if (!me) return false;
  return inManagerChain(edges, employeeId, me.id); // self OR caller is an ancestor manager
}

// PAN is a government ID — HR/self ONLY, hidden even from the managing chain
// (same posture as bank/ID documents, RULE-PODIUM-001). Apply to FULL rows only;
// projectPublic() never includes pan_number anyway.
function stripPan(row, auth, edges) {
  if (!row || !('pan_number' in row)) return row;
  if (isHr(auth)) return row;
  const me = callerEmployee(edges, auth.userId);
  if (me && me.id === row.id) return row;
  const { pan_number, ...rest } = row;
  return rest;
}

// Public (directory-safe) projection of an employee row.
const PUBLIC_EMP_KEYS = [
  'id', 'employee_code', 'full_name', 'preferred_name', 'job_title',
  'department_id', 'job_role_id', 'manager_id', 'secondary_manager_id', 'photo_url', 'status', 'work_email',
];
function projectPublic(row) {
  const out = {};
  for (const k of PUBLIC_EMP_KEYS) if (k in row) out[k] = row[k];
  // keep embedded labels if present
  if (row.department) out.department = row.department;
  if (row.job_role)   out.job_role = row.job_role;
  if (row.manager)    out.manager = row.manager;
  if (row.secondary_manager) out.secondary_manager = row.secondary_manager;
  out._restricted = true;
  return out;
}

const EMP_EMBED =
  'department:department_id(id,name,code),job_role:job_role_id(id,title,level),manager:manager_id(id,full_name,job_title),secondary_manager:secondary_manager_id(id,full_name,job_title)';

// ────────────────────────────────────────────────────────────────────────────
// GET ACTIONS
// ────────────────────────────────────────────────────────────────────────────

async function getMe(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const [sr, hiringOn, canCreateOpening, googleAdmin, panelOn, leaveNav] = await Promise.all([
    sb(`/rest/v1/settings?id=eq.1&select=comp_vault_enabled,min_tenure_days,exit_notice_days&limit=1`, env),
    hiringAccess(auth, me, env),
    hasPerm(auth, 'podium_hiring') ? Promise.resolve(true) : hasActiveReports(me, env),
    isGoogleAdmin(auth, env),
    panelSeat(me, env),
    leaveNavState(auth, me, edges, env),
  ]);
  return ok({
    userId: auth.userId,
    email: auth.email,
    role: auth.role,
    fullName: auth.fullName,
    // podium_super_admin is a DISPLAY flag for the nav/page guards only (never read server-side —
    // hasPerm reads auth.permissions); the worker gates on canCalibrate(auth).
    // podium_hiring_access is the same kind of display flag (nav only); every hiring action self-scopes.
    // podium_offer_templates (nav only) mirrors canAdminOfferTemplates: salary allow-list or podium_admin.
    // podium_google_admin (display only) = podium.google_admin_access (J1, L3); every J1 handler re-checks.
    // podium_interviews_access (O2 D9, nav only) = a seat on any non-cancelled interview panel; the panel actions
    // self-scope on the caller's own panel row. It does NOT feed podium_hiring_access (a pure panelist sees only My interviews).
    // podium_leave_access (Leave D15, nav only) = covered OR ≥1 active direct report OR HR; podium_leave_pending = the
    // count of pending leave requests the caller may decide (the nav badge + dashboard tile). Every leave action self-scopes.
    permissions: { ...(auth.permissions || {}), podium_super_admin: !!auth.isSuperAdmin, podium_hiring_access: hiringOn,
      podium_offer_templates: canComp(auth) || isAdmin(auth), podium_google_admin: googleAdmin, podium_interviews_access: panelOn,
      podium_leave_access: leaveNav.access, podium_leave_pending: leaveNav.pending },
    employee_id: me?.id || null,
    settings: sr.data?.[0] || { comp_vault_enabled: false, min_tenure_days: 90, exit_notice_days: 30 },
    tier: { admin: isAdmin(auth), hr: isHr(auth), comp: canComp(auth), super_admin: !!auth.isSuperAdmin },
    hiring: { access: hiringOn, can_create: !!canCreateOpening, interviews: panelOn },
    leave: { access: leaveNav.access, pending: leaveNav.pending },
  });
}

async function getSettings(url, auth, env) {
  const r = await sb(`/rest/v1/settings?id=eq.1&select=*&limit=1`, env);
  if (!r.ok) return err('db_error', 500);
  return ok(r.data?.[0] || null);
}

// Directory list. Everyone with podium_view sees it; rows the caller can't see in
// full are projected down to the public subset.
async function getEmployees(url, auth, env, ctx) {
  kickGoogleSync(env, auth, ctx);   // J1b D7: opening the People list drains the Google push queue
  const status = url.searchParams.get('status');
  const department = url.searchParams.get('department_id');
  const search = (url.searchParams.get('search') || '').trim();
  const limit = intParam(url, 'limit', 500, { min: 1, max: 2000 });
  const offset = intParam(url, 'offset', 0);

  // X1: "on notice" is an OPEN exit, not a status (0010 deviation 1) — ?status=notice lists those people.
  const onNotice = await openExitEmployeeIds(env);
  const filters = [];
  if (status === 'notice') filters.push(onNotice.size ? `id=in.(${[...onNotice].join(',')})` : 'id=is.null');
  else if (status && status !== 'all') filters.push(`status=eq.${encodeURIComponent(status)}`);
  else if (!status) filters.push('status=neq.exited');
  if (department) filters.push(`department_id=eq.${department}`);
  if (search) {
    const s = encodeURIComponent(search);
    filters.push(`or=(full_name.ilike.*${s}*,preferred_name.ilike.*${s}*,employee_code.ilike.*${s}*,work_email.ilike.*${s}*,job_title.ilike.*${s}*)`);
  }

  const [r, edges] = await Promise.all([
    sb(`/rest/v1/employees?${filters.join('&')}&select=*,${EMP_EMBED}&order=full_name.asc&limit=${limit}&offset=${offset}`, env),
    loadOrgEdges(env),
  ]);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const rows = (r.data || []).map(e => ({
    ...(canSeeFull(auth, edges, e.id) ? stripPan(e, auth, edges) : projectPublic(e)), on_notice: onNotice.has(e.id),
  }));
  return ok({ employees: rows, offset, limit });
}

// Employees with an OPEN exit (= on notice). Best-effort: the directory must not fail on it.
async function openExitEmployeeIds(env) {
  const r = await sb(`/rest/v1/employee_exits?status=eq.open&select=employee_id&limit=1000`, env);
  return new Set(r.ok && Array.isArray(r.data) ? r.data.map(x => x.employee_id).filter(id => UUID_RE.test(id)) : []);
}

async function getEmployee(url, auth, env, ctx) {
  kickGoogleSync(env, auth, ctx);   // J1b D7: opening a person's page drains the Google push queue
  const id = url.searchParams.get('id');
  const code = url.searchParams.get('code');
  if (!id && !code) return err('id or code required', 400);
  const filter = id ? `id=eq.${id}` : `employee_code=eq.${encodeURIComponent(code)}`;
  const [r, edges] = await Promise.all([
    sb(`/rest/v1/employees?${filter}&select=*,${EMP_EMBED}&limit=1`, env),
    loadOrgEdges(env),
  ]);
  if (!r.ok) return err('db_error', 500);
  const emp = r.data?.[0];
  if (!emp) return err('not_found', 404);
  const full = canSeeFull(auth, edges, emp.id);
  // Direct reports (directory-safe) for the profile's "Team" section.
  const reports = (r2 => (r2 || []))((await sb(
    `/rest/v1/employees?manager_id=eq.${emp.id}&status=neq.exited&select=id,employee_code,full_name,job_title,photo_url,status&order=full_name.asc`, env,
  )).data);
  const onNotice = (await openExitEmployeeIds(env)).has(emp.id);
  return ok({ employee: { ...(full ? stripPan(emp, auth, edges) : projectPublic(emp)), on_notice: onNotice }, can_see_full: full, can_see_comp: canComp(auth), reports });
}

async function getOrgChart(url, auth, env) {
  const includeExited = url.searchParams.get('include_exited') === 'true';
  const filter = includeExited ? '' : 'status=neq.exited&';
  const r = await sb(
    `/rest/v1/employees?${filter}select=id,employee_code,full_name,preferred_name,job_title,manager_id,photo_url,status,department:department_id(id,name,code)&order=full_name.asc&limit=5000`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  return ok({ nodes: r.data || [] });
}

async function getOrgSnapshots(url, auth, env) {
  const id = url.searchParams.get('id');
  if (id) {
    const r = await sb(`/rest/v1/org_snapshots?id=eq.${id}&select=*&limit=1`, env);
    if (!r.ok) return err('db_error', 500);
    return ok({ snapshot: r.data?.[0] || null });
  }
  const r = await sb(`/rest/v1/org_snapshots?select=id,label,captured_at,captured_by&order=captured_at.desc&limit=200`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ snapshots: r.data || [] });
}

async function getDepartments(url, auth, env) {
  const r = await sb(
    `/rest/v1/departments?select=*,head:head_employee_id(id,full_name),parent:parent_department_id(id,name)&order=name.asc`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  // headcount per department (directory-safe)
  const er = await sb(`/rest/v1/employees?status=neq.exited&select=department_id`, env);
  const counts = {};
  for (const e of (er.data || [])) if (e.department_id) counts[e.department_id] = (counts[e.department_id] || 0) + 1;
  const rows = (r.data || []).map(d => ({ ...d, headcount: counts[d.id] || 0 }));
  return ok({ departments: rows });
}

// Strip salary-band fields unless the caller may see compensation.
function projectJobRole(role, auth) {
  if (canComp(auth)) return role;
  const { salary_band_min, salary_band_mid, salary_band_max, ...rest } = role;
  return { ...rest, _bands_hidden: true };
}

async function getJobRoles(url, auth, env) {
  const r = await sb(
    `/rest/v1/job_roles?select=*,department:department_id(id,name)&order=title.asc`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  // KPI counts
  const kr = await sb(`/rest/v1/role_kpis?active=eq.true&select=job_role_id`, env);
  const counts = {};
  for (const k of (kr.data || [])) counts[k.job_role_id] = (counts[k.job_role_id] || 0) + 1;
  const rows = (r.data || []).map(rl => projectJobRole({ ...rl, kpi_count: counts[rl.id] || 0 }, auth));
  return ok({ job_roles: rows });
}

async function getJobRole(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!id) return err('id required', 400);
  const r = await sb(`/rest/v1/job_roles?id=eq.${id}&select=*,department:department_id(id,name)&limit=1`, env);
  if (!r.ok) return err('db_error', 500);
  const role = r.data?.[0];
  if (!role) return err('not_found', 404);
  const kr = await sb(`/rest/v1/role_kpis?job_role_id=eq.${id}&select=*&order=sort_order.asc,created_at.asc`, env);
  // employees in this role (directory-safe)
  const er = await sb(`/rest/v1/employees?job_role_id=eq.${id}&status=neq.exited&select=id,employee_code,full_name,job_title,photo_url&order=full_name.asc`, env);
  return ok({ job_role: projectJobRole(role, auth), kpis: kr.data || [], employees: er.data || [] });
}

// Append-only audit of CROSS-PERSON salary reads. Self-views of one's own pay are
// not a leak and are not logged. Best-effort: a failed insert must never block a read.
async function logCompAccess(auth, action, subjectEmployeeId, subjectLabel, env, detail) {
  try {
    await sb(`/rest/v1/comp_access_log`, env, {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify([{
        viewer_user_id: auth.userId,
        viewer_name: auth.fullName || null,
        action,
        subject_employee_id: subjectEmployeeId || null,
        subject_label: subjectLabel || null,
        detail: detail || null,
      }]),
    });
  } catch (_e) { /* best-effort audit; never block the read */ }
}

// Compensation — CROSS-PERSON read, allow-list-gated (canComp = comp_access member).
// The ONLY path that returns another person's pay. Returns the per-employee event
// log + current CTC (latest non-bonus new_ctc). Every read is audited.
async function getCompensation(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
  await logCompAccess(auth, 'getCompensation', employee_id, null, env);
  const r = await sb(
    `/rest/v1/compensation_events?employee_id=eq.${employee_id}&select=*&order=effective_date.desc,created_at.desc`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  const events = r.data || [];
  const latestCtc = events.find(e => e.event_type !== 'one_time_bonus' && e.new_ctc != null);
  const sr = await sb(`/rest/v1/settings?id=eq.1&select=comp_vault_enabled&limit=1`, env);
  return ok({
    events,
    current_ctc: latestCtc ? Number(latestCtc.new_ctc) : null,
    comp_vault_enabled: !!sr.data?.[0]?.comp_vault_enabled,
  });
}

// SELF-ONLY comp view. Takes NO employee-id parameter — a caller can structurally
// only ever see their OWN compensation (resolved from the JWT via callerEmployee).
// Reachable by the self-only baseline (SELF_SERVE_GET). Self-views are not audited.
async function getMyCompensation(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return ok({ employee_id: null, events: [], current_ctc: null });
  const r = await sb(
    `/rest/v1/compensation_events?employee_id=eq.${me.id}&select=*&order=effective_date.desc,created_at.desc`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  // A locked-in appraisal increment/bonus stays hidden from its subject until the appraisal is
  // shared (S396 hostile review) — the lock is a super-admin step, the share is the release.
  const apprIds = [...new Set((r.data || []).map(e => e.appraisal_id).filter(Boolean))];
  let released = new Set();
  if (apprIds.length) {
    const ar = await sb(`/rest/v1/appraisals?id=in.(${apprIds.join(',')})&status=in.(shared,acknowledged)&select=id`, env);
    if (!ar.ok) return err('db_error', 500);
    released = new Set((ar.data || []).map(x => x.id));
  }
  const events = (r.data || []).filter(e => !e.appraisal_id || released.has(e.appraisal_id));
  const latestCtc = events.find(e => e.event_type !== 'one_time_bonus' && e.new_ctc != null);
  return ok({ employee_id: me.id, events, current_ctc: latestCtc ? Number(latestCtc.new_ctc) : null });
}

// Documents — visible to hr/admin, self, or a manager in the chain. Bank/ID docs
// are restricted to hr/admin/self even from a managing chain — and so are the salary-bearing
// letters (2026-11-11, J1): pay is allow-list only (RULE-PODIUM-002), and a manager could read a
// report's CTC straight off their offer/increment letter.
// J1 review: the salary letters are a tighter tier still — the salary allow-list (canComp) or the person
// themselves; HR/admin alone no longer suffice (RULE-PODIUM-002: pay is allow-list only, not role-derived).
// Non-self reads of them are logged to comp_access_log like every other salary read.
const RESTRICTED_DOC_TYPES = new Set(['bank_details', 'id_proof', 'address_proof', 'offer_letter', 'increment_letter', 'appraisal_letter']);
const SALARY_DOC_TYPES = new Set(['offer_letter', 'increment_letter', 'appraisal_letter']);

// J2: a document the person uploaded themselves (<employee_id>/self/…, /welcome) is restricted like the
// RESTRICTED_DOC_TYPES whatever its type — self + HR only, never the manager chain ("you and HR only").
const isSelfUploadPath = (p) => typeof p === 'string' && p.includes('/self/');
function docAllowed(auth, edges, employeeId, docType, storagePath = null) {
  const me = callerEmployee(edges, auth.userId);
  const isSelf = !!me && me.id === employeeId;
  if (SALARY_DOC_TYPES.has(docType)) return isSelf || canComp(auth);
  if (isHr(auth)) return true;
  if (!me) return false;
  if (isSelf) return true;
  const isMgr = inManagerChain(edges, employeeId, me.id);
  if (!isMgr) return false;
  if (isSelfUploadPath(storagePath)) return false; // self uploads: self + HR only
  return !RESTRICTED_DOC_TYPES.has(docType); // managers can't see bank/ID/address or the salary letters
}
// A salary letter read by someone other than its subject → audited (self-views are not, as getMyCompensation).
function isAuditedSalaryDocRead(auth, edges, employeeId, docType) {
  if (!SALARY_DOC_TYPES.has(docType)) return false;
  const me = callerEmployee(edges, auth.userId);
  return !(me && me.id === employeeId);
}

async function getDocuments(url, auth, env) {
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
  const edges = await loadOrgEdges(env);
  if (!canSeeFull(auth, edges, employee_id)) return err('forbidden', 403);
  const r = await sb(`/rest/v1/documents?employee_id=eq.${employee_id}&select=*&order=uploaded_at.desc`, env);
  if (!r.ok) return err('db_error', 500);
  const rows = (r.data || []).filter(d => docAllowed(auth, edges, employee_id, d.doc_type, d.storage_path));
  const salaryRows = rows.filter(d => isAuditedSalaryDocRead(auth, edges, employee_id, d.doc_type));
  if (salaryRows.length) await logCompAccess(auth, 'getDocuments', employee_id, null, env, { doc_types: [...new Set(salaryRows.map(d => d.doc_type))], count: salaryRows.length });
  return ok({ documents: rows });
}

async function getDocumentDownloadUrl(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!id) return err('id required', 400);
  const dr = await sb(`/rest/v1/documents?id=eq.${id}&select=*&limit=1`, env);
  if (!dr.ok) return err('db_error', 500);
  const doc = dr.data?.[0];
  if (!doc) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  if (!docAllowed(auth, edges, doc.employee_id, doc.doc_type, doc.storage_path)) return err('forbidden', 403);
  if (!String(doc.storage_path).startsWith(`${doc.employee_id}/`)) return err('forbidden', 403);
  if (isAuditedSalaryDocRead(auth, edges, doc.employee_id, doc.doc_type))
    await logCompAccess(auth, 'getDocumentDownloadUrl', doc.employee_id, null, env, { document_id: doc.id, doc_type: doc.doc_type });

  const seg = String(doc.storage_path).split('/').map(encodeURIComponent).join('/');
  const sr = await storageFetch(`/object/sign/${DOC_BUCKET}/${seg}`, env, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 120 }),
  });
  if (!sr.ok || !sr.data?.signedURL) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
  return ok({ url: `${env.SUPABASE_URL}/storage/v1${sr.data.signedURL}`, file_name: doc.file_name, mime_type: doc.mime_type });
}

// ────────────────────────────────────────────────────────────────────────────
// POST ACTIONS
// ────────────────────────────────────────────────────────────────────────────

function pickFields(body, allowed, src) {
  const o = {};
  const from = src || body;
  for (const k of allowed) if (k in from) o[k] = from[k];
  return o;
}
function pickPatch(body, allowed) {
  if (!body || typeof body.patch !== 'object') return {};
  return pickFields(body, allowed, body.patch);
}

async function mintEmployeeCode(env) {
  const r = await sbStore(`/rest/v1/rpc/next_employee_seq`, env, {
    method: 'POST',
    headers: { 'Accept-Profile': 'podium', 'Content-Profile': 'podium' },
    body: JSON.stringify({}),
  });
  if (!r.ok || typeof r.data !== 'number') return null;
  return `EMP-${String(r.data).padStart(3, '0')}`;
}

const EMPLOYEE_FIELDS = [
  'auth_user_id', 'full_name', 'preferred_name', 'personal_email', 'work_email', 'phone',
  'emergency_contact_name', 'emergency_contact_phone', 'date_of_birth',
  'department_id', 'job_role_id', 'job_title', 'manager_id', 'secondary_manager_id', 'employment_type',
  'legal_entity', 'work_location', 'date_joined', 'probation_end_date', 'confirmed_at',
  'date_exited', 'exit_reason', 'status', 'photo_url',
  'gender', 'blood_group', 'pan_number',
  // J1b D5: the Google org unit Podium wants (pushed to Google; google_org_unit stays "what Google last said").
  'org_unit_path',
  // Leave D1: coverage (null = not covered). Both writers are requireHr; cleanLeavePolicyField validates the value.
  'leave_policy',
];

// Leave D1: blank → null (not covered); otherwise one of LEAVE_POLICIES. Mutates `obj`; → null | the error response.
function cleanLeavePolicyField(obj) {
  if (!obj || !('leave_policy' in obj)) return null;
  const v = obj.leave_policy == null ? '' : String(obj.leave_policy).trim();
  if (!v) { obj.leave_policy = null; return null; }
  if (!LEAVE_POLICIES.includes(v)) return errCode('bad_leave_policy', 'Leave policy must be empty or fraternitas', 400);
  obj.leave_policy = v;
  return null;
}

// J1b: the org unit picked on EmployeeForm. Blank clears; otherwise a path ('/…') that is not in (or under) one of
// settings.directory_excluded_ous (400 ou_excluded). The value already stored is always accepted (EmployeeForm sends
// every field on every save, so an unchanged OU must not block saving someone). Whether the OU exists in Google is
// decided at push time (target_ou_unknown). Mutates `obj`; → null | the error response.
async function cleanOrgUnitField(obj, env, employeeId = null) {
  if (!obj || !('org_unit_path' in obj)) return null;
  const raw = obj.org_unit_path;
  if (raw === null || raw === undefined || String(raw).trim() === '') { obj.org_unit_path = null; return null; }
  const v = String(raw).trim();
  if (!v.startsWith('/') || v.length > 300) return errCode('bad_org_unit', 'Pick an org unit from the list', 400);
  obj.org_unit_path = v;
  const [sr, cr] = await Promise.all([
    sb(`/rest/v1/settings?id=eq.1&select=directory_excluded_ous&limit=1`, env),
    isUuid(employeeId) ? sb(`/rest/v1/employees?id=eq.${employeeId}&select=org_unit_path&limit=1`, env) : Promise.resolve({ ok: true, data: [] }),
  ]);
  if (!sr.ok || !cr.ok) return err('db_error: settings lookup failed', 500);
  if (cr.data?.[0]?.org_unit_path === v) return null;
  const excluded = sr.data?.[0]?.directory_excluded_ous || ['/Admin and general'];
  if (ouExcluded(v, excluded)) return errCode('ou_excluded', 'That org unit is excluded from Podium (shared / admin accounts). Pick another', 400);
  return null;
}

// ⭐ ONE date validator for all three write paths (S363 hostile review). The first version of this
// change guarded the sync and `updateEmployee` and MISSED `createEmployee` — because it was found by
// grepping the literal `status: 'exited'`, and this path sets status from `pickFields`, so the string
// never appears. The commit claimed "only two code paths can set status='exited' and both are guarded";
// there were three. Duplicated logic is what let the third hide, so there is now exactly one copy.
// ⚠️ A REGEX IS NOT A DATE CHECK: `/^\d{4}-\d{2}-\d{2}$/` accepts 2026-02-30 and 2026-04-31, which
// then reach Postgres and throw 22008 mid-loop — the half-applied batch the sync's comment promises
// is impossible. Round-trip through Date so an impossible day is rejected before any write.
// `String(v)` alone also let `['2026-09-01']` pass, hence the typeof check.
function badDate(v, label, { allowFuture = false } = {}) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${label} required (YYYY-MM-DD)`;
  const d = new Date(v + 'T00:00:00Z');
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== v) return `${label} is not a real date (${v})`;
  if (!allowFuture && v > new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }))
    return `${label} is in the future (${v})`;
  return null;
}

// J1: a work email Podium created for a hire who has not joined yet belongs to Confirm joining — a hand-made
// employee row with it would be a duplicate the joining step then refuses (podium_email_taken). Fails closed.
// → null when free, else the error response.
async function workEmailAwaitingJoining(env, email) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return null;
  const r = await sb(`/rest/v1/work_accounts?email=eq.${encodeURIComponent(em)}&status=neq.failed&application_id=not.is.null&select=id,application:application_id(status)&limit=5`, env);
  if (!r.ok || !Array.isArray(r.data)) return err('db_error: work_accounts lookup failed', 500);
  return r.data.some(w => w.application?.status !== 'joined')
    ? errCode('created_by_podium_awaiting_joining', 'Podium created this address for a hire who has not joined — use Confirm joining on the candidate', 409)
    : null;
}

// J2: PAN through the HR edit paths gets the /welcome validator — trimmed, spaces stripped, uppercased, then
// ^[A-Z]{5}[0-9]{4}[A-Z]$ (blank clears). Mutates `obj`; → null | the error response.
function cleanPanField(obj) {
  if (!obj || !('pan_number' in obj)) return null;
  const raw = obj.pan_number;
  if (raw === null || raw === undefined || String(raw).trim() === '') { obj.pan_number = null; return null; }
  const v = normPan(raw);
  if (!PAN_RE.test(v)) return errCode('bad_pan', 'PAN looks like ABCDE1234F (5 letters, 4 digits, 1 letter)', 400);
  obj.pan_number = v;
  return null;
}

async function createEmployee(body, auth, env, ctx) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.full_name) return err('full_name required', 400);
  // X1: nobody is CREATED exited (or on notice) — an exit only happens through the exit flow, which
  // records its reason, checklist and LWD (exit_close). S363's "no exit without a real date" holds by
  // construction now. A future joining date is legitimate here (onboarded before they start).
  if (body.date_joined) { const e = badDate(body.date_joined, 'Joining date', { allowFuture: true }); if (e) return err(e, 400); }
  if (employeeWriteTouchesExit(body, null)) return x1Err('use_exit_flow', 400);
  if (body.work_email) { const held = await workEmailAwaitingJoining(env, body.work_email); if (held) return held; }
  let code = String(body.employee_code || '').trim();
  if (!code) { code = await mintEmployeeCode(env); if (!code) return err('failed_to_mint_employee_code', 500); }
  const row = { employee_code: code, created_by: auth.userId, ...pickFields(body, EMPLOYEE_FIELDS) };
  { const pe = cleanPanField(row); if (pe) return pe; }
  { const le = cleanLeavePolicyField(row); if (le) return le; }
  { const cf = coveredFromOnChange(null, row.leave_policy, istToday()); if (cf) row.leave_covered_from = cf; }
  { const oe = await cleanOrgUnitField(row, env); if (oe) return oe; }
  const r = await sb(`/rest/v1/employees`, env, { method: 'POST', body: JSON.stringify([row]), headers: actorHeaders(auth) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  const created = r.data?.[0];
  // J1b D7: the insert trigger marked them pending; push inline (never fails the save).
  return ok(created ? { ...created, google_sync: await googleSyncAfterSave(env, auth, ctx, created.id) } : created);
}

// ── Auto-reassign reports when a manager exits (S306) ────────────────────────
// Exiting someone used to PATCH only that person, leaving every active report pointing at
// an exited row. Those reports then float to the TOP of the org chart as pseudo-roots, and
// the stale line keeps governing access (the manager chain IS the visibility tier here).
// It happened twice in one day — Varun Nandakumar (3 reports) and Jyothi S (2).
//
// Reports escalate to the exiting person's nearest ACTIVE ancestor, which is the same call a
// human makes by hand. Idempotent by design: re-running an exit re-reconciles, so it also
// cleans up stragglers left by exits that predate this code.
async function reassignReportsOnExit(exitingId, auth, env) {
  const out = { escalated: [], unassigned: [], dotted_cleared: 0, to_manager: null, errors: [] };
  const r = await sb(`/rest/v1/employees?select=id,full_name,status,manager_id,secondary_manager_id&limit=5000`, env);
  if (!r.ok) { out.errors.push('reassign: could not load employees'); return out; }
  const all = r.data || [];
  const byId = new Map(all.map(e => [e.id, e]));
  const exiting = byId.get(exitingId);
  if (!exiting) { out.errors.push('reassign: exiting employee not found'); return out; }

  // ⚠️ The audit write MUST be checked. These reassignments move people silently; an unchecked
  // insert means a stale PostgREST schema cache (or a lost grant) would leave the org changed with
  // NO trace and no error — the same unchecked-result class RULE-STOCK-002 records. Surfaced as a
  // loud error rather than swallowed, because "reassigned but unlogged" is the state we must never
  // reach quietly.
  async function audit(rows) {
    if (!rows.length) return;
    const ar = await sb(`/rest/v1/manager_reassignments`, env, {
      method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows),
    });
    if (!ar.ok) out.errors.push(`AUDIT WRITE FAILED (reporting lines were changed WITHOUT a log): ${JSON.stringify(ar.data)}`);
  }

  const reports = all.filter(e => e.manager_id === exitingId && e.status !== 'exited');
  const dotted = all.filter(e => e.secondary_manager_id === exitingId && e.status !== 'exited');
  if (!reports.length && !dotted.length) return out;

  // ⚠️ Walk PAST chained exits. Escalating to a manager who has also left would just move the
  // dangling line up a level and silently recreate the bug. Cycle-guarded by a seen-set.
  let heir = null;
  const seen = new Set([exitingId]);
  let cursor = exiting.manager_id;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const cand = byId.get(cursor);
    if (!cand) break;
    if (cand.status !== 'exited') { heir = cand; break; }
    cursor = cand.manager_id;
  }

  if (reports.length) {
    // A report can never inherit itself (only reachable through a pre-existing cycle).
    const movable = reports.filter(e => !heir || e.id !== heir.id);
    const stuck = reports.filter(e => heir && e.id === heir.id);
    for (const e of stuck) out.unassigned.push({ id: e.id, full_name: e.full_name, why: 'would report to self' });

    if (!heir) {
      // The exiting person was a root (or every ancestor has left). There is no defensible
      // automatic answer, so the line is LEFT INTACT and surfaced for a human rather than
      // nulled — silently orphaning people is worse than a stale line someone can see.
      for (const e of movable) out.unassigned.push({ id: e.id, full_name: e.full_name, why: 'no active manager above the exiting employee' });
    } else if (movable.length) {
      const ids = movable.map(e => e.id).filter(id => UUID_RE.test(id));
      const pr = await sb(`/rest/v1/employees?id=in.(${ids.join(',')})&status=neq.exited&select=id`, env,
        { method: 'PATCH', body: JSON.stringify({ manager_id: heir.id, updated_at: nowIso() }), headers: actorHeaders(auth) });
      if (!pr.ok) out.errors.push(`reassign: ${JSON.stringify(pr.data)}`);
      else {
        out.to_manager = { id: heir.id, full_name: heir.full_name };
        out.escalated = movable.map(e => ({ id: e.id, full_name: e.full_name }));
        await audit(movable.map(e => ({
          exited_employee_id: exitingId, report_employee_id: e.id,
          from_manager_id: exitingId, to_manager_id: heir.id,
          line: 'solid', reason: 'escalated', created_by: auth?.userId || null,
        })));
      }
    }
    if (out.unassigned.length) {
      await audit(out.unassigned.map(e => ({
        exited_employee_id: exitingId, report_employee_id: e.id,
        from_manager_id: exitingId, to_manager_id: null,
        line: 'solid', reason: 'left_unassigned', created_by: auth?.userId || null,
      })));
    }
  }

  // Dotted lines confer NO access and are directory-only, so escalating one would invent a
  // relationship nobody stated. A dangling dotted line to someone who has left is just noise
  // — clear it, and record that we did.
  if (dotted.length) {
    const ids = dotted.map(e => e.id).filter(id => UUID_RE.test(id));
    const dr = await sb(`/rest/v1/employees?id=in.(${ids.join(',')})&status=neq.exited&select=id`, env,
      { method: 'PATCH', body: JSON.stringify({ secondary_manager_id: null, updated_at: nowIso() }) });
    if (!dr.ok) out.errors.push(`reassign dotted: ${JSON.stringify(dr.data)}`);
    else {
      out.dotted_cleared = Array.isArray(dr.data) ? dr.data.length : 0;
      await audit(dotted.map(e => ({
        exited_employee_id: exitingId, report_employee_id: e.id,
        from_manager_id: exitingId, to_manager_id: null,
        line: 'dotted', reason: 'cleared_dotted', created_by: auth?.userId || null,
      })));
    }
  }
  return out;
}

async function updateEmployee(body, auth, env, ctx) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.employee_id) return err('employee_id required', 400);
  const patch = pickPatch(body, EMPLOYEE_FIELDS);
  delete patch.employee_code; // immutable
  // A person can't be their own (solid or dotted) manager.
  if (patch.secondary_manager_id === body.employee_id) patch.secondary_manager_id = null;
  if (patch.manager_id === body.employee_id) patch.manager_id = null;
  // ⭐ X1: the exit flow is the ONLY path to `exited` (plan 2026-11-11-podium-x1-exits). This edit may not
  // set status exited / notice, nor change date_exited or exit_reason — exit_close writes all three from the
  // exit record. Decided on the STORED row because EmployeeForm sends every field on every save: an unchanged
  // date on an already-exited person is not a change. (The S363 date rules this replaces now live in the exit
  // flow: the LWD is required there and the close cannot run before it.)
  if ('status' in patch || 'date_exited' in patch || 'exit_reason' in patch) {
    const cr = await sb(`/rest/v1/employees?id=eq.${body.employee_id}&select=status,date_exited,exit_reason`, env);
    if (!cr.ok || !Array.isArray(cr.data)) return err('db_error: employee lookup failed', 500);
    if (employeeWriteTouchesExit(patch, cr.data[0] || {})) return x1Err('use_exit_flow', 400);
  }
  if (patch.work_email) { const held = await workEmailAwaitingJoining(env, patch.work_email); if (held) return held; }
  { const pe = cleanPanField(patch); if (pe) return pe; }
  { const le = cleanLeavePolicyField(patch); if (le) return le; }
  { const oe = await cleanOrgUnitField(patch, env, body.employee_id); if (oe) return oe; }
  // Leave D14: a coverage flip is logged (EmployeeForm sends every field, so only a real change counts).
  let leaveFrom;
  if ('leave_policy' in patch) {
    const lr = await sb(`/rest/v1/employees?id=eq.${body.employee_id}&select=leave_policy&limit=1`, env);
    if (!lr.ok) return err('db_error: employee lookup failed', 500);
    const was = lr.data?.[0]?.leave_policy ?? null;
    if (was !== patch.leave_policy) leaveFrom = was;
    // Accrual is lazy: write what was earned while covered BEFORE the flip, or an off → on (which moves
    // leave_covered_from) would drop the months nobody read (Codex S453).
    if (was && was !== patch.leave_policy) {
      const ens = await ensureLeaveCurrent(env, [body.employee_id]);
      if (!ens.ok) return err(`db_error: leave ${ens.error}`, 500);
    }
    // Coverage history: off → on starts earning from this IST month, so the off gap never back-fills (leave.js).
    const cf = coveredFromOnChange(was, patch.leave_policy, istToday());
    if (cf) patch.leave_covered_from = cf;
  }
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);
  const r = await sb(`/rest/v1/employees?id=eq.${body.employee_id}`, env, { method: 'PATCH', body: JSON.stringify(patch), headers: actorHeaders(auth) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  const saved = r.data?.[0];
  if (saved && leaveFrom !== undefined) {
    await leaveEvent(env, auth, await meOf(auth, env), { employee_id: saved.id, event_type: 'coverage_changed', detail: { from: leaveFrom, to: saved.leave_policy ?? null } });
  }
  // J1b D7: the update trigger marked them pending only if a pushed field changed (EmployeeForm sends every field,
  // the trigger compares IS DISTINCT FROM). Push inline; a Google failure comes back as google_sync, never an error.
  return ok(saved ? { ...saved, google_sync: await googleSyncAfterSave(env, auth, ctx, saved.id) } : saved);
}

const DEPARTMENT_FIELDS = ['name', 'code', 'parent_department_id', 'head_employee_id', 'description', 'active'];

async function createDepartment(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.name) return err('name required', 400);
  const row = { created_by: auth.userId, ...pickFields(body, DEPARTMENT_FIELDS) };
  const r = await sb(`/rest/v1/departments`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function updateDepartment(body, auth, env, ctx) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.department_id) return err('department_id required', 400);
  const patch = pickPatch(body, DEPARTMENT_FIELDS);
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);
  const r = await sb(`/rest/v1/departments?id=eq.${body.department_id}`, env, { method: 'PATCH', body: JSON.stringify(patch), headers: actorHeaders(auth) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  // J1b D6/D7: a rename marked its members pending (trigger); they drain after the response, 8 at a time.
  kickGoogleSync(env, auth, ctx);
  return ok(r.data?.[0]);
}

const JOB_ROLE_FIELDS = [
  'role_code', 'title', 'department_id', 'level', 'summary', 'job_description',
  'responsibilities', 'salary_band_min', 'salary_band_mid', 'salary_band_max', 'active',
];
const BAND_FIELDS = ['salary_band_min', 'salary_band_mid', 'salary_band_max'];

async function createJobRole(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.title) return err('title required', 400);
  const row = { created_by: auth.userId, ...pickFields(body, JOB_ROLE_FIELDS) };
  if (!canComp(auth)) for (const f of BAND_FIELDS) delete row[f]; // bands are comp-gated
  const r = await sb(`/rest/v1/job_roles`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function updateJobRole(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.job_role_id) return err('job_role_id required', 400);
  const patch = pickPatch(body, JOB_ROLE_FIELDS);
  if (!canComp(auth)) for (const f of BAND_FIELDS) delete patch[f];
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);
  const r = await sb(`/rest/v1/job_roles?id=eq.${body.job_role_id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// Replace the full KPI set for a role (delete + insert).
async function setRoleKpis(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.job_role_id) return err('job_role_id required', 400);
  const kpis = Array.isArray(body.kpis) ? body.kpis : [];
  await sb(`/rest/v1/role_kpis?job_role_id=eq.${body.job_role_id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (kpis.length === 0) return ok({ kpis: [] });
  const rows = kpis.map((k, i) => ({
    job_role_id: body.job_role_id,
    name: k.name,
    description: k.description || null,
    metric_type: ['qualitative', 'quantitative'].includes(k.metric_type) ? k.metric_type : null,
    target: k.target || null,
    weight: k.weight != null ? Number(k.weight) : null,
    sort_order: k.sort_order != null ? Math.round(Number(k.sort_order)) : i,
    active: k.active !== false,
  }));
  const r = await sb(`/rest/v1/role_kpis`, env, { method: 'POST', body: JSON.stringify(rows) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok({ kpis: r.data || [] });
}

// Compensation event. v1: only increment_pct + bonus amount allowed. The
// absolute-CTC vault columns are stripped unless settings.comp_vault_enabled.
async function addCompensationEvent(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  if (!body.employee_id) return err('employee_id required', 400);
  if (!['initial', 'increment', 'revision', 'one_time_bonus', 'correction'].includes(body.event_type))
    return err('invalid event_type', 400);

  const sr = await sb(`/rest/v1/settings?id=eq.1&select=comp_vault_enabled&limit=1`, env);
  const vaultOn = !!sr.data?.[0]?.comp_vault_enabled;

  const row = {
    employee_id: body.employee_id,
    event_type: body.event_type,
    effective_date: body.effective_date || undefined,
    increment_pct: body.increment_pct != null ? Number(body.increment_pct) : null,
    amount: body.amount != null ? Number(body.amount) : null,
    currency: body.currency || 'INR',
    reason: body.reason || null,
    approved_by: body.approved_by || auth.userId,
    created_by: auth.userId,
  };
  if (vaultOn) {
    if (body.old_ctc != null) row.old_ctc = Number(body.old_ctc);
    if (body.new_ctc != null) row.new_ctc = Number(body.new_ctc);
    if (body.components != null) row.components = body.components;
  }
  const r = await sb(`/rest/v1/compensation_events`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok({ event: r.data?.[0], comp_vault_enabled: vaultOn });
}

// Document upload — mint a signed upload URL into the PRIVATE bucket. The client
// PUTs the file to it (supabase-js uploadToSignedUrl), then calls recordDocument.
function safeSeg(s) { return encodeURIComponent(String(s || '').replace(/[^\w.\-]+/g, '_')); }

async function createDocumentUploadUrl(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.employee_id) return err('employee_id required', 400);
  if (!body.file_name) return err('file_name required', 400);
  const docType = body.doc_type || 'other';
  const path = `${body.employee_id}/${safeSeg(docType)}/${Date.now()}_${safeSeg(body.file_name)}`;
  const sr = await storageFetch(`/object/upload/sign/${DOC_BUCKET}/${path}`, env, { method: 'POST' });
  if (!sr.ok || !sr.data?.url) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
  const tokenMatch = String(sr.data.url).match(/token=([^&]+)/);
  return ok({ storage_path: path, token: tokenMatch ? decodeURIComponent(tokenMatch[1]) : null, signed_url: sr.data.url });
}

const DOC_FIELDS = ['doc_type', 'title', 'storage_path', 'file_name', 'mime_type', 'file_size', 'expires_at', 'notes'];

async function recordDocument(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.employee_id) return err('employee_id required', 400);
  if (!body.storage_path) return err('storage_path required', 400);
  if (!body.doc_type) return err('doc_type required', 400);
  // Employee docs live under <employee_id>/ only — the bucket also holds hiring files (candidates/, openings/),
  // whose visibility rules this endpoint does not run. Never let a row here alias one of those objects.
  if (!isUuid(body.employee_id) || !String(body.storage_path).startsWith(`${body.employee_id}/`) || String(body.storage_path).includes('..'))
    return err('storage_path must be under this employee', 400);
  const row = { employee_id: body.employee_id, uploaded_by: auth.userId, ...pickFields(body, DOC_FIELDS) };
  const r = await sb(`/rest/v1/documents`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function deleteDocument(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.id) return err('id required', 400);
  const dr = await sb(`/rest/v1/documents?id=eq.${body.id}&select=storage_path&limit=1`, env);
  const path = dr.data?.[0]?.storage_path;
  const r = await sb(`/rest/v1/documents?id=eq.${body.id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  if (path) {
    const seg = String(path).split('/').map(encodeURIComponent).join('/');
    await storageFetch(`/object/${DOC_BUCKET}/${seg}`, env, { method: 'DELETE' });
  }
  return ok({ deleted: body.id });
}

// Capture a point-in-time org chart snapshot.
async function captureOrgSnapshot(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const r = await sb(
    `/rest/v1/employees?status=neq.exited&select=id,employee_code,full_name,job_title,manager_id,photo_url,department:department_id(name)&limit=5000`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  const ins = await sb(`/rest/v1/org_snapshots`, env, {
    method: 'POST',
    body: JSON.stringify([{ label: body.label || `Snapshot ${nowIso().slice(0, 10)}`, snapshot: { nodes: r.data || [], captured_at: nowIso() }, captured_by: auth.userId }]),
  });
  if (!ins.ok) return err(`db_error: ${JSON.stringify(ins.data)}`, 400);
  return ok(ins.data?.[0]);
}

async function updateSettings(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const patch = {};
  if (typeof body.comp_vault_enabled === 'boolean') patch.comp_vault_enabled = body.comp_vault_enabled;
  if (body.min_tenure_days != null) patch.min_tenure_days = Math.round(Number(body.min_tenure_days));
  // X1: the default notice period (LWD = notice date + this). 0010 CHECKs 0–365.
  if (body.exit_notice_days != null) patch.exit_notice_days = Math.round(Number(body.exit_notice_days));
  if (Object.keys(patch).length === 0) return err('no_patch', 400);
  patch.updated_at = nowIso();
  const r = await sb(`/rest/v1/settings?id=eq.1`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 2 — PERFORMANCE CAPTURE (observations, wins, 1:1s)
// Access derives from the manager_id graph + isHr — no new perm keys.
// See docs/superpowers/specs/2026-06-02-podium-phase2-performance-capture-design.md
// ────────────────────────────────────────────────────────────────────────────

async function meOf(auth, env) { return callerEmployee(await loadOrgEdges(env), auth.userId); }

// True when the caller IS the appraisal's subject. canManage() short-circuits on HR before its
// own self check, so every HR-gated appraisal write must test this first.
function isOwnAppraisal(edges, auth, employeeId) {
  const me = callerEmployee(edges, auth.userId);
  return !!(me && me.id === employeeId);
}
// HR list views: the caller's OWN row keeps only what the subject may see until it is shared.
// The internal fields (recommendation, comments, calibration) stay hidden on your own row for good;
// the result itself is hidden until shared.
function maskOwnAppraisal(row, meE) {
  if (!meE || row.employee_id !== meE.id) return row;
  const o = { ...row, calibration_note: null, suggested_pct: null, manager_overall_rating: null,
    manager_suggested_increment_pct: null, manager_suggested_bonus: null, manager_recommendation_note: null,
    manager_comments: null, calibrated_increment_pct: null, calibrated_bonus: null, _own: true };
  if (row.status === 'shared' || row.status === 'acknowledged') return o;
  return { ...o, final_rating: null, outcome: null, manager_did_well: null, manager_improve: null, manager_focus: null };
}
// Calibration, the all-employees cycle view, share and the applied increment are locked to the
// SUPER ADMINS (store.users_profile.role = 'super_admin' — Vinay + Afshaan), not the Podium admin
// role, which Mohit and Priya also hold (S396, Afshaan). HR-role users are plain managers here.
function canCalibrate(auth) { return !!auth?.isSuperAdmin; }
function requireCalibrate(auth) { return canCalibrate(auth) ? null : err('Forbidden — appraisal calibration is super-admin only', 403); }
// Drafts go only to their author: self_draft to the subject, manager_draft to the reviewing manager.
function stripDrafts(row, { keepSelf = false, keepManager = false } = {}) {
  const o = { ...row };
  if (!keepSelf) { delete o.self_draft; delete o.self_draft_saved_at; }
  if (!keepManager) { delete o.manager_draft; delete o.manager_draft_saved_at; }
  return o;
}
// Can the caller create/manage performance entries ABOUT employee E?
// HR/admin, or an ancestor manager of E (not E themselves).
function canManage(auth, edges, employeeId) {
  if (isHr(auth)) return true;
  const me = callerEmployee(edges, auth.userId);
  if (!me || me.id === employeeId) return false;
  return inManagerChain(edges, employeeId, me.id);
}

// All employee ids reporting (directly or transitively) up to rootEmpId. Excludes root.
function descendantsOf(edges, rootEmpId) {
  const out = new Set();
  if (!rootEmpId) return out;
  const children = {};
  for (const e of edges) if (e.manager_id) (children[e.manager_id] ||= []).push(e.id);
  const stack = [...(children[rootEmpId] || [])];
  let guard = 0;
  while (stack.length && guard++ < 10000) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const c of (children[id] || [])) stack.push(c);
  }
  return out;
}

// Per-row observation visibility for `subjectId` (HR/admin already see all upstream).
function filterObservationsForViewer(rows, auth, edges, subjectId) {
  if (isHr(auth)) return rows;
  const me = callerEmployee(edges, auth.userId);
  const isSubject = !!(me && me.id === subjectId);
  const isChainMgr = !!(me && me.id !== subjectId && inManagerChain(edges, subjectId, me.id));
  return rows.filter(r => {
    if (me && r.author_employee_id === me.id) return true;               // author sees own (any tier)
    if (r.visibility === 'shared_with_employee') return isSubject || isChainMgr;
    if (r.visibility === 'shared_with_managers') return isChainMgr;      // not the subject
    return false;                                                        // private → author/HR only
  });
}

// Strip a 1:1's private_notes unless the viewer is its authoring manager or HR.
function projectOneOnOne(row, auth, me) {
  if (isHr(auth) || (me && row.manager_employee_id === me.id)) return row;
  return { ...row, private_notes: null, _private_hidden: true };
}

const OBS_EMBED = 'author:employees!author_employee_id(id,full_name,job_title)';
const ONE_EMBED = 'manager:employees!manager_employee_id(id,full_name,job_title)';

// ── Observations ─────────────────────────────────────────────────────────────

async function getObservations(url, auth, env) {
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
  const edges = await loadOrgEdges(env);
  if (!canSeeFull(auth, edges, employee_id)) return err('forbidden', 403);
  const r = await sb(
    `/rest/v1/observations?subject_employee_id=eq.${employee_id}&select=*,${OBS_EMBED}&order=observed_on.desc,created_at.desc`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const me = callerEmployee(edges, auth.userId);
  const visible = filterObservationsForViewer(r.data || [], auth, edges, employee_id).map(row => {
    const isAuthor = !!(me && row.author_employee_id === me.id);
    return { ...row, _can_edit: isAuthor, _can_delete: isAuthor || isHr(auth) };
  });
  return ok({ observations: visible, can_add: canManage(auth, edges, employee_id) });
}

const OBSERVATION_FIELDS = ['body', 'sentiment', 'tags', 'visibility', 'observed_on'];
const SENTIMENTS = ['positive', 'neutral', 'constructive'];

async function createObservation(body, auth, env) {
  if (!body.subject_employee_id) return err('subject_employee_id required', 400);
  if (!body.body) return err('body required', 400);
  if (!SENTIMENTS.includes(body.sentiment)) return err('invalid sentiment', 400);
  const edges = await loadOrgEdges(env);
  if (!canManage(auth, edges, body.subject_employee_id)) return err('forbidden — not a manager of this person', 403);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return err('no_employee_record', 403);
  const row = {
    subject_employee_id: body.subject_employee_id,
    author_employee_id: me.id,
    created_by: auth.userId,
    ...pickFields(body, OBSERVATION_FIELDS),
  };
  const r = await sb(`/rest/v1/observations`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function updateObservation(body, auth, env) {
  if (!body.id) return err('id required', 400);
  const cur = await sb(`/rest/v1/observations?id=eq.${body.id}&select=author_employee_id&limit=1`, env);
  const row = cur.data?.[0]; if (!row) return err('not_found', 404);
  const me = await meOf(auth, env);
  if (!me || me.id !== row.author_employee_id) return err('forbidden — author only', 403);
  const patch = pickPatch(body, OBSERVATION_FIELDS);
  if (patch.sentiment && !SENTIMENTS.includes(patch.sentiment)) return err('invalid sentiment', 400);
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);
  const r = await sb(`/rest/v1/observations?id=eq.${body.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// ── Accomplishments (wins) ───────────────────────────────────────────────────

async function getAccomplishments(url, auth, env) {
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
  const edges = await loadOrgEdges(env);
  if (!canSeeFull(auth, edges, employee_id)) return err('forbidden', 403);
  const me = callerEmployee(edges, auth.userId);
  const r = await sb(`/rest/v1/accomplishments?employee_id=eq.${employee_id}&select=*&order=achieved_on.desc,created_at.desc`, env);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const mine = !!(me && me.id === employee_id);
  const rows = (r.data || []).map(row => ({ ...row, _can_edit: mine, _can_delete: mine || isHr(auth) }));
  return ok({ accomplishments: rows, can_add: mine });
}

const ACCOMPLISHMENT_FIELDS = ['title', 'description', 'tags', 'achieved_on'];

async function createAccomplishment(body, auth, env) {
  if (!body.title) return err('title required', 400);
  const me = await meOf(auth, env);
  if (!me) return err('no_employee_record — only employees can record wins', 403);
  const row = { employee_id: me.id, created_by: auth.userId, ...pickFields(body, ACCOMPLISHMENT_FIELDS) };
  const r = await sb(`/rest/v1/accomplishments`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function updateAccomplishment(body, auth, env) {
  if (!body.id) return err('id required', 400);
  const cur = await sb(`/rest/v1/accomplishments?id=eq.${body.id}&select=employee_id&limit=1`, env);
  const row = cur.data?.[0]; if (!row) return err('not_found', 404);
  const me = await meOf(auth, env);
  if (!me || me.id !== row.employee_id) return err('forbidden — author only', 403);
  const patch = pickPatch(body, ACCOMPLISHMENT_FIELDS);
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);
  const r = await sb(`/rest/v1/accomplishments?id=eq.${body.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// ── 1:1 notes ────────────────────────────────────────────────────────────────

async function getOneOnOnes(url, auth, env) {
  const employee_id = url.searchParams.get('employee_id'); // the report
  if (!employee_id) return err('employee_id required', 400);
  const edges = await loadOrgEdges(env);
  if (!canSeeFull(auth, edges, employee_id)) return err('forbidden', 403);
  const me = callerEmployee(edges, auth.userId);
  const r = await sb(
    `/rest/v1/one_on_ones?report_employee_id=eq.${employee_id}&select=*,${ONE_EMBED}&order=met_on.desc,created_at.desc`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const rows = (r.data || []).map(row => {
    const isAuthor = !!(me && row.manager_employee_id === me.id);
    return { ...projectOneOnOne(row, auth, me), _can_edit: isAuthor, _can_delete: isAuthor || isHr(auth) };
  });
  return ok({ one_on_ones: rows, can_add: canManage(auth, edges, employee_id) });
}

const ONEONONE_FIELDS = ['met_on', 'shared_notes', 'private_notes', 'action_items'];

async function createOneOnOne(body, auth, env) {
  if (!body.report_employee_id) return err('report_employee_id required', 400);
  const edges = await loadOrgEdges(env);
  if (!canManage(auth, edges, body.report_employee_id)) return err('forbidden — not a manager of this person', 403);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return err('no_employee_record', 403);
  const fields = pickFields(body, ONEONONE_FIELDS);
  if (fields.action_items && !Array.isArray(fields.action_items)) delete fields.action_items;
  const row = { report_employee_id: body.report_employee_id, manager_employee_id: me.id, created_by: auth.userId, ...fields };
  const r = await sb(`/rest/v1/one_on_ones`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function updateOneOnOne(body, auth, env) {
  if (!body.id) return err('id required', 400);
  const cur = await sb(`/rest/v1/one_on_ones?id=eq.${body.id}&select=manager_employee_id&limit=1`, env);
  const row = cur.data?.[0]; if (!row) return err('not_found', 404);
  const me = await meOf(auth, env);
  if (!me || me.id !== row.manager_employee_id) return err('forbidden — author only', 403);
  const patch = pickPatch(body, ONEONONE_FIELDS);
  if (patch.action_items && !Array.isArray(patch.action_items)) delete patch.action_items;
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);
  const r = await sb(`/rest/v1/one_on_ones?id=eq.${body.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// ── Shared delete (author or HR) ─────────────────────────────────────────────

async function deleteEntry(table, ownerCol, body, auth, env) {
  if (!body.id) return err('id required', 400);
  const cur = await sb(`/rest/v1/${table}?id=eq.${body.id}&select=${ownerCol}&limit=1`, env);
  const row = cur.data?.[0]; if (!row) return err('not_found', 404);
  const me = await meOf(auth, env);
  const isAuthor = !!(me && me.id === row[ownerCol]);
  if (!isAuthor && !isHr(auth)) return err('forbidden — author or HR only', 403);
  const r = await sb(`/rest/v1/${table}?id=eq.${body.id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok({ deleted: body.id });
}
async function deleteObservation(body, auth, env)    { return deleteEntry('observations', 'author_employee_id', body, auth, env); }
async function deleteAccomplishment(body, auth, env)  { return deleteEntry('accomplishments', 'employee_id', body, auth, env); }
async function deleteOneOnOne(body, auth, env)        { return deleteEntry('one_on_ones', 'manager_employee_id', body, auth, env); }

// ── Aggregate reads (My Performance + Team feed) ─────────────────────────────

async function getMyPerformance(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return ok({ employee_id: null, accomplishments: [], observations: [], one_on_ones: [], open_action_items: [] });
  const [wins, obs, oned] = await Promise.all([
    sb(`/rest/v1/accomplishments?employee_id=eq.${me.id}&select=*&order=achieved_on.desc&limit=200`, env),
    sb(`/rest/v1/observations?subject_employee_id=eq.${me.id}&visibility=eq.shared_with_employee&select=*,${OBS_EMBED}&order=observed_on.desc&limit=200`, env),
    sb(`/rest/v1/one_on_ones?report_employee_id=eq.${me.id}&select=*,${ONE_EMBED}&order=met_on.desc&limit=200`, env),
  ]);
  const oneRows = (oned.data || []).map(r => projectOneOnOne(r, auth, me)); // report ≠ author → private stripped
  const openItems = [];
  for (const o of oneRows)
    for (const ai of (Array.isArray(o.action_items) ? o.action_items : []))
      if (ai && !ai.done) openItems.push({ text: ai.text, met_on: o.met_on, one_on_one_id: o.id });
  return ok({
    employee_id: me.id,
    accomplishments: wins.data || [],
    observations: obs.data || [],            // subject view: shared_with_employee only
    one_on_ones: oneRows,
    open_action_items: openItems,
  });
}

async function getTeamActivity(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  let scope;
  if (isHr(auth)) {
    const focus = url.searchParams.get('employee_id');
    scope = focus ? descendantsOf(edges, focus) : new Set(edges.map(e => e.id));
  } else {
    if (!me) return ok({ activity: [] });
    scope = descendantsOf(edges, me.id);
  }
  const ids = [...scope];
  if (ids.length === 0) return ok({ activity: [], team: [] });
  const inList = `(${ids.join(',')})`;
  const teamRes = await sb(`/rest/v1/employees?id=in.${inList}&status=neq.exited&select=id,full_name,job_title&order=full_name.asc`, env);
  const team = teamRes.data || [];
  const [obs, wins, oned] = await Promise.all([
    sb(`/rest/v1/observations?subject_employee_id=in.${inList}&select=*,subject:employees!subject_employee_id(id,full_name),${OBS_EMBED}&order=observed_on.desc&limit=50`, env),
    sb(`/rest/v1/accomplishments?employee_id=in.${inList}&select=*,employee:employees!employee_id(id,full_name)&order=achieved_on.desc&limit=50`, env),
    sb(`/rest/v1/one_on_ones?report_employee_id=in.${inList}&select=*,report:employees!report_employee_id(id,full_name),${ONE_EMBED}&order=met_on.desc&limit=50`, env),
  ]);
  const obsRows = (obs.data || []).filter(r => {
    if (isHr(auth)) return true;
    if (me && r.author_employee_id === me.id) return true;
    if (r.visibility === 'private') return false;
    return !!(me && inManagerChain(edges, r.subject_employee_id, me.id)); // chain mgr sees both shared tiers
  });
  const onedRows = (oned.data || []).map(r => projectOneOnOne(r, auth, me));
  const activity = [
    ...obsRows.map(r => ({ kind: 'observation', date: r.observed_on, ...r })),
    ...(wins.data || []).map(r => ({ kind: 'win', date: r.achieved_on, ...r })),
    ...onedRows.map(r => ({ kind: 'one_on_one', date: r.met_on, ...r })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 100);
  return ok({ activity, team });
}

// ────────────────────────────────────────────────────────────────────────────
// PERMISSION LAYER — Podium-managed roles (store.podium_roles / podium_user_roles)
// Mirrors Snorkel (RULE-SNORKEL-002). RULE-PODIUM-006. Admin actions gated on
// podium_admin; role list is open metadata (no PII).
// ────────────────────────────────────────────────────────────────────────────

const PODIUM_PERM_KEYS = ['podium_view', 'podium_hr', 'podium_admin', 'podium_hiring'];

// Keep only known keys as `true`; any elevated key implies podium_view so an admin
// can't mint a role that 403s itself at the gate (RULE-PODIUM-001 corollary).
function normalizePodiumPerms(permissions) {
  const out = {};
  for (const k of PODIUM_PERM_KEYS) if (permissions && permissions[k]) out[k] = true;
  if (out.podium_hr || out.podium_admin || out.podium_hiring) out.podium_view = true;
  return out;
}

async function getPodiumRoles(url, auth, env) {
  const r = await sbStore(`/rest/v1/podium_roles?select=*&order=is_system.desc,label.asc`, env);
  if (!r.ok) return err('db_error', 500);
  return ok(r.data || []);
}

async function getPodiumUsers(url, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const [up, ur] = await Promise.all([
    sbStore(`/rest/v1/users_profile?select=id,full_name,role,active&order=full_name.asc`, env),
    sbStore(`/rest/v1/podium_user_roles?select=user_id,role_key`, env),
  ]);
  if (!up.ok) return err('db_error', 500);
  const roleMap = {};
  if (ur.ok) (ur.data || []).forEach(x => { roleMap[x.user_id] = x.role_key; });
  const authUsers = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  const authData = authUsers.ok ? await authUsers.json() : { users: [] };
  const emailMap = {};
  (authData.users || []).forEach(u => { emailMap[u.id] = u.email; });
  return ok((up.data || []).map(u => ({ ...u, email: emailMap[u.id] || '', podium_role: roleMap[u.id] || null })));
}

async function createPodiumRole(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || {};
  if (!d.role_key || !d.label) return err('role_key and label required', 400);
  const key = String(d.role_key).trim().toLowerCase().replace(/\s+/g, '_');
  const r = await sbStore(`/rest/v1/podium_roles`, env, {
    method: 'POST',
    body: JSON.stringify([{
      role_key: key, label: d.label, description: d.description || null,
      permissions: normalizePodiumPerms(d.permissions), is_system: false,
    }]),
  });
  if (!r.ok) return err('create_failed: ' + JSON.stringify(r.data), 400);
  return ok({ role_key: key });
}

async function updatePodiumRole(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || {};
  if (!d.role_key) return err('role_key required', 400);
  const cur = await sbStore(`/rest/v1/podium_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=is_system&limit=1`, env);
  const isSys = !!(cur.ok && cur.data?.[0]?.is_system);
  const updates = { updated_at: nowIso() };
  if (d.label !== undefined)       updates.label = d.label;
  if (d.description !== undefined) updates.description = d.description;
  // System roles (admin / employee) have immutable permissions — prevents an admin from
  // dropping podium_admin off the admin role and locking everyone out. Label/desc editable.
  if (d.permissions !== undefined && !isSys) updates.permissions = normalizePodiumPerms(d.permissions);
  const r = await sbStore(`/rest/v1/podium_roles?role_key=eq.${encodeURIComponent(d.role_key)}`, env, {
    method: 'PATCH', body: JSON.stringify(updates),
  });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  return ok({ updated: d.role_key });
}

async function deletePodiumRole(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || {};
  if (!d.role_key) return err('role_key required', 400);
  const chk = await sbStore(`/rest/v1/podium_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=is_system&limit=1`, env);
  if (chk.ok && chk.data?.[0]?.is_system) return err('cannot delete a system role', 400);
  const assigned = await sbStore(`/rest/v1/podium_user_roles?role_key=eq.${encodeURIComponent(d.role_key)}&limit=1`, env);
  if (assigned.ok && assigned.data?.length) return err('cannot delete a role with assigned users', 400);
  const r = await sbStore(`/rest/v1/podium_roles?role_key=eq.${encodeURIComponent(d.role_key)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err('delete_failed', 400);
  return ok({ deleted: d.role_key });
}

async function assignPodiumRole(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || {};
  if (!d.user_id) return err('user_id required', 400);
  // Empty role_key → unassign → user falls back to self-only baseline.
  if (!d.role_key) {
    await sbStore(`/rest/v1/podium_user_roles?user_id=eq.${encodeURIComponent(d.user_id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
    return ok({ user_id: d.user_id, role_key: null });
  }
  const chk = await sbStore(`/rest/v1/podium_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=role_key&limit=1`, env);
  if (!chk.ok || !chk.data?.[0]) return err('unknown role', 400);
  const r = await sbStore(`/rest/v1/podium_user_roles?on_conflict=user_id`, env, {
    method: 'POST',
    prefer: 'return=representation,resolution=merge-duplicates',
    body: JSON.stringify({ user_id: d.user_id, role_key: d.role_key, assigned_by: auth.userId, assigned_at: nowIso() }),
  });
  if (!r.ok) return err('assign_failed: ' + JSON.stringify(r.data), 400);
  return ok({ user_id: d.user_id, role_key: d.role_key });
}

// ────────────────────────────────────────────────────────────────────────────
// GOOGLE DIRECTORY SYNC (on-demand) — HR-gated. RULE-PODIUM-007.
// Excludes shared/role OUs + an ignore list; proposes new joiners + departures;
// imports are review-and-confirm (drafts nothing, never clobbers manual edits).
// ────────────────────────────────────────────────────────────────────────────

const DEPT_ALIAS = { 'd2c': 'D2C / Website' }; // OU leaf → podium department name
// Guards client-supplied ids before they reach a PostgREST `in.()` filter.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Email as a comparison key. '' and NULL must mean the same thing (the falsy-empty-string class), or a
// blank baseline reads as "dismissed" against a blank Google value. (normOu went with the J1b D10 move tiers.)
export function normEmail(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim().toLowerCase();
  return t === '' ? null : t;
}

// ouExcluded lives in src/googlesync.js (J1b scope shares it).
function mapOuToDept(ou, deptByName) {
  if (!ou || ou === '/') return null;
  const leaf = ou.split('/').filter(Boolean).pop() || '';
  const name = (DEPT_ALIAS[leaf.toLowerCase()] || leaf).toLowerCase();
  return deptByName.get(name) || null;
}

// J1: lowercased email → 'awaiting_joining' (tied to an application not yet joined) | 'override' (made
// without hiring), for the live work_accounts rows Podium created.
// FAILS CLOSED: null when the lookup fails — callers return db_error rather than treat every account as
// "created outside Podium" (which would let the sync import a hire who has not joined).
async function podiumMadeAccounts(env) {
  const r = await sb(`/rest/v1/work_accounts?status=neq.failed&select=email,application_id,application:application_id(status)&limit=5000`, env);
  if (!r.ok || !Array.isArray(r.data)) return null;
  const m = new Map();
  for (const w of r.data) {
    const em = String(w.email || '').toLowerCase();
    if (!w.application_id) m.set(em, 'override');
    else if (w.application?.status !== 'joined') m.set(em, 'awaiting_joining');
  }
  return m;
}

async function getDirectorySyncPreview(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!googleConfigured(env)) return err('google_not_configured', 400);
  let gusers;
  try { gusers = await fetchGoogleUsers(env); }
  catch (e) { return err('google_sync_failed: ' + (e?.message || e), 502); }

  const [sres, igRes, eRes, dRes, podiumMade] = await Promise.all([
    sb(`/rest/v1/settings?id=eq.1&select=directory_excluded_ous&limit=1`, env),
    sb(`/rest/v1/directory_ignored?select=email`, env),
    sb(`/rest/v1/employees?select=id,full_name,work_email,status&limit=5000`, env),
    sb(`/rest/v1/departments?select=id,name&limit=500`, env),
    podiumMadeAccounts(env),
  ]);
  if (!podiumMade) return err('db_error: work_accounts lookup failed', 500);
  const excluded = (sres.ok && sres.data?.[0]?.directory_excluded_ous) || ['/Admin and general'];
  const ignored = new Set((igRes.ok ? igRes.data : []).map(r => (r.email || '').toLowerCase()));
  const emps = eRes.ok ? eRes.data : [];
  const empByEmail = new Map(emps.map(e => [(e.work_email || '').toLowerCase(), e]));
  const depts = (dRes.ok ? dRes.data : []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const deptByName = new Map(depts.map(d => [d.name.toLowerCase(), d.id]));
  const authMap = await authEmailMap(env);

  const gEmails = new Set();
  const gSuspended = new Set();
  let excludedCount = 0;
  // How many Google accounts actually carry a manager relation (reported; an S306 claim was once wrongly
  // inferred from the review rows instead).
  let gWithManager = 0;
  const newCands = [];

  // ⭐ J1b D10: the S306 MOVE tiers ('moved' / 'differs') are gone. Podium is now the source of truth for
  // department, manager and org unit, and pushes them to Google (plan 2026-11-12-podium-j1b-google-sync), so a
  // Google-side difference is no longer a proposal to change Podium: it is shown, per field, on the Google vs Podium
  // tab (getGoogleDiff), where HR pushes Podium's value. The import keeps new joiners, departure alerts, the ignore
  // list and the excluded OUs; importDirectoryCandidates refuses update / dismiss / baseline.
  for (const gu of gusers) {
    const email = (gu.primaryEmail || '').toLowerCase();
    if (!email) continue;
    gEmails.add(email);
    if ((gu.relations || []).some(x => x.type === 'manager' && x.value)) gWithManager++;
    if (gu.suspended) gSuspended.add(email);
    if (ouExcluded(gu.orgUnitPath, excluded)) { excludedCount++; continue; }
    if (ignored.has(email)) continue;
    if (empByEmail.has(email)) continue;     // already an employee: their fields are pushed FROM Podium (J1b)
    if (gu.suspended) continue;              // suspended & not in Podium → not a new active hire
    const deptId = mapOuToDept(gu.orgUnitPath, deptByName);
    const rel = (gu.relations || []).find(r => r.type === 'manager' && r.value);
    const mgr = rel ? empByEmail.get(rel.value.toLowerCase()) : null;
    // J1: an account Podium created for a hire who has not joined yet becomes an employee through
    // Confirm joining, never through this import (labelled, and refused by the create path).
    const madeBy = podiumMade.get(email);
    newCands.push({
      email: gu.primaryEmail,
      origin: madeBy === 'awaiting_joining' ? 'podium_awaiting_joining' : madeBy === 'override' ? 'podium_override' : 'outside',
      full_name: [gu.name?.givenName, gu.name?.familyName].filter(Boolean).join(' ') || gu.name?.fullName || gu.primaryEmail,
      org_unit: gu.orgUnitPath || '',
      job_title: gu.organizations?.[0]?.title || '',
      suggested_department_id: deptId,
      suggested_manager_id: mgr ? mgr.id : null,
      has_login: !!authMap[email],
    });
  }
  // Departures: active LOT-domain employees whose Google account is gone or suspended.
  // ⭐ X1: these are ALERTS, never exits — "an exit was started outside Podium; start the exit here". The sync
  // cannot record an exit (no reason, no checklist, no LWD); importDirectoryCandidates refuses the exit list.
  // exit_open = Podium already has the open exit, so the alert is expected (the person is serving notice).
  const openExits = await openExitEmployeeIds(env);
  const departed = emps.filter(e => {
    if (e.status !== 'active' || !e.work_email) return false;
    const em = e.work_email.toLowerCase();
    if (!em.endsWith('@legendoftoys.com')) return false; // only judge accounts we expect in Google
    return !gEmails.has(em) || gSuspended.has(em);
  }).map(e => ({
    id: e.id, full_name: e.full_name, work_email: e.work_email, alert: 'exit_started_outside_podium',
    exit_open: openExits.has(e.id),
    reason: gSuspended.has(e.work_email.toLowerCase()) ? 'suspended in Google' : 'no Google account',
  }));

  return ok({
    new_candidates: newCands.sort((a, b) => a.full_name.localeCompare(b.full_name)),
    departed,
    departments: depts,
    managers: emps.filter(e => e.status === 'active').map(e => ({ id: e.id, full_name: e.full_name }))
                  .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    counts: {
      google_total: gusers.length, excluded_ou: excludedCount, new: newCands.length, departed: departed.length,
      google_with_manager: gWithManager,
      active_in_podium: emps.filter(e => e.status !== 'exited').length,
    },
  });
}

// J1b D10: update[] / dismiss[] / baseline[] (the S306 move review) are refused. Podium owns department, manager
// and org unit and PUSHES them to Google; writing Google's values (or a Google baseline) back into Podium would
// undo Podium's own change. A non-empty list is refused outright: silently ignoring it would let an old client
// believe it had applied it. Pure (exported for test/directory-sync.test.mjs). → null | error code
export function refusedImportPayload(d) {
  const has = (k) => Array.isArray(d?.[k]) && d[k].length > 0;
  return has('update') || has('dismiss') || has('baseline') ? 'podium_owns_these_fields' : null;
}

export async function importDirectoryCandidates(body, auth, env, ctx) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  // ⭐ X1: the sync no longer exits anyone. Exits are recorded in Podium (reason, checklist, LWD — the exit
  // flow), and the S363 history of this list (sync-day dates, ~₹3.36L of phantom SG&A) is why: Google knows
  // THAT an account went, never why or when the person last worked. A non-empty `exit` is refused outright —
  // silently ignoring it would let an old client believe it had exited people.
  if (Array.isArray(d.exit) && d.exit.length) return x1Err('exits_are_recorded_in_podium', 400);
  { const refused = refusedImportPayload(d); if (refused) return j1bErr(refused, 400); }
  if (!googleConfigured(env)) return err('google_not_configured', 400);
  // ⭐ `date_joined` IS REQUIRED on every import (S363) — the mirror of the (former) exit-date rule.
  // This path created people with NO joining date at all, and a NULL `date_joined` is not neutral:
  // `sales.f_podium_salary_run` and `_coverage` both gate on `(e.date_joined IS NULL OR
  // e.date_joined <= m_end)`, so an undated person is "employed" in EVERY month ever — including
  // months before their row existed. Measured 2026-09-09: 8 active employees had no joining date,
  // ALL of them created by this sync, and three September joiners were being reported as August
  // coverage gaps. The cost side happens to be protected (the run also requires
  // `effective_date <= m_end`, so someone with no applicable comp row contributes ₹0), but that is
  // a second guard doing this one's job — backfill a CTC with an early effective_date and the
  // phantom cost becomes real. Google knows when it created an account; it does not know when
  // somebody started work.
  // ⚠️ Unlike `date_exited`, a FUTURE `date_joined` is legitimate — people are onboarded before
  // they start (a 2 Sep start recorded in August is exactly how `eligible` moved 65→64). So this
  // validates the format only and deliberately does NOT cap at today.
  const create = Array.isArray(d.create) ? d.create : []; // [{email, date_joined, department_id, manager_id, job_title}]
  // X1 exit[] and the J1b move-review lists (update / dismiss / baseline) are refused above.
  const ignore = Array.isArray(d.ignore) ? d.ignore : [];  // [email,...]
  if (create.length > 20) return err('import at most 20 people per sync (subrequest limit) — run again for the rest', 400);
  // Validate every import BEFORE writing any of them: a half-applied
  // batch would leave some people created and others not, with no way to tell which from here.
  for (const c of create) {
    if (!c || !c.email) return err('each import needs an email', 400);
    // allowFuture: people are onboarded before they start.
    const e = badDate(c.date_joined, `Joining date for ${c.email}`, { allowFuture: true });
    if (e) return err(`${e} — Google knows when it made the account, not when they started`, 400);
  }
  const result = { created: [], ignored: [], errors: [] };

  if (ignore.length) {
    const rows = ignore.map(em => ({ email: String(em).toLowerCase(), ignored_by: auth.userId }));
    await sb(`/rest/v1/directory_ignored?on_conflict=email`, env,
      { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify(rows) });
    result.ignored = ignore;
  }

  if (create.length) {
    let gusers;
    try { gusers = await fetchGoogleUsers(env); }
    catch (e) { return err('google_sync_failed: ' + (e?.message || e), 502); }
    const gByEmail = new Map(gusers.map(u => [(u.primaryEmail || '').toLowerCase(), u]));
    const authMap = await authEmailMap(env);
    const [exRes, podiumMade] = await Promise.all([
      sb(`/rest/v1/employees?select=work_email&limit=5000`, env),
      podiumMadeAccounts(env),
    ]);
    if (!podiumMade) return err('db_error: work_accounts lookup failed', 500);
    const existing = new Set((exRes.ok ? exRes.data : []).map(e => (e.work_email || '').toLowerCase()));
    for (const c of create) {
      const em = (c.email || '').toLowerCase();
      if (!em || existing.has(em)) { result.errors.push(`${c.email || '?'}: already exists`); continue; }
      // J1: the hire joins via Confirm joining (employee + comp + documents in one transaction), not here.
      if (podiumMade.get(em) === 'awaiting_joining') { result.errors.push(`${c.email}: created_by_podium_awaiting_joining`); continue; }
      const gu = gByEmail.get(em);
      if (!gu) { result.errors.push(`${c.email}: not in Google directory`); continue; }
      const seq = await nextEmployeeSeq(env);
      if (!seq && seq !== 0) { result.errors.push(`${c.email}: sequence error`); continue; }
      const row = {
        employee_code: 'EMP-' + String(seq).padStart(3, '0'),
        full_name: [gu.name?.givenName, gu.name?.familyName].filter(Boolean).join(' ') || gu.name?.fullName || gu.primaryEmail,
        work_email: gu.primaryEmail,
        department_id: c.department_id || null,
        manager_id: c.manager_id || null,
        job_title: c.job_title || gu.organizations?.[0]?.title || null,
        // Validated above. Never defaulted — an undated employee is counted as employed in every
        // month that has ever existed (see the note on `create`).
        date_joined: c.date_joined,
        status: 'active',
        auth_user_id: authMap[em] || null,
        google_user_id: gu.id || null,
        google_org_unit: gu.orgUnitPath || null, // what Google said at creation
        // J1b D5: Podium owns the OU from now on; start from where Google has them so the first push moves nobody.
        org_unit_path: gu.orgUnitPath || null,
        synced_from_google_at: nowIso(),
        created_by: auth.userId,
      };
      const ins = await sb(`/rest/v1/employees`, env, { method: 'POST', body: JSON.stringify([row]), headers: actorHeaders(auth) });
      if (ins.ok) { existing.add(em); result.created.push({ email: gu.primaryEmail, employee_code: row.employee_code }); }
      else result.errors.push(`${c.email}: ${JSON.stringify(ins.data)}`);
    }
    // J1b: each new row was marked pending by the insert trigger; push them after the response.
    if (result.created.length) kickGoogleSync(env, auth, ctx);
  }
  return ok(result);
}

// ────────────────────────────────────────────────────────────────────────────
// APPRAISAL ENGINE (Phase 3) — RULE-PODIUM-008.
// Twice-yearly (Apr 1 / Oct 1) two-sided hybrid reviews → lightweight calibration
// → banded (pro-rated) increment → share + acknowledge; PIP flag. Participation is
// relationship-scoped (subject / manager-chain), NOT podium_view-gated.
// ────────────────────────────────────────────────────────────────────────────

function clampRating(v) { const n = Math.round(Number(v)); return (n >= 1 && n <= 5) ? n : null; }
// Review boxes are rich text (S396): the editor sends HTML, stored sanitized to a tag whitelist with
// every attribute dropped. Text outside tags has < > escaped. Legacy plain text never went through
// this and the UI renders it as text; the editor always wraps new content in a block tag.
function reviewText(v) { return typeof v === 'string' ? sanitizeRich(v.slice(0, 40000)) : null; }
// ₹ amount: null = not given; NaN = given but invalid (caller 400s).
function parseMoney(v) {
  if (v == null || (typeof v === 'string' && !v.trim())) return null;
  if (typeof v !== 'number' && typeof v !== 'string') return NaN;
  const n = Number(v);
  return (Number.isFinite(n) && n >= 0 && n <= 1e9) ? Math.round(n * 100) / 100 : NaN;
}
// null = not given; NaN = given but invalid (caller 400s).
function parseIncrementPct(v) {
  if (v == null || (typeof v === 'string' && !v.trim())) return null;
  if (typeof v !== 'number' && typeof v !== 'string') return NaN;
  const n = Number(v);
  return (Number.isFinite(n) && n >= 0 && n <= 100) ? Math.round(n * 100) / 100 : NaN;
}
// A saved-but-not-submitted review. Lives in <side>_draft (jsonb) so it never touches the
// submitted columns the other side reads; KPI ratings stay in the draft until submit.
function reviewDraft(d, side) {
  const kpi = Array.isArray(d.kpi_ratings) ? d.kpi_ratings : [];
  return {
    overall_rating: clampRating(d[`${side}_overall_rating`]),
    did_well: reviewText(d[`${side}_did_well`]), improve: reviewText(d[`${side}_improve`]), focus: reviewText(d[`${side}_focus`]),
    kpi_ratings: kpi.slice(0, 25).filter(k => k && k.id).map(k => ({ id: String(k.id), rating: clampRating(k.rating) })),
  };
}
function isoMinusMonths(dateStr, months) { const x = new Date(dateStr + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() - months); return x.toISOString().slice(0, 10); }
function isoMinusDays(dateStr, days) { const x = new Date(dateStr + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - days); return x.toISOString().slice(0, 10); }
function periodMonths(start, end) {
  if (!start || !end) return 6;
  const s = new Date(start + 'T00:00:00Z'), e = new Date(end + 'T00:00:00Z');
  let m = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
  if (e.getUTCDate() < s.getUTCDate()) m -= 1;
  return Math.max(m, 1);
}
function suggestedPct(bands, rating, months) {
  const b = (bands || []).find(x => Number(x.rating) === Number(rating));
  if (!b) return null;
  const base = Number(b.mid != null ? b.mid : (b.default || 0));
  return Math.round(base * (months / 6) * 100) / 100;
}
async function loadAppraisalSettings(env) {
  const r = await sb(`/rest/v1/settings?id=eq.1&select=increment_bands,appraisal_prompts,pip_rating_threshold,comp_vault_enabled&limit=1`, env);
  const s = r.data?.[0] || {};
  return {
    bands: s.increment_bands || [],
    prompts: s.appraisal_prompts || ['What went well', 'What could have gone better', 'Focus for the next period'],
    pipThreshold: s.pip_rating_threshold ?? 2,
    vault: !!s.comp_vault_enabled,
  };
}
async function saveKpiRatings(appraisalId, list, side, env) {
  if (!Array.isArray(list) || !list.length) return;
  const col = side === 'manager' ? 'manager_rating' : 'self_rating';
  for (const item of list.slice(0, 25)) {
    if (!item || !item.id) continue;
    await sb(`/rest/v1/appraisal_kpi_ratings?id=eq.${item.id}&appraisal_id=eq.${appraisalId}`, env,
      { method: 'PATCH', body: JSON.stringify({ [col]: clampRating(item.rating) }) });
  }
}
// Subject sees own self-side always; manager qualitative + final + outcome only once shared;
// never manager_overall_rating or calibration_note.
function projectAppraisalForSubject(a) {
  const o = {
    id: a.id, cycle: a.cycle, status: a.status,
    review_period_start: a.review_period_start, review_period_end: a.review_period_end,
    self_overall_rating: a.self_overall_rating, self_did_well: a.self_did_well,
    self_improve: a.self_improve, self_focus: a.self_focus, self_submitted_at: a.self_submitted_at,
    self_draft: a.self_draft ?? null, self_draft_saved_at: a.self_draft_saved_at ?? null,
  };
  if (a.status === 'shared' || a.status === 'acknowledged') {
    o.final_rating = a.final_rating; o.outcome = a.outcome;
    o.manager_did_well = a.manager_did_well; o.manager_improve = a.manager_improve; o.manager_focus = a.manager_focus;
    o.shared_at = a.shared_at; o.acknowledged_at = a.acknowledged_at; o.ack_note = a.ack_note;
  }
  return o;
}

// ── Config (self-serve; bands/threshold only for HR/comp) ─────────────────────
async function getAppraisalConfig(url, auth, env) {
  const s = await loadAppraisalSettings(env);
  const out = { appraisal_prompts: s.prompts };
  if (isHr(auth) || canComp(auth)) { out.increment_bands = s.bands; out.pip_rating_threshold = s.pipThreshold; }
  return ok(out);
}

// ── Cycles (HR) ───────────────────────────────────────────────────────────────
async function getAppraisalCycles(url, auth, env) {
  const gate = requireCalibrate(auth); if (gate) return gate;
  const r = await sb(`/rest/v1/appraisal_cycles?select=*&order=appraisal_date.desc&limit=100`, env);
  return ok({ cycles: r.data || [] });
}
async function getAppraisalCycle(url, auth, env) {
  const gate = requireCalibrate(auth); if (gate) return gate;
  const id = url.searchParams.get('id'); if (!id) return err('id required', 400);
  const [cr, ar] = await Promise.all([
    sb(`/rest/v1/appraisal_cycles?id=eq.${id}&select=*&limit=1`, env),
    sb(`/rest/v1/appraisals?cycle_id=eq.${id}&select=status,self_submitted_at,manager_submitted_at,manager_draft_saved_at,final_rating,outcome&limit=2000`, env),
  ]);
  const cycle = cr.data?.[0]; if (!cycle) return err('not_found', 404);
  const a = ar.data || [];
  return ok({
    cycle,
    counts: {
      total: a.length,
      self_done: a.filter(x => x.self_submitted_at).length,
      manager_done: a.filter(x => x.manager_submitted_at).length,
      // drafts that would be stranded if the cycle leaves 'active'
      manager_drafts: a.filter(x => x.manager_draft_saved_at && !x.manager_submitted_at).length,
      finalized: a.filter(x => x.final_rating).length,
      shared: a.filter(x => x.status === 'shared' || x.status === 'acknowledged').length,
      acknowledged: a.filter(x => x.status === 'acknowledged').length,
      pip: a.filter(x => x.outcome === 'pip').length,
    },
  });
}
async function createAppraisalCycle(body, auth, env) {
  const gate = requireCalibrate(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.appraisal_date) return err('appraisal_date required (e.g. an Apr 1 / Oct 1)', 400);
  const ad = d.appraisal_date;
  const row = {
    name: d.name || ('Appraisal ' + ad),
    appraisal_date: ad,
    period_start: d.period_start || isoMinusMonths(ad, 6),
    period_end: d.period_end || isoMinusDays(ad, 1),
    eligibility_cutoff_date: d.eligibility_cutoff_date || isoMinusMonths(ad, 3),
    self_review_due: d.self_review_due || null,
    manager_review_due: d.manager_review_due || null,
    status: 'draft',
    created_by: auth.userId,
  };
  const r = await sb(`/rest/v1/appraisal_cycles`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err('create_failed: ' + JSON.stringify(r.data), 400);
  return ok(r.data?.[0]);
}
async function setCycleStatus(body, auth, env) {
  const gate = requireCalibrate(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.cycle_id || !['draft', 'active', 'calibration', 'closed'].includes(d.status)) return err('cycle_id + valid status required', 400);
  const r = await sb(`/rest/v1/appraisal_cycles?id=eq.${d.cycle_id}`, env, { method: 'PATCH', body: JSON.stringify({ status: d.status, updated_at: nowIso() }) });
  if (!r.ok) return err('update_failed', 400);
  return ok({ cycle_id: d.cycle_id, status: d.status });
}

// ── Enrollment (HR) ────────────────────────────────────────────────────────────
async function getEnrollmentPreview(url, auth, env) {
  const gate = requireCalibrate(auth); if (gate) return gate;
  const cycleId = url.searchParams.get('cycle_id'); if (!cycleId) return err('cycle_id required', 400);
  const cr = await sb(`/rest/v1/appraisal_cycles?id=eq.${cycleId}&select=*&limit=1`, env);
  const cycle = cr.data?.[0]; if (!cycle) return err('cycle not found', 404);
  const [er, ar, existing] = await Promise.all([
    sb(`/rest/v1/employees?status=eq.active&select=id,full_name,date_joined,manager_id&order=full_name.asc&limit=5000`, env),
    sb(`/rest/v1/appraisals?select=employee_id,cycle:cycle_id(appraisal_date)&limit=5000`, env),
    sb(`/rest/v1/appraisals?cycle_id=eq.${cycleId}&select=employee_id&limit=5000`, env),
  ]);
  const emps = er.data || [];
  const empById = new Map(emps.map(e => [e.id, e]));
  const enrolled = new Set((existing.data || []).map(x => x.employee_id));
  const lastByEmp = {};
  for (const a of (ar.data || [])) { const ad = a.cycle?.appraisal_date; if (ad && (!lastByEmp[a.employee_id] || ad > lastByEmp[a.employee_id])) lastByEmp[a.employee_id] = ad; }
  const cutoff = cycle.eligibility_cutoff_date;
  const cands = emps.map(e => {
    let eligibility = 'eligible', flag = null;
    if (!e.date_joined) { eligibility = 'unknown'; flag = 'no join date'; }
    else if (e.date_joined < cutoff) { eligibility = 'eligible'; }
    else {
      eligibility = 'ineligible';
      const days = (new Date(e.date_joined + 'T00:00:00Z') - new Date(cutoff + 'T00:00:00Z')) / 86400000;
      if (days >= 0 && days <= 7) flag = 'borderline';
    }
    const ps = lastByEmp[e.id] || e.date_joined || cycle.period_start;
    const mgr = e.manager_id ? empById.get(e.manager_id) : null;
    return {
      employee_id: e.id, full_name: e.full_name, date_joined: e.date_joined,
      eligibility, flag, already_enrolled: enrolled.has(e.id),
      review_period_start: ps, review_period_end: cycle.appraisal_date,
      review_period_months: periodMonths(ps, cycle.appraisal_date),
      manager_id: e.manager_id, manager_name: mgr ? mgr.full_name : null,
    };
  });
  return ok({ cycle, candidates: cands });
}
async function enrollAppraisalCycle(body, auth, env) {
  const gate = requireCalibrate(auth); if (gate) return gate;
  const d = body.data || body;
  const cycleId = d.cycle_id, ids = Array.isArray(d.employee_ids) ? d.employee_ids : [];
  if (!cycleId || !ids.length) return err('cycle_id and employee_ids[] required', 400);
  const cr = await sb(`/rest/v1/appraisal_cycles?id=eq.${cycleId}&select=*&limit=1`, env);
  const cycle = cr.data?.[0]; if (!cycle) return err('cycle not found', 404);
  const ex = await sb(`/rest/v1/appraisals?cycle_id=eq.${cycleId}&select=employee_id&limit=5000`, env);
  const already = new Set((ex.data || []).map(x => x.employee_id));
  const toAdd = ids.filter(id => !already.has(id));
  if (!toAdd.length) return ok({ enrolled: 0, skipped: ids.length });
  const [er, ar] = await Promise.all([
    sb(`/rest/v1/employees?id=in.(${toAdd.join(',')})&select=id,date_joined,manager_id,job_role_id&limit=5000`, env),
    sb(`/rest/v1/appraisals?select=employee_id,cycle:cycle_id(appraisal_date)&limit=5000`, env),
  ]);
  const emps = er.data || [];
  const lastByEmp = {};
  for (const a of (ar.data || [])) { const ad = a.cycle?.appraisal_date; if (ad && (!lastByEmp[a.employee_id] || ad > lastByEmp[a.employee_id])) lastByEmp[a.employee_id] = ad; }
  const roleIds = [...new Set(emps.map(e => e.job_role_id).filter(Boolean))];
  const kpisByRole = {};
  if (roleIds.length) {
    const kr = await sb(`/rest/v1/role_kpis?job_role_id=in.(${roleIds.join(',')})&active=eq.true&select=id,job_role_id,name,weight,sort_order&order=sort_order.asc&limit=2000`, env);
    for (const k of (kr.data || [])) (kpisByRole[k.job_role_id] ||= []).push(k);
  }
  const rows = emps.map(e => ({
    cycle_id: cycleId, employee_id: e.id, manager_id: e.manager_id || null,
    review_period_start: lastByEmp[e.id] || e.date_joined || cycle.period_start,
    review_period_end: cycle.appraisal_date, status: 'self_review',
  }));
  const ins = await sb(`/rest/v1/appraisals`, env, { method: 'POST', body: JSON.stringify(rows), prefer: 'return=representation' });
  if (!ins.ok) return err('enroll_failed: ' + JSON.stringify(ins.data), 400);
  const created = ins.data || [];
  const kpiRows = [];
  for (const a of created) {
    const e = emps.find(x => x.id === a.employee_id);
    for (const k of ((e && kpisByRole[e.job_role_id]) || [])) kpiRows.push({ appraisal_id: a.id, role_kpi_id: k.id, kpi_name: k.name, weight: k.weight, sort_order: k.sort_order || 0 });
  }
  if (kpiRows.length) await sb(`/rest/v1/appraisal_kpi_ratings`, env, { method: 'POST', body: JSON.stringify(kpiRows), prefer: 'return=minimal' });
  return ok({ enrolled: created.length, kpis: kpiRows.length });
}

// ── Reviews (self-serve, relationship-checked) ─────────────────────────────────
async function submitSelfReview(body, auth, env) {
  const d = body.data || body;
  if (!d.appraisal_id) return err('appraisal_id required', 400);
  const ar = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}&select=*,cycle:cycle_id(status)&limit=1`, env);
  const a = ar.data?.[0]; if (!a) return err('not_found', 404);
  const me = await meOf(auth, env);
  if (!me || me.id !== a.employee_id) return err('forbidden — your own self-review only', 403);
  if (a.cycle?.status !== 'active') return err('cycle is not open for reviews', 422);
  if (a.status === 'shared' || a.status === 'acknowledged') return err('already finalized', 422);
  if (d.draft === true) {
    const r = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}`, env, { method: 'PATCH',
      body: JSON.stringify({ self_draft: reviewDraft(d, 'self'), self_draft_saved_at: nowIso(), updated_at: nowIso() }) });
    if (!r.ok) return err('save_failed: ' + JSON.stringify(r.data), 400);
    return ok({ id: d.appraisal_id, status: a.status, draft: true });
  }
  const patch = {
    self_overall_rating: clampRating(d.self_overall_rating),
    self_did_well: reviewText(d.self_did_well), self_improve: reviewText(d.self_improve), self_focus: reviewText(d.self_focus),
    self_submitted_at: nowIso(), self_draft: null, self_draft_saved_at: null, updated_at: nowIso(),
  };
  if (a.status === 'self_review') patch.status = 'manager_review';
  const r = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err('save_failed: ' + JSON.stringify(r.data), 400);
  await saveKpiRatings(d.appraisal_id, d.kpi_ratings, 'self', env);
  return ok({ id: d.appraisal_id, status: patch.status || a.status });
}
async function submitManagerReview(body, auth, env) {
  const d = body.data || body;
  if (!d.appraisal_id) return err('appraisal_id required', 400);
  const ar = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}&select=*,cycle:cycle_id(status)&limit=1`, env);
  const a = ar.data?.[0]; if (!a) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  if (isOwnAppraisal(edges, auth, a.employee_id)) return err('forbidden — you cannot write the manager review of your own appraisal', 403);
  // Same predicate as getAppraisal's canWriteMgr: the appraisal's own manager, or — only when it has
  // no direct manager — someone up the live chain who is not a super admin.
  const meE = callerEmployee(edges, auth.userId);
  const mayReview = !!meE && (a.manager_id === meE.id || (!a.manager_id && !canCalibrate(auth) && inManagerChain(edges, a.employee_id, meE.id)));
  if (!mayReview) return err('forbidden — only the reviewing manager can write this', 403);
  if (a.cycle?.status !== 'active') return err('cycle is not open for reviews', 422);
  if (a.status === 'shared' || a.status === 'acknowledged') return err('already finalized', 422);
  const pct = parseIncrementPct(d.manager_suggested_increment_pct);
  if (Number.isNaN(pct)) return err('suggested increment must be a % between 0 and 100', 400);
  const bonus = parseMoney(d.manager_suggested_bonus);
  if (Number.isNaN(bonus)) return err('suggested one-time bonus must be a ₹ amount ≥ 0', 400);
  // Internal-only fields (reviewing manager + super admins; never the subject).
  const rec = { manager_comments: reviewText(d.manager_comments), manager_recommendation_note: reviewText(d.manager_recommendation_note) };
  if (d.draft === true) {
    const r = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}`, env, { method: 'PATCH',
      body: JSON.stringify({ manager_draft: { ...reviewDraft(d, 'manager'), suggested_increment_pct: pct, suggested_bonus: bonus,
        comments: rec.manager_comments, recommendation_note: rec.manager_recommendation_note }, manager_draft_saved_at: nowIso(), updated_at: nowIso() }) });
    if (!r.ok) return err('save_failed: ' + JSON.stringify(r.data), 400);
    return ok({ id: d.appraisal_id, status: a.status, draft: true });
  }
  // The manager reviews what the employee wrote — submit waits for the self-review unless a super
  // admin waived it for this appraisal (a draft is always allowed). S396, Afshaan.
  if (!a.self_submitted_at && !a.self_review_waived_at)
    return err('the self-review is not submitted yet — save your review as a draft for now', 422);
  const patch = {
    manager_overall_rating: clampRating(d.manager_overall_rating),
    manager_did_well: reviewText(d.manager_did_well), manager_improve: reviewText(d.manager_improve), manager_focus: reviewText(d.manager_focus),
    manager_suggested_increment_pct: pct, manager_suggested_bonus: bonus, ...rec,
    manager_submitted_at: nowIso(), manager_draft: null, manager_draft_saved_at: null, status: 'calibration', updated_at: nowIso(),
  };
  const r = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err('save_failed: ' + JSON.stringify(r.data), 400);
  await saveKpiRatings(d.appraisal_id, d.kpi_ratings, 'manager', env);
  return ok({ id: d.appraisal_id, status: 'calibration' });
}
async function acknowledgeAppraisal(body, auth, env) {
  const d = body.data || body;
  if (!d.appraisal_id) return err('appraisal_id required', 400);
  const ar = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}&select=employee_id,status&limit=1`, env);
  const a = ar.data?.[0]; if (!a) return err('not_found', 404);
  const me = await meOf(auth, env);
  if (!me || me.id !== a.employee_id) return err('forbidden', 403);
  if (a.status !== 'shared') return err('not yet shared', 422);
  const r = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}`, env, { method: 'PATCH', body: JSON.stringify({ status: 'acknowledged', acknowledged_at: nowIso(), ack_note: d.ack_note ?? null, updated_at: nowIso() }) });
  if (!r.ok) return err('ack_failed', 400);
  return ok({ id: d.appraisal_id, status: 'acknowledged' });
}

// ── Calibration / finalize / share (HR) ────────────────────────────────────────
async function finalizeAppraisal(body, auth, env) {
  const gate = requireCalibrate(auth); if (gate) return gate;
  const d = body.data || body;
  const fr = clampRating(d.final_rating);
  if (!d.appraisal_id || !fr) return err('appraisal_id + final_rating (1-5) required', 400);
  const own = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}&select=employee_id,comp_locked_at&limit=1`, env);
  if (!own.data?.[0]) return err('not_found', 404);
  if (own.data[0].comp_locked_at) return err('compensation is locked in for this appraisal — the final rating can no longer change', 422);
  if (isOwnAppraisal(await loadOrgEdges(env), auth, own.data[0].employee_id)) return err('forbidden — you cannot calibrate your own appraisal', 403);
  const s = await loadAppraisalSettings(env);
  const r = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}`, env, {
    method: 'PATCH', body: JSON.stringify({
      final_rating: fr, calibration_note: d.calibration_note ?? null,
      calibrated_by: auth.userId, calibrated_at: nowIso(),
      outcome: fr <= s.pipThreshold ? 'pip' : 'standard', updated_at: nowIso(),
    }),
  });
  if (!r.ok) return err('finalize_failed: ' + JSON.stringify(r.data), 400);
  return ok({ id: d.appraisal_id, final_rating: fr, outcome: fr <= s.pipThreshold ? 'pip' : 'standard' });
}
async function shareAppraisal(body, auth, env) {
  const gate = requireCalibrate(auth); if (gate) return gate;
  const d = body.data || body;
  const ids = Array.isArray(d.appraisal_ids) ? d.appraisal_ids : (d.appraisal_id ? [d.appraisal_id] : []);
  if (!ids.length) return err('appraisal_id or appraisal_ids[] required', 400);
  const meE = callerEmployee(await loadOrgEdges(env), auth.userId);
  const notOwn = meE ? `&employee_id=neq.${meE.id}` : '';   // HR never releases their own result
  const r = await sb(`/rest/v1/appraisals?id=in.(${ids.join(',')})&final_rating=not.is.null&status=neq.acknowledged${notOwn}`, env,
    { method: 'PATCH', body: JSON.stringify({ status: 'shared', shared_at: nowIso(), updated_at: nowIso() }), prefer: 'return=representation' });
  if (!r.ok) return err('share_failed: ' + JSON.stringify(r.data), 400);
  return ok({ shared: (r.data || []).length });
}
// ── Calibrated comp → lock-in (super admin + comp allow-list; spec 2026-09-22 §3) ─────────────
function requireCalibrateComp(auth) { return requireCalibrate(auth) || requireComp(auth); }
// Pre-appraisal annual CTC per employee: the latest non-bonus event carrying a new_ctc, ignoring the
// events a lock-in of THESE appraisals wrote — so "before" stays put once a person is locked.
// Returns { [employee_id]: ctc }, or with withComponents { [employee_id]: { ctc, components } }.
async function baseCtcByEmployee(empIds, appraisalIds, env, { withComponents = false } = {}) {
  const out = {};
  if (!empIds.length) return out;
  const skip = new Set(appraisalIds);
  const r = await sb(`/rest/v1/compensation_events?employee_id=in.(${empIds.join(',')})&event_type=neq.one_time_bonus&new_ctc=not.is.null&select=employee_id,new_ctc,components,appraisal_id&order=effective_date.desc,created_at.desc&limit=20000`, env);
  if (!r.ok) throw new Error('db_error reading CTC');
  for (const e of (r.data || [])) {
    if (out[e.employee_id] != null || (e.appraisal_id && skip.has(e.appraisal_id))) continue;
    out[e.employee_id] = withComponents ? { ctc: Number(e.new_ctc), components: e.components || null } : Number(e.new_ctc);
  }
  return out;
}
// The increment event must carry salary components: payouts read monthly_fixed off the latest
// non-bonus event (currentComponentsFor), so a bare increment would drop the person from fixed
// payouts (S396 hostile review). Every numeric component scales by the increment; text fields stay.
function scaleComponents(components, pct) {
  if (!components || typeof components !== 'object') return null;
  const f = 1 + Number(pct) / 100;
  const out = {};
  for (const [k, v] of Object.entries(components)) out[k] = (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v * f * 100) / 100 : v;
  return out;
}
function idList(d) {
  const ids = Array.isArray(d.appraisal_ids) ? d.appraisal_ids : (d.appraisal_id ? [d.appraisal_id] : []);
  return (ids.length && ids.length <= 1000 && ids.every(x => typeof x === 'string' && UUID_RE.test(x))) ? [...new Set(ids)] : null;
}
const newCtc = (base, pct) => (base == null ? null : (pct == null ? base : Math.round(base * (1 + Number(pct) / 100))));

// Calibrated increment % + OTB ₹ — a DRAFT on the appraisal until lock-in. `null` clears a value.
async function saveCalibratedComp(body, auth, env) {
  const gate = requireCalibrateComp(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.appraisal_id) return err('appraisal_id required', 400);
  const pct = parseIncrementPct(d.calibrated_increment_pct);
  if (Number.isNaN(pct)) return err('increment must be a % between 0 and 100', 400);
  const bonus = parseMoney(d.calibrated_bonus);
  if (Number.isNaN(bonus)) return err('one-time bonus must be a ₹ amount ≥ 0', 400);
  const ar = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}&select=employee_id,comp_locked_at&limit=1`, env);
  const a = ar.data?.[0]; if (!a) return err('not_found', 404);
  if (isOwnAppraisal(await loadOrgEdges(env), auth, a.employee_id)) return err('forbidden — you cannot set your own increment', 403);
  if (a.comp_locked_at) return err('already locked in — correct it with a compensation event', 422);
  // comp_locked_at=is.null in the filter: a lock racing this save wins, the save becomes a no-op.
  const r = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}&comp_locked_at=is.null`, env, { method: 'PATCH', prefer: 'return=representation',
    body: JSON.stringify({ calibrated_increment_pct: pct, calibrated_bonus: bonus, updated_at: nowIso() }) });
  if (!r.ok) return err('save_failed: ' + JSON.stringify(r.data), 400);
  if (!(r.data || []).length) return err('already locked in', 422);
  return ok({ id: d.appraisal_id, calibrated_increment_pct: pct, calibrated_bonus: bonus });
}

// Accept = copy the manager's recommendation into the calibrated values, for one or many unlocked
// appraisals. One PATCH per distinct (pct, bonus) pair, not per row.
async function acceptManagerRecommendation(body, auth, env) {
  const gate = requireCalibrateComp(auth); if (gate) return gate;
  const d = body.data || body;
  const ids = idList(d);
  if (!ids) return err('appraisal_id or appraisal_ids[] (uuids) required', 400);
  const meE = callerEmployee(await loadOrgEdges(env), auth.userId);
  const ar = await sb(`/rest/v1/appraisals?id=in.(${ids.join(',')})&comp_locked_at=is.null&manager_submitted_at=not.is.null&select=id,employee_id,manager_suggested_increment_pct,manager_suggested_bonus&limit=2000`, env);
  const groups = {};
  for (const a of (ar.data || [])) {
    if (meE && a.employee_id === meE.id) continue;   // never your own
    if (a.manager_suggested_increment_pct == null && a.manager_suggested_bonus == null) continue;
    const k = `${a.manager_suggested_increment_pct ?? ''}|${a.manager_suggested_bonus ?? ''}`;
    (groups[k] ||= { pct: a.manager_suggested_increment_pct, bonus: a.manager_suggested_bonus, ids: [] }).ids.push(a.id);
  }
  let accepted = 0;
  for (const g of Object.values(groups)) {
    const r = await sb(`/rest/v1/appraisals?id=in.(${g.ids.join(',')})&comp_locked_at=is.null`, env, { method: 'PATCH', prefer: 'return=representation',
      body: JSON.stringify({ calibrated_increment_pct: g.pct, calibrated_bonus: g.bonus, updated_at: nowIso() }) });
    if (!r.ok) return err('accept_failed: ' + JSON.stringify(r.data), 400);
    accepted += (r.data || []).length;
  }
  return ok({ accepted, skipped: ids.length - accepted });
}

// Lock in = the permanent write. For each appraisal (all / a selection / one): an `increment` event
// (old → new CTC) when the calibrated % > 0 and a `one_time_bonus` event when the OTB > 0, both
// effective on the cycle's appraisal date and tied by appraisal_id; then comp_locked_at is stamped.
// Needs a final rating; an increment needs a CTC on record. The lock is CLAIMED first (conditional
// PATCH) so two clicks can't double-write; a failed insert releases the claim.
async function lockAppraisalComp(body, auth, env) {
  const gate = requireCalibrateComp(auth); if (gate) return gate;
  const d = body.data || body;
  const ids = idList(d);
  if (!ids) return err('appraisal_id or appraisal_ids[] (uuids) required', 400);
  const meE = callerEmployee(await loadOrgEdges(env), auth.userId);
  const ar = await sb(`/rest/v1/appraisals?id=in.(${ids.join(',')})&select=id,employee_id,final_rating,calibrated_increment_pct,calibrated_bonus,comp_locked_at,employee:employee_id(full_name),cycle:cycle_id(name,appraisal_date)&limit=2000`, env);
  if (!ar.ok) return err('db_error', 500);
  const rows = ar.data || [];
  const sr = await sb(`/rest/v1/settings?id=eq.1&select=comp_vault_enabled&limit=1`, env);
  const vaultOn = !!sr.data?.[0]?.comp_vault_enabled;
  const base = await baseCtcByEmployee([...new Set(rows.map(a => a.employee_id))], rows.map(a => a.id), env, { withComponents: true });
  const skipped = [];
  const ready = [];
  for (const a of rows) {
    const name = a.employee?.full_name || a.id;
    const pct = a.calibrated_increment_pct == null ? null : Number(a.calibrated_increment_pct);
    if (meE && a.employee_id === meE.id) skipped.push({ id: a.id, name, reason: 'your own appraisal' });
    else if (a.comp_locked_at) skipped.push({ id: a.id, name, reason: 'already locked' });
    else if (!a.final_rating) skipped.push({ id: a.id, name, reason: 'no final rating yet' });
    else if (pct == null && a.calibrated_bonus == null) skipped.push({ id: a.id, name, reason: 'no calibrated increment / bonus' });
    else if (vaultOn && pct > 0 && base[a.employee_id] == null) skipped.push({ id: a.id, name, reason: 'no current CTC on record' });
    else ready.push(a.id);
  }
  for (const id of ids) if (!rows.some(a => a.id === id)) skipped.push({ id, name: id, reason: 'not found' });
  if (!ready.length) return ok({ locked: 0, events: 0, skipped });
  const stamp = nowIso();
  const claim = await sb(`/rest/v1/appraisals?id=in.(${ready.join(',')})&comp_locked_at=is.null&final_rating=not.is.null`, env, { method: 'PATCH', prefer: 'return=representation',
    body: JSON.stringify({ comp_locked_at: stamp, comp_locked_by: auth.userId, updated_at: stamp }) });
  if (!claim.ok) return err('lock_failed: ' + JSON.stringify(claim.data), 400);
  const claimed = claim.data || [];   // post-claim values = the values locked
  const byId = Object.fromEntries(rows.map(a => [a.id, a]));
  const events = [];
  for (const c of claimed) {
    const a = byId[c.id];
    const pct = c.calibrated_increment_pct == null ? null : Number(c.calibrated_increment_pct);
    const bonus = c.calibrated_bonus == null ? null : Number(c.calibrated_bonus);
    // Every row carries the same keys — PostgREST rejects a bulk insert whose objects differ (PGRST102).
    const common = { employee_id: c.employee_id, effective_date: a.cycle?.appraisal_date, currency: 'INR', appraisal_id: c.id,
      reason: `Appraisal — ${a.cycle?.name || ''}`.trim(), approved_by: auth.userId, created_by: auth.userId,
      old_ctc: null, new_ctc: null, components: null };
    if (pct != null && pct > 0) {
      const b = base[c.employee_id] || null;
      events.push({ ...common, event_type: 'increment', increment_pct: pct, amount: null,
        ...(vaultOn && b ? { old_ctc: b.ctc, new_ctc: newCtc(b.ctc, pct), components: scaleComponents(b.components, pct) } : {}) });
    }
    if (bonus != null && bonus > 0) events.push({ ...common, event_type: 'one_time_bonus', increment_pct: null, amount: bonus });
  }
  if (events.length) {
    const ins = await sb(`/rest/v1/compensation_events`, env, { method: 'POST', body: JSON.stringify(events), prefer: 'return=minimal' });
    if (!ins.ok) {
      const rb = await sb(`/rest/v1/appraisals?id=in.(${claimed.map(c => c.id).join(',')})&comp_locked_at=eq.${encodeURIComponent(stamp)}`, env,
        { method: 'PATCH', body: JSON.stringify({ comp_locked_at: null, comp_locked_by: null }) });
      return err(`lock_failed — no compensation written${rb.ok ? '' : `; the lock flag could NOT be released on ${claimed.length} appraisal(s), clear comp_locked_at = ${stamp}`}: ` + JSON.stringify(ins.data), 400);
    }
  }
  for (const id of ready) if (!claimed.some(c => c.id === id)) skipped.push({ id, name: byId[id]?.employee?.full_name || id, reason: 'locked by someone else just now' });
  return ok({ locked: claimed.length, events: events.length, skipped });
}

// A super admin lets the reviewing manager submit without the self-review (one appraisal).
async function waiveSelfReview(body, auth, env) {
  const gate = requireCalibrate(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.appraisal_id) return err('appraisal_id required', 400);
  const waive = d.waived !== false;
  const r = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}`, env, { method: 'PATCH', prefer: 'return=representation',
    body: JSON.stringify(waive ? { self_review_waived_at: nowIso(), self_review_waived_by: auth.userId, updated_at: nowIso() }
                               : { self_review_waived_at: null, self_review_waived_by: null, updated_at: nowIso() }) });
  if (!r.ok) return err('waive_failed: ' + JSON.stringify(r.data), 400);
  if (!(r.data || []).length) return err('not_found', 404);
  return ok({ id: d.appraisal_id, waived: waive });
}

async function setCycleBudget(body, auth, env) {
  const gate = requireCalibrateComp(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.cycle_id) return err('cycle_id required', 400);
  const type = d.budget_type == null || d.budget_type === '' ? null : d.budget_type;
  if (type != null && !['pct', 'amount'].includes(type)) return err("budget_type must be 'pct' or 'amount'", 400);
  const value = parseMoney(d.budget_value);
  if (Number.isNaN(value) || (type === 'pct' && value != null && value > 100)) return err('budget must be a % (0–100) or a ₹ amount ≥ 0', 400);
  const r = await sb(`/rest/v1/appraisal_cycles?id=eq.${d.cycle_id}`, env, { method: 'PATCH', prefer: 'return=representation',
    body: JSON.stringify({ budget_type: type, budget_value: type ? value : null, updated_at: nowIso() }) });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  if (!(r.data || []).length) return err('not_found', 404);
  return ok({ cycle_id: d.cycle_id, budget_type: type, budget_value: type ? value : null });
}

// The cycle overview (spec §1): every enrolled person with their manager + department, review
// progress, current CTC and calibrated comp, plus company-level totals against the cycle budget.
// Totals include every row (a budget has to); rows keep the own-appraisal mask.
async function getCycleOverview(url, auth, env) {
  const gate = requireCalibrate(auth); if (gate) return gate;
  const cycleId = url.searchParams.get('cycle_id'); if (!cycleId) return err('cycle_id required', 400);
  const compOk = canComp(auth);
  const [cr, ar] = await Promise.all([
    sb(`/rest/v1/appraisal_cycles?id=eq.${cycleId}&select=*&limit=1`, env),
    sb(`/rest/v1/appraisals?cycle_id=eq.${cycleId}&select=id,employee_id,manager_id,status,self_overall_rating,self_submitted_at,self_draft_saved_at,self_review_waived_at,manager_overall_rating,manager_submitted_at,manager_draft_saved_at,manager_suggested_increment_pct,manager_suggested_bonus,final_rating,outcome,calibrated_increment_pct,calibrated_bonus,comp_locked_at,shared_at,employee:employee_id(full_name,job_title,employee_code,department:department_id(name)),manager:manager_id(full_name)&order=created_at.asc&limit=2000`, env),
  ]);
  const cycle = cr.data?.[0]; if (!cycle) return err('not_found', 404);
  const all = ar.data || [];
  const meE = callerEmployee(await loadOrgEdges(env), auth.userId);
  const base = compOk ? await baseCtcByEmployee([...new Set(all.map(a => a.employee_id))], all.map(a => a.id), env) : {};
  if (compOk) await logCompAccess(auth, 'getCycleOverview', null, cycle.name, env, { cycle_id: cycleId, employees: all.length });
  const n = (v) => (v == null ? null : Number(v));
  const counts = {
    enrolled: all.length,
    self_done: all.filter(a => a.self_submitted_at).length,
    self_waived: all.filter(a => !a.self_submitted_at && a.self_review_waived_at).length,
    manager_done: all.filter(a => a.manager_submitted_at).length,
    manager_drafts: all.filter(a => a.manager_draft_saved_at && !a.manager_submitted_at).length,
    calibrated: all.filter(a => a.final_rating).length,
    comp_set: all.filter(a => a.calibrated_increment_pct != null || a.calibrated_bonus != null).length,
    locked: all.filter(a => a.comp_locked_at).length,
    shared: all.filter(a => a.status === 'shared' || a.status === 'acknowledged').length,
    pip: all.filter(a => a.outcome === 'pip').length,
  };
  let comp = null;
  if (compOk) {
    let before = 0, after = 0, otb = 0, recAfter = 0, recOtb = 0, withCtc = 0, pctSum = 0, pctN = 0;
    for (const a of all) {
      if (meE && a.employee_id === meE.id) continue;   // your own comp stays out of your totals
      const b = base[a.employee_id];
      const pct = n(a.calibrated_increment_pct), recPct = n(a.manager_suggested_increment_pct);
      if (pct != null) { pctSum += pct; pctN++; }
      otb += n(a.calibrated_bonus) || 0;
      recOtb += n(a.manager_suggested_bonus) || 0;
      if (b == null) continue;
      withCtc++; before += b; after += newCtc(b, pct); recAfter += newCtc(b, recPct);
    }
    const budgetAmount = cycle.budget_type === 'pct' ? Math.round(before * Number(cycle.budget_value || 0) / 100)
      : cycle.budget_type === 'amount' ? Number(cycle.budget_value || 0) : null;
    const used = (after - before) + otb;
    const counted = all.filter(a => !(meE && a.employee_id === meE.id)).length;
    comp = {
      excludes_own: counted !== all.length,
      with_ctc: withCtc, missing_ctc: counted - withCtc,
      ctc_before: before, ctc_after: after, increment_cost: after - before, otb_total: otb,
      avg_increment_pct: pctN ? Math.round(pctSum / pctN * 100) / 100 : null, increment_count: pctN,
      weighted_increment_pct: before ? Math.round((after - before) / before * 10000) / 100 : null,
      recommended: { increment_cost: recAfter - before, otb_total: recOtb },
      budget: { type: cycle.budget_type || null, value: n(cycle.budget_value), amount: budgetAmount, used,
                remaining: budgetAmount == null ? null : budgetAmount - used },
    };
  }
  const rows = all.map(a => {
    const row = maskOwnAppraisal({ ...a, department: a.employee?.department?.name || null }, meE);
    if (compOk) { row.current_ctc = base[a.employee_id] ?? null; row.new_ctc = row._own ? null : newCtc(row.current_ctc, row.calibrated_increment_pct); }
    return row;
  });
  return ok({ cycle, counts, comp, appraisals: rows, can_comp: compOk });
}

// ── Reads: subject / manager / HR views ────────────────────────────────────────
async function getMyAppraisals(url, auth, env) {
  const me = await meOf(auth, env);
  // Open cycles are returned even to an unlinked login, so /reviews can say "no cycle open"
  // vs "you have nothing in this cycle" truthfully.
  const cr = await sb(`/rest/v1/appraisal_cycles?status=eq.active&select=id,name,appraisal_date,period_start,period_end,self_review_due,manager_review_due&order=appraisal_date.desc&limit=20`, env);
  const active_cycles = cr.data || [];
  if (!me) return ok({ employee_id: null, active_cycles, appraisals: [], to_review: [] });
  const [ar, tr] = await Promise.all([
    sb(`/rest/v1/appraisals?employee_id=eq.${me.id}&select=*,cycle:cycle_id(id,name,appraisal_date,period_end,status,self_review_due)&order=created_at.desc&limit=200`, env),
    sb(`/rest/v1/appraisals?manager_id=eq.${me.id}&select=id,status,self_submitted_at,self_review_waived_at,manager_submitted_at,manager_draft_saved_at,employee:employee_id(full_name,job_title),cycle:cycle_id(id,name,status,manager_review_due)&order=created_at.desc&limit=300`, env),
  ]);
  const appraisals = (ar.data || []).map(projectAppraisalForSubject);
  const to_review = (tr.data || []).filter(a => a.cycle?.status === 'active')
    .map(a => ({ id: a.id, employee: a.employee, status: a.status, self_submitted: !!a.self_submitted_at, self_waived: !a.self_submitted_at && !!a.self_review_waived_at,
                 done: !!a.manager_submitted_at, manager_submitted_at: a.manager_submitted_at,
                 draft_saved_at: a.manager_draft_saved_at, cycle: a.cycle }));
  return ok({ employee_id: me.id, active_cycles, appraisals, to_review });
}
async function getTeamAppraisals(url, auth, env) {
  const me = await meOf(auth, env);
  const hr = canCalibrate(auth);   // the all-appraisals list is super-admin only (S396)
  if (!me && !hr) return ok({ appraisals: [] });
  const cycleId = url.searchParams.get('cycle_id');
  let filter = cycleId ? `cycle_id=eq.${cycleId}` : `cycle_id=not.is.null`;
  if (!hr) filter += `&manager_id=eq.${me.id}`;
  const ar = await sb(`/rest/v1/appraisals?${filter}&select=id,employee_id,status,self_submitted_at,manager_submitted_at,final_rating,outcome,employee:employee_id(full_name,job_title),cycle:cycle_id(name,status)&order=created_at.desc&limit=500`, env);
  return ok({ appraisals: (ar.data || []).map(a => maskOwnAppraisal(a, me)) });
}
async function getAppraisal(url, auth, env) {
  const id = url.searchParams.get('id'); if (!id) return err('id required', 400);
  const ar = await sb(`/rest/v1/appraisals?id=eq.${id}&select=*,cycle:cycle_id(*),employee:employee_id(id,full_name,job_title,department:department_id(name)),manager:manager_id(id,full_name)&limit=1`, env);
  const a = ar.data?.[0]; if (!a) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  // Role is decided PER APPRAISAL, not per user (S396): your own appraisal is always the
  // subject view — even for an admin — and a report's is the manager view (with the HR tools
  // alongside when you are also HR). Before this, admin/HR got the read-only HR view
  // everywhere, so admins could neither self-review nor write their reports' manager reviews.
  const isSubject = !!(me && me.id === a.employee_id);
  const hr = canCalibrate(auth);   // the HR/calibration view is super-admin only (S396)
  // Manager = the appraisal's own manager, or (non-super-admin only) someone up the live chain. A
  // super admin above the direct manager stays on the calibration view — a skip-level submit would
  // overwrite the direct manager's review and close their task (hostile review S396).
  const isDirect = !isSubject && !!me && a.manager_id === me.id;
  const isChain = !isSubject && !!me && !isDirect && !hr && inManagerChain(edges, a.employee_id, me.id);
  const isMgr = isDirect || isChain;
  // Only the reviewing manager writes (and sees the draft + suggestion): the direct manager, or a
  // chain manager when the appraisal has no direct manager. Any other skip-level reads the
  // submitted review only (hostile review S396: one manager_draft column, one writer).
  const canWriteMgr = isDirect || (isChain && !a.manager_id);
  if (!isSubject && !isMgr && !hr) return err('forbidden', 403);
  const kr = await sb(`/rest/v1/appraisal_kpi_ratings?appraisal_id=eq.${id}&select=*&order=sort_order.asc`, env);
  const kpis = kr.data || [];
  // OKR surfacing (read-only, Phase 4): the subject's individual objectives for the OKR
  // cycle anchored to THIS appraisal's date. The reviewer (subject/chain-mgr/HR) already
  // has ≥ individual-OKR visibility, so no extra gate. Never weighted into the rating.
  const okrs = await subjectOkrsForAnchor(a.employee_id, a.cycle?.appraisal_date, env);
  let increment = null;
  const compView = hr && canComp(auth);
  if (isSubject || compView) {
    // A lock-in writes up to two events (increment + one_time_bonus); present them as one.
    const cr = await sb(`/rest/v1/compensation_events?appraisal_id=eq.${id}&select=increment_pct,amount,currency,effective_date,event_type,old_ctc,new_ctc&order=created_at.desc&limit=10`, env);
    const evs = cr.data || [];
    if (evs.length) {
      const inc = evs.find(e => e.event_type !== 'one_time_bonus');
      const otb = evs.find(e => e.event_type === 'one_time_bonus');
      increment = { increment_pct: inc?.increment_pct ?? null, amount: otb?.amount ?? inc?.amount ?? null,
        currency: (inc || otb).currency, effective_date: (inc || otb).effective_date, event_type: (inc || otb).event_type };
      if (compView) { increment.old_ctc = inc?.old_ctc ?? null; increment.new_ctc = inc?.new_ctc ?? null; }
    }
    if (isSubject && !(a.status === 'shared' || a.status === 'acknowledged')) increment = null;
  }
  if (!isSubject && (hr || isMgr)) {
    const out = stripDrafts({ ...a, kpis, okrs, increment, _role: isMgr ? 'manager' : 'hr', _can_calibrate: hr, _can_comp: compView,
      _can_write_manager: canWriteMgr }, { keepManager: canWriteMgr });
    if (!hr) { // super-admin-internal
      out.calibration_note = null; out.calibrated_increment_pct = null; out.calibrated_bonus = null;
    }
    if (!hr && !canWriteMgr) {  // the recommendation + internal comments: its author and super admins only
      out.manager_suggested_increment_pct = null; out.manager_suggested_bonus = null;
      out.manager_recommendation_note = null; out.manager_comments = null;
    }
    if (compView) {
      await logCompAccess(auth, 'getAppraisal', a.employee_id, a.employee?.full_name || null, env);
      out.current_ctc = (await baseCtcByEmployee([a.employee_id], [a.id], env))[a.employee_id] ?? null;
    }
    return ok(out);
  }
  // subject
  const out = projectAppraisalForSubject(a);
  out._role = 'subject';
  out.okrs = okrs;
  out.increment = increment;
  out.kpis = kpis.map(k => ({ id: k.id, kpi_name: k.kpi_name, weight: k.weight, self_rating: k.self_rating, manager_rating: (a.status === 'shared' || a.status === 'acknowledged') ? k.manager_rating : null }));
  return ok(out);
}
async function getAppraisals(url, auth, env) {
  const gate = requireCalibrate(auth); if (gate) return gate;
  const cycleId = url.searchParams.get('cycle_id'); if (!cycleId) return err('cycle_id required', 400);
  const compOk = canComp(auth);
  const [cr, ar] = await Promise.all([
    sb(`/rest/v1/appraisal_cycles?id=eq.${cycleId}&select=*&limit=1`, env),
    sb(`/rest/v1/appraisals?cycle_id=eq.${cycleId}&select=*,employee:employee_id(full_name,job_title,department:department_id(name)),manager:manager_id(full_name)&order=created_at.desc&limit=2000`, env),
  ]);
  const cycle = cr.data?.[0];
  const s = await loadAppraisalSettings(env);
  const meE = callerEmployee(await loadOrgEdges(env), auth.userId);
  const rows = (ar.data || []).map(a => {
    const months = periodMonths(a.review_period_start, a.review_period_end);
    const row = { ...a, review_period_months: months, suggested_pct: compOk ? suggestedPct(s.bands, a.final_rating || a.manager_overall_rating, months) : null };
    return maskOwnAppraisal(stripDrafts(row), meE);
  });
  return ok({ cycle, appraisals: rows, increment_bands: compOk ? s.bands : null, pip_rating_threshold: s.pipThreshold });
}

// ────────────────────────────────────────────────────────────────────────────
// DISPATCH
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// FACTORY COST MODULE (compensation-tier) — source of truth for the cost engine.
// Salaries live ONLY here + are rendered ONLY in the Podium admin UI. The Redline
// cost views read aggregates from Postgres RPCs, never these raw rows.
// ────────────────────────────────────────────────────────────────────────────
// requireComp(auth) (defined above) returns an err Response for non-comp users, else null.

// public-schema read (operators live in public). Service-role, no schema profile.
async function sbPublicGet(path, env) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  const text = await res.text(); let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function getFactoryWorkforce(url, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  await logCompAccess(auth, 'getFactoryWorkforce', null, 'all factory operators', env);
  const ops   = (await sbPublicGet(`/rest/v1/operators?select=id,employee_id,name,department,status&status=eq.active&order=department,name`, env)).data || [];
  const wf    = (await sb(`/rest/v1/factory_workforce?select=*`, env)).data || [];
  const pay   = (await sb(`/rest/v1/factory_pay?select=operator_id,effective_from,monthly_ctc&order=effective_from.desc`, env)).data || [];
  const ranks = (await sb(`/rest/v1/factory_ranks?select=*&order=sort_order`, env)).data || [];
  const wfBy = {}; for (const w of (wf || [])) wfBy[w.operator_id] = w;
  const curPay = {}; for (const p of (pay || [])) if (!curPay[p.operator_id]) curPay[p.operator_id] = p; // latest
  const rows = (Array.isArray(ops) ? ops : []).map(o => ({
    id: o.id, employee_id: o.employee_id, name: o.name, department: o.department, status: o.status,
    factory: wfBy[o.id] || null,
    current_ctc: curPay[o.id]?.monthly_ctc ?? null,
    current_ctc_from: curPay[o.id]?.effective_from ?? null,
  }));
  return ok({ operators: rows, ranks: ranks || [] });
}

async function getFactoryCostInputs(url, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  const r     = await sb(`/rest/v1/factory_cost_inputs?select=*&order=kind,label,effective_from.desc`, env);
  const rates = await sb(`/rest/v1/factory_ot_rates?select=*&order=effective_from.desc`, env);
  return ok({ cost_inputs: r.data || [], ot_rates: rates.data || [] });
}

async function setFactoryWorkforce(body, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  const d = body.data || body;
  if (!d.operator_id) return err('operator_id required');
  const row = {
    operator_id: d.operator_id,
    rank_id: d.rank_id || null,
    employment_type: d.employment_type === 'contract' ? 'contract' : 'in_house',
    active: d.active !== false,
    updated_at: new Date().toISOString(),
  };
  const r = await sb(`/rest/v1/factory_workforce?on_conflict=operator_id`, env, {
    method: 'POST', body: JSON.stringify(row),
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  });
  if (!r.ok) return err('workforce upsert failed: ' + JSON.stringify(r.data));
  return ok(Array.isArray(r.data) ? r.data[0] : r.data);
}

async function setFactoryPay(body, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  const d = body.data || body;
  if (!d.operator_id || d.monthly_ctc == null || !d.effective_from) return err('operator_id, monthly_ctc, effective_from required');
  const r = await sb(`/rest/v1/factory_pay`, env, {
    method: 'POST',
    body: JSON.stringify({ operator_id: d.operator_id, effective_from: d.effective_from, monthly_ctc: Number(d.monthly_ctc), note: d.note || null, created_by: auth.userId || null }),
  });
  if (!r.ok) return err('pay insert failed: ' + JSON.stringify(r.data));
  return ok(Array.isArray(r.data) ? r.data[0] : r.data);
}

async function bulkUploadFactoryPay(body, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  const d = body.data || body;
  const rows = Array.isArray(d.rows) ? d.rows : [];
  if (!rows.length) return err('rows required');
  const ops = (await sbPublicGet(`/rest/v1/operators?select=id,employee_id,name`, env)).data || [];
  const byEmp = {}, byName = {};
  for (const o of (Array.isArray(ops) ? ops : [])) {
    if (o.employee_id) byEmp[String(o.employee_id).trim().toLowerCase()] = o.id;
    if (o.name) byName[String(o.name).trim().toLowerCase()] = o.id;
  }
  const eff = d.effective_from || (new Date().toISOString().slice(0, 8) + '01');
  const payRows = [], wfRows = [], unmatched = []; let matched = 0;
  for (const r of rows) {
    const opId = byEmp[String(r.employee_id || '').trim().toLowerCase()] || byName[String(r.name || '').trim().toLowerCase()] || null;
    if (!opId || r.monthly_ctc == null || isNaN(Number(r.monthly_ctc))) { unmatched.push(r); continue; }
    matched++;
    payRows.push({ operator_id: opId, effective_from: r.effective_from || eff, monthly_ctc: Number(r.monthly_ctc), note: 'bulk upload', created_by: auth.userId || null });
    wfRows.push({ operator_id: opId, employment_type: r.employment_type === 'contract' ? 'contract' : 'in_house', active: true, updated_at: new Date().toISOString() });
  }
  if (wfRows.length) await sb(`/rest/v1/factory_workforce?on_conflict=operator_id`, env, { method: 'POST', body: JSON.stringify(wfRows), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  if (payRows.length) { const pr = await sb(`/rest/v1/factory_pay`, env, { method: 'POST', body: JSON.stringify(payRows), prefer: 'return=minimal' }); if (!pr.ok) return err('pay bulk insert failed: ' + JSON.stringify(pr.data)); }
  return ok({ inserted: payRows.length, matched, unmatched });
}

async function setFactoryCostInput(body, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  const d = body.data || body;
  const KINDS = ['rent', 'electricity', 'other', 'admin', 'security'];
  if (!KINDS.includes(d.kind) || !d.label || d.monthly_amount == null || !d.effective_from) return err('kind(valid), label, monthly_amount, effective_from required');
  const r = await sb(`/rest/v1/factory_cost_inputs`, env, {
    method: 'POST',
    body: JSON.stringify({ kind: d.kind, label: d.label, effective_from: d.effective_from, monthly_amount: Number(d.monthly_amount), is_estimated: !!d.is_estimated, note: d.note || null, created_by: auth.userId || null }),
  });
  if (!r.ok) return err('cost input insert failed: ' + JSON.stringify(r.data));
  return ok(Array.isArray(r.data) ? r.data[0] : r.data);
}

async function setFactoryOtRates(body, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  const d = body.data || body;
  if (d.in_house_per_hour == null || d.contract_per_hour == null || !d.effective_from) return err('in_house_per_hour, contract_per_hour, effective_from required');
  const r = await sb(`/rest/v1/factory_ot_rates`, env, {
    method: 'POST',
    body: JSON.stringify({ effective_from: d.effective_from, in_house_per_hour: Number(d.in_house_per_hour), contract_per_hour: Number(d.contract_per_hour) }),
  });
  if (!r.ok) return err('ot rate insert failed: ' + JSON.stringify(r.data));
  return ok(Array.isArray(r.data) ? r.data[0] : r.data);
}

// ── Phase 6 — Analytics (aggregate-only; math lives in podium.f_analytics_*) ──
// Org + Perf are HR/admin surfaces. Comp is allow-list-gated (RULE-PODIUM-002:
// the allow-list is THE salary gate) and audited — it is a cross-person comp
// read even though only aggregates are returned.

function clampInt(v, def, min, max) {
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : def;
}

async function getAnalyticsOrg(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const months = clampInt(url.searchParams.get('months'), 12, 1, 36);
  const r = await sb(`/rest/v1/rpc/f_analytics_org`, env, {
    method: 'POST', body: JSON.stringify({ p_months: months }),
  });
  if (!r.ok) return err('db_error', 500);
  return ok(r.data);
}

async function getAnalyticsComp(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const months = clampInt(url.searchParams.get('months'), 12, 1, 36);
  await logCompAccess(auth, 'getAnalyticsComp', null, 'comp aggregates', env, { months });
  const r = await sb(`/rest/v1/rpc/f_analytics_comp`, env, {
    method: 'POST', body: JSON.stringify({ p_months: months }),
  });
  if (!r.ok) return err('db_error', 500);
  return ok(r.data);
}

async function getAnalyticsPerf(url, auth, env) {
  // Rating distribution / PIP counts include unshared calibration results → super admins only (S396).
  const gate = requireCalibrate(auth); if (gate) return gate;
  const cycles = clampInt(url.searchParams.get('cycles'), 4, 1, 10);
  const r = await sb(`/rest/v1/rpc/f_analytics_perf`, env, {
    method: 'POST', body: JSON.stringify({ p_cycles: cycles }),
  });
  if (!r.ok) return err('db_error', 500);
  return ok(r.data);
}

// ── Payouts ledger — period + component helpers ──────────────────────────────
// FY = Apr 1 – Mar 31. Half 1 = Apr–Sep, Half 2 = Oct–Mar. Monthly key 'YYYY-MM';
// half key 'FYaa-bb-H1|H2' (e.g. 'FY26-27-H1').
function periodMeta(key) {
  if (/^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day of month m
    return { period_type: 'monthly', period_start: `${key}-01`, period_end: end };
  }
  const hm = /^FY(\d{2})-(\d{2})-H([12])$/.exec(key);
  if (hm) {
    const sy = 2000 + Number(hm[1]);
    return Number(hm[3]) === 1
      ? { period_type: 'half_yearly', period_start: `${sy}-04-01`, period_end: `${sy}-09-30` }
      : { period_type: 'half_yearly', period_start: `${sy}-10-01`, period_end: `${sy + 1}-03-31` };
  }
  return { period_type: 'one_time', period_start: null, period_end: null };
}

// Latest non-bonus CTC components per employee id → { <empId>: componentsJsonb }.
// Batched (single query, IN filter) — no per-row awaits.
async function currentComponentsFor(empIds, env) {
  if (!empIds.length) return {};
  const r = await sb(
    `/rest/v1/compensation_events?employee_id=in.(${empIds.join(',')})&event_type=neq.one_time_bonus` +
    `&select=employee_id,components,effective_date,created_at&order=effective_date.desc,created_at.desc`,
    env,
  );
  const out = {};
  for (const row of (r.ok ? r.data || [] : [])) if (!out[row.employee_id]) out[row.employee_id] = row.components || {};
  return out;
}

// ── Payouts ledger — reads (comp = cross-person + audited; self = own-only) ───
const PAYOUT_ORDER = 'order=period_start.desc.nullslast,paid_on.desc.nullslast,created_at.desc';

async function getPayouts(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
  await logCompAccess(auth, 'getPayouts', employee_id, null, env);
  const r = await sb(`/rest/v1/payouts?employee_id=eq.${employee_id}&select=*&${PAYOUT_ORDER}`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ payouts: r.data || [] });
}

async function getMyPayouts(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return ok({ employee_id: null, payouts: [] });
  const r = await sb(`/rest/v1/payouts?employee_id=eq.${me.id}&select=*&${PAYOUT_ORDER}`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ employee_id: me.id, payouts: r.data || [] });
}

// The entry grid: every active employee for a period+type, with a defaulted target
// (from current CTC components) and any existing row. Comp-gated + audited.
async function getPayoutPeriodSheet(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const period_key = url.searchParams.get('period_key');
  const payout_type = url.searchParams.get('payout_type') || 'fixed';
  if (!period_key) return err('period_key required', 400);
  const meta = periodMeta(period_key);
  await logCompAccess(auth, 'getPayoutPeriodSheet', null, `${payout_type} ${period_key}`, env);
  const er = await sb(`/rest/v1/employees?status=neq.exited&select=id,employee_code,full_name,department:department_id(name)&order=full_name.asc`, env);
  const emps = er.ok ? (er.data || []) : [];
  const comps = await currentComponentsFor(emps.map(e => e.id), env);
  const xr = await sb(`/rest/v1/payouts?period_key=eq.${encodeURIComponent(period_key)}&payout_type=eq.${payout_type}&select=*`, env);
  const existing = {}; for (const row of (xr.ok ? xr.data || [] : [])) existing[row.employee_id] = row;
  const rows = emps.map(e => {
    const c = comps[e.id] || {};
    let target = null;
    if (payout_type === 'fixed') target = c.monthly_fixed ?? null;
    else if (payout_type === 'variable') {
      if (meta.period_type === 'monthly') target = c.monthly_variable ?? null;
      else if (meta.period_type === 'half_yearly') target = c.variable_yearly != null ? Number(c.variable_yearly) / 2 : null;
    }
    return {
      employee_id: e.id, employee_code: e.employee_code, full_name: e.full_name,
      department: e.department?.name || null, bonus_type: c.bonus_type || null,
      default_target: target != null ? Number(target) : null,
      existing: existing[e.id] || null,
    };
  });
  return ok({ period_key, period_type: meta.period_type, payout_type, rows });
}

// Vendor / bulk payouts (e.g. contract-labour agency) — not tied to an employee.
async function getBulkPayouts(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const period_key = url.searchParams.get('period_key');
  await logCompAccess(auth, 'getBulkPayouts', null, period_key || 'all', env);
  let q = `/rest/v1/payouts?payee_type=eq.vendor&select=*&${PAYOUT_ORDER}`;
  if (period_key) q += `&period_key=eq.${encodeURIComponent(period_key)}`;
  const r = await sb(q, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ payouts: r.data || [] });
}

// ── RazorpayX Payroll actuals feed (comp-gated + audited) ────────────────────
// Map RazorpayX employees ↔ Podium employees by work_email (Fraternitas white-collar).
// Side-effect: persists newly-resolved razorpayx_employee_id onto the Podium row so
// later syncs resolve directly. Returns matched + both-sided unmatched for review.
// Cursored id-scan of RazorpayX payroll for a month. This API has no list endpoint, so
// we walk sequential employee-ids; view-payroll returns name + amounts in one call. Each
// hit is resolved to a Podium employee (persisted id first, else unique normalized-name
// match). The client keeps calling with next_start until trailing_misses hits its stop
// threshold, rate_limited flips, or the id cap is reached. ≤~45 subreqs/call (chunk + 1
// roster read). Comp-gated + audited. On the first chunk (start<=1) the Podium roster is
// returned for the modal's manual-map dropdown + no-payroll diff.
async function getRazorpayxPayrollScan(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  if (!razorpayxConfigured(env)) return err('razorpayx_not_configured', 400);
  const month = url.searchParams.get('month');
  if (!/^\d{4}-\d{2}$/.test(month || '')) return err('month required (YYYY-MM)', 400);
  const start = intParam(url, 'start', 1, { min: 1 });
  const span = intParam(url, 'span', 40, { min: 1, max: 45 });
  await logCompAccess(auth, 'getRazorpayxPayrollScan', null, `${month} ids ${start}..${start + span - 1}`, env);

  // Leavers stay matchable for the months they were still paid: a backfill of Apr–Jul must be
  // able to map someone who has since exited (S396 — July had 3 leavers the roster could not show).
  const er = await sb(`/rest/v1/employees?or=(status.neq.exited,date_exited.gte.${month}-01)&select=id,employee_code,full_name,razorpayx_employee_id&order=full_name.asc`, env);
  if (!er.ok) return err('db_error', 500);
  const emps = er.data || [];
  const byPersistedId = new Map();
  const byName = new Map();          // normName -> employee | 'AMBIGUOUS'
  for (const e of emps) {
    if (e.razorpayx_employee_id) byPersistedId.set(String(e.razorpayx_employee_id), e);
    const k = normName(e.full_name);
    if (k) byName.set(k, byName.has(k) ? 'AMBIGUOUS' : e);
  }

  const rows = [];
  let trailingMisses = 0, rateLimited = false, lastHit = null;
  for (let i = start; i < start + span; i++) {
    const p = await razorpayxViewPayroll(env, i, month);
    if (p.rate_limited) { rateLimited = true; break; }
    if (!p.ok) { trailingMisses++; continue; }
    trailingMisses = 0; lastHit = i;
    const persisted = byPersistedId.get(String(i));
    let e = persisted || null, method = persisted ? 'persisted' : 'none';
    if (!e) { const nm = byName.get(normName(p.name)); if (nm === 'AMBIGUOUS') method = 'ambiguous'; else if (nm) { e = nm; method = 'name'; } }
    rows.push({
      razorpayx_employee_id: String(i), name: p.name, gross: p.gross,
      employee_id: e?.id || null, employee_code: e?.employee_code || null, full_name: e?.full_name || null,
      match_method: method,
    });
  }
  const out = {
    month, scanned_from: start, scanned_to: start + span - 1, next_start: start + span,
    rows, trailing_misses: trailingMisses, last_hit: lastHit, rate_limited: rateLimited,
  };
  if (start <= 1) out.roster = emps.map(e => ({ employee_id: e.id, employee_code: e.employee_code, full_name: e.full_name }));
  return ok(out);
}

// ── Payouts ledger — writes (comp-gated) ─────────────────────────────────────
async function upsertPayouts(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const d = body.data || body;
  const inRows = Array.isArray(d.rows) ? d.rows : [];
  if (!inRows.length) return err('rows required', 400);
  const clean = [];
  for (const r of inRows) {
    const isVendor = r.payee_type === 'vendor';
    if (!r.payout_type || r.amount == null || isNaN(Number(r.amount))) continue;
    if (isVendor ? !r.payee_label : !r.employee_id) continue; // vendor needs a label, employee needs an id
    const key = r.period_key || null;
    const meta = key ? periodMeta(key)
      : { period_type: r.period_type || 'one_time', period_start: r.period_start || null, period_end: r.period_end || null };
    clean.push({
      ...(r.id ? { id: r.id } : {}),
      employee_id: isVendor ? null : r.employee_id,
      payee_type: isVendor ? 'vendor' : 'employee',
      payee_label: isVendor ? r.payee_label : null,
      payout_type: r.payout_type,
      period_type: meta.period_type,
      period_key: key,
      period_start: meta.period_start,
      period_end: meta.period_end,
      target_amount: r.target_amount != null ? Number(r.target_amount) : null,
      achievement_pct: r.achievement_pct != null ? Number(r.achievement_pct) : null,
      amount: Number(r.amount),
      currency: r.currency || 'INR',
      paid_on: r.paid_on || null,
      note: r.note || null,
      source: r.source || 'manual',
      created_by: auth.userId || null,
      updated_at: nowIso(),
    });
  }
  if (!clean.length) return err('no valid rows', 400);
  // Only per-EMPLOYEE periodic rows dedup via the unique index. Vendor rows (null
  // employee_id) + ad-hoc rows are plain inserts (delete+re-add to correct).
  const periodic = clean.filter(r => r.employee_id && r.period_key);
  const rest = clean.filter(r => !(r.employee_id && r.period_key));
  let saved = 0;
  if (periodic.length) {
    const r = await sb(`/rest/v1/payouts?on_conflict=employee_id,payout_type,period_key`, env, {
      method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify(periodic),
    });
    if (!r.ok) return err('upsert_failed: ' + JSON.stringify(r.data), 400);
    saved += periodic.length;
  }
  if (rest.length) {
    const r = await sb(`/rest/v1/payouts`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rest) });
    if (!r.ok) return err('insert_failed: ' + JSON.stringify(r.data), 400);
    saved += rest.length;
  }
  await logCompAccess(auth, 'upsertPayouts', null, `${saved} rows`, env);
  return ok({ saved });
}

// Write confirmed RazorpayX gross amounts into the payouts ledger. One 'fixed' row
// per employee-month; source='razorpayx' supersedes autogen/manual via the unique
// index (employee_id,payout_type,period_key). Comp-gated + audited.
async function applyRazorpayxPayouts(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const d = body.data || body;
  const month = d.month;
  const inRows = Array.isArray(d.rows) ? d.rows : [];
  if (!/^\d{4}-\d{2}$/.test(month || '')) return err('month required (YYYY-MM)', 400);
  if (!inRows.length) return err('rows required', 400);

  const meta = periodMeta(month);   // { period_type:'monthly', period_start, period_end }
  const clean = [];
  const idMap = [];                  // {id, razorpayx_employee_id} to persist the mapping
  for (const r of inRows) {
    if (!r.employee_id || r.amount == null || isNaN(Number(r.amount))) continue;
    clean.push({
      employee_id: r.employee_id,
      payee_type: 'employee',
      payout_type: 'fixed',
      period_type: meta.period_type,
      period_key: month,
      period_start: meta.period_start,
      period_end: meta.period_end,
      amount: Number(r.amount),
      currency: 'INR',
      paid_on: r.paid_on || null,
      source: 'razorpayx',
      source_ref: r.source_ref || (r.razorpayx_employee_id ? `rzp:${r.razorpayx_employee_id}:${month}` : null),
      created_by: auth.userId || null,
      updated_at: nowIso(),
    });
    if (r.razorpayx_employee_id) idMap.push({ id: r.employee_id, razorpayx_employee_id: String(r.razorpayx_employee_id) });
  }
  if (!clean.length) return err('no valid rows', 400);

  const w = await sb(`/rest/v1/payouts?on_conflict=employee_id,payout_type,period_key`, env, {
    method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify(clean),
  });
  if (!w.ok) return err('upsert_failed: ' + JSON.stringify(w.data), 400);

  // Persist the confirmed RazorpayX id -> Podium employee mapping (best-effort; next
  // month resolves by persisted id, no name-match needed).
  // PATCH per row: an upsert POST of {id, razorpayx_employee_id} is an INSERT first and fails
  // employees' NOT NULL columns, so the S393 run persisted none of its 21 mappings.
  let idsPersisted = 0;
  for (const m of idMap) {
    try {
      // The id is UNIQUE: release it from anyone else first (a corrected override must win).
      await sb(`/rest/v1/employees?razorpayx_employee_id=eq.${encodeURIComponent(m.razorpayx_employee_id)}&id=neq.${encodeURIComponent(m.id)}`, env, {
        method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ razorpayx_employee_id: null }),
      });
      const u = await sb(`/rest/v1/employees?id=eq.${encodeURIComponent(m.id)}`, env, {
        method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ razorpayx_employee_id: m.razorpayx_employee_id }),
      });
      if (u.ok) idsPersisted++;
    } catch (_e) { /* mapping re-derives from name next run; never block the write */ }
  }
  await logCompAccess(auth, 'applyRazorpayxPayouts', null, `${month}: ${clean.length} rows`, env);
  return ok({ month, saved: clean.length, ids_persisted: idsPersisted });
}

// Auto-create a month's FIXED rows for active staff from current monthly_fixed.
// Idempotent — skips employees who already have a fixed row for the month.
async function generateFixedPayouts(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const d = body.data || body;
  const period_key = d.period_key;
  if (!period_key || !/^\d{4}-\d{2}$/.test(period_key)) return err('period_key (YYYY-MM) required', 400);
  const meta = periodMeta(period_key);
  const er = await sb(`/rest/v1/employees?status=neq.exited&select=id`, env);
  const emps = er.ok ? (er.data || []) : [];
  const comps = await currentComponentsFor(emps.map(e => e.id), env);
  const xr = await sb(`/rest/v1/payouts?period_key=eq.${encodeURIComponent(period_key)}&payout_type=eq.fixed&select=employee_id`, env);
  const have = new Set((xr.ok ? xr.data || [] : []).map(r => r.employee_id));
  const rows = [];
  for (const e of emps) {
    if (have.has(e.id)) continue;
    const mf = comps[e.id]?.monthly_fixed;
    if (mf == null) continue;
    rows.push({
      employee_id: e.id, payout_type: 'fixed', period_type: 'monthly', period_key,
      period_start: meta.period_start, period_end: meta.period_end,
      target_amount: Number(mf), amount: Number(mf), currency: 'INR',
      source: 'fixed_autogen', created_by: auth.userId || null,
    });
  }
  if (rows.length) {
    const r = await sb(`/rest/v1/payouts`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
    if (!r.ok) return err('generate_failed: ' + JSON.stringify(r.data), 400);
  }
  await logCompAccess(auth, 'generateFixedPayouts', null, `${period_key}: +${rows.length}`, env);
  return ok({ created: rows.length, skipped: have.size });
}

async function deletePayout(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const r = await sb(`/rest/v1/payouts?id=eq.${encodeURIComponent(d.id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err('delete_failed', 400);
  await logCompAccess(auth, 'deletePayout', null, d.id, env);
  return ok({ deleted: d.id });
}

// ── Salary-access allow-list (super_admin only: exactly Afshaan + Vinay) ──────
// Controls who is in podium.comp_access, i.e. who can see EVERYONE's salary.
// Edit-right derives from store.users_profile.role='super_admin', never from
// comp_access membership, so a super_admin can't lock themselves out.
async function getCompAccess(url, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const r = await sb(`/rest/v1/comp_access?select=*&order=added_at.asc`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ members: r.data || [] });
}

async function addCompAccess(body, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.auth_user_id) return err('auth_user_id required', 400);
  const prof = await sbStore(`/rest/v1/users_profile?id=eq.${encodeURIComponent(d.auth_user_id)}&select=full_name&limit=1`, env);
  const fullName = (prof.ok && prof.data?.[0]?.full_name) || d.full_name || null;
  const r = await sb(`/rest/v1/comp_access?on_conflict=auth_user_id`, env, {
    method: 'POST', prefer: 'return=representation,resolution=merge-duplicates',
    body: JSON.stringify({ auth_user_id: d.auth_user_id, full_name: fullName, added_by: auth.userId, note: d.note || null }),
  });
  if (!r.ok) return err('add_failed: ' + JSON.stringify(r.data), 400);
  await logCompAccess(auth, 'addCompAccess', null, fullName, env, { added: d.auth_user_id });
  return ok({ auth_user_id: d.auth_user_id, full_name: fullName });
}

async function removeCompAccess(body, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.auth_user_id) return err('auth_user_id required', 400);
  const r = await sb(`/rest/v1/comp_access?auth_user_id=eq.${encodeURIComponent(d.auth_user_id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err('remove_failed', 400);
  await logCompAccess(auth, 'removeCompAccess', null, d.full_name || null, env, { removed: d.auth_user_id });
  return ok({ removed: d.auth_user_id });
}

async function getCompAccessLog(url, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const limit = intParam(url, 'limit', 200, { min: 1, max: 1000 });
  const r = await sb(`/rest/v1/comp_access_log?select=*&order=at.desc&limit=${limit}`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ log: r.data || [] });
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 4 — OKRs (objectives / key results / check-ins)
// 6-monthly cycles anchored to appraisal dates; company→dept→individual cascade;
// auto-progress + manual final grade; individual-OKR visibility = self + manager
// chain + HR (conservative). No new perm key. RULE-PODIUM-009.
// Spec: docs/superpowers/specs/2026-07-10-podium-okr-engine-design.md
// ────────────────────────────────────────────────────────────────────────────

// Alignment must point UP: individual→dept/company, dept→company, company→none.
function okrAlignmentOk(childLevel, parentLevel) {
  const rank = { company: 0, department: 1, individual: 2 };
  return rank[parentLevel] < rank[childLevel];
}

// Can the caller SEE objective row O? company/dept = org-visible; individual = self/chain/HR.
function canSeeObjectiveRow(hr, me, edges, o) {
  if (o.level !== 'individual') return true;
  if (hr) return true;
  if (!me) return false;
  return inManagerChain(edges, o.owner_employee_id, me.id); // self OR ancestor manager
}

// Can the caller author/edit/grade objective row O? (sync — needs precomputed headed-dept set)
//  company → HR; department → HR OR dept head; individual → HR OR owner OR ancestor manager.
function objEditableRow(hr, me, edges, headedDeptIds, o) {
  if (hr) return true;
  if (!me) return false;
  if (o.level === 'company') return false;
  if (o.level === 'department') return !!(o.department_id && headedDeptIds.has(o.department_id));
  return me.id === o.owner_employee_id || inManagerChain(edges, o.owner_employee_id, me.id);
}

// Async authorship check for a single objective (POST writers). Fetches the dept head.
async function canAuthorObjective(auth, edges, obj, env) {
  if (isHr(auth)) return true;
  const me = callerEmployee(edges, auth.userId);
  if (!me) return false;
  if (obj.level === 'company') return false;
  if (obj.level === 'department') {
    if (!obj.department_id) return false;
    const dr = await sb(`/rest/v1/departments?id=eq.${obj.department_id}&select=head_employee_id&limit=1`, env);
    return dr.data?.[0]?.head_employee_id === me.id;
  }
  if (!obj.owner_employee_id) return false;
  return me.id === obj.owner_employee_id || inManagerChain(edges, obj.owner_employee_id, me.id);
}

// Which department ids does this employee head? (for objEditableRow in cycle reads)
async function headedDeptIdsOf(empId, env) {
  if (!empId) return new Set();
  const dr = await sb(`/rest/v1/departments?head_employee_id=eq.${empId}&select=id&limit=200`, env);
  return new Set((dr.data || []).map(d => d.id));
}

// ── Reads ─────────────────────────────────────────────────────────────────────
async function getOkrConfig(url, auth, env) {
  const r = await sb(`/rest/v1/okr_cycles?select=id,name,anchor_date,period_start,period_end,status&order=anchor_date.desc,created_at.desc&limit=100`, env);
  const cycles = r.data || [];
  const hr = isHr(auth);
  const visible = hr ? cycles : cycles.filter(c => c.status !== 'draft');
  return ok({ cycles: visible, current: visible[0] || null, can_admin: hr });
}

async function getOkrCycle(url, auth, env) {
  const id = url.searchParams.get('id') || url.searchParams.get('cycle_id');
  if (!id) return err('id required', 400);
  const r = await sb(`/rest/v1/rpc/f_okr_cycle`, env, { method: 'POST', body: JSON.stringify({ p_cycle_id: id }) });
  if (!r.ok) return err('load_failed: ' + JSON.stringify(r.data), 400);
  const doc = r.data;
  if (!doc || !doc.cycle) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const hr = isHr(auth);
  const headedDeptIds = await headedDeptIdsOf(me?.id, env);
  const st = doc.cycle.status;
  const objectives = (doc.objectives || [])
    .filter(o => canSeeObjectiveRow(hr, me, edges, o))
    .map(o => {
      const canEdit = objEditableRow(hr, me, edges, headedDeptIds, o);
      return { ...o, _can_edit: canEdit, _can_grade: canEdit && (st === 'scoring' || st === 'closed') };
    });
  return ok({ cycle: doc.cycle, objectives, can_admin: hr });
}

async function getObjective(url, auth, env) {
  const id = url.searchParams.get('id'); if (!id) return err('id required', 400);
  const or = await sb(`/rest/v1/objectives?id=eq.${id}&select=*,cycle:cycle_id(id,name,status,anchor_date)&limit=1`, env);
  const obj = or.data?.[0]; if (!obj) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const hr = isHr(auth);
  if (!canSeeObjectiveRow(hr, me, edges, obj)) return err('forbidden', 403);
  // Scores from the canonical RPC (find this objective in the assembled cycle doc).
  const cr = await sb(`/rest/v1/rpc/f_okr_cycle`, env, { method: 'POST', body: JSON.stringify({ p_cycle_id: obj.cycle_id }) });
  const scored = ((cr.ok && cr.data?.objectives) || []).find(o => o.id === id) || null;
  const krs = scored?.key_results || [];
  const krIds = krs.map(k => k.id);
  let checkins = [];
  if (krIds.length) {
    const ch = await sb(`/rest/v1/okr_checkins?key_result_id=in.(${krIds.join(',')})&select=*,author:author_employee_id(full_name)&order=created_at.desc&limit=500`, env);
    checkins = ch.data || [];
  }
  const headedDeptIds = await headedDeptIdsOf(me?.id, env);
  const canEdit = objEditableRow(hr, me, edges, headedDeptIds, obj);
  const st = obj.cycle?.status;
  return ok({
    objective: scored ? { ...scored, cycle: obj.cycle } : obj,
    checkins,
    _can_edit: canEdit,
    _can_grade: canEdit && (st === 'scoring' || st === 'closed'),
  });
}

// Read-only OKR surfacing for the appraisal detail: a subject's INDIVIDUAL objectives for
// the OKR cycle anchored to `anchorDate` (the appraisal date). Returns [] when no cycle.
async function subjectOkrsForAnchor(employeeId, anchorDate, env) {
  if (!employeeId || !anchorDate) return [];
  const c = await sb(`/rest/v1/okr_cycles?anchor_date=eq.${anchorDate}&select=id&order=created_at.desc&limit=1`, env);
  const cyc = c.data?.[0]; if (!cyc) return [];
  const doc = await sb(`/rest/v1/rpc/f_okr_cycle`, env, { method: 'POST', body: JSON.stringify({ p_cycle_id: cyc.id }) });
  const objs = (doc.ok && doc.data?.objectives) || [];
  return objs
    .filter(o => o.level === 'individual' && o.owner_employee_id === employeeId)
    .map(o => ({
      id: o.id, title: o.title,
      displayed_score: o.displayed_score, final_score: o.final_score,
      final_confidence: o.final_confidence, reflection_note: o.reflection_note,
      key_results: (o.key_results || []).map(k => ({
        title: k.title, kr_score: k.kr_score, current_value: k.current_value,
        target_value: k.target_value, unit: k.unit,
      })),
    }));
}

// Latest non-draft cycle (the "current" one everyone works in).
async function currentOkrCycle(env) {
  const r = await sb(`/rest/v1/okr_cycles?status=neq.draft&select=id,name,anchor_date,period_start,period_end,status&order=anchor_date.desc,created_at.desc&limit=1`, env);
  return r.data?.[0] || null;
}

async function getMyOkrs(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return ok({ employee_id: null, cycle: null, my_objectives: [], surfaced: [] });
  const cycle = await currentOkrCycle(env);
  if (!cycle) return ok({ employee_id: me.id, cycle: null, my_objectives: [], surfaced: [] });
  const doc = await sb(`/rest/v1/rpc/f_okr_cycle`, env, { method: 'POST', body: JSON.stringify({ p_cycle_id: cycle.id }) });
  const objs = (doc.ok && doc.data?.objectives) || [];
  const my_objectives = objs.filter(o => o.level === 'individual' && o.owner_employee_id === me.id)
    .map(o => ({ ...o, _can_edit: true, _can_grade: cycle.status === 'scoring' || cycle.status === 'closed' }));
  const surfaced = objs.filter(o => o.level === 'company' || o.level === 'department');
  return ok({ employee_id: me.id, cycle, my_objectives, surfaced });
}

async function getTeamOkrs(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const hr = isHr(auth);
  if (!me && !hr) return ok({ cycle: null, objectives: [] });
  const cycle = await currentOkrCycle(env);
  if (!cycle) return ok({ cycle: null, objectives: [] });
  const doc = await sb(`/rest/v1/rpc/f_okr_cycle`, env, { method: 'POST', body: JSON.stringify({ p_cycle_id: cycle.id }) });
  const objs = (doc.ok && doc.data?.objectives) || [];
  let scope; // null = all (HR, no filter)
  if (hr) {
    const rootId = url.searchParams.get('employee_id');
    scope = rootId ? descendantsOf(edges, rootId) : null;
  } else {
    scope = descendantsOf(edges, me.id);
  }
  const team = objs.filter(o => o.level === 'individual' && o.owner_employee_id
    && (scope === null || scope.has(o.owner_employee_id)));
  return ok({ cycle, objectives: team });
}

// ── Cycle admin (HR) ────────────────────────────────────────────────────────
async function createOkrCycle(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.anchor_date) return err('anchor_date required (an Apr 1 / Oct 1)', 400);
  const ad = d.anchor_date;
  const row = {
    name: d.name || ('OKRs ' + ad),
    anchor_date: ad,
    period_start: d.period_start || isoMinusMonths(ad, 6),
    period_end: d.period_end || isoMinusDays(ad, 1),
    status: 'draft',
    created_by: auth.userId,
  };
  const r = await sb(`/rest/v1/okr_cycles`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err('create_failed: ' + JSON.stringify(r.data), 400);
  return ok(r.data?.[0]);
}
async function updateOkrCycle(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.cycle_id) return err('cycle_id required', 400);
  const patch = { updated_at: nowIso() };
  for (const k of ['name', 'anchor_date', 'period_start', 'period_end']) if (k in d) patch[k] = d[k];
  const r = await sb(`/rest/v1/okr_cycles?id=eq.${d.cycle_id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err('update_failed', 400);
  return ok(r.data?.[0]);
}
async function setOkrCycleStatus(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.cycle_id || !['draft', 'active', 'scoring', 'closed'].includes(d.status)) return err('cycle_id + valid status required', 400);
  const r = await sb(`/rest/v1/okr_cycles?id=eq.${d.cycle_id}`, env, { method: 'PATCH', body: JSON.stringify({ status: d.status, updated_at: nowIso() }) });
  if (!r.ok) return err('update_failed', 400);
  return ok({ cycle_id: d.cycle_id, status: d.status });
}
async function deleteOkrCycle(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.cycle_id) return err('cycle_id required', 400);
  if (!d.confirm) {
    const oc = await sb(`/rest/v1/objectives?cycle_id=eq.${d.cycle_id}&select=id&limit=1`, env);
    if (oc.data?.length) return err('cycle_has_objectives — pass confirm:true to delete it and all its objectives', 409);
  }
  const r = await sb(`/rest/v1/okr_cycles?id=eq.${d.cycle_id}`, env, { method: 'DELETE' });
  if (!r.ok) return err('delete_failed', 400);
  return ok({ deleted: d.cycle_id });
}

// ── Objectives ────────────────────────────────────────────────────────────────
async function createObjective(body, auth, env) {
  const d = body.data || body;
  if (!d.cycle_id || !d.level || !d.title) return err('cycle_id, level, title required', 400);
  if (!['company', 'department', 'individual'].includes(d.level)) return err('bad level', 400);
  if (d.level === 'department' && !d.department_id) return err('department_id required for a department objective', 400);
  if (d.level === 'individual' && !d.owner_employee_id) return err('owner_employee_id required for an individual objective', 400);
  const edges = await loadOrgEdges(env);
  if (!(await canAuthorObjective(auth, edges, { level: d.level, department_id: d.department_id, owner_employee_id: d.owner_employee_id }, env))) return err('forbidden', 403);
  if (d.parent_objective_id) {
    const pr = await sb(`/rest/v1/objectives?id=eq.${d.parent_objective_id}&select=level,cycle_id&limit=1`, env);
    const parent = pr.data?.[0];
    if (!parent) return err('parent objective not found', 400);
    if (parent.cycle_id !== d.cycle_id) return err('parent objective must be in the same cycle', 400);
    if (!okrAlignmentOk(d.level, parent.level)) return err('alignment must point up (individual→dept/company, dept→company)', 400);
  }
  const row = {
    cycle_id: d.cycle_id, level: d.level,
    owner_employee_id: d.owner_employee_id || null,
    department_id: d.level === 'department' ? d.department_id : null,
    parent_objective_id: d.parent_objective_id || null,
    title: d.title, description: d.description || null,
    sort_order: Number.isFinite(d.sort_order) ? Math.round(d.sort_order) : 0,
    created_by: auth.userId,
  };
  const r = await sb(`/rest/v1/objectives`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err('create_failed: ' + JSON.stringify(r.data), 400);
  return ok(r.data?.[0]);
}
async function updateObjective(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const or = await sb(`/rest/v1/objectives?id=eq.${d.id}&select=*&limit=1`, env);
  const obj = or.data?.[0]; if (!obj) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  if (!(await canAuthorObjective(auth, edges, obj, env))) return err('forbidden', 403);
  const patch = { updated_at: nowIso() };
  if ('title' in d) patch.title = d.title;
  if ('description' in d) patch.description = d.description;
  if ('status' in d && ['active', 'closed'].includes(d.status)) patch.status = d.status;
  if ('sort_order' in d) patch.sort_order = Math.round(Number(d.sort_order) || 0);
  if ('owner_employee_id' in d && obj.level === 'individual') patch.owner_employee_id = d.owner_employee_id;
  if ('parent_objective_id' in d) {
    if (d.parent_objective_id) {
      if (d.parent_objective_id === d.id) return err('objective cannot be its own parent', 400);
      const pr = await sb(`/rest/v1/objectives?id=eq.${d.parent_objective_id}&select=level,cycle_id&limit=1`, env);
      const parent = pr.data?.[0];
      if (!parent || parent.cycle_id !== obj.cycle_id || !okrAlignmentOk(obj.level, parent.level)) return err('invalid parent alignment', 400);
    }
    patch.parent_objective_id = d.parent_objective_id || null;
  }
  const r = await sb(`/rest/v1/objectives?id=eq.${d.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  return ok(r.data?.[0]);
}
async function deleteObjective(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const or = await sb(`/rest/v1/objectives?id=eq.${d.id}&select=*&limit=1`, env);
  const obj = or.data?.[0]; if (!obj) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  if (!(await canAuthorObjective(auth, edges, obj, env))) return err('forbidden', 403);
  const r = await sb(`/rest/v1/objectives?id=eq.${d.id}`, env, { method: 'DELETE' });
  if (!r.ok) return err('delete_failed', 400);
  return ok({ deleted: d.id });
}

// ── Key results ─────────────────────────────────────────────────────────────
async function createKeyResult(body, auth, env) {
  const d = body.data || body;
  if (!d.objective_id || !d.title || !d.metric_type) return err('objective_id, title, metric_type required', 400);
  if (!['number', 'percentage', 'currency', 'milestone'].includes(d.metric_type)) return err('bad metric_type', 400);
  const or = await sb(`/rest/v1/objectives?id=eq.${d.objective_id}&select=*&limit=1`, env);
  const obj = or.data?.[0]; if (!obj) return err('objective not found', 404);
  const edges = await loadOrgEdges(env);
  if (!(await canAuthorObjective(auth, edges, obj, env))) return err('forbidden', 403);
  const isMilestone = d.metric_type === 'milestone';
  const start = isMilestone ? 0 : (Number(d.start_value) || 0);
  const target = isMilestone ? 1 : Number(d.target_value);
  if (!isMilestone && !Number.isFinite(target)) return err('target_value required', 400);
  const row = {
    objective_id: d.objective_id, title: d.title, metric_type: d.metric_type,
    start_value: start, target_value: target,
    current_value: (d.current_value != null ? Number(d.current_value) : start),
    unit: d.unit || null,
    direction: (d.direction === 'decrease' ? 'decrease' : 'increase'),
    weight: (d.weight != null && Number(d.weight) > 0 ? Number(d.weight) : 1),
    sort_order: Number.isFinite(d.sort_order) ? Math.round(d.sort_order) : 0,
  };
  const r = await sb(`/rest/v1/key_results`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err('create_failed: ' + JSON.stringify(r.data), 400);
  return ok(r.data?.[0]);
}
async function updateKeyResult(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const kr = await sb(`/rest/v1/key_results?id=eq.${d.id}&select=*,objective:objective_id(*)&limit=1`, env);
  const krRow = kr.data?.[0]; if (!krRow) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  if (!(await canAuthorObjective(auth, edges, krRow.objective, env))) return err('forbidden', 403);
  const patch = { updated_at: nowIso() };
  if ('title' in d) patch.title = d.title;
  if ('unit' in d) patch.unit = d.unit || null;
  if ('start_value' in d) patch.start_value = Number(d.start_value) || 0;
  if ('target_value' in d) patch.target_value = Number(d.target_value);
  if ('direction' in d && ['increase', 'decrease'].includes(d.direction)) patch.direction = d.direction;
  if ('weight' in d && Number(d.weight) > 0) patch.weight = Number(d.weight);
  if ('status' in d && ['active', 'closed'].includes(d.status)) patch.status = d.status;
  if ('sort_order' in d) patch.sort_order = Math.round(Number(d.sort_order) || 0);
  const r = await sb(`/rest/v1/key_results?id=eq.${d.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  return ok(r.data?.[0]);
}
async function deleteKeyResult(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const kr = await sb(`/rest/v1/key_results?id=eq.${d.id}&select=id,objective:objective_id(*)&limit=1`, env);
  const krRow = kr.data?.[0]; if (!krRow) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  if (!(await canAuthorObjective(auth, edges, krRow.objective, env))) return err('forbidden', 403);
  const r = await sb(`/rest/v1/key_results?id=eq.${d.id}`, env, { method: 'DELETE' });
  if (!r.ok) return err('delete_failed', 400);
  return ok({ deleted: d.id });
}

// ── Check-ins + grading ───────────────────────────────────────────────────────
async function recordCheckin(body, auth, env) {
  const d = body.data || body;
  if (!d.key_result_id || d.value == null || !d.confidence) return err('key_result_id, value, confidence required', 400);
  if (!['on_track', 'at_risk', 'off_track'].includes(d.confidence)) return err('bad confidence', 400);
  const kr = await sb(`/rest/v1/key_results?id=eq.${d.key_result_id}&select=id,objective:objective_id(*)&limit=1`, env);
  const krRow = kr.data?.[0]; if (!krRow) return err('key_result not found', 404);
  const obj = krRow.objective;
  const cy = await sb(`/rest/v1/okr_cycles?id=eq.${obj.cycle_id}&select=status&limit=1`, env);
  if (cy.data?.[0]?.status === 'closed') return err('cycle_closed', 409);
  const edges = await loadOrgEdges(env);
  if (!(await canAuthorObjective(auth, edges, obj, env))) return err('forbidden', 403);
  const me = callerEmployee(edges, auth.userId);
  const value = Number(d.value);
  if (!Number.isFinite(value)) return err('bad value', 400);
  const ir = await sb(`/rest/v1/okr_checkins`, env, {
    method: 'POST',
    body: JSON.stringify([{ key_result_id: d.key_result_id, author_employee_id: me?.id || null, value, confidence: d.confidence, note: d.note || null }]),
  });
  if (!ir.ok) return err('checkin_failed: ' + JSON.stringify(ir.data), 400);
  // Denormalise the latest value onto the KR (cheap-read mirror; newest check-in is truth).
  await sb(`/rest/v1/key_results?id=eq.${d.key_result_id}`, env, { method: 'PATCH', body: JSON.stringify({ current_value: value, updated_at: nowIso() }) });
  return ok(ir.data?.[0]);
}
async function gradeObjective(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const or = await sb(`/rest/v1/objectives?id=eq.${d.id}&select=*,cycle:cycle_id(status)&limit=1`, env);
  const obj = or.data?.[0]; if (!obj) return err('not_found', 404);
  const st = obj.cycle?.status;
  if (st !== 'scoring' && st !== 'closed') return err('grading allowed only when the cycle is scoring/closed', 409);
  const edges = await loadOrgEdges(env);
  if (!(await canAuthorObjective(auth, edges, obj, env))) return err('forbidden', 403);
  const patch = { updated_at: nowIso() };
  if (d.final_score != null) {
    let s = Number(d.final_score); if (!Number.isFinite(s)) return err('bad final_score', 400);
    patch.final_score = Math.max(0, Math.min(1, s));
  }
  if ('final_confidence' in d) {
    if (d.final_confidence && !['on_track', 'at_risk', 'off_track'].includes(d.final_confidence)) return err('bad final_confidence', 400);
    patch.final_confidence = d.final_confidence || null;
  }
  if ('reflection_note' in d) patch.reflection_note = d.reflection_note || null;
  const r = await sb(`/rest/v1/objectives?id=eq.${d.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err('grade_failed: ' + JSON.stringify(r.data), 400);
  return ok(r.data?.[0]);
}

// ────────────────────────────────────────────────────────────────────────────
// HIRING — C1 openings + C2 candidates / applications / documents.
// Every action is in SELF_SERVE_GET/POST and self-scopes: a manager without a Podium role reaches
// their OWN openings (owner / reporting manager / approver) and nothing else. The permission table
// lives in src/hiring.js (unit-tested). Plan: docs/superpowers/plans/2026-11-11-podium-hiring-c1-c2.md
// Salary numbers (band, current/expected CTC) are never written into application_events. reason = a
// category code; free text (which may quote a number) goes only in detail.note and every read strips it
// for viewers off that opening's salary chain (redactEvent / candidateEventsFor in src/hiring.js).
// ────────────────────────────────────────────────────────────────────────────

function errCode(code, message, status = 400) { return json({ ok: false, error: code, message }, status); }
const isUuid = (x) => typeof x === 'string' && UUID_RE.test(x);
const todayIso = () => nowIso().slice(0, 10);
const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const OPENING_EMBED =
  'department:department_id(id,name),job_role:job_role_id(id,title),reporting_manager:reporting_manager_employee_id(id,employee_code,full_name,job_title),hiring_owner:hiring_owner_employee_id(id,employee_code,full_name,job_title)';

// Founders = active, no manager, users_profile.role = 'super_admin' (EMP-001 / EMP-002 today).
async function loadFounders(env) {
  const er = await sb(`/rest/v1/employees?manager_id=is.null&status=eq.active&auth_user_id=not.is.null&select=id,auth_user_id,employee_code&order=employee_code.asc`, env);
  const rows = er.data || [];
  if (!rows.length) return [];
  const pr = await sbStore(`/rest/v1/users_profile?id=in.(${rows.map(r => r.auth_user_id).join(',')})&role=eq.super_admin&select=id`, env);
  const sa = new Set((pr.data || []).map(p => p.id));
  return rows.filter(r => sa.has(r.auth_user_id)).map(r => r.id);
}

// Append-only timeline, batched. Best-effort like logCompAccess: the write already landed.
async function hiringEvents(env, auth, me, rows) {
  const list = (rows || []).filter(Boolean).map(r => ({
    actor_user_id: auth.userId, actor_employee_id: me?.id || null,
    application_id: null, opening_id: null, candidate_id: null, from_status: null, to_status: null, reason: null, detail: null,
    ...r,
  }));
  if (!list.length) return;
  try { await sb(`/rest/v1/application_events`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(list) }); }
  catch (_e) { /* best-effort */ }
}

// Openings (by id list, or all) + their pending/current budgets + the caller's roles on each.
async function loadOpeningsWithRoles(auth, me, env, { ids = null, extra = '' } = {}) {
  if (ids && !ids.length) return [];
  const idf = ids ? `id=in.(${ids.join(',')})&` : '';
  const or = await sb(`/rest/v1/openings?${idf}${extra}select=*,${OPENING_EMBED}&order=created_at.desc&limit=2000`, env);
  if (!or.ok) throw new Error(`db_error: ${JSON.stringify(or.data)}`);
  const openings = or.data || [];
  if (!openings.length) return [];
  const br = await sb(`/rest/v1/opening_budgets?opening_id=in.(${openings.map(o => o.id).join(',')})&status=in.(pending,approved)&select=*`, env);
  const budgets = br.data || [];
  const byOpening = {};
  for (const b of budgets) (byOpening[b.opening_id] ||= []).push(b);
  return openings.map(o => ({ o, budgets: byOpening[o.id] || [], roles: openingRoles(auth, me, o, byOpening[o.id] || []) }));
}

async function loadOneOpening(auth, me, env, id) {
  if (!isUuid(id)) return null;
  return (await loadOpeningsWithRoles(auth, me, env, { ids: [id] }))[0] || null;
}

// Nav access: podium_hiring, HR, ≥1 active direct report, or a seat on any opening's chain.
async function hiringAccess(auth, me, env) {
  if (hasPerm(auth, 'podium_hiring') || isHr(auth)) return true;
  if (!me) return false;
  const [dr, op, bu] = await Promise.all([
    sb(`/rest/v1/employees?manager_id=eq.${me.id}&status=eq.active&select=id&limit=1`, env),
    sb(`/rest/v1/openings?or=(hiring_owner_employee_id.eq.${me.id},reporting_manager_employee_id.eq.${me.id})&select=id&limit=1`, env),
    sb(`/rest/v1/opening_budgets?approver_employee_id=eq.${me.id}&status=in.(pending,approved)&select=id&limit=1`, env),
  ]);
  return !!(dr.data?.length || op.data?.length || bu.data?.length);
}

// Pickers for the hiring forms. Hiring managers are mostly self-only Podium users (no podium_view),
// so they cannot call getEmployees/getJobRoles/getDepartments. This returns ONLY the directory-public
// subset (name, code, title, department) and role metadata — never bands or salary numbers.
async function getHiringLookups(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  if (!(await hiringAccess(auth, me, env))) return err('forbidden', 403);
  const [er, dr, rr, canCreate] = await Promise.all([
    sb(`/rest/v1/employees?status=neq.exited&select=id,employee_code,full_name,job_title,department_id,status,auth_user_id&order=full_name.asc&limit=2000`, env),
    sb(`/rest/v1/departments?active=eq.true&select=id,name&order=name.asc&limit=500`, env),
    sb(`/rest/v1/job_roles?active=eq.true&select=id,role_code,title,department_id,job_description,salary_band_max&order=title.asc&limit=1000`, env),
    hasPerm(auth, 'podium_hiring') ? Promise.resolve(true) : hasActiveReports(me, env),
  ]);
  if (!er.ok || !dr.ok || !rr.ok) return err('db_error', 500);
  return ok({
    me: me ? { id: me.id } : null,
    can_create: !!canCreate,
    // O2: can_interview = an active employee with a Podium login (the panel rule, D3). The login id stays here.
    employees: (er.data || []).map(({ auth_user_id, status, ...e }) => ({ ...e, can_interview: status === 'active' && !!auth_user_id })),
    departments: dr.data || [],
    job_roles: (rr.data || []).map(r => ({
      id: r.id, role_code: r.role_code, title: r.title, department_id: r.department_id,
      has_jd: !!(r.job_description && String(r.job_description).trim()),
      has_band: r.salary_band_max != null,
    })),
  });
}

async function hasActiveReports(me, env) {
  if (!me) return false;
  const r = await sb(`/rest/v1/employees?manager_id=eq.${me.id}&status=eq.active&select=id&limit=1`, env);
  return !!r.data?.length;
}

function bandOf(b) { return b ? { band_min: numOrNull(b.band_min), band_max: numOrNull(b.band_max) } : null; }
function budgetStatus(x) {
  if (x.budgets.some(b => b.status === 'pending')) return 'pending';
  if (x.o.current_budget_id) return 'approved';
  return 'none';
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function getOpenings(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const status = url.searchParams.get('status');
  const search = (url.searchParams.get('search') || '').trim();
  const f = [];
  if (status && status !== 'all') {
    if (!OPENING_STATUSES.includes(status)) return err('bad status', 400);
    f.push(`status=eq.${status}`);
  }
  if (search) { const s = cleanSearch(search); f.push(`or=(designation.ilike.*${s}*,opening_code.ilike.*${s}*)`); }
  const all = await loadOpeningsWithRoles(auth, me, env, { extra: f.length ? f.join('&') + '&' : '' });
  const visible = all.filter(x => canSeeOpening(x.roles));
  const counts = {};
  if (visible.length) {
    const ar = await sb(`/rest/v1/applications?opening_id=in.(${visible.map(x => x.o.id).join(',')})&select=opening_id,status`, env);
    for (const a of (ar.data || [])) { const c = (counts[a.opening_id] ||= {}); c[a.status] = (c[a.status] || 0) + 1; }
  }
  const rows = visible.map(x => {
    const sal = canSeeSalary(x.roles);
    const cur = x.budgets.find(b => b.id === x.o.current_budget_id);
    const pend = x.budgets.find(b => b.status === 'pending');
    return {
      id: x.o.id, opening_code: x.o.opening_code, designation: x.o.designation, status: x.o.status,
      department: x.o.department, job_role: x.o.job_role,
      reporting_manager: x.o.reporting_manager, hiring_owner: x.o.hiring_owner,
      location_city: x.o.location_city, employment_type: x.o.employment_type,
      headcount: x.o.headcount, target_join_date: x.o.target_join_date, created_at: x.o.created_at,
      has_jd: !!x.o.current_jd_id, budget_status: budgetStatus(x),
      application_counts: counts[x.o.id] || {},
      ...(sal ? { band: bandOf(cur), pending_band: bandOf(pend) } : {}),
      can_see_salary: sal,
    };
  });
  // One audit row per list call that returned any band (RULE-PODIUM-002: every salary-bearing read is logged).
  const banded = rows.filter(r => r.band || r.pending_band);
  if (banded.length) await logCompAccess(auth, 'getOpenings', null, 'list', env, { openings: banded.length });
  return ok({ openings: rows });
}

async function getOpening(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!isUuid(id)) return err('id required', 400);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, id);
  if (!x) return err('not_found', 404);
  if (!canSeeOpening(x.roles)) return err('forbidden', 403);
  const sal = canSeeSalary(x.roles);
  const [jr, br, ar, evr, founders, ofr] = await Promise.all([
    sb(`/rest/v1/opening_jds?opening_id=eq.${id}&select=*&order=version.desc`, env),
    sb(`/rest/v1/opening_budgets?opening_id=eq.${id}&select=*,approver:approver_employee_id(id,full_name),requester:requested_by_employee_id(id,full_name)&order=version.desc`, env),
    sb(`/rest/v1/applications?opening_id=eq.${id}&select=*,candidate:candidate_id(id,candidate_code,full_name)&order=created_at.desc`, env),
    sb(`/rest/v1/application_events?opening_id=eq.${id}&select=*&order=created_at.desc&limit=100`, env),
    loadFounders(env),
    // C3: each application's latest offer revision — status only (no figures) for the candidate rows.
    sb(`/rest/v1/offers?opening_id=eq.${id}&select=application_id,offer_ref,revision,status&order=revision.desc`, env),
  ]);
  // O2: the round plan + a per-application interview line (count, next time, feedback owed — no content).
  const [rounds, ivr] = await Promise.all([
    openingRounds(env, [id]),
    sb(`/rest/v1/interviews?opening_id=eq.${id}&select=id,application_id,status,scheduled_at`, env),
  ]);
  // rowsOf: a failed read (e.g. 0014 not applied yet) is no rows, never a 500.
  const ivRows = rowsOf(ivr);
  const ivPanel = await sbInChunks(env, ivRows.map(i => i.id),
    (ids) => `/rest/v1/interview_panel?interview_id=in.(${ids.join(',')})&select=interview_id,due_at,submitted_at`);
  const ivSummary = interviewSummary(ivRows, ivPanel);
  const latestOffer = {};
  for (const o of (ofr.data || [])) if (!latestOffer[o.application_id]) latestOffer[o.application_id] = o;
  if (!jr.ok || !br.ok || !ar.ok) return err('db_error', 500);
  const jds = jr.data || [];
  // Band numbers AND the free-text decision note are salary-chain only (a note can quote a number).
  const budgets = (br.data || []).map(b => (sal ? { ...b, band_min: numOrNull(b.band_min), band_max: numOrNull(b.band_max) }
    : (({ band_min, band_max, decision_note, ...rest }) => rest)(b)));
  const applications = (ar.data || []).map(a => {
    const base = { id: a.id, candidate: a.candidate, candidate_id: a.candidate_id, status: a.status, source: a.source,
      source_detail: a.source_detail, notice_period_days: a.notice_period_days, outcome_reason: redactReason(a.outcome_reason, sal),
      moved_to_application_id: a.moved_to_application_id, created_at: a.created_at, closed_at: a.closed_at,
      offer: latestOffer[a.id] ? { offer_ref: latestOffer[a.id].offer_ref, revision: latestOffer[a.id].revision, status: latestOffer[a.id].status } : null,
      interviews_summary: ivSummary[a.id] || { count: 0, next_at: null, pending_feedback: 0 } };
    return sal ? { ...base, current_ctc: numOrNull(a.current_ctc), expected_ctc: numOrNull(a.expected_ctc) } : base;
  });
  // Approver: the pending request's snapshot, else who a request made now would go to.
  const pend = (br.data || []).find(b => b.status === 'pending');
  const approverId = pend ? pend.approver_employee_id
    : resolveApprover(edges, founders, x.o.reporting_manager_employee_id, me?.id || null, x.o.hiring_owner_employee_id);
  let approver = pend?.approver || null;
  if (!approver && approverId) {
    const ap = await sb(`/rest/v1/employees?id=eq.${approverId}&select=id,employee_code,full_name,job_title&limit=1`, env);
    approver = ap.data?.[0] || null;
  }
  const showsSalary = sal && (budgets.length > 0 || applications.some(a => a.current_ctc != null || a.expected_ctc != null));
  if (showsSalary) await logCompAccess(auth, 'getOpening', null, x.o.opening_code, env, { opening_id: id });
  const { current_jd_id } = x.o;
  // Same rule decideBand enforces: the snapshotted approver or a founder, never the requester.
  const isFounder = !!auth.isSuperAdmin && !!me && founders.includes(me.id);
  const canDecidePending = !!pend && pend.requested_by !== auth.userId && !checkBandDecider(me?.id || null, isFounder, pend);
  return ok({
    opening: x.o,
    my_roles: { ...x.roles, can_edit: canEditOpening(x.roles), can_manage_apps: canManageApps(x.roles),
      can_see_salary: sal, can_change_chain: canChangeChain(x.roles), is_founder: isFounder },
    can_decide_pending: canDecidePending,
    jd: jds.find(j => j.id === current_jd_id) || null,
    jd_versions: jds,
    budgets,
    applications,
    events: (evr.data || []).map(e => redactEvent(e, sal)),
    approver,
    rounds,
  });
}

async function getJdDownloadUrl(url, auth, env) {
  const jdId = url.searchParams.get('jd_id');
  if (!isUuid(jdId)) return err('jd_id required', 400);
  const jr = await sb(`/rest/v1/opening_jds?id=eq.${jdId}&select=*&limit=1`, env);
  const jd = jr.data?.[0];
  if (!jd) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  const x = await loadOneOpening(auth, callerEmployee(edges, auth.userId), env, jd.opening_id);
  if (!x || !canSeeOpening(x.roles)) return err('forbidden', 403);
  if (!jd.storage_path) return err('no_file', 400);
  return signDownload(jd.storage_path, jd.file_name, jd.mime_type, env);
}

async function signDownload(path, fileName, mime, env) {
  const seg = String(path).split('/').map(encodeURIComponent).join('/');
  const sr = await storageFetch(`/object/sign/${DOC_BUCKET}/${seg}`, env, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 120 }),
  });
  if (!sr.ok || !sr.data?.signedURL) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
  return ok({ url: `${env.SUPABASE_URL}/storage/v1${sr.data.signedURL}`, file_name: fileName, mime_type: mime });
}

async function signUpload(path, env) {
  const sr = await storageFetch(`/object/upload/sign/${DOC_BUCKET}/${path}`, env, { method: 'POST' });
  if (!sr.ok || !sr.data?.url) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
  const tokenMatch = String(sr.data.url).match(/token=([^&]+)/);
  return ok({ storage_path: path, token: tokenMatch ? decodeURIComponent(tokenMatch[1]) : null, signed_url: sr.data.url });
}

// A candidate's openings, with the caller's roles on each. allAccess = HR / podium_hiring.
async function candidateScope(auth, me, env, candidateId) {
  const ar = await sb(`/rest/v1/applications?candidate_id=eq.${candidateId}&select=*&order=created_at.desc`, env);
  if (!ar.ok) throw new Error('db_error');
  const apps = ar.data || [];
  const opIds = [...new Set(apps.map(a => a.opening_id))];
  const ops = await loadOpeningsWithRoles(auth, me, env, { ids: opIds });
  const byId = Object.fromEntries(ops.map(x => [x.o.id, x]));
  const visible = ops.filter(x => canSeeOpening(x.roles));
  const allAccess = isHr(auth) || hasPerm(auth, 'podium_hiring');
  // docCtx feeds canSeeDocRow / candidateEventsFor: a salary doc tied to an application is judged on
  // THAT application's opening only.
  const docCtx = {
    rolesByOpening: Object.fromEntries(visible.map(x => [x.o.id, x.roles])),
    appOpening: Object.fromEntries(apps.map(a => [a.id, a.opening_id])),
    hr: isHr(auth),
  };
  return { apps, byId, visible, rolesList: visible.map(x => x.roles), docCtx, allAccess, canSee: allAccess || visible.length > 0 };
}

async function getCandidates(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const status = url.searchParams.get('status');
  const openingId = url.searchParams.get('opening_id');
  const search = (url.searchParams.get('search') || '').trim();
  if (status && status !== 'all' && !ACTIVE_APP_STATUSES.includes(status) && !TERMINAL_APP_STATUSES.includes(status)) return err('bad status', 400);
  if (openingId && !isUuid(openingId)) return err('bad opening_id', 400);
  const allAccess = isHr(auth) || hasPerm(auth, 'podium_hiring');
  const ops = await loadOpeningsWithRoles(auth, me, env);
  const visible = ops.filter(x => canSeeOpening(x.roles));
  const opById = Object.fromEntries(visible.map(x => [x.o.id, x.o]));
  let opIds = visible.map(x => x.o.id);
  if (openingId) opIds = opIds.filter(i => i === openingId);
  if (!opIds.length && !(allAccess && !openingId && !(status && status !== 'all'))) return ok({ candidates: [] });
  const af = [];
  if (opIds.length) af.push(`opening_id=in.(${opIds.join(',')})`);
  if (status && status !== 'all') af.push(`status=eq.${status}`);
  const ar = opIds.length
    ? await sb(`/rest/v1/applications?${af.join('&')}&select=id,candidate_id,opening_id,status,created_at&order=created_at.desc&limit=5000`, env)
    : { ok: true, data: [] };
  if (!ar.ok) return err('db_error', 500);
  const latest = {};
  for (const a of (ar.data || [])) if (!latest[a.candidate_id]) latest[a.candidate_id] = a; // ordered newest first
  const filtered = !!(openingId || (status && status !== 'all'));
  const cf = [];
  if (!(allAccess && !filtered)) {
    const ids = Object.keys(latest);
    if (!ids.length) return ok({ candidates: [] });
    cf.push(`id=in.(${ids.join(',')})`);
  }
  if (search) { const s = cleanSearch(search); cf.push(`or=(full_name.ilike.*${s}*,email.ilike.*${s}*,phone.ilike.*${s}*,candidate_code.ilike.*${s}*)`); }
  const cr = await sb(`/rest/v1/candidates?${cf.length ? cf.join('&') + '&' : ''}select=id,candidate_code,full_name,email,phone,location,current_title,current_employer,created_at&order=created_at.desc&limit=1000`, env);
  if (!cr.ok) return err('db_error', 500);
  const rows = (cr.data || []).map(c => {
    const a = latest[c.id];
    const o = a ? opById[a.opening_id] : null;
    return { ...c, latest_application: a ? { id: a.id, status: a.status, opening_id: a.opening_id,
      opening_code: o?.opening_code || null, designation: o?.designation || null, created_at: a.created_at } : null };
  });
  return ok({ candidates: rows });
}

async function getCandidate(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!isUuid(id)) return err('id required', 400);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const cr = await sb(`/rest/v1/candidates?id=eq.${id}&select=*&limit=1`, env);
  const cand = cr.data?.[0];
  if (!cand) return err('not_found', 404);
  const sc = await candidateScope(auth, me, env, id);
  if (!sc.canSee) return err('forbidden', 403);
  const visApps = sc.apps.filter(a => canSeeOpening(sc.byId[a.opening_id]?.roles));
  const [dr, evr, ofr] = await Promise.all([
    sb(`/rest/v1/candidate_documents?candidate_id=eq.${id}&select=*&order=uploaded_at.desc`, env),
    sb(`/rest/v1/application_events?candidate_id=eq.${id}&select=*&order=created_at.desc&limit=200`, env),
    visApps.length
      ? sb(`/rest/v1/offers?application_id=in.(${visApps.map(a => a.id).join(',')})&select=id,application_id,opening_id,candidate_id,offer_ref,revision,status,mode,designation,start_date,issue_date,valid_until,sent_at,accepted_at,declined_at,created_at,updated_at,total_ctc,approver_employee_id&order=revision.desc`, env)
      : Promise.resolve({ data: [] }),
  ]);
  const offersAll = await expireDueOffers(env, auth, me, ofr.data || []);
  // O2: each visible application's interviews (same shape as getApplicationInterviews) + the active round plan of
  // the openings the caller manages (for the Schedule form).
  const rolesByOpening = Object.fromEntries(sc.visible.map(v => [v.o.id, v.roles]));
  const manageOps = sc.visible.filter(v => canManageApps(v.roles)).map(v => v.o.id);
  const [ivByApp, roundsAll, calOn] = await Promise.all([
    chainInterviews(env, me, visApps, rolesByOpening),
    openingRounds(env, manageOps, { activeOnly: true }),
    manageOps.length ? calendarEnabled(env) : Promise.resolve(false),   // O3
  ]);
  let salaryShown = false;
  const applications = visApps.map(a => {
    const x = sc.byId[a.opening_id];
    const sal = canSeeSalary(x.roles);
    const { current_ctc, expected_ctc, ...rest } = a;
    rest.outcome_reason = redactReason(a.outcome_reason, sal);
    // C3: the application's offer revisions — total CTC only where the caller has salary on that offer.
    const offers = offersAll.filter(o => o.application_id === a.id).map(o => {
      const os = canSeeSalary(offerRoles(x.roles, o, me?.id || null));
      if (os && o.total_ctc != null) salaryShown = true;
      const { approver_employee_id, ...v } = offerView(o, os);
      return v;
    });
    const out = { ...rest, opening: { id: x.o.id, opening_code: x.o.opening_code, designation: x.o.designation, status: x.o.status, has_jd: !!x.o.current_jd_id },
      can_manage: canManageApps(x.roles), can_see_salary: sal, can_offer: canManageOffers(x.roles), offers,
      allowed_transitions: APP_TRANSITIONS[a.status] || [],
      interviews: ivByApp[a.id] || [],
      rounds: canManageApps(x.roles) ? roundsAll.filter(r => r.opening_id === x.o.id) : [],
      can_schedule: canManageApps(x.roles) && canSchedule(a.status) && x.o.status === 'open' && !jdGate(x.o),
      calendar_enabled: canManageApps(x.roles) && calOn, candidate_has_email: addressOk(String(cand.email || '').trim().toLowerCase()) };
    if (sal) {
      out.current_ctc = numOrNull(current_ctc); out.expected_ctc = numOrNull(expected_ctc);
      if (out.current_ctc != null || out.expected_ctc != null) salaryShown = true;
    }
    return out;
  });
  const hr = isHr(auth);
  const documents = (dr.data || []).filter(d => canSeeDocRow(d.doc_type, d.application_id, sc.docCtx));
  if (documents.some(d => docTier(d.doc_type) === 'salary')) salaryShown = true;
  // Timeline: rows on openings the caller can see, document rows only for doc types they can see,
  // free-text notes/reasons only where they can see salary (candidateEventsFor, unit-tested).
  const events = candidateEventsFor(evr.data || [], sc.docCtx);
  if (salaryShown) await logCompAccess(auth, 'getCandidate', null, cand.candidate_code, env, { candidate_id: id });
  const { email_norm, phone_norm, ...person } = cand;
  return ok({
    candidate: person, applications, documents, events,
    can_edit: hr || sc.visible.some(x => canManageApps(x.roles)),
    can_upload_types: CANDIDATE_DOC_TYPES.filter(t => canSeeCandidateDoc(t, sc.rolesList, hr)),
  });
}

async function getCandidateDocumentUrl(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!isUuid(id)) return err('id required', 400);
  const dr = await sb(`/rest/v1/candidate_documents?id=eq.${id}&select=*&limit=1`, env);
  const doc = dr.data?.[0];
  if (!doc) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  const sc = await candidateScope(auth, callerEmployee(edges, auth.userId), env, doc.candidate_id);
  if (!canSeeDocRow(doc.doc_type, doc.application_id, sc.docCtx)) return err('forbidden', 403);
  if (docTier(doc.doc_type) === 'salary') {
    const cr = await sb(`/rest/v1/candidates?id=eq.${doc.candidate_id}&select=candidate_code&limit=1`, env);
    await logCompAccess(auth, 'getCandidateDocumentUrl', null, cr.data?.[0]?.candidate_code || null, env, { document_id: id, doc_type: doc.doc_type });
  }
  return signDownload(doc.storage_path, doc.file_name, doc.mime_type, env);
}

async function findCandidateDuplicates(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  if (!(await hiringAccess(auth, me, env))) return err('forbidden', 403);
  const e = normEmailKey(url.searchParams.get('email'));
  const p = normPhoneKey(url.searchParams.get('phone'));
  const ors = [];
  if (e) ors.push(`email_norm.eq.${encodeURIComponent(e.replace(/[,()]/g, ''))}`);
  if (p && p.length >= 6) ors.push(`phone_norm.eq.${p}`);
  if (!ors.length) return ok({ count: 0, matches: [] });
  const cr = await sb(`/rest/v1/candidates?or=(${ors.join(',')})&select=id,candidate_code,full_name,email,phone&order=created_at.desc&limit=5`, env);
  if (!cr.ok) return err('db_error', 500);
  const hits = cr.data || [];
  if (!hits.length) return ok({ count: 0, matches: [] });
  const ar = await sb(`/rest/v1/applications?candidate_id=in.(${hits.map(h => h.id).join(',')})&select=candidate_id,opening_id`, env);
  const apps = ar.data || [];
  const allAccess = isHr(auth) || hasPerm(auth, 'podium_hiring');
  let visOps = new Set();
  if (!allAccess) {
    const ops = await loadOpeningsWithRoles(auth, me, env, { ids: [...new Set(apps.map(a => a.opening_id))] });
    visOps = new Set(ops.filter(x => canSeeOpening(x.roles)).map(x => x.o.id));
  }
  const appCount = {};
  for (const a of apps) appCount[a.candidate_id] = (appCount[a.candidate_id] || 0) + 1;
  const matches = hits
    .filter(h => allAccess || apps.some(a => a.candidate_id === h.id && visOps.has(a.opening_id)))
    .map(h => ({ ...h, applications_count: appCount[h.id] || 0 }));
  // Others only ever learn THAT a match exists (count), never who.
  return ok({ count: hits.length, matches });
}

// ── Writes: openings ──────────────────────────────────────────────────────────

// Multi-row writes run as ONE transaction in Postgres (migrations/0007_hiring_atomic_rpcs.sql). The
// functions trust their caller: every authorization check stays in the handler, before the call.
// Codes (OPN-NNN / CAN-NNNN) are minted inside them via podium.next_hiring_seq.
// opts.headers: extra request headers (J1b: X-Podium-Actor, read by the 0015 dirty trigger via request.headers).
async function hiringRpc(env, name, p, opts = {}) {
  return sb(`/rest/v1/rpc/${name}`, env, { method: 'POST', body: JSON.stringify({ p }), ...(opts.headers ? { headers: opts.headers } : {}) });
}
// A function's own `raise exception '<code>'` comes back as PostgREST { message: '<code>' }.
function rpcError(r) { return r && !r.ok ? (r.data?.message || null) : null; }

const OPENING_FIELDS = ['job_role_id', 'designation', 'department_id', 'location_city', 'location_state',
  'employment_type', 'headcount', 'target_join_date', 'notes'];

function cleanOpeningPatch(d) {
  const p = pickFields(d, OPENING_FIELDS);
  for (const k of ['job_role_id', 'department_id']) if (k in p) { if (p[k] === '' || p[k] == null) p[k] = null; else if (!isUuid(p[k])) return { error: `bad ${k}` }; }
  if ('designation' in p) { p.designation = String(p.designation || '').trim(); if (!p.designation) return { error: 'designation required' }; }
  if ('headcount' in p) { p.headcount = Math.round(Number(p.headcount)); if (!(p.headcount >= 1 && p.headcount <= 100)) return { error: 'headcount must be 1-100' }; }
  if ('employment_type' in p && !['full_time', 'intern'].includes(p.employment_type)) return { error: 'bad employment_type' };
  if ('target_join_date' in p && !p.target_join_date) p.target_join_date = null;
  for (const k of ['location_city', 'location_state']) if (k in p && !String(p[k] || '').trim()) delete p[k];
  return { patch: p };
}

async function activeEmployeeIds(ids, env) {
  const list = [...new Set(ids.filter(isUuid))];
  if (!list.length) return new Set();
  const r = await sb(`/rest/v1/employees?id=in.(${list.join(',')})&status=neq.exited&select=id`, env);
  return new Set((r.data || []).map(e => e.id));
}

async function createOpening(body, auth, env) {
  const d = body.data || body;
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const hiring = hasPerm(auth, 'podium_hiring');
  if (!hiring && !(await hasActiveReports(me, env))) return err('forbidden — needs podium_hiring or direct reports', 403);
  const ownerId = d.hiring_owner_employee_id || me?.id || null;
  if (!hiring && ownerId !== me?.id) return err('only podium_hiring may name another hiring owner', 403);
  const rmId = d.reporting_manager_employee_id;
  if (!isUuid(rmId)) return err('reporting_manager_employee_id required', 400);
  if (!isUuid(ownerId)) return err('hiring_owner_employee_id required', 400);
  // A manager hires into their own team only: the RM is them or someone in their reporting subtree.
  if (!hiring && rmId !== me?.id && !descendantsOf(edges, me?.id).has(rmId)) {
    return errCode('reporting_manager_not_in_team', 'The reporting manager must be you or someone in your team', 403);
  }
  const live = await activeEmployeeIds([rmId, ownerId], env);
  if (!live.has(rmId) || !live.has(ownerId)) return err('reporting manager / hiring owner must be current employees', 400);
  const cp = cleanOpeningPatch(d);
  if (cp.error) return err(cp.error, 400);
  if (!cp.patch.designation) return err('designation required', 400);
  // A role's band is allow-list data (projectJobRole hides it); copying it blind would let a manager
  // mint an opening on a number they cannot see.
  if (d.band_from_role && !canComp(auth)) {
    return errCode('band_from_role_requires_comp', "Only the salary allow-list can use the role's band — enter a band instead", 403);
  }

  let role = null;
  if (d.band_from_role || d.use_role_jd) {
    if (!isUuid(cp.patch.job_role_id)) return err('job_role_id required for band_from_role / use_role_jd', 400);
    role = (await sb(`/rest/v1/job_roles?id=eq.${cp.patch.job_role_id}&select=salary_band_min,salary_band_max,job_description&limit=1`, env)).data?.[0];
    if (!role) return err('job role not found', 400);
  }
  const band = d.band_from_role ? parseBand(role.salary_band_min, role.salary_band_max) : parseBand(d.band_min, d.band_max);
  if (band.error) return err(d.band_from_role ? `role band unusable: ${band.error}` : band.error, 400);
  const jdText = d.use_role_jd ? String(role.job_description || '').trim() : String(d.jd_text || '').trim();
  if (d.use_role_jd && !jdText) return err('the job role has no JD text', 400);

  const founders = await loadFounders(env);
  const approver = resolveApprover(edges, founders, rmId, me?.id || null, ownerId);
  if (!approver) return err('no_approver — could not resolve a budget approver', 500);

  // Opening + budget v1 + JD v1 + event in one transaction (0007). Status is open only when the JD
  // row lands in that same call.
  const r = await hiringRpc(env, 'hiring_create_opening', {
    opening: { ...cp.patch, reporting_manager_employee_id: rmId, hiring_owner_employee_id: ownerId },
    band,
    jd: jdText ? { source: d.use_role_jd ? 'job_role' : 'text', jd_text: jdText } : null,
    approver_employee_id: approver,
    actor_user_id: auth.userId, actor_employee_id: me?.id || null,
    event_detail: { jd: !!jdText, band_from_role: !!d.band_from_role, approver_employee_id: approver },
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.opening);
}

async function updateOpening(body, auth, env) {
  const d = body.data || body;
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, d.id);
  if (!x) return err('not_found', 404);
  if (!canEditOpening(x.roles)) return err('forbidden', 403);
  const cp = cleanOpeningPatch(d);
  if (cp.error) return err(cp.error, 400);
  const patch = cp.patch;
  const chain = {};
  for (const k of ['reporting_manager_employee_id', 'hiring_owner_employee_id']) {
    if (k in d && d[k] !== x.o[k]) chain[k] = d[k];
  }
  const pend = x.budgets.find(b => b.status === 'pending') || null;
  let reApprover = null;
  if (Object.keys(chain).length) {
    if (!canChangeChain(x.roles)) return err('forbidden — chain changes need podium_hiring', 403);
    const live = await activeEmployeeIds(Object.values(chain), env);
    if (!Object.values(chain).every(v => live.has(v))) return err('chain members must be current employees', 400);
    const founders = await loadFounders(env);
    const isFounder = !!auth.isSuperAdmin && !!me && founders.includes(me.id);
    // podium_hiring may not seat themselves on an opening's chain (it would hand them its salary view).
    if (!isFounder && me && Object.values(chain).includes(me.id)) {
      return errCode('no_self_chain', 'You cannot make yourself the hiring owner or reporting manager — ask a founder', 403);
    }
    if (pend) {
      const rm = chain.reporting_manager_employee_id || x.o.reporting_manager_employee_id;
      const owner = chain.hiring_owner_employee_id || x.o.hiring_owner_employee_id;
      reApprover = resolveApprover(edges, founders, rm, me?.id || null, owner);
      if (!reApprover) return err('no_approver — could not resolve a budget approver', 500);
      if (reApprover === me?.id) return errCode('no_self_approval', 'This change would make you the approver of the pending band', 403);
    }
    Object.assign(patch, chain);
  }
  if (!Object.keys(patch).length) return err('no_patch', 400);
  const events = Object.keys(cp.patch).length ? [{ event_type: 'opening_updated', detail: { fields: Object.keys(cp.patch) } }] : [];
  if (Object.keys(chain).length) {
    const from = Object.fromEntries(Object.keys(chain).map(k => [k, x.o[k]]));
    events.push({ event_type: 'chain_changed', detail: { from, to: chain } });
    // Either seat changing can change who may approve (owner + RM are both skipped) → the pending band is
    // cancelled and re-requested (same numbers, requested by the caller) to the new approver. Patch +
    // re-request + events are one transaction (0008 hiring_change_chain).
    const r = await hiringRpc(env, 'hiring_change_chain', {
      opening_id: x.o.id, patch, pending_budget_id: pend ? pend.id : null, approver_employee_id: reApprover,
      events, actor_user_id: auth.userId, actor_employee_id: me?.id || null,
    });
    if (rpcError(r) === 'stale') return errCode('stale', 'The band request changed — reload and retry', 409);
    if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
    return ok(r.data?.opening);
  }
  const r = await sb(`/rest/v1/openings?id=eq.${x.o.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  await hiringEvents(env, auth, me, events.map(e => ({ ...e, opening_id: x.o.id })));
  return ok(r.data?.[0]);
}

async function setOpeningStatus(body, auth, env) {
  const d = body.data || body;
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, d.id);
  if (!x) return err('not_found', 404);
  if (!canEditOpening(x.roles)) return err('forbidden', 403);
  const to = d.status;
  if (!['open', 'on_hold', 'filled', 'cancelled'].includes(to)) return err('bad status', 400);
  const from = x.o.status;
  if (from === to) return ok(x.o);
  if (to === 'open' && jdGate(x.o)) return errCode('jd_required', JD_REQUIRED_MSG, 409);
  if (['filled', 'cancelled'].includes(from) && !hasPerm(auth, 'podium_hiring')) return err('forbidden — reopening needs podium_hiring', 403);
  if (['filled', 'cancelled'].includes(to)) {
    const ar = await sb(`/rest/v1/applications?opening_id=eq.${x.o.id}&status=in.(${ACTIVE_APP_STATUSES.join(',')})&select=id&limit=1`, env);
    if (ar.data?.length) return errCode('resolve_applications_first', 'Close or move the active applications first', 409);
  }
  const r = await sb(`/rest/v1/openings?id=eq.${x.o.id}`, env, { method: 'PATCH', body: JSON.stringify({ status: to }) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  // Free text → detail.note (salary-chain only on read), never event.reason.
  const note = String(d.reason || '').trim();
  await hiringEvents(env, auth, me, [{ opening_id: x.o.id, event_type: 'opening_status', from_status: from, to_status: to, detail: note ? { note } : null }]);
  return ok(r.data?.[0]);
}

async function addOpeningJd(body, auth, env) {
  const d = body.data || body;
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, d.opening_id);
  if (!x) return err('not_found', 404);
  if (!canEditOpening(x.roles)) return err('forbidden', 403);
  let row;
  if (d.storage_path) {
    // Exactly the shape createJdUploadUrl mints for THIS opening — no traversal, no other opening's file.
    if (checkJdPath(d.storage_path, x.o.id)) return err('bad storage_path', 400);
    const fe = fileOk(d.file_name || d.storage_path, JD_EXTS, d.file_size) || checkFileSize(d.file_size);
    if (fe) return err(fe, 400);
    row = { source: 'file', storage_path: d.storage_path, file_name: d.file_name || null, mime_type: d.mime_type || null,
      file_size: Number(d.file_size), jd_text: String(d.jd_text || '').trim() || null };
  } else if (d.use_role_jd) {
    if (!x.o.job_role_id) return err('the opening has no job role', 400);
    const role = (await sb(`/rest/v1/job_roles?id=eq.${x.o.job_role_id}&select=job_description&limit=1`, env)).data?.[0];
    const t = String(role?.job_description || '').trim();
    if (!t) return err('the job role has no JD text', 400);
    row = { source: 'job_role', jd_text: t };
  } else {
    const t = String(d.jd_text || '').trim();
    if (!t) return err('jd_text, storage_path or use_role_jd required', 400);
    row = { source: 'text', jd_text: t };
  }
  // Next version + make it current + (first JD on a draft) open the opening + events, one transaction
  // (0008 hiring_add_jd). Never reopens on_hold / filled / cancelled.
  const r = await hiringRpc(env, 'hiring_add_jd', { opening_id: x.o.id, jd: row, actor_user_id: auth.userId, actor_employee_id: me?.id || null });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok({ jd: r.data?.jd, opening: r.data?.opening });
}

async function createJdUploadUrl(body, auth, env) {
  const d = body.data || body;
  const edges = await loadOrgEdges(env);
  const x = await loadOneOpening(auth, callerEmployee(edges, auth.userId), env, d.opening_id);
  if (!x) return err('not_found', 404);
  if (!canEditOpening(x.roles)) return err('forbidden', 403);
  if (!d.file_name) return err('file_name required', 400);
  const fe = fileOk(d.file_name, JD_EXTS, d.file_size);
  if (fe) return err(fe === 'bad_file_type' ? 'JD must be a PDF or DOCX' : fe, 400);
  return signUpload(jdPath(x.o.id, d.file_name), env);
}

async function requestBandChange(body, auth, env) {
  const d = body.data || body;
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, d.opening_id);
  if (!x) return err('not_found', 404);
  if (!canEditOpening(x.roles)) return err('forbidden', 403);
  const band = parseBand(d.band_min, d.band_max);
  if (band.error) return err(band.error, 400);
  const founders = await loadFounders(env);
  const approver = resolveApprover(edges, founders, x.o.reporting_manager_employee_id, me?.id || null, x.o.hiring_owner_employee_id);
  if (!approver) return err('no_approver — could not resolve a budget approver', 500);
  // Cancel any pending + insert the new pending version + band_requested event, one transaction (0008).
  // The request note is free text that may quote numbers → detail.note, which every read strips for
  // viewers without salary on this opening (redactEvent).
  const r = await hiringRpc(env, 'hiring_request_band_change', {
    opening_id: x.o.id, band, approver_employee_id: approver, note: String(d.note || '').trim() || null,
    actor_user_id: auth.userId, actor_employee_id: me?.id || null,
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.budget);
}

async function decideBand(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.budget_id)) return err('budget_id required', 400);
  if (!['approve', 'reject'].includes(d.decision)) return err("decision must be 'approve' or 'reject'", 400);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const br = await sb(`/rest/v1/opening_budgets?id=eq.${d.budget_id}&select=*&limit=1`, env);
  const b = br.data?.[0];
  if (!b) return err('not_found', 404);
  if (b.status !== 'pending') return errCode('not_pending', 'This band request is no longer pending', 409);
  const founders = await loadFounders(env);
  const isFounder = !!auth.isSuperAdmin && !!me && founders.includes(me.id);
  const bad = b.requested_by === auth.userId ? 'no_self_approval' : checkBandDecider(me?.id || null, isFounder, b);
  if (bad === 'no_self_approval') return errCode('no_self_approval', 'You cannot approve your own band request', 403);
  if (bad) return err('forbidden — only the approver can decide this band', 403);
  // Decide + supersede the previous approved version + repoint the opening + event, one transaction (0007).
  const r = await hiringRpc(env, 'hiring_decide_band', {
    budget_id: b.id, decision: d.decision, note: String(d.note || '').trim() || null,
    actor_user_id: auth.userId, actor_employee_id: me.id,
    event_detail: { version: b.version, as_founder: isFounder && b.approver_employee_id !== me.id },
  });
  if (rpcError(r) === 'not_pending') return errCode('not_pending', 'This band request is no longer pending', 409);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  // Deciding a band does not grant salary visibility (a founder override may not be on the chain):
  // return decision metadata only; the client reloads the opening, which applies canSeeSalary.
  const nb = r.data?.budget || {};
  return ok({ id: nb.id, opening_id: nb.opening_id, version: nb.version, status: nb.status, decided_at: nb.decided_at });
}

// ── Writes: candidates + applications ─────────────────────────────────────────

const CANDIDATE_FIELDS = ['full_name', 'email', 'phone', 'location', 'current_employer', 'current_title',
  'total_experience_years', 'skills', 'education', 'linkedin_url', 'notes'];
const APP_FIELDS = ['source', 'referrer_employee_id', 'source_detail', 'notice_period_days'];
const CTC_FIELDS = ['current_ctc', 'expected_ctc'];

function cleanCandidate(d) {
  const p = pickFields(d, CANDIDATE_FIELDS);
  if ('full_name' in p) { p.full_name = String(p.full_name || '').trim(); if (!p.full_name) return { error: 'full_name required' }; }
  if ('total_experience_years' in p) {
    const n = numOrNull(p.total_experience_years);
    if (n != null && !(n >= 0 && n <= 60)) return { error: 'total_experience_years must be 0-60' };
    p.total_experience_years = n == null ? null : Math.round(n * 10) / 10;
  }
  if ('skills' in p) {
    const s = Array.isArray(p.skills) ? p.skills : String(p.skills || '').split(',');
    p.skills = s.map(v => String(v).trim()).filter(Boolean).slice(0, 50);
  }
  for (const k of ['email', 'phone', 'location', 'current_employer', 'current_title', 'education', 'linkedin_url', 'notes']) {
    if (k in p) p[k] = String(p[k] ?? '').trim() || null;
  }
  return { patch: p };
}

// Application fields; CTC kept only when the caller may see salary on that opening (else dropped).
function cleanApplication(d, salaryOk) {
  const p = pickFields(d, salaryOk ? [...APP_FIELDS, ...CTC_FIELDS] : APP_FIELDS);
  if ('source' in p && !APP_SOURCES.includes(p.source)) return { error: 'bad source' };
  if ('referrer_employee_id' in p) { if (!p.referrer_employee_id) p.referrer_employee_id = null; else if (!isUuid(p.referrer_employee_id)) return { error: 'bad referrer_employee_id' }; }
  if ('source_detail' in p) p.source_detail = String(p.source_detail ?? '').trim() || null;
  if ('notice_period_days' in p) {
    const n = numOrNull(p.notice_period_days);
    if (n != null && !(n >= 0 && n <= 365)) return { error: 'notice_period_days must be 0-365' };
    p.notice_period_days = n == null ? null : Math.round(n);
  }
  for (const k of CTC_FIELDS) if (k in p) {
    const n = numOrNull(p[k]);
    if (n != null && !(n >= 0)) return { error: `bad ${k}` };
    p[k] = n == null ? null : Math.round(n);
  }
  return { patch: p };
}

// The opening must exist, be manageable by the caller, carry a JD and be open.
async function intakeOpening(auth, me, env, openingId) {
  const x = await loadOneOpening(auth, me, env, openingId);
  if (!x) return { res: err('opening not found', 404) };
  if (!canManageApps(x.roles)) return { res: err('forbidden', 403) };
  if (jdGate(x.o)) return { res: errCode('jd_required', JD_REQUIRED_MSG, 409) };
  if (x.o.status !== 'open') return { res: errCode('opening_not_open', 'The opening is not open', 409) };
  return { x };
}

async function createCandidate(body, auth, env) {
  const d = body.data || body;
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const { x, res } = await intakeOpening(auth, me, env, d.opening_id);
  if (res) return res;
  const cc = cleanCandidate(d);
  if (cc.error) return err(cc.error, 400);
  if (!cc.patch.full_name) return err('full_name required', 400);
  const ca = cleanApplication(d, canSeeSalary(x.roles));
  if (ca.error) return err(ca.error, 400);
  // Person + application `new` + both events in one transaction (0007); CAN-NNNN minted inside.
  const r = await hiringRpc(env, 'hiring_create_candidate', {
    opening_id: x.o.id, candidate: cc.patch, application: ca.patch,
    actor_user_id: auth.userId, actor_employee_id: me?.id || null,
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  const { email_norm, phone_norm, ...person } = r.data?.candidate || {};
  const app = r.data?.application || {};
  return ok({ candidate: person, application: { id: app.id, status: app.status, opening_id: app.opening_id } });
}

async function addApplication(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.candidate_id)) return err('candidate_id required', 400);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const { x, res } = await intakeOpening(auth, me, env, d.opening_id);
  if (res) return res;
  // Attaching someone you can't already see would hand you their profile — HR / podium_hiring only.
  const sc = await candidateScope(auth, me, env, d.candidate_id);
  if (!sc.canSee) return err('forbidden — ask HR / hiring to add this person to your opening', 403);
  const ca = cleanApplication(d, canSeeSalary(x.roles));
  if (ca.error) return err(ca.error, 400);
  const ai = await sb(`/rest/v1/applications`, env, { method: 'POST', body: JSON.stringify([{
    ...ca.patch, candidate_id: d.candidate_id, opening_id: x.o.id, status: 'new', created_by: auth.userId,
  }]) });
  if (ai.status === 409) return errCode('already_active', 'This person already has an active application on this opening', 409);
  if (!ai.ok) return err(`db_error: ${JSON.stringify(ai.data)}`, 400);
  const app = ai.data[0];
  // A new active application lifts any retention clock.
  await sb(`/rest/v1/candidates?id=eq.${d.candidate_id}&retain_until=not.is.null`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ retain_until: null }) });
  await hiringEvents(env, auth, me, [{ candidate_id: d.candidate_id, opening_id: x.o.id, application_id: app.id,
    event_type: 'application_created', to_status: 'new', detail: { source: app.source } }]);
  return ok({ id: app.id, status: app.status, opening_id: app.opening_id, candidate_id: app.candidate_id });
}

async function updateCandidate(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.id)) return err('id required', 400);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const sc = await candidateScope(auth, me, env, d.id);
  if (!(isHr(auth) || sc.visible.some(x => canManageApps(x.roles)))) return err('forbidden', 403);
  const cc = cleanCandidate(d);
  if (cc.error) return err(cc.error, 400);
  if (!Object.keys(cc.patch).length) return err('no_patch', 400);
  const r = await sb(`/rest/v1/candidates?id=eq.${d.id}`, env, { method: 'PATCH', body: JSON.stringify(cc.patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  if (!r.data?.length) return err('not_found', 404);
  await hiringEvents(env, auth, me, [{ candidate_id: d.id, event_type: 'candidate_updated', detail: { fields: Object.keys(cc.patch) } }]);
  const { email_norm, phone_norm, ...person } = r.data[0];
  return ok(person);
}

async function loadApplication(env, id) {
  if (!isUuid(id)) return null;
  return (await sb(`/rest/v1/applications?id=eq.${id}&select=*&limit=1`, env)).data?.[0] || null;
}

async function updateApplication(body, auth, env) {
  const d = body.data || body;
  const app = await loadApplication(env, d.id);
  if (!app) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, app.opening_id);
  if (!x || !canManageApps(x.roles)) return err('forbidden', 403);
  const ca = cleanApplication(d, canSeeSalary(x.roles));
  if (ca.error) return err(ca.error, 400);
  if (!Object.keys(ca.patch).length) return err('no_patch', 400);
  const r = await sb(`/rest/v1/applications?id=eq.${app.id}`, env, { method: 'PATCH', body: JSON.stringify(ca.patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  // Field NAMES only — never the CTC values.
  await hiringEvents(env, auth, me, [{ candidate_id: app.candidate_id, opening_id: app.opening_id, application_id: app.id,
    event_type: 'application_updated', detail: { fields: Object.keys(ca.patch) } }]);
  return ok({ id: app.id, updated: Object.keys(ca.patch) });
}

// After an application closes: no other active one and none joined → start the 12-month clock.
async function maybeStartRetention(candidateId, env) {
  const [ar, cr] = await Promise.all([
    sb(`/rest/v1/applications?candidate_id=eq.${candidateId}&status=in.(${[...ACTIVE_APP_STATUSES, 'joined'].join(',')})&select=id&limit=1`, env),
    sb(`/rest/v1/candidates?id=eq.${candidateId}&select=talent_pool&limit=1`, env),
  ]);
  if (ar.data?.length || cr.data?.[0]?.talent_pool) return;
  await sb(`/rest/v1/candidates?id=eq.${candidateId}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ retain_until: retainUntil(todayIso()) }) });
}

async function hasLiveOffer(env, applicationId) {
  const r = await sb(`/rest/v1/offers?application_id=eq.${applicationId}&status=in.(${OFFER_LIVE_STATUSES.join(',')})&select=id&limit=1`, env);
  return !!r.data?.length;
}

async function setApplicationStatus(body, auth, env, ctx) {
  const d = body.data || body;
  // J1: a no-show keeps the accepted offer, so it has its own close (see markNoShow).
  if (d.status === 'no_show') return markNoShow({ data: { application_id: d.id, reason: d.reason, note: d.note } }, auth, env, ctx);
  const app = await loadApplication(env, d.id);
  if (!app) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, app.opening_id);
  if (!x || !canManageApps(x.roles)) return err('forbidden', 403);
  if (jdGate(x.o)) return errCode('jd_required', JD_REQUIRED_MSG, 409);
  // reason = a category code (OUTCOME_REASON_CODES); free text = d.note → event detail.note only.
  const bad = checkTransition(app.status, d.status, d.reason);
  if (bad === 'reason_required') return errCode('reason_required', 'A reason is required to reject or withdraw', 400);
  if (bad === 'bad_reason') return errCode('bad_reason', `reason must be one of: ${OUTCOME_REASON_CODES.join(', ')}`, 400);
  if (bad) return errCode('invalid_transition', `Cannot move ${app.status} → ${d.status} here`, 409);
  // Any manual close or hold (from any status): a live offer revision is withdrawn / declined first.
  if (needsNoLiveOffer(d.status) && await hasLiveOffer(env, app.id)) {
    return errCode('close_offers_first', OFFER_COPY.close_offers_first, 409);
  }
  const reason = String(d.reason || '').trim() || null;
  const note = String(d.note || '').trim() || null;
  const patch = { status: d.status, ...(reason ? { outcome_reason: reason } : {}),
    ...(isTerminalStatus(d.status) ? { closed_at: nowIso() } : {}) };
  // Guarded on the status we read so two racing moves can't both land.
  const r = await sb(`/rest/v1/applications?id=eq.${app.id}&status=eq.${app.status}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  if (!r.data?.length) return errCode('stale', 'The application changed — reload and retry', 409);
  if (isTerminalStatus(d.status)) await maybeStartRetention(app.candidate_id, env);
  if (isTerminalStatus(d.status)) await later(ctx, calendarSweepApplication(env, app.id));   // O3 D8
  await hiringEvents(env, auth, me, [{ candidate_id: app.candidate_id, opening_id: app.opening_id, application_id: app.id,
    event_type: 'status_changed', from_status: app.status, to_status: d.status, reason, detail: note ? { note } : null }]);
  return ok({ id: app.id, status: d.status });
}

async function moveApplication(body, auth, env, ctx) {
  const d = body.data || body;
  // The free-text "why" is a note (salary-chain only on read); the closed row's outcome_reason is the
  // system string "moved to OPN-x".
  const note = String(d.reason || '').trim();
  if (!note) return errCode('reason_required', 'A reason is required to move an application', 400);
  const app = await loadApplication(env, d.id);
  if (!app) return err('not_found', 404);
  if (d.to_opening_id === app.opening_id) return err('already on that opening', 400);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const src = await loadOneOpening(auth, me, env, app.opening_id);
  if (!src || !canManageApps(src.roles)) return err('forbidden', 403);
  const { x: dst, res } = await intakeOpening(auth, me, env, d.to_opening_id);
  if (res) return res;
  if (!(APP_TRANSITIONS[app.status] || []).includes('withdrawn')) return errCode('invalid_transition', `Cannot move an application that is ${app.status}`, 409);
  // Offers stay with the opening they were made for: nothing at offer / accepted moves, and no live
  // revision (e.g. a draft while interviewing) is stranded.
  if (!canMoveFrom(app.status)) return errCode('close_offers_first', 'An application at the offer stage cannot be moved — close it here and add the person to the other opening', 409);
  if (await hasLiveOffer(env, app.id)) return errCode('close_offers_first', OFFER_COPY.close_offers_first, 409);
  // New application + close the old one (guarded on the status read here) + both events, one
  // transaction (0007). Salary fields are NOT copied.
  const r = await hiringRpc(env, 'hiring_move_application', {
    application_id: app.id, expected_status: app.status, to_opening_id: dst.o.id,
    outcome_reason: `moved to ${dst.o.opening_code}`, from_opening_code: src.o.opening_code, note,
    actor_user_id: auth.userId, actor_employee_id: me?.id || null,
  });
  if (r.status === 409 || r.data?.code === '23505') return errCode('already_active', 'This person already has an active application on that opening', 409);
  if (rpcError(r) === 'stale') return errCode('stale', 'The application changed — reload and retry', 409);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  await later(ctx, calendarSweepApplication(env, app.id));   // O3 D8: the old application's interviews were auto-cancelled
  return ok({ from: { id: app.id, status: 'withdrawn' }, to: { id: r.data?.to_application_id, status: 'new', opening_id: dst.o.id } });
}

// ── Writes: candidate documents ───────────────────────────────────────────────

async function createCandidateDocUploadUrl(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.candidate_id)) return err('candidate_id required', 400);
  if (!CANDIDATE_DOC_TYPES.includes(d.doc_type)) return err('bad doc_type', 400);
  if (!d.file_name) return err('file_name required', 400);
  if (d.application_id && !isUuid(d.application_id)) return err('bad application_id', 400);
  const fe = fileOk(d.file_name, CANDIDATE_DOC_EXTS, d.file_size);
  if (fe) return err(fe, 400);
  const edges = await loadOrgEdges(env);
  const sc = await candidateScope(auth, callerEmployee(edges, auth.userId), env, d.candidate_id);
  if (d.application_id && !sc.apps.some(a => a.id === d.application_id)) return err('application_id is not this candidate\'s', 400);
  if (!canSeeDocRow(d.doc_type, d.application_id || null, sc.docCtx)) return err('forbidden', 403);
  return signUpload(candidateDocPath(d.candidate_id, d.doc_type, d.file_name), env);
}

async function recordCandidateDocument(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.candidate_id)) return err('candidate_id required', 400);
  if (!CANDIDATE_DOC_TYPES.includes(d.doc_type)) return err('bad doc_type', 400);
  // Exactly candidates/<this candidate>/<this doc_type>/<ts>_<safe name> — the shape the mint returns.
  // A looser prefix check let a row point at another candidate's object via '..'.
  if (checkCandidateDocPath(d.storage_path, d.candidate_id, d.doc_type)) return err('bad storage_path', 400);
  const fe = fileOk(d.file_name || d.storage_path, CANDIDATE_DOC_EXTS) || checkFileSize(d.file_size);
  if (fe) return err(fe === 'bad_file_size' ? 'file_size must be a positive integer up to 15 MB' : fe, 400);
  if (d.application_id && !isUuid(d.application_id)) return err('bad application_id', 400);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const sc = await candidateScope(auth, me, env, d.candidate_id);
  if (d.application_id && !sc.apps.some(a => a.id === d.application_id)) return err('application_id is not this candidate\'s', 400);
  if (!canSeeDocRow(d.doc_type, d.application_id || null, sc.docCtx)) return err('forbidden', 403);
  const row = {
    candidate_id: d.candidate_id, application_id: d.application_id || null, doc_type: d.doc_type,
    title: d.title || null, storage_path: d.storage_path, file_name: d.file_name || null, mime_type: d.mime_type || null,
    file_size: Number(d.file_size), notes: d.notes || null, uploaded_by: auth.userId,
  };
  const r = await sb(`/rest/v1/candidate_documents`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  // No opening_id: the row is candidate-level and every read filters it by doc type (candidateEventsFor).
  await hiringEvents(env, auth, me, [{ candidate_id: d.candidate_id, application_id: row.application_id, event_type: 'document_added', detail: { doc_type: d.doc_type } }]);
  return ok(r.data?.[0]);
}

async function deleteCandidateDocument(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.id)) return err('id required', 400);
  const dr = await sb(`/rest/v1/candidate_documents?id=eq.${d.id}&select=*&limit=1`, env);
  const doc = dr.data?.[0];
  if (!doc) return err('not_found', 404);
  const recent = Date.now() - new Date(doc.uploaded_at).getTime() < 24 * 3600 * 1000;
  if (!(isHr(auth) || (doc.uploaded_by === auth.userId && recent))) return err('forbidden — HR, or the uploader within 24h', 403);
  // …and only a document the caller can SEE (the list / URL rule) — HR off a salary chain can't delete a payslip.
  const edges = await loadOrgEdges(env);
  const [sc, ref] = await Promise.all([
    candidateScope(auth, callerEmployee(edges, auth.userId), env, doc.candidate_id),
    sb(`/rest/v1/offers?or=(acceptance_doc_id.eq.${doc.id},sent_evidence_doc_id.eq.${doc.id})&select=id&limit=1`, env),
  ]);
  if (!canSeeDocRow(doc.doc_type, doc.application_id, sc.docCtx)) return err('forbidden', 403);
  if (ref.data?.length) return errCode('doc_in_use', OFFER_COPY.doc_in_use, 409);
  const r = await sb(`/rest/v1/candidate_documents?id=eq.${d.id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (r.data?.code === '23503') return errCode('doc_in_use', OFFER_COPY.doc_in_use, 409);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  const seg = String(doc.storage_path).split('/').map(encodeURIComponent).join('/');
  await storageFetch(`/object/${DOC_BUCKET}/${seg}`, env, { method: 'DELETE' });
  await hiringEvents(env, auth, callerEmployee(edges, auth.userId), [{ candidate_id: doc.candidate_id,
    application_id: doc.application_id, event_type: 'document_deleted', detail: { doc_type: doc.doc_type } }]);
  return ok({ deleted: d.id });
}

// ────────────────────────────────────────────────────────────────────────────
// HIRING C3 — offer letters. Plan: docs/superpowers/plans/2026-11-11-podium-hiring-c3-offers.md
// One row per revision (podium.offers). Create / revise / send = the opening's hiring owner or reporting
// manager (canManageOffers); approve = the snapshotted offer approver or a founder, never the requester.
// Figures (terms, annexure, band, PDF) only to callers with salary on that opening (canSeeSalary over
// offerRoles); podium_hiring alone sees status + dates. Every salary-bearing read logs comp_access_log.
// Events carry ids / ref / revision / status only; free text goes to detail.note (stripped on read).
// Error responses never echo a figure — offerDbError drops PostgREST's `details` ("Failing row contains").
// ────────────────────────────────────────────────────────────────────────────

const OFFER_CC_ALWAYS = ['hr@legendoftoys.com'];   // decision 9: HR is copied on every offer
const OFFER_CC_FOUNDER_NAME = 'Afshaan Siddiqui';  // decision 9: + Afshaan (looked up, not hard-coded)
const OFFER_COPY = {
  application_not_ready: 'Offers start once the candidate is interviewing',
  band_not_approved: 'The opening has no approved band yet — get the band approved first',
  draft_exists: 'This application already has an offer in progress — edit that one',
  not_editable: 'Only a draft (or a rejected one) can be edited — revise instead',
  signatory_required: 'Pick who signs the letter',
  signatory_inactive: 'That signatory is not active',
  template_missing: 'No current template for this kind of offer',
  rule_set_missing: 'No statutory rule set covers that start date',
  special_negative: 'The deductions exceed the allowances — the special allowance would be negative',
  wage_rule: 'Basic would fall below 50% of fixed pay',
  pf_opt_out_not_eligible: 'PF opt-out is allowed only when Basic is above the PF wage ceiling',
  offer_expired: 'The acceptance date is after the offer\'s validity — send a fresh revision',
  close_offers_first: 'Withdraw or close this application\'s live offer first',
  pdf_store_failed: 'The PDF could not be stored — try again',
  stale: 'This offer changed — reload and retry',
  not_latest: 'A newer revision of this offer has been sent — only the latest sent revision can be accepted',
  not_approved_for_terms: 'This offer is outside the band and has not been approved for these exact terms',
  already_accepted: 'Another revision of this offer is already accepted',
  doc_already_recorded: 'That file is already recorded',
  pdf_path_in_use: 'That PDF is already recorded against another revision',
  conflict: 'This conflicts with an existing record — reload and retry',
  offer_check_failed: 'The offer failed a consistency check — reload and retry',
  doc_in_use: 'This document is the evidence for an offer revision and cannot be deleted',
  // O1 — email + link
  mail_not_configured: 'Email sending is not set up on this server',
  no_sender_mailbox: 'Neither the hiring owner nor the reporting manager has a Legend of Toys mailbox to send from',
  send_pending: 'The last send is still being checked — try again in a minute',
  mail_failed: 'The email did not go out',
  pdf_missing: 'The issued PDF could not be read — re-issue the offer',
  pdf_hash_mismatch: 'The stored PDF does not match the issued one — re-issue the offer',
  not_link_accepted: 'This offer was not accepted through the link',
  confirmation_exists: 'The confirmation email has already gone out',
  no_bank_details: 'The candidate has not submitted bank details yet',
};
const offerErr = (code, status = 422) => errCode(code, OFFER_COPY[code] || code.replace(/_/g, ' '), status);
// PostgREST error → a mapped code (offerDbErrorCode: unique indexes by name, RPC raises), else code +
// message only. `details` would carry the failing row (figures) and is never echoed.
function offerDbError(r) {
  const m = offerDbErrorCode(r?.data);
  if (m) return offerErr(m.code, m.status);
  const d = r?.data && typeof r.data === 'object' ? r.data : {};
  return err(`db_error: ${[d.code, d.message].filter(Boolean).join(' ') || r?.status}`, 400);
}
// terms_hash for a row about to be written (create / draft edit).
async function termsHash(row) { return sha256Hex(new TextEncoder().encode(offerTermsCanonical(row))); }

async function loadOffer(env, id) {
  if (!isUuid(id)) return null;
  return (await sb(`/rest/v1/offers?id=eq.${id}&select=*&limit=1`, env)).data?.[0] || null;
}
async function currentTemplate(env, key) {
  return (await sb(`/rest/v1/offer_templates?template_key=eq.${key}&is_current=eq.true&select=*&limit=1`, env)).data?.[0] || null;
}
async function ruleSetFor(env, date) {
  return (await sb(`/rest/v1/offer_rule_sets?effective_from=lte.${date}&or=(effective_to.is.null,effective_to.gte.${date})&select=*&order=effective_from.desc&limit=1`, env)).data?.[0] || null;
}
const templateKeyOf = (o) => o?.inputs?.template_key || (o?.mode === 'stipend' ? 'internship' : 'employment');

// The application + opening (with roles) an offer action works on, from an application id.
async function offerAppCtx(auth, env, applicationId) {
  const app = await loadApplication(env, applicationId);
  if (!app) return { res: err('not_found', 404) };
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, app.opening_id);
  if (!x || !canSeeOpening(x.roles)) return { res: err('forbidden', 403) };
  return { app, x, me, edges };
}
// …from an offer id; roles include the snapshotted offer approver.
async function offerCtx(auth, env, offerId) {
  const o = await loadOffer(env, offerId);
  if (!o) return { res: err('not_found', 404) };
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, o.opening_id);
  if (!x) return { res: err('not_found', 404) };
  const roles = offerRoles(x.roles, o, me?.id || null);
  if (!canSeeOpening(roles)) return { res: err('forbidden', 403) };
  return { o, x, roles, me, edges };
}

// Offers need an open opening with a JD and an approved band.
function offerOpeningGate(x) {
  if (jdGate(x.o)) return errCode('jd_required', JD_REQUIRED_MSG, 409);
  if (x.o.status !== 'open') return errCode('opening_not_open', 'The opening is not open', 409);
  if (!x.o.current_budget_id || !x.budgets.some(b => b.id === x.o.current_budget_id)) return offerErr('band_not_approved', 409);
  return null;
}
const currentBudget = (x) => x.budgets.find(b => b.id === x.o.current_budget_id) || null;

function offerDefaults(o) {
  return { designation: o.designation, department_name: o.department?.name || null, location: o.location_city,
    start_date: o.target_join_date || null };
}

// Terms → the offers row fields + annexure + band check, or { error }. Pins rule set + budget.
function buildOffer(terms, mode, opening, rs, budget, templateKey) {
  const a = computeAnnexure({ ...terms, mode, work_state: opening.location_state }, rs.rules);
  if (a.error) return { error: a.error };
  const check = bandCheck(a.totals.total_ctc, [terms.joining_bonus, terms.retention_bonus], bandOf(budget));
  const { valid_days, ...cols } = terms;
  return {
    annexure: a, band_check: check,
    row: { ...cols, mode, total_ctc: a.totals.total_ctc, rule_set_id: rs.id, budget_id: budget?.id || null,
      inputs: { ...terms, mode, template_key: templateKey, work_state: opening.location_state || null, rule_set_code: rs.code },
      annexure: a, band_check: check },
  };
}

// Lazy expiry: 'sent' revisions past valid_until (IST) flip to 'expired' (one RPC for the lot) before a
// read or write uses them. → the rows with the new statuses.
async function expireDueOffers(env, auth, me, offers) {
  const today = istToday();
  const due = (offers || []).filter(o => o.status === 'sent' && o.valid_until && o.valid_until < today);
  if (!due.length) return offers || [];
  const r = await hiringRpc(env, 'hiring_expire_offers', {
    application_ids: [...new Set(due.map(o => o.application_id))], today, actor_user_id: auth.userId, actor_employee_id: me?.id || null,
  });
  const gone = new Set(r.ok ? (r.data?.expired || []) : []);
  return offers.map(o => (gone.has(o.id) ? { ...o, status: 'expired' } : o));
}

async function offerTransition(env, auth, me, o, expected, to, extra = {}) {
  return hiringRpc(env, 'hiring_offer_transition', {
    offer_id: o.id, expected_status: expected, to_status: to, set: extra.set || {}, evidence_doc: extra.evidence_doc || null,
    acceptance_doc: extra.acceptance_doc || null, app_status: extra.app_status || null, event_type: extra.event_type || null,
    event_note: extra.event_note || null, expected_terms_hash: o.terms_hash || null,
    actor_user_id: auth.userId, actor_employee_id: me?.id || null,
  });
}
const transitionFailed = (r) => offerDbError(r);

// Default CC for "Mark as sent" (decision 9): hr@ + the opening's chain + Afshaan. Recorded, not sent (O1 sends).
async function offerDefaultCc(env, x) {
  const ids = [x.o.hiring_owner_employee_id, x.o.reporting_manager_employee_id].filter(Boolean);
  const r = await sb(`/rest/v1/employees?or=(id.in.(${ids.join(',')}),full_name.eq.${encodeURIComponent(`"${OFFER_CC_FOUNDER_NAME}"`)})&select=work_email&limit=10`, env);
  const emails = (r.data || []).map(e => String(e.work_email || '').trim().toLowerCase()).filter(Boolean);
  return [...new Set([...OFFER_CC_ALWAYS, ...emails])];
}

// Render the frozen letter, store it, hash it, and move the revision to `ready` (from `draft` in band,
// or from `approved`). The stored file is the record: downloads serve it, never a re-render.
async function issueOffer(env, auth, me, o, from, set = {}) {
  if (!o.signatory_id) return offerErr('signatory_required');
  const [tr, sr, cr] = await Promise.all([
    sb(`/rest/v1/offer_templates?id=eq.${o.template_id}&select=*&limit=1`, env),
    sb(`/rest/v1/offer_signatories?id=eq.${o.signatory_id}&select=*&limit=1`, env),
    sb(`/rest/v1/candidates?id=eq.${o.candidate_id}&select=full_name&limit=1`, env),
  ]);
  const template = tr.data?.[0], signatory = sr.data?.[0], candidate = cr.data?.[0];
  if (!template) return offerErr('template_missing');
  if (!signatory) return offerErr('signatory_required');
  const issue = o.issue_date || istToday();
  const offer = { ...offerView(o, true), issue_date: issue, valid_until: o.valid_until || addDaysIso(issue, Number(o.inputs?.valid_days || 7)) };
  let bytes;
  try { bytes = await renderOfferPdf({ template, offer, annexure: o.annexure, signatory, candidate }); }
  catch (e) { if (e?.code === 'template_error') return errCode('template_error', e.message, 422); throw e; }
  const sha = await sha256Hex(bytes);
  // Hash-suffixed path, NO upsert: an object is never overwritten. The same bytes already stored (a retry)
  // is fine; different bytes get a different path, and the transition below binds the row to THIS file
  // only if the terms it was rendered from are still the row's (expected_terms_hash).
  const path = offerPdfPath(o.application_id, o.offer_ref, o.revision, sha);
  const up = await storageFetch(`/object/${DOC_BUCKET}/${path}`, env, {
    method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: bytes,
  });
  const dup = !up.ok && (up.status === 409 || /duplicate|already exists/i.test(JSON.stringify(up.data || '')));
  if (!up.ok && !dup) return offerErr('pdf_store_failed', 502);
  const r = await offerTransition(env, auth, me, o, from, 'ready', {
    set: { ...set, issue_date: issue, valid_until: offer.valid_until, pdf_path: path, pdf_sha256: sha, rendered_at: nowIso() },
    event_type: 'offer_ready',
  });
  if (!r.ok) return transitionFailed(r);
  return ok({ id: o.id, offer_ref: o.offer_ref, revision: o.revision, status: 'ready', pdf_sha256: sha });
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function getOfferSetup(url, auth, env) {
  const c = await offerAppCtx(auth, env, url.searchParams.get('application_id'));
  if (c.res) return c.res;
  const { app, x, me, edges } = c;
  if (!canManageOffers(x.roles)) return err('forbidden — offers are made by the opening\'s hiring owner or reporting manager', 403);
  const [tr, sr, cr, founders, cc] = await Promise.all([
    sb(`/rest/v1/offer_templates?is_current=eq.true&select=id,template_key,version,title,notes&order=template_key.asc`, env),
    sb(`/rest/v1/offer_signatories?active=eq.true&select=id,display_name,phone,title,employee_id&order=display_name.asc`, env),
    sb(`/rest/v1/candidates?id=eq.${app.candidate_id}&select=id,candidate_code,full_name,email&limit=1`, env),
    loadFounders(env),
    offerDefaultCc(env, x),
  ]);
  const approverId = resolveApprover(edges, founders, x.o.reporting_manager_employee_id, me?.id || null, x.o.hiring_owner_employee_id);
  const ap = approverId ? (await sb(`/rest/v1/employees?id=eq.${approverId}&select=id,full_name,job_title&limit=1`, env)).data?.[0] : null;
  const sal = canSeeSalary(x.roles);
  const band = sal ? bandOf(currentBudget(x)) : null;
  if (band) await logCompAccess(auth, 'getOfferSetup', null, x.o.opening_code, env, { application_id: app.id });
  return ok({
    application: { id: app.id, status: app.status },
    candidate: cr.data?.[0] || null,
    opening: { id: x.o.id, opening_code: x.o.opening_code, designation: x.o.designation, status: x.o.status,
      employment_type: x.o.employment_type, location_state: x.o.location_state, has_jd: !!x.o.current_jd_id,
      has_band: !!currentBudget(x) },
    templates: tr.data || [], signatories: sr.data || [], band, approver: ap || null,
    defaults: { ...offerDefaults(x.o), template_key: x.o.employment_type === 'intern' ? 'internship' : 'employment',
      valid_days: 7, variable_label: 'variable pay', variable_frequency: 'half-yearly', sent_to: cr.data?.[0]?.email || null, sent_cc: cc },
    can_see_salary: sal,
  });
}

// POST, no write: the annexure + band check + letter text for terms being typed (debounced by the form).
// Salary-bearing (band relation, annexure) → one comp_access_log row per request (plan §0.10).
async function previewOffer(body, auth, env) {
  const d = body.data || body;
  const c = await offerAppCtx(auth, env, d.application_id);
  if (c.res) return c.res;
  const { app, x } = c;
  if (!canSeeSalary(x.roles)) return err('forbidden', 403);
  const key = d.template_key || (x.o.employment_type === 'intern' ? 'internship' : 'employment');
  if (!OFFER_TEMPLATE_KEYS.includes(key)) return err('bad template_key', 400);
  const mode = key === 'internship' ? 'stipend' : 'salary';
  const ct = cleanOfferTerms(d, mode, offerDefaults(x.o));
  if (ct.error) return offerErr(ct.error, 400);
  const [tpl, rs, sr, cr] = await Promise.all([
    currentTemplate(env, key), ruleSetFor(env, ct.terms.start_date),
    ct.terms.signatory_id ? sb(`/rest/v1/offer_signatories?id=eq.${ct.terms.signatory_id}&select=*&limit=1`, env) : Promise.resolve({ data: [] }),
    sb(`/rest/v1/candidates?id=eq.${app.candidate_id}&select=full_name&limit=1`, env),
  ]);
  if (!tpl) return offerErr('template_missing');
  if (!rs) return offerErr('rule_set_missing');
  await logCompAccess(auth, 'previewOffer', null, x.o.opening_code, env, { application_id: app.id });
  const budget = currentBudget(x);
  const b = buildOffer(ct.terms, mode, x.o, rs, budget, key);
  if (b.error) return offerErr(b.error);
  let text = null, templateError = null;
  try {
    text = renderOfferText({ template: tpl, offer: { ...b.row, offer_ref: 'OFR-PREVIEW', revision: null, issue_date: istToday() },
      annexure: b.annexure, signatory: sr.data?.[0] || null, candidate: cr.data?.[0] || null });
  } catch (e) { templateError = e?.message || 'template_error'; }
  return ok({ annexure: b.annexure, total_ctc: b.annexure.totals.total_ctc, band_check: budget ? b.band_check : null,
    needs_approval: budget ? needsApproval(b.band_check) : null, warnings: b.annexure.warnings, rule_set: rs.code,
    template: { id: tpl.id, key, version: tpl.version }, text, template_error: templateError });
}

async function getOffers(url, auth, env) {
  const c = await offerAppCtx(auth, env, url.searchParams.get('application_id'));
  if (c.res) return c.res;
  const { app, x, me } = c;
  const r = await sb(`/rest/v1/offers?application_id=eq.${app.id}&select=*&order=revision.desc`, env);
  if (!r.ok) return err('db_error', 500);
  const rows = await expireDueOffers(env, auth, me, r.data || []);
  let shown = false;
  const offers = rows.map(o => {
    const sal = canSeeSalary(offerRoles(x.roles, o, me?.id || null));
    if (sal) shown = true;
    const v = offerView(o, sal);
    if (sal) { delete v.annexure; delete v.inputs; }   // the list carries the headline figures only
    return { ...v, can_see_salary: sal };
  });
  if (shown) await logCompAccess(auth, 'getOffers', null, x.o.opening_code, env, { application_id: app.id });
  return ok({ offers, can_manage: canManageOffers(x.roles), can_see_salary: canSeeSalary(x.roles) });
}

async function getOffer(url, auth, env) {
  const c = await offerCtx(auth, env, url.searchParams.get('id'));
  if (c.res) return c.res;
  const { x, roles, me } = c;
  let [o] = await expireDueOffers(env, auth, me, [c.o]);
  // O1 (D8): settle in-flight mails and heal a send whose ready → sent step did not land.
  if (await reconcileOfferEmails(env, o)) o = (await loadOffer(env, o.id)) || o;
  const sal = canSeeSalary(roles);
  const [evr, cr, founders, extras] = await Promise.all([
    sb(`/rest/v1/application_events?application_id=eq.${o.application_id}&event_type=like.offer_*&select=*&order=created_at.desc&limit=200`, env),
    sb(`/rest/v1/candidates?id=eq.${o.candidate_id}&select=id,candidate_code,full_name,email&limit=1`, env),
    loadFounders(env),
    offerLinkExtras(env, auth, o, sal, canManageOffers(x.roles)),
  ]);
  const events = (evr.data || []).filter(e => !e.detail?.offer_id || e.detail.offer_id === o.id || e.event_type === 'offer_superseded')
    .map(e => redactEvent(e, sal));
  const isFounder = !!auth.isSuperAdmin && !!me && founders.includes(me.id);
  const meId = me?.id || null;
  const can = {
    manage: canManageOffers(x.roles),
    decide: o.status === 'pending_approval' && !checkBandDecider(meId, isFounder, o),
    see_salary: sal,
    // O1
    send_email: canManageOffers(x.roles) && ['ready', 'sent'].includes(o.status),
    resend_confirmation: canManageOffers(x.roles) && o.status === 'accepted' && !!extras.acceptance
      && !extras.emails.some(e => e.kind === 'confirmation' && ['sending', 'sent', 'unknown'].includes(e.status)),
    verify_docs: isHr(auth),
    allow_bank_update: isHr(auth) && extras.has_bank,
    reveal_bank: canComp(auth) && extras.has_bank,
  };
  const { has_bank, ...o1 } = extras;
  const base = { offer: offerView(o, sal), candidate: cr.data?.[0] || null,
    opening: { id: x.o.id, opening_code: x.o.opening_code, designation: x.o.designation, status: x.o.status }, events, can, ...o1 };
  if (!sal) return ok(base);
  const empIds = [o.approver_employee_id, o.requested_by_employee_id, o.decided_by_employee_id].filter(Boolean);
  const [tr, sr, rr, er, cc, sender] = await Promise.all([
    sb(`/rest/v1/offer_templates?id=eq.${o.template_id}&select=*&limit=1`, env),
    o.signatory_id ? sb(`/rest/v1/offer_signatories?id=eq.${o.signatory_id}&select=*&limit=1`, env) : Promise.resolve({ data: [] }),
    sb(`/rest/v1/offer_rule_sets?id=eq.${o.rule_set_id}&select=code,effective_from,effective_to&limit=1`, env),
    empIds.length ? sb(`/rest/v1/employees?id=in.(${empIds.join(',')})&select=id,full_name`, env) : Promise.resolve({ data: [] }),
    can.manage && ['ready', 'sent'].includes(o.status) ? offerDefaultCc(env, x) : Promise.resolve(null),
    can.manage ? offerSender(env, x.o) : Promise.resolve(null),
  ]);
  const template = tr.data?.[0] || null;
  let text = null, templateError = null;
  try {
    const issue = o.issue_date || istToday();
    text = template ? renderOfferText({ template, offer: { ...offerView(o, true), issue_date: issue }, annexure: o.annexure,
      signatory: sr.data?.[0] || null, candidate: cr.data?.[0] || null }) : null;
  } catch (e) { templateError = e?.message || 'template_error'; }
  const names = Object.fromEntries((er.data || []).map(e => [e.id, e.full_name]));
  await logCompAccess(auth, 'getOffer', null, `${o.offer_ref} r${o.revision}`, env, { offer_id: o.id });
  return ok({ ...base, text, template_error: templateError,
    template: template ? { id: template.id, template_key: template.template_key, version: template.version, title: template.title } : null,
    signatory: sr.data?.[0] || null, rule_set: rr.data?.[0] || null,
    band: bandOf(x.budgets.find(b => b.id === o.budget_id) || null),
    people: { approver: names[o.approver_employee_id] || null, requested_by: names[o.requested_by_employee_id] || null,
      decided_by: names[o.decided_by_employee_id] || null },
    default_cc: cc, mail_from: sender?.email || null });
}

async function getOfferPdfUrl(url, auth, env) {
  const c = await offerCtx(auth, env, url.searchParams.get('id'));
  if (c.res) return c.res;
  if (!canSeeSalary(c.roles)) return err('forbidden', 403);
  if (!c.o.pdf_path) return errCode('no_pdf', 'This revision has not been issued yet', 409);
  await logCompAccess(auth, 'getOfferPdfUrl', null, `${c.o.offer_ref} r${c.o.revision}`, env, { offer_id: c.o.id });
  return signDownload(c.o.pdf_path, `${c.o.offer_ref}-r${c.o.revision}.pdf`, 'application/pdf', env);
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function createOffer(body, auth, env) {
  const d = body.data || body;
  const c = await offerAppCtx(auth, env, d.application_id);
  if (c.res) return c.res;
  const { app, x, me } = c;
  if (!canManageOffers(x.roles)) return err('forbidden — offers are made by the opening\'s hiring owner or reporting manager', 403);
  if (!OFFER_APP_STATUSES.includes(app.status)) return offerErr('application_not_ready', 409);
  const gate = offerOpeningGate(x); if (gate) return gate;
  const key = d.template_key || (x.o.employment_type === 'intern' ? 'internship' : 'employment');
  if (!OFFER_TEMPLATE_KEYS.includes(key)) return err('bad template_key', 400);
  const mode = key === 'internship' ? 'stipend' : 'salary';
  const ct = cleanOfferTerms(d, mode, offerDefaults(x.o));
  if (ct.error) return offerErr(ct.error, 400);
  const [tpl, rs, open, sig] = await Promise.all([
    currentTemplate(env, key), ruleSetFor(env, ct.terms.start_date),
    sb(`/rest/v1/offers?application_id=eq.${app.id}&status=in.(${OFFER_OPEN_STATUSES.join(',')})&select=id&limit=1`, env),
    ct.terms.signatory_id ? sb(`/rest/v1/offer_signatories?id=eq.${ct.terms.signatory_id}&select=active&limit=1`, env) : Promise.resolve(null),
  ]);
  if (open.data?.length) return offerErr('draft_exists', 409);
  if (!tpl) return offerErr('template_missing');
  if (!rs) return offerErr('rule_set_missing');
  if (sig && !sig.data?.[0]?.active) return offerErr('signatory_inactive', 400);
  const b = buildOffer(ct.terms, mode, x.o, rs, currentBudget(x), key);
  if (b.error) return offerErr(b.error);
  // Ref minted (revision 1) or reused + next revision + offer_created event, one transaction (0008).
  const row = { ...b.row, application_id: app.id, opening_id: x.o.id, candidate_id: app.candidate_id, template_id: tpl.id };
  row.terms_hash = await termsHash(row);
  const r = await hiringRpc(env, 'hiring_create_offer', {
    offer: row, year: istToday().slice(0, 4), actor_user_id: auth.userId, actor_employee_id: me?.id || null,
  });
  if (!r.ok) return offerDbError(r);
  return ok({ offer: offerView(r.data?.offer, true), warnings: b.annexure.warnings, amendment: app.status === 'accepted' });
}

async function updateOfferDraft(body, auth, env) {
  const d = body.data || body;
  const c = await offerCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { o, x, me } = c;
  if (!canManageOffers(x.roles)) return err('forbidden', 403);
  if (!OFFER_EDITABLE_STATUSES.includes(o.status)) return offerErr('not_editable', 409);
  const gate = offerOpeningGate(x); if (gate) return gate;
  const key = templateKeyOf(o);
  const ct = cleanOfferTerms({ ...(o.inputs || {}), ...d }, o.mode, offerDefaults(x.o));
  if (ct.error) return offerErr(ct.error, 400);
  const [tpl, rs, sig] = await Promise.all([
    currentTemplate(env, key), ruleSetFor(env, ct.terms.start_date),
    ct.terms.signatory_id ? sb(`/rest/v1/offer_signatories?id=eq.${ct.terms.signatory_id}&select=active&limit=1`, env) : Promise.resolve(null),
  ]);
  if (!tpl) return offerErr('template_missing');
  if (!rs) return offerErr('rule_set_missing');
  if (sig && !sig.data?.[0]?.active) return offerErr('signatory_inactive', 400);
  // Still a draft → re-pin the current template / rule set / band (decision 2: recompute only while draft).
  const b = buildOffer(ct.terms, o.mode, x.o, rs, currentBudget(x), key);
  if (b.error) return offerErr(b.error);
  const patch = { ...b.row, template_id: tpl.id, status: 'draft', approver_employee_id: null, requested_by_employee_id: null,
    decided_by_employee_id: null, decided_at: null, approved_terms_hash: null };
  // New terms → new hash: any submit / approve / render in flight for the old terms now fails 'stale'.
  patch.terms_hash = await termsHash(patch);
  const r = await sb(`/rest/v1/offers?id=eq.${o.id}&status=in.(${OFFER_EDITABLE_STATUSES.join(',')})`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return offerDbError(r);
  if (!r.data?.length) return errCode('stale', 'This offer changed — reload and retry', 409);
  await hiringEvents(env, auth, me, [{ candidate_id: o.candidate_id, opening_id: o.opening_id, application_id: o.application_id,
    event_type: 'offer_updated', from_status: o.status, to_status: 'draft', detail: { offer_id: o.id, offer_ref: o.offer_ref, revision: o.revision } }]);
  return ok({ offer: offerView(r.data[0], true), warnings: b.annexure.warnings });
}

// draft → ready (in band / below band: render now) or → pending_approval (above band / extras).
// approved → ready re-tries the render when the approval's render step failed.
async function submitOffer(body, auth, env) {
  const d = body.data || body;
  const c = await offerCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { o, x, me, edges } = c;
  if (!canManageOffers(x.roles)) return err('forbidden', 403);
  if (!['draft', 'approved'].includes(o.status)) return errCode('invalid_transition', `Cannot submit an offer that is ${o.status}`, 409);
  const gate = offerOpeningGate(x); if (gate) return gate;
  const app = await loadApplication(env, o.application_id);
  if (!OFFER_APP_STATUSES.includes(app?.status)) return offerErr('application_not_ready', 409);
  if (o.status === 'approved') return issueOffer(env, auth, me, o, 'approved');
  if (!o.signatory_id) return offerErr('signatory_required');
  // The band may have moved since the draft was saved: check against the CURRENT approved band.
  const budget = currentBudget(x);
  const check = bandCheck(Number(o.total_ctc), [o.joining_bonus, o.retention_bonus], bandOf(budget));
  const set = { band_check: check, budget_id: budget.id, requested_by_employee_id: me?.id || null,
    decided_by_employee_id: null, decided_at: null, decision_note: null };
  if (!needsApproval(check)) return issueOffer(env, auth, me, o, 'draft', set);
  const founders = await loadFounders(env);
  const approver = resolveApprover(edges, founders, x.o.reporting_manager_employee_id, me?.id || null, x.o.hiring_owner_employee_id);
  if (!approver) return err('no_approver — could not resolve an offer approver', 500);
  const r = await offerTransition(env, auth, me, o, 'draft', 'pending_approval', {
    set: { ...set, approver_employee_id: approver }, event_type: 'offer_submitted',
  });
  if (!r.ok) return transitionFailed(r);
  return ok({ id: o.id, status: 'pending_approval', approver_employee_id: approver });
}

async function decideOffer(body, auth, env) {
  const d = body.data || body;
  if (!['approve', 'reject'].includes(d.decision)) return err("decision must be 'approve' or 'reject'", 400);
  const o = await loadOffer(env, d.id);
  if (!o) return err('not_found', 404);
  if (o.status !== 'pending_approval') return errCode('not_pending', 'This offer is no longer pending approval', 409);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const founders = await loadFounders(env);
  const isFounder = !!auth.isSuperAdmin && !!me && founders.includes(me.id);
  const bad = checkBandDecider(me?.id || null, isFounder, o);
  if (bad === 'no_self_approval') return errCode('no_self_approval', 'You submitted this offer, so someone else has to approve it', 403);
  if (bad) return err('forbidden — only the approver can decide this offer', 403);
  const note = String(d.note || '').trim() || null;
  const set = { decided_by_employee_id: me.id, decided_at: nowIso(), decision_note: note };
  if (d.decision === 'approve') {
    // Approving issues the letter at once: the application must still be live and the opening open.
    const [app, x] = await Promise.all([loadApplication(env, o.application_id), loadOneOpening(auth, me, env, o.opening_id)]);
    if (!OFFER_APP_STATUSES.includes(app?.status)) return offerErr('application_not_ready', 409);
    if (!x) return err('not_found', 404);
    const gate = offerOpeningGate(x); if (gate) return gate;
  }
  if (d.decision === 'reject') {
    const r = await offerTransition(env, auth, me, o, 'pending_approval', 'approval_rejected', { set, event_type: 'offer_rejected', event_note: note });
    if (!r.ok) return transitionFailed(r);
    return ok({ id: o.id, status: 'approval_rejected' });
  }
  const r = await offerTransition(env, auth, me, o, 'pending_approval', 'approved', { set, event_type: 'offer_approved', event_note: note });
  if (!r.ok) return transitionFailed(r);
  // Approved → render + store + ready straight away. A render failure leaves it `approved`;
  // the hiring owner's Submit re-tries the render (submitOffer from `approved`).
  const issued = await issueOffer(env, auth, me, r.data.offer, 'approved');
  if (issued.status !== 200) return ok({ id: o.id, status: 'approved', render_error: (await issued.json())?.error || 'render_failed' });
  // Metadata only — deciding does not grant salary visibility (a founder override may be off the chain).
  return ok({ id: o.id, status: 'ready' });
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

async function markOfferSent(body, auth, env) {
  const d = body.data || body;
  const c = await offerCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { o, x, me } = c;
  if (!canManageOffers(x.roles)) return err('forbidden', 403);
  if (o.status !== 'ready') return errCode('invalid_transition', `Only a ready offer can be marked as sent (this one is ${o.status})`, 409);
  if (!canSendOffer(o)) return offerErr('not_approved_for_terms', 409);
  const gate = offerOpeningGate(x); if (gate) return gate;
  const app = await loadApplication(env, o.application_id);
  if (!OFFER_APP_STATUSES.includes(app?.status)) return offerErr('application_not_ready', 409);
  const to = String(d.sent_to || '').trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return err('sent_to must be an email address', 400);
  const cc = (Array.isArray(d.sent_cc) ? d.sent_cc : String(d.sent_cc || '').split(/[,;\s]+/))
    .map(e => String(e).trim().toLowerCase()).filter(Boolean);
  if (cc.length > 20 || cc.some(e => !EMAIL_RE.test(e))) return err('sent_cc must be up to 20 email addresses', 400);
  let sentAt = nowIso();
  if (d.sent_at) {
    const t = new Date(d.sent_at);
    if (Number.isNaN(t.getTime()) || t.getTime() > Date.now() + 5 * 60000) return err('bad sent_at', 400);
    sentAt = t.toISOString();
  }
  const sentDay = istToday(new Date(sentAt).getTime());
  if (o.issue_date && sentDay < o.issue_date) return err('sent_at is before the issue date', 400);
  // Validity runs from the send (default valid_days), never shorter than what the letter already says.
  let validUntil = addDaysIso(sentDay, Number(o.inputs?.valid_days || 7));
  if (o.valid_until && o.valid_until > validUntil) validUntil = o.valid_until;
  if (d.valid_until) {
    if (!isIsoDate(d.valid_until) || d.valid_until < sentDay) return err('bad valid_until', 400);
    validUntil = d.valid_until;
  }
  let evidence = null;
  if (d.evidence_storage_path) {
    if (checkOfferDocPath(d.evidence_storage_path, o.candidate_id, o.offer_ref, o.revision, 'sent_evidence')) return err('bad storage_path', 400);
    const fe = checkFileSize(d.file_size);
    if (fe) return err('file_size must be a positive integer up to 15 MB', 400);
    evidence = { storage_path: d.evidence_storage_path, file_name: d.file_name || null, mime_type: d.mime_type || 'application/pdf',
      file_size: Number(d.file_size), title: `${o.offer_ref} r${o.revision} — as sent` };
  }
  // ready → sent + supersede the application's other ready/sent revisions + application → offer, one
  // transaction (0008).
  const r = await offerTransition(env, auth, me, o, 'ready', 'sent', {
    set: { sent_at: sentAt, sent_by: auth.userId, sent_to: to, sent_cc: cc, valid_until: validUntil },
    evidence_doc: evidence, app_status: 'offer', event_type: 'offer_sent',
  });
  if (!r.ok) return transitionFailed(r);
  return ok({ id: o.id, status: 'sent', valid_until: validUntil, application_status: r.data?.application_status, superseded: r.data?.superseded || [] });
}

async function recordOfferAcceptance(body, auth, env) {
  const d = body.data || body;
  const c = await offerCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { o, x, me } = c;
  if (!canManageOffers(x.roles)) return err('forbidden', 403);
  // From `expired` too: a signed copy dated inside the validity counts even if it is recorded late.
  if (!['sent', 'expired'].includes(o.status)) return errCode('invalid_transition', `Only a sent offer can be accepted (this one is ${o.status})`, 409);
  if (!isIsoDate(d.accepted_at)) return err('accepted_at (YYYY-MM-DD) required', 400);
  if (d.accepted_at > istToday()) return err('accepted_at is in the future', 400);
  if (o.issue_date && d.accepted_at < o.issue_date) return err('accepted_at is before the issue date', 400);
  if (o.valid_until && d.accepted_at > o.valid_until) return offerErr('offer_expired', 409);
  if (checkOfferDocPath(d.signed_storage_path, o.candidate_id, o.offer_ref, o.revision, 'signed')) return err('signed copy required (bad storage_path)', 400);
  if (checkFileSize(d.file_size)) return err('file_size must be a positive integer up to 15 MB', 400);
  const [app, sib] = await Promise.all([
    loadApplication(env, o.application_id),
    sb(`/rest/v1/offers?application_id=eq.${o.application_id}&select=id,revision,sent_at`, env),
  ]);
  if (!['offer', 'accepted'].includes(app?.status)) return offerErr('application_not_ready', 409);
  // Only the newest revision ever sent can be accepted (the RPC enforces it again under lock).
  if (!isLatestSent(sib.data || [], o.id)) return offerErr('not_latest', 409);
  const r = await offerTransition(env, auth, me, o, ['sent', 'expired'], 'accepted', {
    set: { accepted_at: d.accepted_at },
    acceptance_doc: { storage_path: d.signed_storage_path, file_name: d.file_name || null, mime_type: d.mime_type || 'application/pdf',
      file_size: Number(d.file_size), title: `${o.offer_ref} r${o.revision} — signed` },
    app_status: 'accepted', event_type: 'offer_accepted',
  });
  if (!r.ok) return transitionFailed(r);
  // Headcount: warn (not block) once accepted offers on the opening reach it.
  const ar = await sb(`/rest/v1/offers?opening_id=eq.${o.opening_id}&status=eq.accepted&select=id`, env);
  const accepted = (ar.data || []).length;
  const headcount = Number(x.o.headcount || 1);
  return ok({ id: o.id, status: 'accepted', application_status: r.data?.application_status,
    accepted_on_opening: accepted, headcount, warnings: accepted > headcount ? ['headcount_exceeded'] : (accepted === headcount ? ['headcount_full'] : []) });
}

async function recordOfferDecline(body, auth, env) {
  const d = body.data || body;
  const c = await offerCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { o, x, me } = c;
  if (!canManageOffers(x.roles)) return err('forbidden', 403);
  if (!['sent', 'expired'].includes(o.status)) return errCode('invalid_transition', `Only a sent offer can be declined (this one is ${o.status})`, 409);
  const note = String(d.note || '').trim() || null;
  const r = await offerTransition(env, auth, me, o, ['sent', 'expired'], 'declined', {
    set: { declined_at: nowIso(), outcome_note: note }, event_type: 'offer_declined', event_note: note,
  });
  if (!r.ok) return transitionFailed(r);
  return ok({ id: o.id, status: 'declined' });
}

async function withdrawOffer(body, auth, env) {
  const d = body.data || body;
  const reason = String(d.reason || '').trim();
  if (!reason) return errCode('reason_required', 'A reason is required to withdraw an offer', 400);
  const c = await offerCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { o, x, me } = c;
  if (!canManageOffers(x.roles)) return err('forbidden', 403);
  if (!OFFER_WITHDRAWABLE.includes(o.status)) return errCode('invalid_transition', `Cannot withdraw an offer that is ${o.status}`, 409);
  const r = await offerTransition(env, auth, me, o, o.status, 'withdrawn', {
    set: { outcome_note: reason }, event_type: 'offer_withdrawn', event_note: reason,
  });
  if (!r.ok) return transitionFailed(r);
  return ok({ id: o.id, status: 'withdrawn' });
}

async function createOfferDocUploadUrl(body, auth, env) {
  const d = body.data || body;
  if (!OFFER_DOC_KINDS.includes(d.kind)) return err("kind must be 'sent_evidence' or 'signed'", 400);
  const fe = fileOk(d.file_name, ['pdf'], d.file_size);
  if (fe) return err(fe === 'bad_file_type' ? 'Upload a PDF' : fe, 400);
  const c = await offerCtx(auth, env, d.offer_id);
  if (c.res) return c.res;
  if (!canManageOffers(c.x.roles)) return err('forbidden', 403);
  return signUpload(offerDocPath(c.o.candidate_id, c.o.offer_ref, c.o.revision, d.kind), env);
}

// ────────────────────────────────────────────────────────────────────────────
// HIRING O1 — the offer email + the candidate's acceptance link. Plan: docs/superpowers/plans/2026-11-12-podium-o1-offer-link.md
// Mail goes out through Gmail as the opening's hiring owner (else reporting manager) — never an address from
// the caller (D1). Every send is an intent row first (offer_emails 'sending'), then Gmail, then sent / failed /
// unknown; reconcileOfferEmails settles the in-between by searching the sender's mailbox for our Message-ID (D8).
// The link carries a 32-byte token; only its SHA-256 is stored. /public/offer* sits before the JWT gate.
// ────────────────────────────────────────────────────────────────────────────

const PODIUM_APP_URL = 'https://podium.legendoftoys.com';
const podiumAppUrl = (env) => String(env.PODIUM_APP_URL || PODIUM_APP_URL).replace(/\/+$/, '');
const offerLinkUrl = (env, token) => `${podiumAppUrl(env)}/offer/?t=${encodeURIComponent(token)}`;
const staffOfferUrl = (env, offerId) => `${podiumAppUrl(env)}/hiring/offer/?id=${offerId}`;
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';   // already on the shared SA's DWD list
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const LINK_DOC_OPEN_DAYS = 7;             // D7: the documents step stays open until start_date + 7
const HEADCOUNT_FULL_NOTICE = "Thank you — we'll be in touch shortly.";

// Per-mailbox token cache, per isolate (a token is good for an hour).
const gmailTokens = new Map();
// A failed read (e.g. before 0012 is applied) reads as no rows, so getOffer keeps working for C3.
const rowsOf = (r) => (r?.ok && Array.isArray(r.data) ? r.data : []);
async function gmailToken(env, mailbox) {
  const hit = gmailTokens.get(mailbox);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  const token = await googleAccessToken(env, { scope: GMAIL_SCOPE, sub: mailbox });
  gmailTokens.set(mailbox, { token, exp: Date.now() + 3300 * 1000 });
  return token;
}

// → { ok, id, threadId } | { ok: false, definite, status, error }. definite = Gmail answered, so the mail
// certainly did not go; a throw / timeout / 5xx is NOT definite (it may have gone) → the row goes 'unknown'.
async function gmailSend(env, senderEmail, raw, threadId = null) {
  let token;
  try { token = await gmailToken(env, senderEmail); }
  catch (e) { return { ok: false, definite: true, status: 0, error: `token: ${String(e?.message || e).slice(0, 300)}` }; }
  const attempt = async (tid) => {
    let res;
    try {
      res = await fetch(`${GMAIL_BASE}/messages/send`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: b64urlStr(raw), ...(tid ? { threadId: tid } : {}) }), signal: AbortSignal.timeout(25000),
      });
    } catch (e) { return { ok: false, definite: false, status: 0, error: String(e?.message || e).slice(0, 300) }; }
    const d = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: d.id || null, threadId: d.threadId || null };
    return { ok: false, definite: res.status < 500, status: res.status, error: String(d?.error?.message || `HTTP ${res.status}`).slice(0, 500) };
  };
  const r = await attempt(threadId);
  // A thread that no longer exists in that mailbox: Gmail refused the whole send, so send it unthreaded.
  if (!r.ok && r.definite && threadId && [400, 404].includes(r.status)) return attempt(null);
  return r;
}

// → { found, id, threadId } | { error }. Searches the sender's own mailbox for our Message-ID.
async function gmailFindByMessageId(env, senderEmail, messageId) {
  try {
    const token = await gmailToken(env, senderEmail);
    const q = `rfc822msgid:${String(messageId).replace(/^<|>$/g, '')}`;
    const res = await fetch(`${GMAIL_BASE}/messages?q=${encodeURIComponent(q)}&includeSpamTrash=true&maxResults=1`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return { error: d?.error?.message || `HTTP ${res.status}` };
    const m = (d.messages || [])[0];
    return m ? { found: true, id: m.id, threadId: m.threadId || null } : { found: false };
  } catch (e) { return { error: String(e?.message || e) }; }
}

// D1: the mailbox an offer goes out from = the hiring owner's work_email, else the reporting manager's.
async function offerSender(env, opening) {
  const ids = [opening?.hiring_owner_employee_id, opening?.reporting_manager_employee_id].filter(Boolean);
  if (!ids.length) return null;
  const r = await sb(`/rest/v1/employees?id=in.(${ids.join(',')})&select=id,full_name,preferred_name,work_email,status`, env);
  const by = Object.fromEntries((r.data || []).map(e => [e.id, e]));
  for (const id of ids) {
    const e = by[id];
    const m = String(e?.work_email || '').trim().toLowerCase();
    if (e && e.status !== 'exited' && m.endsWith(`@${WORK_DOMAIN}`) && addressOk(m)) {
      return { email: m, name: e.full_name, first: String(e.preferred_name || '').trim() || firstName(e.full_name) };
    }
  }
  return null;
}
async function loadOpeningRow(env, id) {
  return (await sb(`/rest/v1/openings?id=eq.${id}&select=id,opening_code,hiring_owner_employee_id,reporting_manager_employee_id,headcount&limit=1`, env)).data?.[0] || null;
}

// D9 / review M: reply in the application's thread in THIS mailbox (thread ids are per mailbox). Candidate mails
// thread only on candidate mails; copies / alerts on earlier internal mails, else on the candidate thread.
async function offerThread(env, applicationId, senderEmail, kind) {
  for (const kinds of threadKindsFor(kind)) {
    const r = await sb(`/rest/v1/offer_emails?application_id=eq.${applicationId}&sender_email=eq.${encodeURIComponent(senderEmail)}`
      + `&kind=in.(${kinds.join(',')})&status=eq.sent&gmail_thread_id=not.is.null&select=gmail_thread_id,message_id_header`
      + `&order=created_at.desc&limit=1`, env);
    const t = rowsOf(r)[0];
    if (t) return { threadId: t.gmail_thread_id, inReplyTo: t.message_id_header };
  }
  return { threadId: null, inReplyTo: null };
}

async function storageBytes(env, path) {
  const seg = String(path).split('/').map(encodeURIComponent).join('/');
  try {
    const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/authenticated/${DOC_BUCKET}/${seg}`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch (_e) { return null; }
}
async function signedUrl(env, path, secs) {
  const seg = String(path).split('/').map(encodeURIComponent).join('/');
  const sr = await storageFetch(`/object/sign/${DOC_BUCKET}/${seg}`, env, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: secs }) });
  return sr.ok && sr.data?.signedURL ? `${env.SUPABASE_URL}/storage/v1${sr.data.signedURL}` : null;
}

// Validity from the send day (default valid_days), never shorter than the letter already says (= markOfferSent).
function sendValidUntil(o, sentDay) {
  let v = addDaysIso(sentDay, Number(o.inputs?.valid_days || 7));
  if (o.valid_until && o.valid_until > v) v = o.valid_until;
  return v;
}

// D8 — intent → Gmail → status. → { row, status: 'sent'|'failed'|'unknown' } | { status: 'refused'|'busy'|'db_error', error }
// 'busy' = a partial unique index refused the intent (an unresolved offer mail, a confirmation or a copy already
// exists) → nothing was sent. failWith = record the row as `failed` with that error and do NOT call Gmail (F).
// The caller runs afterOfferMailSent for a sent 'offer' mail (after its copy, so offers.sent_cc is right).
async function deliverOfferMail(env, { offer, kind, sender, to, cc = [], subject, text, html, attachments = [], createdBy = null,
  tokenHash = null, copyTo = [], parentId = null, failWith = null }) {
  const id = crypto.randomUUID();
  const messageId = offerMessageId(id);
  let mime = null, th = { threadId: null, inReplyTo: null };
  if (!failWith) {
    th = await offerThread(env, offer.application_id, sender.email, kind);
    mime = buildOfferMime({ from: sender.email, fromName: sender.name, to, cc, subject, text, html, messageId,
      inReplyTo: th.inReplyTo, attachments });
    if (mime.error) return { status: 'refused', error: mime.error };
  }
  const ins = await sb(`/rest/v1/offer_emails`, env, { method: 'POST', body: JSON.stringify([{
    id, offer_id: offer.id, application_id: offer.application_id, kind, status: failWith ? 'failed' : 'sending',
    error: failWith ? String(failWith).slice(0, 1000) : null, sender_email: sender?.email || '', to_email: to || '', cc_emails: cc,
    copy_to: copyTo, parent_email_id: parentId, subject, message_id_header: messageId, token_hash: tokenHash, created_by: createdBy }]) });
  if (!ins.ok) {
    if (ins.status === 409 || ins.data?.code === '23505') return { status: 'busy', error: 'send_pending' };
    return { status: 'db_error', error: [ins.data?.code, ins.data?.message].filter(Boolean).join(' ') || String(ins.status) };
  }
  const row = ins.data[0];
  if (failWith) return { row, status: 'failed', error: row.error };
  const g = await gmailSend(env, sender.email, mime.raw, th.threadId);
  const patch = g.ok ? { status: 'sent', gmail_message_id: g.id, gmail_thread_id: g.threadId, sent_at: nowIso(), error: null }
    : g.definite ? { status: 'failed', error: g.error } : { status: 'unknown', error: g.error };
  await sb(`/rest/v1/offer_emails?id=eq.${row.id}&status=eq.sending`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
  return { row: { ...row, ...patch }, status: patch.status, error: patch.error || null };
}

// The link-free copy of a sent offer mail for the people who were to be CC'd (A). Recorded, never blocks; one per
// parent (offer_emails_one_copy). → deliverOfferMail's result | null when there is nobody to copy.
async function sendOfferCopy(env, parent, o) {
  if (!(parent.copy_to || []).length) return null;
  try {
    const opening = await loadOpeningRow(env, o.opening_id);
    const sender = opening ? await offerSender(env, opening) : null;
    if (!sender || sender.email !== parent.sender_email) return null;   // owner changed since: skip, the parent stands
    const [cr, pdf] = await Promise.all([
      sb(`/rest/v1/candidates?id=eq.${o.candidate_id}&select=full_name&limit=1`, env),
      o.pdf_path ? storageBytes(env, o.pdf_path) : Promise.resolve(null),
    ]);
    const mail = renderOfferCopyEmail({ candidateName: rowsOf(cr)[0]?.full_name || null, candidateEmail: parent.to_email,
      designation: o.designation, startDate: o.start_date, validUntil: o.valid_until, staffUrl: staffOfferUrl(env, o.id),
      revised: Number(o.revision) > 1 });
    return await deliverOfferMail(env, { offer: o, kind: 'offer_copy', sender, to: sender.email, cc: parent.copy_to,
      subject: offerSubject(o.designation), text: mail.text, html: mail.html, parentId: parent.id, createdBy: parent.created_by,
      attachments: pdf ? [{ filename: `${o.offer_ref}-r${o.revision}.pdf`, mime: 'application/pdf', bytes: pdf }] : [] });
  } catch (e) {
    console.error('[offer-copy]', e?.message || e);
    return null;
  }
}

// An offer mail is out: older links of the same revision die (D6), and the revision moves to `sent` (D8.4).
// Copies first (A) — a copy failure is recorded on its own row and never blocks.
async function afterOfferMailSent(env, e) {
  const o = await loadOffer(env, e.offer_id);
  if (o) await sendOfferCopy(env, e, o);
  await sb(`/rest/v1/offer_emails?offer_id=eq.${e.offer_id}&kind=eq.offer&id=neq.${e.id}&link_revoked_at=is.null`
    + `&created_at=lt.${encodeURIComponent(e.created_at)}`, env, { method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ link_revoked_at: nowIso() }) });
  return finishOfferSend(env, e.offer_id);
}

// Idempotent: a `ready` revision whose offer mail is `sent` → the C3 ready → sent step, with markOfferSent's set.
// Runs right after a send and from reconcile, so a transition that failed after the mail left heals on the next view.
async function finishOfferSend(env, offerId) {
  const o = await loadOffer(env, offerId);
  if (!o || o.status !== 'ready') return null;
  const er = await sb(`/rest/v1/offer_emails?offer_id=eq.${o.id}&kind=eq.offer&status=eq.sent&select=*&order=created_at.desc&limit=1`, env);
  const e = er.data?.[0];
  if (!e) return null;
  const actorEmp = e.created_by
    ? (await sb(`/rest/v1/employees?auth_user_id=eq.${e.created_by}&select=id&limit=1`, env)).data?.[0]?.id || null : null;
  return hiringRpc(env, 'hiring_offer_transition', {
    offer_id: o.id, expected_status: 'ready', to_status: 'sent',
    set: { sent_at: e.sent_at || e.created_at, sent_by: e.created_by, sent_to: e.to_email, sent_cc: e.copy_to || [],
      valid_until: sendValidUntil(o, istToday(Date.parse(e.created_at))) },
    evidence_doc: null, acceptance_doc: null, app_status: 'offer', event_type: 'offer_sent', event_note: null,
    expected_terms_hash: o.terms_hash, actor_user_id: e.created_by, actor_employee_id: actorEmp,
  });
}

// D8.3 — settle 'unknown' rows and stuck 'sending' rows by asking the sender's mailbox. → true when anything moved.
async function reconcileOfferEmails(env, o) {
  const r = await sb(`/rest/v1/offer_emails?offer_id=eq.${o.id}&status=in.(sending,unknown)&select=*`, env);
  const now = Date.now();
  const due = rowsOf(r).filter(e => reconcileDue(e, now));
  let changed = false;
  if (due.length && env.GOOGLE_SA_JSON) {
    const found = await Promise.all(due.map(e => gmailFindByMessageId(env, e.sender_email, e.message_id_header)));
    const settled = await Promise.all(due.map(async (e, i) => {
      const f = found[i];
      if (f.error) return null;
      // A hit → sent; a miss → unknown (+1), and failed only on the second miss ≥ 2 minutes after the first.
      const patch = reconcileDecision(e, f, now);
      const guard = e.last_reconciled_at ? `&last_reconciled_at=eq.${encodeURIComponent(e.last_reconciled_at)}` : '&last_reconciled_at=is.null';
      const pr = await sb(`/rest/v1/offer_emails?id=eq.${e.id}&status=eq.${e.status}${guard}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
      return pr.ok && pr.data?.length ? { ...e, ...patch } : null;
    }));
    for (const e of settled.filter(Boolean)) {
      if (e.status === 'unknown') continue;
      changed = true;
      if (e.status === 'sent' && e.kind === 'offer') await afterOfferMailSent(env, e);
    }
  }
  if (!changed && o.status === 'ready') {
    const fr = await finishOfferSend(env, o.id);
    if (fr?.ok) changed = true;
  }
  return changed;
}

// ── Staff: send / resend the offer by email ──────────────────────────────────

// POST sendOfferEmail {id, sent_to?, sent_cc?} — a `ready` revision, or a `sent` one again (same revision: a wrong
// address, a lost mail). Same gates as markOfferSent; the issued PDF is attached; a fresh link every time.
async function sendOfferEmail(body, auth, env) {
  const d = body.data || body;
  const c = await offerCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { x } = c;
  let o = c.o;
  if (!canManageOffers(x.roles)) return err('forbidden', 403);
  if (!env.GOOGLE_SA_JSON) return offerErr('mail_not_configured', 503);
  if (await reconcileOfferEmails(env, o)) o = (await loadOffer(env, o.id)) || o;
  if (o.status === 'ready') {
    if (!canSendOffer(o)) return offerErr('not_approved_for_terms', 409);
    const gate = offerOpeningGate(x); if (gate) return gate;
  } else if (o.status === 'sent') {
    if (o.valid_until && o.valid_until < istToday()) return offerErr('offer_expired', 409);
  } else {
    return errCode('invalid_transition', `Only a ready offer can be emailed, or a sent one re-sent (this one is ${o.status})`, 409);
  }
  const app = await loadApplication(env, o.application_id);
  if (!OFFER_APP_STATUSES.includes(app?.status)) return offerErr('application_not_ready', 409);
  // C: reconcile ran above; an offer mail still unresolved blocks a new send (the index enforces it again).
  const [pend, cr] = await Promise.all([
    sb(`/rest/v1/offer_emails?offer_id=eq.${o.id}&kind=eq.offer&status=in.(sending,unknown)&select=id&limit=1`, env),
    sb(`/rest/v1/candidates?id=eq.${o.candidate_id}&select=full_name,email&limit=1`, env),
  ]);
  if (!pend.ok) return err('db_error', 500);
  if (pend.data?.length) return offerErr('send_pending', 409);
  const cand = cr.data?.[0] || null;
  const to = String(d.sent_to ?? cand?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return err('sent_to must be an email address', 400);
  const cc = d.sent_cc === undefined || d.sent_cc === null ? await offerDefaultCc(env, x)
    : (Array.isArray(d.sent_cc) ? d.sent_cc : String(d.sent_cc || '').split(/[,;\s]+/)).map(e => String(e).trim().toLowerCase()).filter(Boolean);
  if (cc.length > 20 || cc.some(e => !EMAIL_RE.test(e))) return err('sent_cc must be up to 20 email addresses', 400);
  const sender = await offerSender(env, x.o);
  if (!sender) return offerErr('no_sender_mailbox', 409);
  if (!o.pdf_path) return offerErr('pdf_missing', 409);
  const pdf = await storageBytes(env, o.pdf_path);
  if (!pdf) return offerErr('pdf_missing', 502);
  if ((await sha256Hex(pdf)) !== o.pdf_sha256) return offerErr('pdf_hash_mismatch', 409);

  const token = newLinkToken();
  const validUntil = o.status === 'ready' ? sendValidUntil(o, istToday()) : o.valid_until;
  const mail = renderOfferEmail({ candidateFirst: firstName(cand?.full_name), designation: o.designation, startDate: o.start_date,
    validUntil, link: offerLinkUrl(env, token), revised: Number(o.revision) > 1, ownerName: sender.name });
  // A: the link-bearing mail goes To the candidate only; the CC list gets a link-free copy after it is sent.
  const split = splitOfferRecipients({ to, cc, sender: sender.email });
  const res = await deliverOfferMail(env, { offer: o, kind: 'offer', sender, to: split.candidate.to, cc: [],
    copyTo: split.copy?.cc || [], subject: offerSubject(o.designation), text: mail.text, html: mail.html,
    attachments: [{ filename: `${o.offer_ref}-r${o.revision}.pdf`, mime: 'application/pdf', bytes: pdf }],
    createdBy: auth.userId, tokenHash: await hashLinkToken(token) });
  if (res.status === 'refused') return err(res.error, 400);
  if (res.status === 'busy') return offerErr('send_pending', 409);
  if (res.status === 'db_error') return err(`db_error: ${res.error}`, 500);
  if (res.status === 'failed') {
    return json({ ok: false, error: 'mail_failed', message: `${OFFER_COPY.mail_failed}: ${res.error}`, email_id: res.row.id }, 502);
  }
  if (res.status === 'sent') await afterOfferMailSent(env, res.row);   // copy + revoke older links + ready → sent
  const [fresh, cpr] = await Promise.all([
    loadOffer(env, o.id),
    sb(`/rest/v1/offer_emails?parent_email_id=eq.${res.row.id}&kind=eq.offer_copy&select=id,status,cc_emails&order=created_at.desc&limit=1`, env),
  ]);
  const copy = rowsOf(cpr)[0] || null;
  return ok({ id: o.id, status: (fresh || o).status, valid_until: (fresh || o).valid_until ?? validUntil,
    email: { id: res.row.id, status: res.status, sender_email: sender.email, to_email: split.candidate.to, copy_to: res.row.copy_to },
    copy: copy ? { id: copy.id, status: copy.status, cc_emails: copy.cc_emails } : null });
}

// The confirmation after a link acceptance. To = the to_email of the EXACT offer mail whose link was used
// (offer_acceptances.token_hash); no CC and no link (A) — the CC list gets a link-free confirmation_copy. One per
// offer (offer_emails_one_confirmation: a conflict = skip, never a second Gmail call — D). No certificate bytes →
// a `failed` row and no Gmail call (F), retryable through resendOfferConfirmation.
// → deliverOfferMail's result (+ copy) | { status: 'refused', error }.
async function sendOfferConfirmation(env, o, createdBy) {
  const [ar, opening, cr, dr] = await Promise.all([
    sb(`/rest/v1/offer_acceptances?offer_id=eq.${o.id}&select=token_hash&limit=1`, env),
    loadOpeningRow(env, o.opening_id),
    sb(`/rest/v1/candidates?id=eq.${o.candidate_id}&select=full_name&limit=1`, env),
    o.acceptance_doc_id ? sb(`/rest/v1/candidate_documents?id=eq.${o.acceptance_doc_id}&select=storage_path,file_name&limit=1`, env) : Promise.resolve({ ok: true, data: [] }),
  ]);
  const th = rowsOf(ar)[0]?.token_hash;
  if (!th) return { status: 'refused', error: 'not_link_accepted' };
  const lr = await sb(`/rest/v1/offer_emails?token_hash=eq.${th}&kind=eq.offer&select=id,to_email,copy_to&limit=1`, env);
  const linkMail = rowsOf(lr)[0];
  const to = String(linkMail?.to_email || '').trim().toLowerCase();
  const sender = opening ? await offerSender(env, opening) : null;
  if (!sender) return { status: 'refused', error: 'no_sender_mailbox' };
  if (!EMAIL_RE.test(to)) return { status: 'refused', error: 'no recipient' };
  const cand = rowsOf(cr)[0], doc = rowsOf(dr)[0];
  const subject = offerSubject(o.designation);
  const pdf = doc?.storage_path ? await storageBytes(env, doc.storage_path) : null;
  if (!pdf) {
    return deliverOfferMail(env, { offer: o, kind: 'confirmation', sender, to, subject, text: '', html: '', createdBy,
      failWith: !doc ? 'The accepted offer document could not be found' : 'The accepted offer PDF could not be read from storage' });
  }
  const filename = doc.file_name || `${o.offer_ref}-r${o.revision}-accepted.pdf`;
  const attachments = [{ filename, mime: 'application/pdf', bytes: pdf }];
  const mail = renderConfirmationEmail({ candidateFirst: firstName(cand?.full_name), designation: o.designation, joinDate: o.start_date,
    ownerName: sender.name });
  const res = await deliverOfferMail(env, { offer: o, kind: 'confirmation', sender, to, cc: [], subject, text: mail.text, html: mail.html,
    attachments, createdBy, copyTo: linkMail.copy_to || [] });
  if (res.status === 'sent' && (linkMail.copy_to || []).length) {
    try {
      const cm = renderConfirmationCopyEmail({ candidateName: cand?.full_name || null, candidateEmail: to, designation: o.designation,
        joinDate: o.start_date, staffUrl: staffOfferUrl(env, o.id) });
      res.copy = await deliverOfferMail(env, { offer: o, kind: 'confirmation_copy', sender, to: sender.email,
        cc: linkMail.copy_to.filter(e => e !== sender.email && e !== to), subject, text: cm.text, html: cm.html, attachments,
        parentId: res.row.id, createdBy });
    } catch (e) { console.error('[confirmation-copy]', e?.message || e); }
  }
  return res;
}

// An internal alert (decline / question / blocked acceptance): from the sender mailbox to itself, CC the reporting
// manager + hr@, in the application's thread. A failure is recorded on the row, never thrown.
async function sendOfferAlert(env, o, kind, { reason = null, text = null, proposedDate = null } = {}) {
  try {
    const opening = await loadOpeningRow(env, o.opening_id);
    const sender = opening ? await offerSender(env, opening) : null;
    if (!sender) return null;
    const [mr, cr] = await Promise.all([
      opening.reporting_manager_employee_id
        ? sb(`/rest/v1/employees?id=eq.${opening.reporting_manager_employee_id}&select=work_email&limit=1`, env) : Promise.resolve({ data: [] }),
      sb(`/rest/v1/candidates?id=eq.${o.candidate_id}&select=full_name&limit=1`, env),
    ]);
    const cc = [...new Set([String(mr.data?.[0]?.work_email || '').trim().toLowerCase(), ...OFFER_CC_ALWAYS])]
      .filter(e => e && e !== sender.email && addressOk(e));
    const mail = renderAlertEmail({ kind, candidateName: cr.data?.[0]?.full_name || null, offerRef: o.offer_ref, revision: o.revision,
      reason, text, proposedDate, appUrl: `${podiumAppUrl(env)}/hiring/offer/?id=${o.id}` });
    return await deliverOfferMail(env, { offer: o, kind: 'alert', sender, to: sender.email, cc, subject: offerSubject(o.designation),
      text: mail.text, html: mail.html });
  } catch (e) {
    console.error('[offer-alert]', e?.message || e);
    return null;
  }
}

// POST resendOfferConfirmation {id} — an offer accepted through the link whose confirmation mail is missing or failed.
async function resendOfferConfirmation(body, auth, env) {
  const d = body.data || body;
  const c = await offerCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { o, x } = c;
  if (!canManageOffers(x.roles)) return err('forbidden', 403);
  if (!env.GOOGLE_SA_JSON) return offerErr('mail_not_configured', 503);
  if (o.status !== 'accepted') return errCode('invalid_transition', `Only an accepted offer gets a confirmation (this one is ${o.status})`, 409);
  await reconcileOfferEmails(env, o);
  const [ar, er] = await Promise.all([
    sb(`/rest/v1/offer_acceptances?offer_id=eq.${o.id}&select=id&limit=1`, env),
    sb(`/rest/v1/offer_emails?offer_id=eq.${o.id}&kind=eq.confirmation&status=in.(sending,sent,unknown)&select=id&limit=1`, env),
  ]);
  if (!ar.data?.length) return offerErr('not_link_accepted', 409);
  if (er.data?.length) return offerErr('confirmation_exists', 409);
  const res = await sendOfferConfirmation(env, o, auth.userId);
  if (res.status === 'refused') return ['no_sender_mailbox', 'not_link_accepted'].includes(res.error) ? offerErr(res.error, 409) : err(res.error, 400);
  if (res.status === 'busy') return offerErr('confirmation_exists', 409);
  if (res.status === 'db_error') return err(`db_error: ${res.error}`, 500);
  if (res.status === 'failed') return json({ ok: false, error: 'mail_failed', message: `${OFFER_COPY.mail_failed}: ${res.error}`, email_id: res.row.id }, 502);
  return ok({ id: o.id, email: { id: res.row.id, status: res.status },
    copy: res.copy?.row ? { id: res.copy.row.id, status: res.copy.status } : null });
}

// ── Staff: responses, joining documents, bank ────────────────────────────────

// POST markOfferResponseSeen {response_id}
async function markOfferResponseSeen(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.response_id)) return err('response_id required', 400);
  const rr = await sb(`/rest/v1/offer_responses?id=eq.${d.response_id}&select=id,offer_id,seen_at&limit=1`, env);
  const resp = rr.data?.[0];
  if (!resp) return err('not_found', 404);
  const c = await offerCtx(auth, env, resp.offer_id);
  if (c.res) return c.res;
  if (!canManageOffers(c.x.roles)) return err('forbidden', 403);
  if (resp.seen_at) return ok({ id: resp.id, seen_at: resp.seen_at });
  const r = await sb(`/rest/v1/offer_responses?id=eq.${resp.id}&seen_at=is.null`, env, { method: 'PATCH',
    body: JSON.stringify({ seen_by: auth.userId, seen_at: nowIso() }) });
  if (!r.ok) return offerDbError(r);
  return ok({ id: resp.id, seen_at: r.data?.[0]?.seen_at || nowIso() });
}

// POST verifyCandidateDocument {id, verified} — HR ticks (or clears) a joining document after looking at it.
async function verifyCandidateDocument(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  if (!isUuid(d.id)) return err('id required', 400);
  if (typeof d.verified !== 'boolean') return err('verified must be true or false', 400);
  const dr = await sb(`/rest/v1/candidate_documents?id=eq.${d.id}&select=id,candidate_id,application_id,doc_type&limit=1`, env);
  const doc = dr.data?.[0];
  if (!doc) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const sc = await candidateScope(auth, me, env, doc.candidate_id);
  if (!canSeeDocRow(doc.doc_type, doc.application_id, sc.docCtx)) return err('forbidden', 403);
  const patch = d.verified ? { verified_by: auth.userId, verified_at: nowIso() } : { verified_by: null, verified_at: null };
  const r = await sb(`/rest/v1/candidate_documents?id=eq.${doc.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return offerDbError(r);
  await hiringEvents(env, auth, me, [{ candidate_id: doc.candidate_id, application_id: doc.application_id,
    event_type: d.verified ? 'document_verified' : 'document_unverified', detail: { doc_type: doc.doc_type, document_id: doc.id } }]);
  return ok({ id: doc.id, verified_by: patch.verified_by, verified_at: patch.verified_at });
}

// POST allowCandidateBankUpdate {candidate_id} — HR opens ONE change through the link, for 7 days.
async function allowCandidateBankUpdate(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  if (!isUuid(d.candidate_id)) return err('candidate_id required', 400);
  const until = new Date(Date.now() + 7 * 86400000).toISOString();
  const r = await sb(`/rest/v1/candidate_bank_details?candidate_id=eq.${d.candidate_id}&select=candidate_id,editable_until`, env, {
    method: 'PATCH', body: JSON.stringify({ editable_until: until, reopen_by: auth.userId }) });
  if (!r.ok) return offerDbError(r);
  if (!r.data?.length) return offerErr('no_bank_details', 404);
  const edges = await loadOrgEdges(env);
  await hiringEvents(env, auth, callerEmployee(edges, auth.userId), [{ candidate_id: d.candidate_id, event_type: 'bank_update_allowed',
    detail: { editable_until: until } }]);
  return ok({ candidate_id: d.candidate_id, editable_until: until });
}

// POST revealCandidateBank {candidate_id} — the full account number, salary allow-list only (Finance enters it in
// RazorpayX), logged.
async function revealCandidateBank(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const d = body.data || body;
  if (!isUuid(d.candidate_id)) return err('candidate_id required', 400);
  const [br, cr] = await Promise.all([
    sb(`/rest/v1/candidate_bank_details?candidate_id=eq.${d.candidate_id}&select=bank_account_number,bank_ifsc,bank_account_name,bank_name,submitted_at&limit=1`, env),
    sb(`/rest/v1/candidates?id=eq.${d.candidate_id}&select=candidate_code&limit=1`, env),
  ]);
  const b = br.data?.[0];
  if (!b) return offerErr('no_bank_details', 404);
  await logCompAccess(auth, 'revealCandidateBank', null, cr.data?.[0]?.candidate_code || null, env, { candidate_id: d.candidate_id });
  return ok({ candidate_id: d.candidate_id, ...b });
}

// GET getOfferResponses — unseen candidate responses on offers the caller can manage (dashboard card + Hiring page).
async function getOfferResponses(url, auth, env) {
  const r = await sb(`/rest/v1/offer_responses?seen_at=is.null&select=id,offer_id,application_id,kind,reason,text,proposed_join_date,created_at,`
    + `offer:offer_id(id,offer_ref,revision,opening_id,candidate_id,designation,status)&order=created_at.desc&limit=200`, env);
  if (!r.ok) return err('db_error', 500);
  const rows = (r.data || []).filter(x => x.offer);
  if (!rows.length) return ok({ responses: [] });
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const ops = await loadOpeningsWithRoles(auth, me, env, { ids: [...new Set(rows.map(x => x.offer.opening_id))] });
  const manage = new Map(ops.filter(x => canManageOffers(x.roles)).map(x => [x.o.id, x.o]));
  const mine = rows.filter(x => manage.has(x.offer.opening_id));
  const cids = [...new Set(mine.map(x => x.offer.candidate_id))];
  const cr = cids.length ? await sb(`/rest/v1/candidates?id=in.(${cids.join(',')})&select=id,full_name`, env) : { data: [] };
  const names = Object.fromEntries((cr.data || []).map(x => [x.id, x.full_name]));
  return ok({ responses: mine.map(x => ({
    id: x.id, kind: x.kind, reason: x.reason, reason_label: x.reason ? DECLINE_REASONS[x.reason] || x.reason : null,
    text: x.text, proposed_join_date: x.proposed_join_date, created_at: x.created_at,
    offer_id: x.offer_id, offer_ref: x.offer.offer_ref, revision: x.offer.revision, offer_status: x.offer.status,
    application_id: x.application_id, designation: x.offer.designation, candidate_name: names[x.offer.candidate_id] || null,
    opening_code: manage.get(x.offer.opening_id)?.opening_code || null,
  })) });
}

// GET getOfferMailCheck (super_admin) — D1 proof: mint a gmail.modify token AS the caller's own work mailbox and read
// its profile. Sends nothing.
async function getOfferMailCheck(url, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  if (!env.GOOGLE_SA_JSON) return offerErr('mail_not_configured', 503);
  const er = await sb(`/rest/v1/employees?auth_user_id=eq.${auth.userId}&select=work_email&limit=1`, env);
  const mailbox = String(er.data?.[0]?.work_email || '').trim().toLowerCase();
  if (!addressOk(mailbox)) return err('your employee record has no work_email', 400);
  let token;
  try { token = await googleAccessToken(env, { scope: GMAIL_SCOPE, sub: mailbox }); }
  catch (e) { return ok({ mailbox, token: false, error: String(e?.message || e).slice(0, 300), all_good: false }); }
  const res = await fetch(`${GMAIL_BASE}/profile`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await res.json().catch(() => ({}));
  return ok({ mailbox, scope: GMAIL_SCOPE, token: true, call: res.ok, status: res.status,
    profile_email: d.emailAddress || null, error: res.ok ? null : d?.error?.message || null,
    all_good: res.ok && String(d.emailAddress || '').toLowerCase() === mailbox });
}

// getOffer's O1 part: emails (never token_hash), responses, the acceptance evidence, the joining checklist, the bank.
async function offerLinkExtras(env, auth, o, sal, canManage) {
  const hr = isHr(auth);
  const [er, rr, ar, dr, br] = await Promise.all([
    sb(`/rest/v1/offer_emails?offer_id=eq.${o.id}&select=id,offer_id,kind,status,sender_email,to_email,cc_emails,copy_to,parent_email_id,subject,error,created_at,sent_at,link_revoked_at,reconcile_misses,token_hash&order=created_at.desc`, env),
    sb(`/rest/v1/offer_responses?offer_id=eq.${o.id}&select=*&order=created_at.desc`, env),
    sb(`/rest/v1/offer_acceptances?offer_id=eq.${o.id}&select=*&limit=1`, env),
    // L: this application's documents, plus candidate-level ones (no application) — never another application's.
    sb(`/rest/v1/candidate_documents?candidate_id=eq.${o.candidate_id}&doc_type=in.(${LINK_DOC_TYPE_KEYS.join(',')})`
      + `&or=(application_id.eq.${o.application_id},application_id.is.null)`
      + `&select=id,application_id,doc_type,title,file_name,source,uploaded_at,verified_at,verified_by&order=uploaded_at.asc`, env),
    sb(`/rest/v1/candidate_bank_details?candidate_id=eq.${o.candidate_id}&select=bank_account_number,bank_ifsc,bank_account_name,bank_name,submitted_at,editable_until&limit=1`, env),
  ]);
  const all = rowsOf(er);
  const emails = all.map(({ token_hash, ...e }) => ({ ...e, has_link: !!token_hash, link_live: e.kind === 'offer' && isLinkLive({ ...e, token_hash }, all) }));
  // Free text can quote a figure → only for the salary chain (as detail.note).
  const responses = rowsOf(rr).map(x => ({ id: x.id, kind: x.kind, reason: x.reason,
    reason_label: x.reason ? DECLINE_REASONS[x.reason] || x.reason : null, text: sal ? x.text : null,
    proposed_join_date: x.proposed_join_date, created_at: x.created_at, seen_at: x.seen_at, seen_by: x.seen_by }));
  const a = rowsOf(ar)[0] || null;
  const acceptance = a ? { id: a.id, typed_name: a.typed_name, accepted_at: a.accepted_at, ip: a.ip, confirmed_join_date: a.confirmed_join_date,
    pdf_sha256: a.pdf_sha256, signed_doc_id: a.signed_doc_id, user_agent: canManage ? a.user_agent : null } : null;
  // Existing visibility rule (docTier): ID / PAN / bank / address / relieving → HR; payslips → the salary chain;
  // the rest → anyone who sees the offer. A viewer who may not see the file gets the count only.
  const docs = rowsOf(dr);
  const joining = LINK_DOC_TYPES.map(t => {
    const files = docs.filter(x => x.doc_type === t.doc_type);
    const tier = docTier(t.doc_type);
    const visible = tier === 'hr' ? hr : tier === 'salary' ? sal : true;
    return { doc_type: t.doc_type, label: t.label, required: t.required, count: files.length,
      verified_count: files.filter(f => f.verified_at).length,
      docs: visible ? files.map(f => ({ id: f.id, title: f.title, file_name: f.file_name, source: f.source, uploaded_at: f.uploaded_at,
        verified_at: f.verified_at, verified_by: f.verified_by })) : null };
  });
  const b = rowsOf(br)[0] || null;
  const bank = (hr || canComp(auth) || canManage) && b ? { bank_account_number: maskBankAccount(b.bank_account_number), bank_ifsc: b.bank_ifsc,
    bank_account_name: b.bank_account_name, bank_name: b.bank_name, submitted_at: b.submitted_at, editable_until: b.editable_until,
    editable: !!b.editable_until && Date.parse(b.editable_until) > Date.now() } : null;
  return { emails, responses, acceptance, joining, bank, has_bank: !!b };
}

// ── Public: the candidate's link (/public/offer*) — no login, the token is the only credential ──
const PUBLIC_COPY = {
  link_invalid: LINK_INVALID,
  confirm_required: 'Tick both boxes to accept',
  name_mismatch: 'Type your full name exactly as it appears on the offer',
  bad_reason: 'Pick a reason',
  text_required: 'Write your question',
  text_too_long: 'Please keep it under 2,000 characters',
  bad_date: 'Pick a valid date',
  question_cap: 'That is the most questions we can take today — we will reply to the ones you sent',
  not_documents_step: 'Documents can be uploaded after you accept the offer',
  bad_doc_type: 'Pick which document this is',
  bad_file_type: 'Please upload a PDF, JPG or PNG',
  bad_file_size: 'The file is empty or over 15 MB',
  upload_not_found: 'We could not find that upload — please try again',
  storage_check_failed: 'We could not check the upload right now — please try again',
  path_refused: 'That upload does not belong to this offer',
  upload_cap: 'That is the most files we can take here — please reply to our email',
  upload_already_recorded: 'That file is already recorded',
  bank_cap: 'That is the most bank submissions we can take here — please reply to our email',
  bank_locked: 'Your bank details are already with us. To change them, ask the Legend of Toys team.',
  bad_bank: 'Please check the highlighted fields',
};
const pubErr = (code, status, extra = {}) => json({ ok: false, error: code, message: PUBLIC_COPY[code] || LINK_INVALID, ...extra }, status);
const clientIp = (request) => String(request.headers.get('CF-Connecting-IP') || '').slice(0, 100) || null;
const clientUa = (request) => String(request.headers.get('User-Agent') || '').slice(0, 500) || null;

// → { email, offer, hash, token } for a live link (D6), else null.
async function offerLinkByToken(env, t) {
  if (!linkTokenShapeOk(t)) return null;
  const hash = await hashLinkToken(t);
  const r = await sb(`/rest/v1/offer_emails?token_hash=eq.${hash}&kind=eq.offer&select=*&limit=1`, env);
  if (!r.ok) throw new Error(`token lookup failed: ${r.status}`);
  const e = r.data?.[0];
  if (!e) return null;
  const [sib, o] = await Promise.all([
    sb(`/rest/v1/offer_emails?offer_id=eq.${e.offer_id}&kind=eq.offer&select=id,offer_id,kind,status,created_at,link_revoked_at`, env),
    loadOffer(env, e.offer_id),
  ]);
  if (!sib.ok) throw new Error(`link lookup failed: ${sib.status}`);
  if (!o || !isLinkLive(e, sib.data || [])) return null;
  return { email: e, offer: o, hash, token: t };
}

async function linkCtx(env, link) {
  let o = link.offer;
  // I: a live link on a `ready` revision = its send has not settled. Settle it (reconcile + finishOfferSend), then
  // re-read; still `ready` → linkState's "being prepared" notice.
  if (o.status === 'ready') {
    if (await reconcileOfferEmails(env, o)) o = (await loadOffer(env, o.id)) || o;
    link.offer = o;
  }
  const [opening, cr] = await Promise.all([
    loadOpeningRow(env, o.opening_id),
    sb(`/rest/v1/candidates?id=eq.${o.candidate_id}&select=id,full_name&limit=1`, env),
  ]);
  const owner = opening ? await offerSender(env, opening) : null;
  const st = linkState({ offer: o, today: istToday(), startPlus7: addDaysIso(o.start_date, LINK_DOC_OPEN_DAYS), ownerFirst: owner?.first || '' });
  return { o, opening, candidate: cr.data?.[0] || null, owner, st };
}

// The page's view. A notice carries no letter, no name and no terms (D7).
async function publicOfferView(env, link, extra = {}, ctx = null) {
  const { o, candidate, owner, st } = ctx || await linkCtx(env, link);
  if (st.mode === 'notice') return ok({ mode: 'notice', notice: st.notice, ...extra });
  const common = { mode: st.mode, candidate_first_name: firstName(candidate?.full_name), designation: o.designation,
    offer_ref: o.offer_ref, revision: o.revision, start_date: o.start_date, owner_first_name: owner?.first || null };
  if (st.mode === 'respond') {
    const [tr, sr, pdfUrl] = await Promise.all([
      sb(`/rest/v1/offer_templates?id=eq.${o.template_id}&select=*&limit=1`, env),
      o.signatory_id ? sb(`/rest/v1/offer_signatories?id=eq.${o.signatory_id}&select=display_name,phone,title&limit=1`, env) : Promise.resolve({ data: [] }),
      o.pdf_path ? signedUrl(env, o.pdf_path, 600) : Promise.resolve(null),
    ]);
    let view = null;
    try {
      const tpl = tr.data?.[0];
      view = tpl ? renderOfferText({ template: tpl, offer: { ...offerView(o, true), issue_date: o.issue_date || istToday() },
        annexure: o.annexure, signatory: sr.data?.[0] || null, candidate }) : null;
    } catch (_e) { view = null; }   // the PDF link still carries the letter
    // H: `letter` = the renderOfferText object LetterPreview reads (title / letterhead / paragraphs / closing / footer);
    // the annexure rides separately for AnnexureTable.
    const letter = view ? { title: view.title, letterhead: view.letterhead, paragraphs: view.paragraphs, closing: view.closing,
      footer: view.footer } : null;
    return ok({ ...common, department: o.department_name || null, location: o.location || null, valid_until: o.valid_until,
      letter, annexure: view?.annexure || null, pdf_url: pdfUrl, decline_reasons: declineReasonList(), ...extra });
  }
  // documents
  const [dr, br] = await Promise.all([
    sb(`/rest/v1/candidate_documents?candidate_id=eq.${o.candidate_id}&source=eq.candidate_link&doc_type=in.(${LINK_DOC_TYPE_KEYS.join(',')})`
      + `&select=doc_type,file_name,uploaded_at,verified_at&order=uploaded_at.asc`, env),
    sb(`/rest/v1/candidate_bank_details?candidate_id=eq.${o.candidate_id}&select=bank_account_number,bank_ifsc,bank_account_name,bank_name,submitted_at,editable_until&limit=1`, env),
  ]);
  if (!dr.ok || !br.ok) throw new Error('public offer read failed');
  const rows = dr.data || [];
  const b = br.data?.[0] || null;
  return ok({ ...common, accepted_at: o.accepted_at,
    docs: LINK_DOC_TYPES.map(t => {
      const docs = rows.filter(r => r.doc_type === t.doc_type).map(r => ({ file_name: r.file_name, uploaded_at: r.uploaded_at, verified: !!r.verified_at }));
      return { ...t, count: docs.length, uploaded: docs.length > 0, verified: docs.some(f => f.verified), docs };
    }),
    bank: b ? { bank_account_number: maskBankAccount(b.bank_account_number), bank_ifsc: b.bank_ifsc, bank_account_name: b.bank_account_name,
      bank_name: b.bank_name, submitted_at: b.submitted_at } : null,
    bank_editable: !b || (!!b.editable_until && Date.parse(b.editable_until) > Date.now()),
    docs_open_until: addDaysIso(o.start_date, LINK_DOC_OPEN_DAYS), ...extra });
}

async function handlePublicOffer(request, url, env) {
  const sub = url.pathname.replace(/\/+$/, '');
  if (sub === '/public/offer') {
    if (request.method !== 'GET') return err('method_not_allowed', 405);
    const link = await offerLinkByToken(env, url.searchParams.get('t'));
    return link ? publicOfferView(env, link) : pubErr('link_invalid', 404);
  }
  // Every action is POST: mail scanners follow GET links and must never accept an offer.
  if (request.method !== 'POST') return err('method_not_allowed', 405);
  let body;
  try { body = await request.json(); } catch { return err('bad_json', 400); }
  const link = await offerLinkByToken(env, body?.t);
  if (!link) return pubErr('link_invalid', 404);
  const ctx = await linkCtx(env, link);
  const { o, candidate, st } = ctx;
  const ip = clientIp(request), ua = clientUa(request);
  const reload = async (extra = {}) => {
    const fresh = await loadOffer(env, o.id);
    return publicOfferView(env, { ...link, offer: fresh || o }, extra);
  };

  if (sub === '/public/offer/accept') {
    if (o.status === 'accepted' || st.mode !== 'respond') return publicOfferView(env, link, {}, ctx);   // idempotent
    if (body.agree !== true || body.confirm_join !== true) return pubErr('confirm_required', 422);
    const typed = String(body.typed_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!namesMatch(typed, candidate?.full_name)) return pubErr('name_mismatch', 422);
    const pdf = await storageBytes(env, o.pdf_path);
    if (!pdf || (await sha256Hex(pdf)) !== o.pdf_sha256) throw new Error('issued pdf unavailable or changed');
    const acceptedAt = nowIso();
    const lines = certificateLines({ offerRef: o.offer_ref, revision: o.revision, candidateName: candidate.full_name, typedName: typed,
      acceptedAtIst: istStamp(acceptedAt), joinDate: o.start_date, ip, userAgent: ua, pdfSha256: o.pdf_sha256,
      tokenHashPrefix: link.hash.slice(0, 12) });
    const signed = await appendCertificatePage(pdf, lines, { when: new Date(acceptedAt) });
    const ssha = await sha256Hex(signed);
    // B: a per-attempt nonce — this request's object is this request's alone. No upsert; any refusal = not ours.
    const path = acceptedPdfPath(o.application_id, o.offer_ref, o.revision, ssha, newPathNonce());
    const up = await storageFetch(`/object/${DOC_BUCKET}/${path}`, env, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: signed });
    if (!up.ok) throw new Error(`accepted pdf store failed: ${up.status}`);
    const r = await hiringRpc(env, 'offer_link_accept', {
      offer_id: o.id, token_hash: link.hash, typed_name: typed, confirmed_join_date: o.start_date, accepted_at: acceptedAt,
      ip, user_agent: ua, pdf_sha256: o.pdf_sha256, today: istToday(),
      signed_doc: { storage_path: path, file_name: `${o.offer_ref}-r${o.revision}-accepted.pdf`, mime_type: 'application/pdf',
        file_size: signed.length, title: `${o.offer_ref} r${o.revision} — accepted through the link` },
    });
    if (!r.ok) {
      // B: delete this request's own object, and only while no document row points at it.
      const ref = await sb(`/rest/v1/candidate_documents?storage_path=eq.${encodeURIComponent(path)}&select=id&limit=1`, env);
      if (ref.ok && Array.isArray(ref.data) && !ref.data.length) {
        const seg = path.split('/').map(encodeURIComponent).join('/');
        await storageFetch(`/object/${DOC_BUCKET}/${seg}`, env, { method: 'DELETE' }).catch(() => null);
      }
      const code = linkDbErrorCode(r.data);
      if (code === 'headcount_full' || code === 'opening_closed') {
        // D5 / G: one blocked row per offer (offer_responses_one_blocked); the alert goes only with the insert that won.
        const ins = await sb(`/rest/v1/offer_responses`, env, { method: 'POST', body: JSON.stringify([{
          offer_id: o.id, application_id: o.application_id, kind: 'accept_blocked', ip, user_agent: ua }]) });
        if (ins.ok && ins.data?.[0]?.id) await sendOfferAlert(env, o, 'accept_blocked');
        else if (!ins.ok && ins.data?.code !== '23505') console.error('[accept-blocked]', ins.status);
        return ok({ mode: 'notice', notice: HEADCOUNT_FULL_NOTICE });
      }
      if (code === 'link_dead') return pubErr('link_invalid', 404);
      if (['offer_not_open', 'offer_expired', 'stale', 'not_latest', 'conflict', 'pdf_changed', 'join_date_mismatch'].includes(code)) return reload();
      throw new Error(`offer_link_accept failed: ${code || r.status}`);
    }
    const fresh = (await loadOffer(env, o.id)) || o;
    try { await sendOfferConfirmation(env, fresh, null); }
    catch (e) { console.error('[offer-confirmation]', e?.message || e); }   // recorded on the row; never fails the acceptance
    return publicOfferView(env, { ...link, offer: fresh });
  }

  if (sub === '/public/offer/decline' || sub === '/public/offer/question') {
    const kind = sub.endsWith('decline') ? 'decline' : 'question';
    if (st.mode !== 'respond') return publicOfferView(env, link, {}, ctx);
    const text = String(body.text ?? '').trim();
    if (text.length > TEXT_MAX) return pubErr('text_too_long', 422);
    if (kind === 'decline' && !DECLINE_REASONS[body.reason]) return pubErr('bad_reason', 422);
    if (kind === 'question' && !text) return pubErr('text_required', 422);
    const proposed = kind === 'question' && body.proposed_join_date ? String(body.proposed_join_date) : null;
    if (proposed && !isIsoDate(proposed)) return pubErr('bad_date', 422);
    const r = await hiringRpc(env, 'offer_link_respond', { offer_id: o.id, token_hash: link.hash, kind,
      reason: kind === 'decline' ? body.reason : null, text: text || null, proposed_join_date: proposed, ip, user_agent: ua, today: istToday() });
    if (!r.ok) {
      const code = linkDbErrorCode(r.data);
      if (code === 'link_dead') return pubErr('link_invalid', 404);
      if (code === 'question_cap') return pubErr('question_cap', 429);
      if (['bad_reason', 'text_required', 'text_too_long'].includes(code)) return pubErr(code, 422);
      if (['offer_not_open', 'offer_expired', 'stale'].includes(code)) return reload();
      throw new Error(`offer_link_respond failed: ${code || r.status}`);
    }
    await sendOfferAlert(env, o, kind, { reason: kind === 'decline' ? body.reason : null, text: text || null, proposedDate: proposed });
    return kind === 'decline' ? reload({ submitted: 'decline' }) : publicOfferView(env, link, { submitted: 'question' }, ctx);
  }

  // ── The documents step (accepted, until start_date + 7) ──
  if (st.mode !== 'documents') return pubErr('not_documents_step', 409);

  if (sub === '/public/offer/upload-url') {
    if (!LINK_DOC_TYPE_KEYS.includes(body.doc_type)) return pubErr('bad_doc_type', 422);
    if (!LINK_DOC_MIMES.includes(body.mime) || fileOk(body.file_name, ['pdf', 'jpg', 'jpeg', 'png'])) return pubErr('bad_file_type', 422);
    // E: reserve the slot first (atomic, ≤ 30 per offer under the offer lock), then mint the URL for that path only.
    const path = candidateLinkDocPath(o.candidate_id, body.doc_type, body.file_name);
    const rv = await hiringRpc(env, 'offer_link_reserve_upload', { offer_id: o.id, candidate_id: o.candidate_id, storage_path: path, doc_type: body.doc_type });
    if (!rv.ok) {
      if (linkDbErrorCode(rv.data) === 'upload_cap') return pubErr('upload_cap', 409);
      throw new Error(`upload reserve failed: ${linkDbErrorCode(rv.data) || rv.status}`);
    }
    return signUpload(path, env);
  }

  if (sub === '/public/offer/upload-done') {
    if (!LINK_DOC_TYPE_KEYS.includes(body.doc_type)) return pubErr('bad_doc_type', 422);
    if (checkCandidateLinkDocPath(body.storage_path, o.candidate_id, body.doc_type)) return pubErr('path_refused', 403);
    // E: only a path reserved through THIS offer's upload-url, and only once.
    const rr = await sb(`/rest/v1/offer_link_uploads?storage_path=eq.${encodeURIComponent(body.storage_path)}&offer_id=eq.${o.id}`
      + `&doc_type=eq.${body.doc_type}&select=id,completed_at&limit=1`, env);
    if (!rr.ok) throw new Error('reservation read failed');
    const resv = rr.data?.[0];
    if (!resv) return pubErr('path_refused', 403);
    if (resv.completed_at) return pubErr('upload_already_recorded', 409);
    // Size + type come from storage, not from the request.
    const so = checkStoredObject(await storageHead(env, body.storage_path));
    if (so.error) return pubErr(so.error, so.error === 'storage_check_failed' ? 502 : 422);
    if (!LINK_DOC_MIMES.includes(so.mime)) return pubErr('bad_file_type', 422);
    // Claim the completion atomically; a second upload-done for the same path loses here.
    const claim = await sb(`/rest/v1/offer_link_uploads?id=eq.${resv.id}&completed_at=is.null&select=id`, env, {
      method: 'PATCH', body: JSON.stringify({ completed_at: nowIso() }) });
    if (!claim.ok) throw new Error('reservation claim failed');
    if (!claim.data?.length) return pubErr('upload_already_recorded', 409);
    const label = LINK_DOC_TYPES.find(t => t.doc_type === body.doc_type)?.label || body.doc_type;
    const r = await sb(`/rest/v1/candidate_documents`, env, { method: 'POST', body: JSON.stringify([{
      candidate_id: o.candidate_id, application_id: o.application_id, doc_type: body.doc_type, title: `${label} (from the candidate)`,
      storage_path: body.storage_path, file_name: String(body.file_name || '').slice(0, 200) || String(body.storage_path).split('/').pop(),
      mime_type: so.mime, file_size: so.size, uploaded_by: null, source: 'candidate_link' }]) });
    if (!r.ok) {
      if (r.data?.code === '23505') return pubErr('upload_already_recorded', 409);
      // Give the slot back so the candidate can retry the same upload.
      await sb(`/rest/v1/offer_link_uploads?id=eq.${resv.id}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ completed_at: null }) });
      throw new Error(`doc record failed: ${r.status}`);
    }
    await sb(`/rest/v1/application_events`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{
      candidate_id: o.candidate_id, application_id: o.application_id, event_type: 'document_added',
      detail: { doc_type: body.doc_type, source: 'candidate_link' } }]) });
    return publicOfferView(env, link, {}, ctx);
  }

  if (sub === '/public/offer/bank') {
    const v = validateCandidateBank(body);
    if (!v.ok) return pubErr('bad_bank', 422, { errors: v.errors });
    const er = await sb(`/rest/v1/application_events?application_id=eq.${o.application_id}&event_type=eq.bank_details_received&select=id&limit=${LINK_BANK_CAP}`, env);
    if (!er.ok) throw new Error('bank cap read failed');
    if ((er.data || []).length >= LINK_BANK_CAP) return pubErr('bank_cap', 429);
    const fields = { ...v.clean, submitted_at: nowIso(), offer_id: o.id };
    // A forwarded link must not be able to change where pay goes: both writes decide in the database.
    const first = await sb(`/rest/v1/candidate_bank_details?on_conflict=candidate_id`, env, {
      method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
      body: JSON.stringify([{ candidate_id: o.candidate_id, ...fields }]) });
    if (!first.ok) throw new Error(`bank write failed: ${first.status}`);
    let isFirst = true;
    if (!first.data?.[0]) {
      isFirst = false;
      // Already on file: only inside an HR "allow update" window, used up by this change.
      const again = await sb(`/rest/v1/candidate_bank_details?candidate_id=eq.${o.candidate_id}&editable_until=gt.${encodeURIComponent(nowIso())}&select=candidate_id`, env, {
        method: 'PATCH', body: JSON.stringify({ ...fields, editable_until: null, reopen_by: null }) });
      if (!again.ok) throw new Error(`bank update failed: ${again.status}`);
      if (!again.data?.[0]) return pubErr('bank_locked', 409);
    }
    await sb(`/rest/v1/application_events`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{
      candidate_id: o.candidate_id, application_id: o.application_id, event_type: 'bank_details_received',
      detail: { offer_id: o.id, first: isFirst } }]) });   // no numbers, ever
    return publicOfferView(env, link, {}, ctx);
  }

  return err('not_found', 404);
}

// ── Templates + signatories (salary allow-list or podium_admin) ──────────────
const canAdminOfferTemplates = (auth) => canComp(auth) || isAdmin(auth);

async function getOfferTemplates(url, auth, env) {
  if (!canAdminOfferTemplates(auth)) return err('forbidden', 403);
  const [tr, sr, rr, er] = await Promise.all([
    sb(`/rest/v1/offer_templates?select=*&order=template_key.asc,version.desc`, env),
    sb(`/rest/v1/offer_signatories?select=*&order=active.desc,display_name.asc`, env),
    sb(`/rest/v1/offer_rule_sets?select=code,effective_from,effective_to,notes,rules&order=effective_from.desc`, env),
    sb(`/rest/v1/employees?status=neq.exited&select=id,employee_code,full_name,job_title&order=full_name.asc&limit=2000`, env),
  ]);
  if (!tr.ok || !sr.ok || !rr.ok) return err('db_error', 500);
  return ok({ templates: tr.data || [], signatories: sr.data || [], rule_sets: rr.data || [], employees: er.data || [], fields: OFFER_FIELDS });
}

function cleanTemplateInput(d) {
  if (!OFFER_TEMPLATE_KEYS.includes(d.template_key)) return { error: 'bad template_key' };
  const title = String(d.title || '').trim();
  const body = String(d.body || '').replace(/\r\n?/g, '\n').trim();
  if (!title) return { error: 'title required' };
  if (!body) return { error: 'body required' };
  if (body.length > 20000) return { error: 'body too long' };
  const addr = (Array.isArray(d.entity_address) ? d.entity_address : String(d.entity_address || '').split('\n'))
    .map(s => String(s).trim()).filter(Boolean);
  if (addr.length > 6) return { error: 'entity_address: up to 6 lines' };
  return { t: { template_key: d.template_key, title, body, entity_name: String(d.entity_name || '').trim() || null,
    entity_address: addr, footer_note: String(d.footer_note || '').trim() || null, notes: String(d.notes || '').trim() || null } };
}

async function previewOfferTemplate(body, auth, env) {
  if (!canAdminOfferTemplates(auth)) return err('forbidden', 403);
  const ci = cleanTemplateInput(body.data || body);
  if (ci.error) return err(ci.error, 400);
  const bad = validateTemplateBody(ci.t.body);
  if (bad) return errCode('template_error', `template_error: ${bad}`, 422);
  const rs = await ruleSetFor(env, istToday());
  const mode = ci.t.template_key === 'internship' ? 'stipend' : 'salary';
  const a = rs ? computeAnnexure({ ...SAMPLE_OFFER, mode, work_state: 'Karnataka' }, rs.rules) : null;
  return ok({ text: renderOfferText({ template: ci.t, offer: SAMPLE_OFFER, annexure: a && !a.error ? a : null,
    signatory: SAMPLE_SIGNATORY, candidate: { full_name: 'Sample Candidate' } }) });
}

async function saveOfferTemplate(body, auth, env) {
  if (!canAdminOfferTemplates(auth)) return err('forbidden', 403);
  const ci = cleanTemplateInput(body.data || body);
  if (ci.error) return err(ci.error, 400);
  // Dry render: an unknown merge field or unclosed section never becomes a current template.
  const bad = validateTemplateBody(ci.t.body);
  if (bad) return errCode('template_error', `template_error: ${bad}`, 422);
  const me = callerEmployee(await loadOrgEdges(env), auth.userId);
  const r = await hiringRpc(env, 'hiring_template_new_version', { ...ci.t, actor_user_id: auth.userId, actor_employee_id: me?.id || null });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.template);
}

async function saveSignatory(body, auth, env) {
  if (!canAdminOfferTemplates(auth)) return err('forbidden', 403);
  const d = body.data || body;
  const row = {};
  if (!d.id || 'display_name' in d) {
    row.display_name = String(d.display_name || '').trim();
    if (!row.display_name) return err('display_name required', 400);
  }
  if (!d.id || 'employee_id' in d) {
    if (d.employee_id && !isUuid(d.employee_id)) return err('bad employee_id', 400);
    row.employee_id = d.employee_id || null;
  }
  if ('phone' in d) row.phone = String(d.phone || '').trim() || null;
  if ('title' in d) row.title = String(d.title || '').trim() || null;
  if ('active' in d) row.active = !!d.active;
  if (row.employee_id) {
    const live = await activeEmployeeIds([row.employee_id], env);
    if (!live.has(row.employee_id)) return err('the signatory must be a current employee', 400);
  }
  const r = d.id
    ? (isUuid(d.id) ? await sb(`/rest/v1/offer_signatories?id=eq.${d.id}`, env, { method: 'PATCH', body: JSON.stringify(row) }) : { ok: false, status: 400, data: 'bad id' })
    : await sb(`/rest/v1/offer_signatories`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (r.status === 409 || r.data?.code === '23505') return errCode('duplicate', 'That employee is already a signatory', 409);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  if (!r.data?.length) return err('not_found', 404);
  return ok(r.data[0]);
}

// ────────────────────────────────────────────────────────────────────────────
// HIRING J1 — Podium creates the work account, then confirms joining.
// Plan: docs/superpowers/plans/2026-11-11-podium-j1-work-accounts.md · pure rules: src/workaccount.js.
// Two human steps: (1) a Google admin (podium.google_admin_access — per person, L3) creates the Google
// user; the temp password exists ONLY in that response. (2) on the day the person turns up, HR / the
// opening's chain confirms joining → hiring_confirm_joining (0009) writes the employee, the initial comp
// event, the documents, `joined` and `filled` in one transaction. No-show → `no_show`; a created account
// can then be suspended (logged). Google writes use googleWriteToken ONLY; every one lands in
// podium.google_admin_log (request minus the password). Rehires are refused until X1.
// ────────────────────────────────────────────────────────────────────────────

const J1_COPY = {
  forbidden_google_admin: 'Only a Google admin (Afshaan, Vinay, Mohit) can do this',
  not_accepted: 'The application must be at Accepted',
  offer_not_accepted: 'This application has no accepted offer',
  offer_not_latest: 'A newer offer revision is in progress or was sent — finish it first',
  rehire_not_supported_yet: 'This person was an employee before — rehires are not supported yet',
  account_exists: 'A work account already exists for this application',
  account_pending_other_email: 'An account for another address is still being created — retry that one',
  email_taken: 'That address is already taken',
  bad_org_unit: 'Pick an org unit from the list',
  bad_name: 'Given and family name are required (up to 60 characters each)',
  override_reason_required: 'Say why this account is created without hiring (at least 10 characters)',
  local_required: 'Enter the part before @',
  local_too_long: 'The address is too long',
  local_bad_chars: 'Use lowercase letters, digits and dots only',
  local_bad_dots: 'No dot at the start or end, and no two dots together',
  google_error: 'Google refused the request',
  record_failed: 'Google created the account but Podium could not record it — retry to finish',
  no_work_account: 'Create the work account first',
  employee_id_mismatch: 'This changed since you loaded it — reload and retry',
  bad_start_date: 'Pick the actual start date',
  start_date_too_far: 'The start date can be at most 7 days ahead — confirm joining on the day',
  start_date_before_acceptance: 'The start date is before the offer was accepted',
  doc_copy_failed: 'The hiring documents could not be copied — try again',
  bad_document_path: 'A document path was outside the employee folder',
  not_suspendable: 'Only an account whose application is No show or Withdrawn can be suspended here',
  stale: 'This changed since you loaded it — reload and retry',
  conflict: 'This conflicts with an existing record — reload and retry',
  check_failed: 'The record failed a consistency check',
  in_progress: 'Someone else is creating this account right now — wait a moment and reload',
  not_resettable: 'Only a created account whose person has not joined can have its password reset here',
  offer_changed: 'The offer changed while joining was being confirmed — reload and retry',
  opening_closed: 'The opening is cancelled — reopen it before confirming joining',
  headcount_full: 'The opening already has its full headcount joined',
  created_by_podium_awaiting_joining: 'Podium created this address for a hire who has not joined — use Confirm joining on the candidate',
};
const j1Err = (code, status = 409) => errCode(code, J1_COPY[code] || code.replace(/_/g, ' '), status);
function j1DbError(r) {
  const m = workAccountDbErrorCode(r?.data);
  if (m) return j1Err(m.code, m.status);
  const d = r?.data && typeof r.data === 'object' ? r.data : {};
  return err(`db_error: ${[d.code, d.message].filter(Boolean).join(' ') || r?.status}`, 400);
}

// L3 allow-list, AND the caller's Podium employee row is active (an exited admin keeps no Google power even
// if the allow-list row was not removed). Resolved per call (display flag in getMe; every handler re-checks).
async function isGoogleAdmin(auth, env) {
  if (!auth?.userId || !isUuid(auth.userId)) return false;
  const [r, er] = await Promise.all([
    sb(`/rest/v1/google_admin_access?auth_user_id=eq.${auth.userId}&select=auth_user_id&limit=1`, env),
    sb(`/rest/v1/employees?auth_user_id=eq.${auth.userId}&status=eq.active&select=id&limit=1`, env),
  ]);
  return !!(r.ok && r.data?.[0] && er.ok && er.data?.[0]);
}
async function requireGoogleAdmin(auth, env) { return (await isGoogleAdmin(auth, env)) ? null : j1Err('forbidden_google_admin', 403); }
// Confirm joining / no-show: HR or podium_hiring ONLY — not the opening's owner / reporting manager. Joining
// writes the employee record and the initial comp event, which is HR's act (and none of the J1 actions is
// self-serve, so a manager without podium_view never reaches them anyway).
const canConfirmJoining = (roles) => !!(roles?.hr || roles?.hiring);

const GDIR_USERS = 'https://admin.googleapis.com/admin/directory/v1/users';
const gJson = { 'Content-Type': 'application/json' };

// Best-effort like logCompAccess: the Google write already happened. `request` never carries the password.
async function googleAdminLog(env, auth, e) {
  try {
    await sb(`/rest/v1/google_admin_log`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{
      actor: auth.userId, actor_email: auth.email || null, action: e.action, target_email: e.target_email,
      google_user_id: e.google_user_id || null, work_account_id: e.work_account_id || null, request: e.request || null,
      ok: !!e.ok, error: e.error ? String(e.error).slice(0, 500) : null,
    }]) });
  } catch (_e) { /* best-effort */ }
}
// Writes during a create attempt: only while this attempt still owns the row and it is still pending.
async function waAttemptPatch(env, id, attemptId, patch) {
  return sb(`/rest/v1/work_accounts?id=eq.${id}&${attemptGuard(attemptId)}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
}
async function loadWorkAccount(env, q) {
  return (await sb(`/rest/v1/work_accounts?${q}&select=*&limit=1`, env)).data?.[0] || null;
}

// The OUs that exist (from the live user list) — the create path only accepts one of these.
function liveOus(gusers) {
  return [...new Set(['/', ...(gusers || []).map(u => u.orgUnitPath).filter(Boolean)])].sort();
}

// Is each address free? Taken if a Podium employee has it, a live work_accounts row claims it, or Google
// knows it (users.get with the READONLY token resolves aliases too). → [{email, available, reason}]
async function emailAvailability(env, emails, { exceptWaId = null } = {}) {
  const list = [...new Set((emails || []).map(e => String(e).toLowerCase()))].slice(0, 3);
  if (!list.length) return [];
  const inList = list.map(e => `"${encodeURIComponent(e)}"`).join(',');
  let token = null;
  try { token = await googleAccessToken(env); } catch (_e) { token = null; }
  const [er, wr, ...gs] = await Promise.all([
    sb(`/rest/v1/employees?work_email=in.(${inList})&select=work_email`, env),
    sb(`/rest/v1/work_accounts?email=in.(${inList})&status=neq.failed&select=id,email`, env),
    ...list.map(e => token
      ? fetch(`${GDIR_USERS}/${encodeURIComponent(e)}?projection=basic`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.status).catch(() => 0)
      : Promise.resolve(0)),
  ]);
  const inPodium = new Set((er.data || []).map(x => String(x.work_email || '').toLowerCase()));
  const claimed = new Set((wr.data || []).filter(x => x.id !== exceptWaId).map(x => x.email));
  return list.map((email, i) => {
    if (inPodium.has(email)) return { email, available: false, reason: 'in_podium' };
    if (claimed.has(email)) return { email, available: false, reason: 'podium_account' };
    if (gs[i] === 200) return { email, available: false, reason: 'google' };
    if (gs[i] === 404) return { email, available: true, reason: null };
    return { email, available: null, reason: 'google_unavailable' };
  });
}

// The create form: names, the two L1 proposals with availability, the live OUs, the L2 default OU.
async function accountFormSetup(env, names, departmentId, exceptWaId) {
  const [gusers, er] = await Promise.all([
    fetchGoogleUsers(env),
    departmentId && isUuid(departmentId)
      ? sb(`/rest/v1/employees?department_id=eq.${departmentId}&status=eq.active&select=department_id,status,google_org_unit`, env)
      : Promise.resolve({ data: [] }),
  ]);
  const ous = liveOus(gusers);
  const locals = proposeLocalParts(names.given, names.family);
  const avail = await emailAvailability(env, locals.map(toEmail), { exceptWaId });
  const dou = defaultOu(departmentId, er.data || []);
  return {
    given: names.given, family: names.family, domain: WORK_DOMAIN, ous, default_ou: ous.includes(dou) ? dou : '/',
    proposals: locals.map((local, i) => ({ local, ...avail[i] })),
  };
}

// GET getWorkAccount?application_id= — the Work account card. Visible to anyone who sees the opening; the
// form (proposals, OUs — Google reads) only for a Google admin while no live account exists.
// Without application_id: the override form setup (?name=), Google admins only.
async function getWorkAccount(url, auth, env) {
  const applicationId = url.searchParams.get('application_id');
  const gAdmin = await isGoogleAdmin(auth, env);
  if (!applicationId) {
    if (!gAdmin) return j1Err('forbidden_google_admin', 403);
    if (!googleConfigured(env)) return err('google_not_configured', 400);
    try { return ok({ google_admin: true, form: await accountFormSetup(env, splitName(url.searchParams.get('name') || ''), null, null) }); }
    catch (e) { return err('google_sync_failed: ' + (e?.message || e), 502); }
  }
  const c = await offerAppCtx(auth, env, applicationId);
  if (c.res) return c.res;
  const { app, x } = c;
  const [wr, or, cr] = await Promise.all([
    sb(`/rest/v1/work_accounts?application_id=eq.${app.id}&select=*&limit=1`, env),
    sb(`/rest/v1/offers?application_id=eq.${app.id}&select=id,revision,status,sent_at,start_date,accepted_at&order=revision.desc`, env),
    sb(`/rest/v1/candidates?id=eq.${app.candidate_id}&select=id,full_name,employee_id&limit=1`, env),
  ]);
  const wa = wr.data?.[0] || null;
  const cand = cr.data?.[0] || {};
  const jo = joiningOffer(or.data || []);
  const rehire = !!cand.employee_id && cand.employee_id !== wa?.employee_id;
  const [rq, emp] = await Promise.all([
    wa?.requested_by ? sb(`/rest/v1/employees?auth_user_id=eq.${wa.requested_by}&select=full_name&limit=1`, env) : Promise.resolve({ data: [] }),
    wa?.employee_id && app.status === 'joined' ? sb(`/rest/v1/employees?id=eq.${wa.employee_id}&select=id,employee_code,full_name&limit=1`, env) : Promise.resolve({ data: [] }),
  ]);
  let form = null;
  if (gAdmin && app.status === 'accepted' && jo.offer && !rehire && (!wa || wa.status === 'failed' || wa.status === 'pending')) {
    if (!googleConfigured(env)) form = { error: 'google_not_configured' };
    else {
      const names = wa ? { given: wa.given_name, family: wa.family_name } : splitName(cand.full_name);
      try { form = await accountFormSetup(env, names, x.o.department_id, wa?.id || null); }
      catch (_e) { form = { error: 'google_unavailable' }; }
    }
  }
  return ok({
    application_status: app.status, offer_accepted: !!jo.offer, offer_error: jo.error || null,
    start_date: jo.offer?.start_date || null, accepted_at: jo.offer?.accepted_at || null, rehire,
    work_account: wa, requested_by_name: rq.data?.[0]?.full_name || null, employee: emp.data?.[0] || null,
    google_admin: gAdmin, can_confirm: canConfirmJoining(x.roles), today: istToday(), form,
  });
}

// GET checkWorkEmail?local= — one availability answer for the Custom box.
async function checkWorkEmail(url, auth, env) {
  const gate = await requireGoogleAdmin(auth, env); if (gate) return gate;
  const local = String(url.searchParams.get('local') || '').trim().toLowerCase();
  const bad = checkLocalPart(local);
  if (bad) return j1Err(bad, 400);
  const except = url.searchParams.get('work_account_id');
  const [a] = await emailAvailability(env, [toEmail(local)], { exceptWaId: isUuid(except) ? except : null });
  return ok({ local, ...a });
}

// POST createWorkAccount — the only place the temp password exists (the response; resetWorkAccountPassword
// is the other). Sequence: validate → claim the row for this attempt BEFORE Google → users.get (adopt only a
// user stamped with this row's id, refuse anyone else's) → users.insert (stamped) → `created` + log. A retry
// after a lost response adopts and sets a fresh password.
async function createWorkAccount(body, auth, env) {
  const gate = await requireGoogleAdmin(auth, env); if (gate) return gate;
  if (!googleWriteConfigured(env) || !googleConfigured(env)) return err('google_write_not_configured', 400);
  const d = body.data || body;
  const local = String(d.local_part || '').trim().toLowerCase();
  const lc = checkLocalPart(local);
  if (lc) return j1Err(lc, 400);
  const given = String(d.given_name || '').trim().replace(/\s+/g, ' ');
  const family = String(d.family_name || '').trim().replace(/\s+/g, ' ');
  if (!given || !family || given.length > 60 || family.length > 60) return j1Err('bad_name', 400);
  const ou = String(d.org_unit_path || '').trim();
  const email = toEmail(local);

  let app = null, overrideReason = null;
  if (d.application_id) {
    app = await loadApplication(env, d.application_id);
    if (!app) return err('not_found', 404);
    if (app.status !== 'accepted') return j1Err('not_accepted');
    const [or, cr] = await Promise.all([
      sb(`/rest/v1/offers?application_id=eq.${app.id}&select=id,revision,status,sent_at&order=revision.desc`, env),
      sb(`/rest/v1/candidates?id=eq.${app.candidate_id}&select=employee_id&limit=1`, env),
    ]);
    const jo = joiningOffer(or.data || []);
    if (jo.error) return j1Err(jo.error);
    if (cr.data?.[0]?.employee_id) return j1Err('rehire_not_supported_yet');
  } else {
    overrideReason = String(d.override_reason || '').trim();
    if (overrideReason.length < 10) return j1Err('override_reason_required', 400);
  }

  let gusers;
  try { gusers = await fetchGoogleUsers(env); }
  catch (e) { return err('google_sync_failed: ' + (e?.message || e), 502); }
  if (!liveOus(gusers).includes(ou)) return j1Err('bad_org_unit', 400);
  const inPodium = await sb(`/rest/v1/employees?work_email=eq.${encodeURIComponent(email)}&select=id&limit=1`, env);
  if (inPodium.data?.length) return j1Err('email_taken');

  // Claim the row for THIS attempt before touching Google (B): a fresh attempt_id, taken only when the row
  // is pending/failed and no other attempt started in the last 2 minutes. Losers get in_progress; every
  // later write is guarded on (attempt_id, pending), so a loser can never overwrite or downgrade a winner.
  const existing = await loadWorkAccount(env, app
    ? `application_id=eq.${app.id}`
    : `application_id=is.null&email=eq.${encodeURIComponent(email)}&status=in.(pending,failed)`);
  if (existing && ['created', 'suspended'].includes(existing.status)) return j1Err('account_exists');
  // A pending row for another address may already have a Google user (stamped with this row's id): finish that.
  if (existing && existing.status === 'pending' && existing.email !== email) return j1Err('account_pending_other_email');
  const attemptId = crypto.randomUUID();
  const fields = { email, given_name: given, family_name: family, org_unit_path: ou, status: 'pending', last_error: null,
    requested_by: auth.userId, attempt_id: attemptId, attempt_started_at: nowIso() };
  let row;
  if (existing) {
    const r = await sb(`/rest/v1/work_accounts?id=eq.${existing.id}&${attemptClaimFilter()}`, env, { method: 'PATCH',
      body: JSON.stringify(fields) });
    if (!r.ok) return j1DbError(r);
    if (!r.data?.length) return j1Err('in_progress');
    row = r.data[0];
  } else {
    const r = await sb(`/rest/v1/work_accounts`, env, { method: 'POST', body: JSON.stringify([{ ...fields,
      application_id: app?.id || null, candidate_id: app?.candidate_id || null, override_reason: overrideReason }]) });
    // Another admin inserted the row for this application a moment ago: theirs is the live attempt.
    if (r.data?.code === '23505' && /work_accounts_application_id/.test(String(r.data?.message || ''))) return j1Err('in_progress');
    if (!r.ok) return j1DbError(r);
    row = r.data?.[0];
  }
  const mine = (patch) => waAttemptPatch(env, row.id, attemptId, patch);

  // externalIds (A) is the ownership proof a retry checks before adopting an existing Google user.
  const googleUser = { primaryEmail: email, name: { givenName: given, familyName: family }, orgUnitPath: ou,
    changePasswordAtNextLogin: true, externalIds: workAccountExternalIds(row.id) };
  const logRequest = { ...googleUser, ...(overrideReason ? { override_reason: overrideReason } : {}) };
  const fail = async (code, message, action = 'create_user', status = 409) => {
    await mine({ status: 'failed', last_error: String(message || code).slice(0, 500) });
    await googleAdminLog(env, auth, { action, target_email: email, work_account_id: row.id, request: logRequest, ok: false, error: message || code });
    return j1Err(code, status);
  };
  let token;
  try { token = await googleWriteToken(env, 'directory'); }
  catch (e) { return fail('google_error', String(e?.message || e), 'create_user', 502); }
  const hdr = { ...gJson, Authorization: `Bearer ${token}` };
  const pw = tempPassword((n) => crypto.getRandomValues(new Uint8Array(n)));

  const gr = await fetch(`${GDIR_USERS}/${encodeURIComponent(email)}?projection=full`, { headers: hdr });
  const gd = await gr.json().catch(() => ({}));
  if (gr.ok) {
    // Adopt ONLY a Google user carrying this row's id (our own earlier insert). Anyone else's → taken.
    if (!isOurPendingAccount(row, gd)) return fail('email_taken', 'already exists in Google (not created by this request)');
    // Our earlier call created it and its response was lost: nobody has its password, so set a fresh one.
    const ur = await fetch(`${GDIR_USERS}/${encodeURIComponent(gd.id)}`, { method: 'PUT', headers: hdr,
      body: JSON.stringify({ password: pw, changePasswordAtNextLogin: true }) });
    const ud = await ur.json().catch(() => ({}));
    if (!ur.ok) return fail('google_error', ud?.error?.message || `HTTP ${ur.status}`, 'link_existing', 502);
    const pr = await mine({ status: 'created', google_user_id: gd.id, last_error: null });
    await googleAdminLog(env, auth, { action: 'link_existing', target_email: email, google_user_id: gd.id, work_account_id: row.id,
      request: { reset_password: true, changePasswordAtNextLogin: true }, ok: true });
    if (!pr.ok || !pr.data?.length) return j1Err('record_failed', 500);
    return ok({ work_account_id: row.id, email, temp_password: pw, linked: true });
  }
  if (gr.status !== 404) return fail('google_error', gd?.error?.message || `HTTP ${gr.status}`, 'create_user', 502);

  const ir = await fetch(GDIR_USERS, { method: 'POST', headers: hdr, body: JSON.stringify({ ...googleUser, password: pw }) });
  const idata = await ir.json().catch(() => ({}));
  if (ir.status === 409) return fail('email_taken', idata?.error?.message || 'in use in Google (user, group or alias)');
  if (!ir.ok || !idata?.id) return fail('google_error', idata?.error?.message || `HTTP ${ir.status}`, 'create_user', 502);
  const pr = await mine({ status: 'created', google_user_id: idata.id, last_error: null });
  await googleAdminLog(env, auth, { action: 'create_user', target_email: email, google_user_id: idata.id, work_account_id: row.id,
    request: logRequest, ok: true });
  // Google has the user (stamped with this row's id); the row stays `pending`, so a retry adopts it and
  // sets a fresh password.
  if (!pr.ok || !pr.data?.length) return j1Err('record_failed', 500);
  return ok({ work_account_id: row.id, email, temp_password: pw, linked: false });
}

// POST resetWorkAccountPassword {work_account_id} — the temp password was lost before first sign-in. Google
// admin; the account is `created` and its person has not joined. Returns the new temp password ONCE.
async function resetWorkAccountPassword(body, auth, env) {
  const gate = await requireGoogleAdmin(auth, env); if (gate) return gate;
  if (!googleWriteConfigured(env)) return err('google_write_not_configured', 400);
  const d = body.data || body;
  if (!isUuid(d.work_account_id)) return err('work_account_id required', 400);
  const wa = await loadWorkAccount(env, `id=eq.${d.work_account_id}`);
  if (!wa) return err('not_found', 404);
  if (wa.status !== 'created' || !wa.google_user_id) return j1Err('not_resettable');
  if (wa.application_id) {
    const app = await loadApplication(env, wa.application_id);
    if (!app || app.status === 'joined') return j1Err('not_resettable');
  } else {
    const er = await sb(`/rest/v1/employees?work_email=eq.${encodeURIComponent(wa.email)}&select=id&limit=1`, env);
    if (!er.ok) return err('db_error', 500);
    if (er.data?.length) return j1Err('not_resettable');
  }
  let token;
  try { token = await googleWriteToken(env, 'directory'); }
  catch (e) { return err('google_write_not_configured: ' + (e?.message || e), 502); }
  const pw = tempPassword((n) => crypto.getRandomValues(new Uint8Array(n)));
  const ur = await fetch(`${GDIR_USERS}/${encodeURIComponent(wa.google_user_id)}`, { method: 'PUT',
    headers: { ...gJson, Authorization: `Bearer ${token}` }, body: JSON.stringify({ password: pw, changePasswordAtNextLogin: true }) });
  const ud = await ur.json().catch(() => ({}));
  await googleAdminLog(env, auth, { action: 'reset_password', target_email: wa.email, google_user_id: wa.google_user_id,
    work_account_id: wa.id, request: { changePasswordAtNextLogin: true }, ok: ur.ok, error: ur.ok ? null : (ud?.error?.message || `HTTP ${ur.status}`) });
  if (!ur.ok) return j1Err('google_error', 502);
  return ok({ work_account_id: wa.id, email: wa.email, temp_password: pw });
}
// ── end J1 create

const alreadyCopied = (r) => r.status === 409 || String(r.data?.statusCode) === '409'
  || /already exists|duplicate/i.test(typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {}));

// POST confirmJoining {application_id, start_date} — the day the person turns up. Copies the hiring documents
// (+ the issued offer PDF) under <employee_id>/hiring/, then ONE transaction (hiring_confirm_joining).
// Re-running is safe: employee_id is allocated once and stored, copies treat "already exists" as done,
// and the RPC returns the existing employee for an application already joined.
async function confirmJoining(body, auth, env, ctx) {
  const d = body.data || body;
  const c = await offerAppCtx(auth, env, d.application_id);
  if (c.res) return c.res;
  const { app, x, me } = c;
  if (!canConfirmJoining(x.roles)) return err('forbidden', 403);
  const actor = { actor_user_id: auth.userId, actor_employee_id: me?.id || null };
  let wa = await loadWorkAccount(env, `application_id=eq.${app.id}`);
  if (app.status === 'joined') {
    if (!wa?.employee_id) return j1Err('not_accepted');
    const r = await hiringRpc(env, 'hiring_confirm_joining', { application_id: app.id, employee_id: wa.employee_id, ...actor }, { headers: actorHeaders(auth) });
    if (r.ok) await seedJoinerOrgUnit(env, wa.employee_id, wa, auth);
    return r.ok ? ok({ ...(r.data || {}), ...(await onboardingAfterJoining(env, wa.employee_id, auth.userId)),
      ...(await copyCandidateBankOnJoining(env, app.candidate_id, wa.employee_id)),
      google_sync: await googleSyncAfterSave(env, auth, ctx, wa.employee_id) }) : j1DbError(r);
  }
  if (app.status !== 'accepted') return j1Err('not_accepted');
  if (!wa || wa.status !== 'created') return j1Err('no_work_account');
  const [or, cr, dr] = await Promise.all([
    sb(`/rest/v1/offers?application_id=eq.${app.id}&select=*&order=revision.desc`, env),
    sb(`/rest/v1/candidates?id=eq.${app.candidate_id}&select=id,employee_id&limit=1`, env),
    sb(`/rest/v1/candidate_documents?candidate_id=eq.${app.candidate_id}&select=*&order=uploaded_at.asc`, env),
  ]);
  if (!or.ok || !cr.ok || !dr.ok) return err('db_error', 500);
  if (cr.data?.[0]?.employee_id) return j1Err('rehire_not_supported_yet');
  const jo = joiningOffer(or.data || []);
  if (jo.error) return j1Err(jo.error);
  const off = jo.offer;
  const sd = checkStartDate(d.start_date, istToday(), off.accepted_at);
  if (sd) return j1Err(sd, 400);

  // Allocate the employee id once (guarded on null), so retries reuse it and the copied paths agree.
  if (!wa.employee_id) {
    const pr = await sb(`/rest/v1/work_accounts?id=eq.${wa.id}&employee_id=is.null`, env, { method: 'PATCH',
      body: JSON.stringify({ employee_id: crypto.randomUUID() }) });
    if (!pr.ok) return j1DbError(pr);
    wa = pr.data?.[0] || await loadWorkAccount(env, `id=eq.${wa.id}`);
    if (!wa?.employee_id) return j1Err('stale');
  }
  const empId = wa.employee_id;

  const docs = (dr.data || []).filter(cd => !NOT_COPIED_ON_JOINING.has(cd.doc_type)).map(cd => {
    const name = cd.file_name || String(cd.storage_path).split('/').pop();
    return { src: cd.storage_path, storage_path: employeeDocPath(empId, cd.id, name), doc_type: candidateDocToEmployeeDocType(cd.doc_type),
      title: cd.title || name, file_name: name, mime_type: cd.mime_type || null, file_size: cd.file_size ?? null };
  });
  if (off.pdf_path) {
    const name = `${off.offer_ref}-r${off.revision}.pdf`;
    docs.push({ src: off.pdf_path, storage_path: employeeDocPath(empId, off.id, name), doc_type: 'offer_letter',
      title: `${off.offer_ref} r${off.revision} — offer letter as issued`, file_name: name, mime_type: 'application/pdf', file_size: null });
  }
  const copies = await Promise.all(docs.map(doc => storageFetch(`/object/copy`, env, { method: 'POST', headers: gJson,
    body: JSON.stringify({ bucketId: DOC_BUCKET, sourceKey: doc.src, destinationKey: doc.storage_path }) })));
  // Say WHICH documents failed (title + type — never storage paths), so HR can fix or remove them.
  const failed = docs.filter((_, i) => !copies[i].ok && !alreadyCopied(copies[i])).map(doc => ({ title: doc.title, doc_type: doc.doc_type }));
  if (failed.length) {
    const list = failed.map(f => `${f.title} (${f.doc_type})`).join('; ');
    return json({ ok: false, error: `doc_copy_failed: ${list}`, code: 'doc_copy_failed', message: J1_COPY.doc_copy_failed, failed }, 502);
  }

  // offer_id + terms_hash: the RPC re-checks, under the application lock, that this is still the joining
  // revision with these terms (the components and the documents above were built from it).
  const r = await hiringRpc(env, 'hiring_confirm_joining', {
    application_id: app.id, employee_id: empId, start_date: d.start_date, offer_id: off.id, terms_hash: off.terms_hash,
    components: off.annexure ? componentsContract(off.annexure, off) : null,
    documents: docs.map(({ src, ...rest }) => rest), ...actor,
  }, { headers: actorHeaders(auth) });
  if (!r.ok) return j1DbError(r);
  // J1b D5: Podium owns the org unit; the joiner's is the one their account was created in (never overwrites one set).
  await seedJoinerOrgUnit(env, empId, wa, auth);
  // J1b: the new employee row was marked pending by the insert trigger; push title / department / manager / code now.
  return ok({ ...(r.data || {}), ...(await onboardingAfterJoining(env, empId, auth.userId)),
    ...(await copyCandidateBankOnJoining(env, app.candidate_id, empId)),
    google_sync: await googleSyncAfterSave(env, auth, ctx, empId) });
}

// J1b D5: a joiner's org_unit_path = the OU their work account was created in, only while it is unset. Best-effort.
async function seedJoinerOrgUnit(env, employeeId, wa, auth) {
  if (!isUuid(employeeId) || !wa?.org_unit_path) return;
  try {
    await sb(`/rest/v1/employees?id=eq.${employeeId}&org_unit_path=is.null`, env, { method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ org_unit_path: wa.org_unit_path, google_org_unit: wa.org_unit_path }), headers: actorHeaders(auth) });
  } catch (_e) { /* best-effort: the push leaves Google's OU alone when Podium's is blank */ }
}

// O1 (D3): the bank details the candidate gave through the offer link → employee_private, ONLY when that row has
// no account yet (a first fill, not a change request — a later change still goes through profile_change_requests).
// Never fails the joining: a problem comes back as bank_copy_warning.
async function copyCandidateBankOnJoining(env, candidateId, employeeId) {
  try {
    const br = await sb(`/rest/v1/candidate_bank_details?candidate_id=eq.${candidateId}&select=bank_account_number,bank_ifsc,bank_account_name&limit=1`, env);
    if (!br.ok) return { bank_copied: false, bank_copy_warning: 'db_error' };
    const b = br.data?.[0];
    if (!b) return { bank_copied: false };
    const fields = { bank_account_number: b.bank_account_number, bank_ifsc: b.bank_ifsc, bank_account_name: b.bank_account_name };
    const ins = await sb(`/rest/v1/employee_private?on_conflict=employee_id`, env, { method: 'POST',
      prefer: 'resolution=ignore-duplicates,return=representation', body: JSON.stringify([{ employee_id: employeeId, ...fields }]) });
    if (!ins.ok) return { bank_copied: false, bank_copy_warning: 'db_error' };
    if (ins.data?.length) return { bank_copied: true };
    const up = await sb(`/rest/v1/employee_private?employee_id=eq.${employeeId}&bank_account_number=is.null`, env, {
      method: 'PATCH', body: JSON.stringify(fields) });
    if (!up.ok) return { bank_copied: false, bank_copy_warning: 'db_error' };
    return { bank_copied: !!up.data?.length };
  } catch (_e) {
    return { bank_copied: false, bank_copy_warning: 'exception' };
  }
}

// J2 hook (decision 5): start the joiner's onboarding right after the joining commits. Best-effort — a failure
// NEVER fails the joining; it is reported (onboarding_started: false + the code) and the HR board lists the person
// under "joined without an onboarding" with a Start button. An onboarding that already exists (a re-run) counts.
async function onboardingAfterJoining(env, employeeId, actorUserId) {
  try {
    // ANY onboarding row (open, complete or CANCELLED) → never auto-start again: a re-run of confirmJoining after HR
    // cancelled one must not resurrect it. HR can still start one by hand.
    const er = await sb(`/rest/v1/employee_onboardings?employee_id=eq.${employeeId}&select=status&order=created_at.desc&limit=1`, env);
    if (!er.ok || !Array.isArray(er.data)) return { onboarding_started: false, onboarding_error: 'db_error' };
    if (er.data.length) return { onboarding_existing: er.data[0].status };
    const r = await startOnboardingFor(env, employeeId, actorUserId, 'joining');
    if (r.ok) return { onboarding_started: true, onboarding_id: r.data?.onboarding_id || null };
    const code = onboardingDbErrorCode(r.data)?.code || 'db_error';
    if (code === 'onboarding_already_open' || code === 'onboarding_already_complete') return { onboarding_started: true, onboarding_existing: true };
    return { onboarding_started: false, onboarding_error: code };
  } catch (e) {
    return { onboarding_started: false, onboarding_error: 'exception' };
  }
}

// POST markNoShow {application_id, reason?, note?} — accepted → no_show. The accepted offer stays as the
// record (they accepted and did not turn up), so unlike the other closes it does not need withdrawing first;
// an amendment still in flight does. setApplicationStatus routes →no_show here.
async function markNoShow(body, auth, env, ctx) {
  const d = body.data || body;
  const c = await offerAppCtx(auth, env, d.application_id || d.id);
  if (c.res) return c.res;
  const { app, x, me } = c;
  if (!canConfirmJoining(x.roles)) return err('forbidden', 403);
  const reason = String(d.reason || '').trim() || null;
  const bad = checkTransition(app.status, 'no_show', reason);
  if (bad === 'bad_reason') return errCode('bad_reason', `reason must be one of: ${OUTCOME_REASON_CODES.join(', ')}`, 400);
  if (bad) return errCode('invalid_transition', `Cannot mark ${app.status} as no-show`, 409);
  const live = OFFER_LIVE_STATUSES.filter(s => s !== 'accepted');
  const lr = await sb(`/rest/v1/offers?application_id=eq.${app.id}&status=in.(${live.join(',')})&select=id&limit=1`, env);
  if (lr.data?.length) return errCode('close_offers_first', OFFER_COPY.close_offers_first, 409);
  const note = String(d.note || '').trim() || null;
  const r = await sb(`/rest/v1/applications?id=eq.${app.id}&status=eq.${app.status}`, env, { method: 'PATCH',
    body: JSON.stringify({ status: 'no_show', closed_at: nowIso(), ...(reason ? { outcome_reason: reason } : {}) }) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  if (!r.data?.length) return errCode('stale', 'The application changed — reload and retry', 409);
  await maybeStartRetention(app.candidate_id, env);
  await later(ctx, calendarSweepApplication(env, app.id));   // O3 D8
  await hiringEvents(env, auth, me, [{ candidate_id: app.candidate_id, opening_id: app.opening_id, application_id: app.id,
    event_type: 'status_changed', from_status: app.status, to_status: 'no_show', reason, detail: note ? { note } : null }]);
  const wa = await loadWorkAccount(env, `application_id=eq.${app.id}`);
  return ok({ id: app.id, status: 'no_show', work_account_status: wa?.status || null });
}

// POST suspendWorkAccount {work_account_id} — Google admin; only for an application that ended no_show /
// withdrawn (X1 widens this). users.update {suspended:true}; row → suspended; logged.
async function suspendWorkAccount(body, auth, env) {
  const gate = await requireGoogleAdmin(auth, env); if (gate) return gate;
  if (!googleWriteConfigured(env)) return err('google_write_not_configured', 400);
  const d = body.data || body;
  if (!isUuid(d.work_account_id)) return err('work_account_id required', 400);
  const wa = await loadWorkAccount(env, `id=eq.${d.work_account_id}`);
  if (!wa) return err('not_found', 404);
  // Idempotent: already suspended → nothing to call, nothing to log again.
  if (wa.status === 'suspended') return ok({ id: wa.id, status: 'suspended', already: true });
  if (wa.status !== 'created' || !wa.google_user_id || !wa.application_id) return j1Err('not_suspendable');
  const app = await loadApplication(env, wa.application_id);
  if (!app || !SUSPENDABLE_APP_STATUSES.includes(app.status)) return j1Err('not_suspendable');
  const request = { suspended: true };
  let token;
  try { token = await googleWriteToken(env, 'directory'); }
  catch (e) { return err('google_write_not_configured: ' + (e?.message || e), 502); }
  const ur = await fetch(`${GDIR_USERS}/${encodeURIComponent(wa.google_user_id)}`, { method: 'PUT',
    headers: { ...gJson, Authorization: `Bearer ${token}` }, body: JSON.stringify(request) });
  const ud = await ur.json().catch(() => ({}));
  if (!ur.ok) {
    await googleAdminLog(env, auth, { action: 'suspend_user', target_email: wa.email, google_user_id: wa.google_user_id,
      work_account_id: wa.id, request, ok: false, error: ud?.error?.message || `HTTP ${ur.status}` });
    return j1Err('google_error', 502);
  }
  const pr = await sb(`/rest/v1/work_accounts?id=eq.${wa.id}&status=eq.created`, env, { method: 'PATCH',
    body: JSON.stringify({ status: 'suspended', suspended_at: nowIso(), suspended_by: auth.userId }) });
  await googleAdminLog(env, auth, { action: 'suspend_user', target_email: wa.email, google_user_id: wa.google_user_id,
    work_account_id: wa.id, request, ok: true });
  if (!pr.ok || !pr.data?.length) return j1Err('record_failed', 500);
  return ok({ id: wa.id, status: 'suspended' });
}

// ────────────────────────────────────────────────────────────────────────────
// J1b — PODIUM → GOOGLE FIELD SYNC (plan docs/superpowers/plans/2026-11-12-podium-j1b-google-sync.md, D1–D11).
// One way: name / title / department / manager / employee code / org unit go FROM Podium TO Google (never phones —
// Afshaan 2026-11-13); Google values are only ever displayed (getGoogleDiff). Dirty-marking is in the database (0015 triggers on
// employees + departments → google_sync_state.dirty_fields), and a drain pushes ONLY those fields: a save that
// changed the title pushes the title, nothing else. Every field is pushed only through pushGoogleFields (HR's
// reviewed bulk push, D11).
// Push timing (no cron): the save that touched one person pushes them inline (8 s budget, googleSyncAfterSave);
// fan-out and leftovers drain after the response (kickGoogleSync → ctx.waitUntil), ≤ 8 people per drain, each
// row claimed with a 2-minute lease; failures retry with backoff 1 / 5 / 30 min. Every push = ownership check →
// GET (full) → merge (src/googlesync.js, never clobbers) → ownership check → PUT only when something changes, each
// Google call aborted after 20 s. Logged in google_admin_log (actor = who made the change, else the caller).
// Founders and super-admins are excluded entirely (users_profile.role = super_admin, EMP-001 / EMP-002, Google
// isAdmin, the impersonated admin). Pure rules: src/googlesync.js.
// ────────────────────────────────────────────────────────────────────────────

const J1B_COPY = {
  podium_owns_these_fields: 'Podium owns department, manager and org unit now and pushes them to Google. Change them on the person in Podium',
  bad_fields: 'Pick fields from: name, title, department, manager, employee_code, org_unit',
  bulk_push_paused: 'The bulk push to Google is paused while Podium’s data is checked. Preview still works; saving a person still updates their Google account',
  too_many: `Push at most ${GSYNC_CAP} people at a time`,
  employee_ids_required: 'Pick at least one person',
  preview_required: 'Preview first: Push needs the preview of every person it sends',
  stale_preview: 'Google or Podium changed since the preview for some people. They were not pushed. Preview again',
  google_write_not_configured: 'Google writes are not configured on the worker',
  google_not_configured: 'Google sync is not configured on the worker',
  context_failed: 'Could not load who is excluded from the sync. Nothing was pushed',
};
const j1bErr = (code, status = 409, extra = {}) => json({ ok: false, error: code, message: J1B_COPY[code] || code.replace(/_/g, ' '), ...extra }, status);
const GSYNC_INLINE_MS = 8000;
const SYNC_EMP_SELECT = 'id,employee_code,auth_user_id,full_name,work_email,phone,job_title,status,department_id,manager_id,'
  + 'org_unit_path,google_user_id,google_org_unit,department:department_id(name),manager:manager_id(work_email)';
const gsyncReady = (env) => googleWriteConfigured(env) && googleConfigured(env);
// D8/M: who made the change. 0015's gsync_actor() reads this header (PostgREST's request.headers) inside the dirty
// trigger, so google_sync_state.dirtied_by names the saver however the write reached the table.
const actorHeaders = (auth) => (isUuid(auth?.userId) ? { 'X-Podium-Actor': auth.userId } : {});

// What Google should hold for an employee row loaded with SYNC_EMP_SELECT.
function desiredFor(e) {
  return desiredGoogleFields(e, { departmentName: e?.department?.name || null, managerEmail: e?.manager?.work_email || null,
    hasManager: !!e?.manager_id });
}

// Who is excluded (D4). FAILS CLOSED: null when any lookup fails, and callers push nothing — a push without the
// super-admin list could write to a founder's account. `gusers` (optional) = the live list for the OU check;
// without it the live OUs load lazily, once, only when a push would MOVE someone (loadLiveOus).
async function googleSyncContext(env, gusers = null) {
  const [sres, igRes, saRes] = await Promise.all([
    sb(`/rest/v1/settings?id=eq.1&select=directory_excluded_ous&limit=1`, env),
    sb(`/rest/v1/directory_ignored?select=email`, env),
    sbStore(`/rest/v1/users_profile?role=eq.super_admin&select=id`, env),
  ]);
  if (!sres.ok || !igRes.ok || !saRes.ok || !Array.isArray(igRes.data) || !Array.isArray(saRes.data)) return null;
  const c = {
    excludedOus: sres.data?.[0]?.directory_excluded_ous || ['/Admin and general'],
    ignored: new Set(igRes.data.map(r => String(r.email || '').toLowerCase())),
    // + the FOUNDER_CODES deny-list inside scopeOf (src/googlesync.js).
    superAdminAuthIds: new Set(saRes.data.map(p => p.id)),
    liveOus: gusers ? new Set(liveOus(gusers)) : null,
    impersonateEmail: env.GOOGLE_ADMIN_IMPERSONATE_EMAIL || null,
  };
  let p = null;
  c.loadLiveOus = () => (p ||= fetchGoogleUsers(env).then(us => { c.liveOus = new Set(liveOus(us)); }));
  return c;
}

// A Directory call that cannot outlive the claim's lease (GOOGLE_CALL_TIMEOUT_MS each, lease 2 min). R5: the deadline
// stays armed while the BODY is read, and the parsed body is returned — a response whose body stalls is aborted and
// surfaces as an AbortError (→ google_timeout, a retryable failure). Callers never read the body themselves.
// → { ok, status, data }   (throws on network error / timeout)
export async function googleFetch(url, opts = {}, timeoutMs = GOOGLE_CALL_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    return { ok: r.ok, status: r.status, data };
  } finally { clearTimeout(t); }
}
const googleCallError = (x) => (x?.name === 'AbortError' ? 'google_timeout' : String(x?.message || x).slice(0, 300));

async function googleGetUser(token, email) {
  try {
    const r = await googleFetch(`${GDIR_USERS}/${encodeURIComponent(email)}?projection=full`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) return { user: null };
    if (!r.ok) return { error: r.data?.error?.message || `HTTP ${r.status}` };
    return { user: r.data };
  } catch (x) { return { error: googleCallError(x) }; }
}

// Does this attempt still own the row, with `needMs` of lease left? (cheap select; see leaseHeld)
async function gsyncStillOwner(env, employeeId, attemptId, needMs) {
  const r = await sb(`/rest/v1/google_sync_state?employee_id=eq.${employeeId}&select=attempt_id,attempt_started_at&limit=1`, env);
  return !!(r.ok && leaseHeld(r.data?.[0], attemptId, Date.now(), needMs));
}

// R2 — the check right before a PUT: still the owner (with time for the PUT), AND the person is still who the attempt
// loaded (status, work email, Google user id re-read) and still in scope. → null = go | the outcome to stop with.
async function gsyncPrePutCheck(env, e, attemptId, gUser, sctx) {
  const [sr, er] = await Promise.all([
    sb(`/rest/v1/google_sync_state?employee_id=eq.${e.id}&select=attempt_id,attempt_started_at&limit=1`, env),
    sb(`/rest/v1/employees?id=eq.${e.id}&select=status,work_email,google_user_id&limit=1`, env),
  ]);
  if (!sr.ok || !leaseHeld(sr.data?.[0], attemptId, Date.now(), GOOGLE_CALL_TIMEOUT_MS + 5000)) return { outcome: 'lost_claim' };
  const fresh = er.ok ? er.data?.[0] : null;
  if (identityChanged(e, fresh) || !scopeOf({ ...e, ...fresh }, gUser, sctx).ok) {
    return { outcome: 'failed', error: 'identity_changed', retry_attempts: IDENTITY_RETRY_ATTEMPTS };
  }
  return null;
}

// One person: scope → (ownership) → GET → merge → [preview hash] → (ownership + identity) → PUT, unless a dry run or
// nothing changes.
// opts.fields = the SYNC_FIELDS to merge (omitted = all, for the admin's full preview / push).
// opts.attemptId = the claim (absent on a dry run: nothing is written).
// opts.expectHash = an admin push's claimed_hash (R1): the final body must hash to it, or no PUT (stale_preview).
// → { outcome: ok | failed | skipped | would_push | no_change | lost_claim | stale_preview, body?, user?, after?,
//     desired?, error?, skip_reason?, backfill_ou?, fieldSkips?, retry_attempts? }
//     after = the users.update response (or the GET when nothing was sent)
export async function pushOneToGoogle(env, token, e, sctx, { fields, dryRun = false, attemptId = null, expectHash = null } = {}) {
  // Everything decidable without Google first: a founder / ignored / exited person never reaches a Google call.
  const pre = scopeOf(e, null, sctx);
  if (pre.reason !== 'no_google_account') return { outcome: 'skipped', skip_reason: pre.reason };
  // The GET as late as possible: right after the ownership check, right before the merge and PUT.
  if (attemptId && !(await gsyncStillOwner(env, e.id, attemptId, 2 * GOOGLE_CALL_TIMEOUT_MS + 5000))) return { outcome: 'lost_claim' };
  const g = await googleGetUser(token, e.work_email);
  if (g.error) return { outcome: 'failed', error: g.error };
  const sc = scopeOf(e, g.user, sctx);
  if (!sc.ok) return { outcome: 'skipped', skip_reason: sc.reason, user: g.user };
  // R6: only an attempt that pushes org_unit AND moves the person needs the live OU list (D4: never into an OU Google
  // does not have). A bad TARGET OU drops the org_unit field only; the other fields still go.
  if (needsOuCheck(e, g.user, fields) && !sctx.liveOus) {
    try { await sctx.loadLiveOus(); } catch (x) { return { outcome: 'failed', error: 'google_ou_list_failed', user: g.user }; }
  }
  const eff = effectiveFields(e, g.user, fields, sctx);
  // D5 backfill (read-only from Google): an unset org_unit_path takes Google's live OU, without dirtying anyone.
  const backfill_ou = !e.org_unit_path && g.user.orgUnitPath ? g.user.orgUnitPath : null;
  const desired = desiredFor(e);
  const body = mergeGoogleUser(g.user, desired, { fields: eff.fields });
  const extra = { user: g.user, desired, backfill_ou, fieldSkips: eff.fieldSkips };
  if (dryRun) return { outcome: body ? 'would_push' : 'no_change', body, ...extra };
  // R1: an admin push sends exactly what HR previewed, or nothing.
  if (expectHash !== null && (await previewHash(body || null)) !== expectHash) return { outcome: 'stale_preview', body, ...extra };
  if (!body) return { outcome: 'ok', body: null, after: g.user, ...extra };
  const stop = await gsyncPrePutCheck(env, e, attemptId, g.user, sctx);
  if (stop) return { ...stop, body: stop.outcome === 'lost_claim' ? null : body, ...extra };
  // users.get returns the resource's `etag`; it is sent as If-Match so a user changed in Google since our GET is not
  // overwritten. Whether Directory users.update enforces If-Match is not documented: a 412 is handled (retryable, the
  // next drain re-GETs), and an ignored header changes nothing. Verify on the synthetic account (plan step 5).
  const headers = { ...gJson, Authorization: `Bearer ${token}`, ...(g.user.etag ? { 'If-Match': g.user.etag } : {}) };
  try {
    const r = await googleFetch(`${GDIR_USERS}/${encodeURIComponent(g.user.id)}`, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (r.status === 412) return { outcome: 'failed', error: 'google_changed_since_read', body, attempted: true, ...extra };
    if (!r.ok) return { outcome: 'failed', error: r.data?.error?.message || `HTTP ${r.status}`, body, attempted: true, ...extra };
    return { outcome: 'ok', body, after: r.data, attempted: true, ...extra };
  } catch (x) { return { outcome: 'failed', error: googleCallError(x), body, attempted: true, ...extra }; }
}

// The google_sync_record row for one claimed person (fs = the fields this attempt was asked to push). null = record
// nothing. oneShot (an admin push, R1): every outcome but ok only RELEASES the claim — the row is left untouched and
// no retry is scheduled for the picked fields (the admin re-previews and pushes again).
function syncRecordRow(row, o, fs, { oneShot = false } = {}) {
  if (o.outcome === 'lost_claim') return null;   // another attempt owns the row now; it records its own result
  const base = { employee_id: row.employee_id, rev: row.rev, ...(o.backfill_ou ? { backfill_ou: o.backfill_ou } : {}) };
  if (o.outcome === 'ok') {
    // G: what Google holds now = the users.update response (or the GET, when nothing needed sending).
    const g = googleFieldsOf(o.after);
    const pushed = fs.filter(f => !o.fieldSkips?.[f]);
    // R6: a field-only skip (bad target OU) still counts as done (a drain must not retry it on every page view): it
    // leaves dirty_fields, is not recorded in last_pushed, and is noted in skip_reason (the person page shows it).
    const skip = Object.entries(o.fieldSkips || {}).map(([f, why]) => `${f}:${why}`).join(',') || null;
    return { ...base, outcome: 'ok', done_fields: fs, skip_reason: skip, last_pushed: nextLastPushed(row.last_pushed, o.desired, pushed, g),
      google_org_unit: g.org_unit, google_manager_email: g.manager, google_user_id: o.user?.id || null };
  }
  if (oneShot) return { ...base, outcome: 'release' };
  if (o.outcome === 'skipped') return { ...base, outcome: 'skipped', skip_reason: o.skip_reason };
  return { ...base, outcome: 'failed', error: String(o.error || 'failed').slice(0, 500),
    next_attempt_at: nextAttemptAt(o.retry_attempts || Number(row.attempts || 0) + 1) };
}

// Best-effort, one insert per drain (the Google writes already happened). Each row carries its own actor (NOT NULL).
async function googleAdminLogMany(env, rows) {
  const list = rows.filter(e => isUuid(e?.actor));
  if (!list.length) return;
  try {
    await sb(`/rest/v1/google_admin_log`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(list.map(e => ({
      actor: e.actor, actor_email: e.actor_email || null, action: e.action, target_email: e.target_email,
      google_user_id: e.google_user_id || null, work_account_id: null, request: e.request || null,
      ok: !!e.ok, error: e.error ? String(e.error).slice(0, 500) : null,
    }))) });
  } catch (_e) { /* best-effort */ }
}

// The log rows for an attempt: only pushes that reached Google (a PUT was sent). actor = who made the change
// (dirtied_by) for a save / drain / retry, the admin for an admin push; request = { trigger, caller, body }.
function gsyncLogRows(rows, outs, emails, auth, trigger) {
  return rows.map((row, i) => {
    const o = outs[i];
    const target = emails.get(row.employee_id);
    if (!target || !o.attempted) return null;
    const actor = trigger !== 'push' && isUuid(row.dirtied_by) ? row.dirtied_by : auth.userId;
    return { actor, actor_email: actor === auth.userId ? auth.email : null, action: o.outcome === 'ok' ? 'sync_fields' : 'sync_fields_failed',
      target_email: target, google_user_id: o.user?.id, ok: o.outcome === 'ok', error: o.error,
      request: { trigger, caller: auth.userId, body: o.body } };
  }).filter(Boolean);
}

// The drain: claim ≤ 8 due rows (oldest change first) in ONE guarded PATCH, push each person's dirty fields, record
// every result in ONE RPC (google_sync_record). Never throws.
// opts.ids limits it to those people · opts.trigger = save | drain | retry (for the log).
// → { configured, results: [{ employee_id, status, error?, skip_reason?, fields }] }
async function drainGoogleSync(env, auth, { ids = null, trigger = 'drain' } = {}) {
  if (!gsyncReady(env)) return { configured: false, results: [] };
  if (!auth?.userId) return { configured: true, results: [] };
  try {
    let idf = '';
    if (ids) {
      const list = [...new Set(ids.filter(isUuid))].slice(0, GSYNC_CAP);
      if (!list.length) return { configured: true, results: [] };
      idf = `employee_id=in.(${list.join(',')})&`;
    }
    const due = await sb(`/rest/v1/google_sync_state?${idf}${syncClaimFilter()}&select=employee_id&order=dirty_at.asc&limit=${GSYNC_CAP}`, env);
    if (!due.ok || !due.data?.length) return { configured: true, results: [] };
    const attemptId = crypto.randomUUID();
    // One UPDATE, so its row order does not matter. The remaining deadlock risk against the dirty trigger / the record
    // (0015, R4) is Postgres-detected: 40P01 aborts one transaction, nothing hangs, and the loser is redone later.
    // A drain claim never carries a preview hash (claimed_hash is only an admin push's, R1).
    const claim = await sb(`/rest/v1/google_sync_state?employee_id=in.(${due.data.map(x => x.employee_id).join(',')})&${syncClaimFilter()}`, env,
      { method: 'PATCH', body: JSON.stringify({ attempt_id: attemptId, attempt_started_at: nowIso(), claimed_fields: null, claimed_hash: null }) });
    const rows = claim.ok && Array.isArray(claim.data) ? claim.data : [];
    if (!rows.length) return { configured: true, results: [] };

    const [er, sctx, tok] = await Promise.all([
      sb(`/rest/v1/employees?id=in.(${rows.map(r => r.employee_id).join(',')})&select=${SYNC_EMP_SELECT}`, env),
      googleSyncContext(env),
      googleWriteToken(env, 'directory').then(t => ({ t }), x => ({ error: String(x?.message || x) })),
    ]);
    const fsOf = rows.map(row => fieldsToPush(row.dirty_fields, row.claimed_fields));
    let outs;
    if (!er.ok || !Array.isArray(er.data) || !sctx) outs = rows.map(() => ({ outcome: 'failed', error: 'context_failed' }));
    else if (tok.error) outs = rows.map(() => ({ outcome: 'failed', error: tok.error }));
    else {
      const byId = new Map(er.data.map(e => [e.id, e]));
      outs = await Promise.all(rows.map((row, i) => {
        const e = byId.get(row.employee_id);
        return e ? pushOneToGoogle(env, tok.t, e, sctx, { fields: fsOf[i], attemptId }) : Promise.resolve({ outcome: 'skipped', skip_reason: 'not_found' });
      }));
    }
    const emails = new Map((er.data || []).map(e => [e.id, e.work_email]));
    const recs = rows.map((row, i) => syncRecordRow(row, outs[i], fsOf[i])).filter(Boolean);
    const rec = recs.length ? await hiringRpc(env, 'google_sync_record', { attempt_id: attemptId, results: recs }) : { ok: true };
    await googleAdminLogMany(env, gsyncLogRows(rows, outs, emails, auth, trigger));
    return {
      configured: true, recorded: !!rec.ok,
      results: rows.map((row, i) => ({ employee_id: row.employee_id, status: outs[i].outcome === 'lost_claim' ? 'pending' : outs[i].outcome,
        error: outs[i].error || null, skip_reason: outs[i].skip_reason || null, fields: bodyFields(outs[i].body) })),
    };
  } catch (e) {
    console.error('[google-sync drain]', e?.message || e);
    return { configured: true, results: [], error: String(e?.message || e).slice(0, 300) };
  }
}

// Drain after the response (fan-out: a renamed department, a manager's new email, reassigned reports, leftovers).
function kickGoogleSync(env, auth, ctx) {
  if (!ctx?.waitUntil || !gsyncReady(env) || !auth?.userId) return;
  ctx.waitUntil(drainGoogleSync(env, auth).catch(() => null));
}

// D7: the save that touched ONE person pushes them inline (8 s budget), then the rest drains after the response.
// Never throws, never fails the save. → { status, error?, skip_reason? } | null
//   status: ok | failed | skipped | pending (still going / claimed elsewhere / backing off / fields left) | none
//           (never dirty) | not_configured
async function googleSyncAfterSave(env, auth, ctx, employeeId, trigger = 'save') {
  try {
    if (!isUuid(employeeId)) return null;
    if (!gsyncReady(env)) return { status: 'not_configured' };
    const run = drainGoogleSync(env, auth, { ids: [employeeId], trigger });
    if (ctx?.waitUntil) ctx.waitUntil(run.then(() => drainGoogleSync(env, auth)).catch(() => null));
    let timer;
    const r = await Promise.race([run, new Promise(res => { timer = setTimeout(() => res(null), GSYNC_INLINE_MS); })]);
    clearTimeout(timer);
    if (!r) return { status: 'pending' };
    const mine = (r.results || []).find(x => x.employee_id === employeeId);
    const st = await sb(`/rest/v1/google_sync_state?employee_id=eq.${employeeId}&select=status,last_error,skip_reason&limit=1`, env);
    const row = st.data?.[0];
    // The row is the truth (an ok push with fields still dirty is `pending`); the drain result carries the error.
    if (row) return { status: row.status, error: mine?.error || row.last_error || null, skip_reason: mine?.skip_reason || row.skip_reason || null };
    return mine ? { status: mine.status, error: mine.error || null, skip_reason: mine.skip_reason || null } : { status: 'none' };
  } catch (e) {
    return { status: 'failed', error: String(e?.message || e).slice(0, 300) };
  }
}

// Retry (google_sync_queue): make the ALREADY-dirty fields due now. Adds no field (R1: admin pushes are one-shot).
async function queueGoogleSyncRetry(env, ids) {
  return hiringRpc(env, 'google_sync_queue', { ids, fields: [] });
}

// D5 backfill outside a drain (the diff / preview reads): one RPC, never dirties. Best-effort.
async function backfillOrgUnits(env, items) {
  if (!items.length) return;
  try { await hiringRpc(env, 'google_sync_backfill_ou', { items }); } catch (_e) { /* best-effort */ }
}

const SYNC_STATE_SELECT = 'employee_id,status,dirty_fields,attempts,last_attempt_at,next_attempt_at,last_error,last_pushed_at,skip_reason,dirty_at';

// GET getGoogleSyncStatus?employee_id= — the person page's banner / chip (HR or a Google admin). Without
// employee_id: the counts + the failed list (Directory screen). Opening it also drains (D7).
async function getGoogleSyncStatus(url, auth, env, ctx) {
  const gAdmin = await isGoogleAdmin(auth, env);
  if (!isHr(auth) && !gAdmin) return err('forbidden', 403);
  kickGoogleSync(env, auth, ctx);
  const id = url.searchParams.get('employee_id');
  if (id) {
    if (!isUuid(id)) return err('employee_id required', 400);
    const r = await sb(`/rest/v1/google_sync_state?employee_id=eq.${id}&select=${SYNC_STATE_SELECT}&limit=1`, env);
    if (!r.ok) return err('db_error', 500);
    return ok({ employee_id: id, configured: gsyncReady(env), can_retry: gAdmin, sync: r.data?.[0] || null });
  }
  const r = await sb(`/rest/v1/google_sync_state?status=neq.ok&select=${SYNC_STATE_SELECT},employee:employee_id(full_name,work_email)&order=dirty_at.asc&limit=500`, env);
  if (!r.ok) return err('db_error', 500);
  const rows = r.data || [];
  const counts = { pending: 0, failed: 0, skipped: 0 };
  for (const x of rows) if (x.status in counts) counts[x.status]++;
  return ok({ configured: gsyncReady(env), can_retry: gAdmin, counts,
    failed: rows.filter(x => x.status === 'failed').map(x => ({ employee_id: x.employee_id, full_name: x.employee?.full_name || null,
      work_email: x.employee?.work_email || null, last_error: x.last_error, attempts: x.attempts, next_attempt_at: x.next_attempt_at })) });
}

// POST retryGoogleSync {employee_id} — Google admin: push this person's dirty fields now, backoff or not.
async function retryGoogleSync(body, auth, env, ctx) {
  const gate = await requireGoogleAdmin(auth, env); if (gate) return gate;
  if (!gsyncReady(env)) return j1bErr('google_write_not_configured', 400);
  const d = body.data || body;
  if (!isUuid(d.employee_id)) return err('employee_id required', 400);
  const q = await queueGoogleSyncRetry(env, [d.employee_id]);
  if (!q.ok) return err('db_error', 500);
  return ok({ employee_id: d.employee_id, google_sync: await googleSyncAfterSave(env, auth, ctx, d.employee_id, 'retry') });
}

// The dry run for these people: GET + merge (fields = the pick, or every field), the exact body and its hash.
// Nothing is written to Google; an unset org_unit_path is backfilled from the GET (D5). → { res } | { results }
async function previewGooglePush(env, ids, fields) {
  const [er, sctx, tok] = await Promise.all([
    sb(`/rest/v1/employees?id=in.(${ids.join(',')})&select=${SYNC_EMP_SELECT}`, env),
    googleSyncContext(env),
    googleWriteToken(env, 'directory').then(t => ({ t }), x => ({ error: String(x?.message || x) })),
  ]);
  if (!er.ok || !Array.isArray(er.data) || !sctx) return { res: j1bErr('context_failed', 500) };
  if (tok.error) return { res: err('google_write_not_configured: ' + tok.error, 502) };
  const byId = new Map(er.data.map(e => [e.id, e]));
  const outs = await Promise.all(ids.map(id => byId.get(id)
    ? pushOneToGoogle(env, tok.t, byId.get(id), sctx, { fields: fields || undefined, dryRun: true })
    : Promise.resolve({ outcome: 'skipped', skip_reason: 'not_found' })));
  await backfillOrgUnits(env, ids.map((id, i) => (outs[i].backfill_ou ? { employee_id: id, ou: outs[i].backfill_ou } : null)).filter(Boolean));
  const hashes = await Promise.all(outs.map(o => previewHash(o.body || null)));
  return { results: ids.map((id, i) => ({ employee_id: id, full_name: byId.get(id)?.full_name || null,
    work_email: byId.get(id)?.work_email || null, status: outs[i].outcome, skip_reason: outs[i].skip_reason || null,
    error: outs[i].error || null, fields: bodyFields(outs[i].body), body: outs[i].body || null, hash: hashes[i] })) };
}

// R1 — the admin push: ONE-SHOT and bound to the preview. Claims each person (google_sync_claim: claimed_fields = the
// pick, claimed_hash = the preview's hash), then claim → GET → merge → the body must hash to claimed_hash → PUT.
// Nothing is queued and nothing is added to dirty_fields. On success the record removes the pushed fields from
// dirty_fields as usual (ok only when none is left); every other outcome just releases the claim (no retry is
// scheduled for the picked fields: the admin previews and pushes again). → { results } | { res }
async function adminPushGoogle(env, auth, ids, fields, hashes) {
  const picked = fields || SYNC_FIELDS;
  const attemptId = crypto.randomUUID();
  const claim = await hiringRpc(env, 'google_sync_claim', { attempt_id: attemptId, fields: picked, lease_ms: SYNC_LEASE_MS,
    items: ids.map(id => ({ employee_id: id, hash: hashes[id] })) });
  if (!claim.ok || !Array.isArray(claim.data)) return { res: err('db_error: claim failed', 500) };
  const rows = claim.data;
  const out = new Map();
  if (rows.length) {
    const [er, sctx, tok] = await Promise.all([
      sb(`/rest/v1/employees?id=in.(${rows.map(r => r.employee_id).join(',')})&select=${SYNC_EMP_SELECT}`, env),
      googleSyncContext(env),
      googleWriteToken(env, 'directory').then(t => ({ t }), x => ({ error: String(x?.message || x) })),
    ]);
    let outs;
    if (!er.ok || !Array.isArray(er.data) || !sctx) outs = rows.map(() => ({ outcome: 'failed', error: 'context_failed' }));
    else if (tok.error) outs = rows.map(() => ({ outcome: 'failed', error: tok.error }));
    else {
      const byId = new Map(er.data.map(e => [e.id, e]));
      outs = await Promise.all(rows.map(row => {
        const e = byId.get(row.employee_id);
        return e ? pushOneToGoogle(env, tok.t, e, sctx, { fields: fieldsToPush(picked, row.claimed_fields), attemptId, expectHash: row.claimed_hash })
          : Promise.resolve({ outcome: 'skipped', skip_reason: 'not_found' });
      }));
    }
    const recs = rows.map((row, i) => syncRecordRow(row, outs[i], fieldsToPush(picked, row.claimed_fields), { oneShot: true })).filter(Boolean);
    if (recs.length) await hiringRpc(env, 'google_sync_record', { attempt_id: attemptId, results: recs });
    await googleAdminLogMany(env, gsyncLogRows(rows, outs, new Map((er.data || []).map(e => [e.id, e.work_email])), auth, 'push'));
    rows.forEach((row, i) => out.set(row.employee_id, outs[i]));
  }
  return { results: ids.map(id => {
    const o = out.get(id);
    // Not claimed = another attempt holds the person right now.
    if (!o) return { employee_id: id, status: 'in_progress', error: null, skip_reason: null, fields: [] };
    const status = o.outcome === 'lost_claim' ? 'in_progress' : o.outcome;
    return { employee_id: id, status, error: o.error || null, skip_reason: o.skip_reason || null, fields: o.attempted ? bodyFields(o.body) : [],
      field_skips: o.fieldSkips || {} };
  }) };
}

// settings.google_bulk_push_paused (0019). true unless the row says exactly false.
export async function bulkPushPaused(env) {
  const r = await sb(`/rest/v1/settings?id=eq.1&select=google_bulk_push_paused&limit=1`, env);
  return !(r.ok && r.data?.[0]?.google_bulk_push_paused === false);
}

// POST pushGoogleFields {employee_ids (≤ 8), fields?, dry_run, preview_hashes} — Google admin.
// dry_run: the exact users.update body per person + its hash (nothing written to Google, nothing logged).
// Push (R1): preview_hashes {employee_id: hash} is REQUIRED for every person (400 preview_required); one-shot via
// adminPushGoogle. Anyone whose body no longer matches the preview is not pushed (stale_preview); the response is
// 409 stale_preview when any are, with every person's result.
export async function pushGoogleFields(body, auth, env, ctx) {
  const gate = await requireGoogleAdmin(auth, env); if (gate) return gate;
  if (!gsyncReady(env)) return j1bErr('google_write_not_configured', 400);
  const d = body.data || body;
  const ids = [...new Set((Array.isArray(d.employee_ids) ? d.employee_ids : []).filter(isUuid))];
  if (!ids.length) return j1bErr('employee_ids_required', 400);
  if (ids.length > GSYNC_CAP) return j1bErr('too_many', 400);
  const fc = cleanSyncFields(d.fields);
  if (fc.error) return j1bErr(fc.error, 400);

  if (d.dry_run) {
    const pv = await previewGooglePush(env, ids, fc.fields);
    return pv.res || ok({ dry_run: true, results: pv.results });
  }
  // Afshaan 2026-11-13: no bulk alignment until he has checked Podium's data (0019). Anything but an explicit false
  // (a failed read included) keeps it paused.
  if (await bulkPushPaused(env)) return j1bErr('bulk_push_paused', 423);
  const hashes = d.preview_hashes && typeof d.preview_hashes === 'object' ? d.preview_hashes : null;
  if (!hashes || ids.some(id => typeof hashes[id] !== 'string' || !/^[0-9a-f]{64}$/.test(hashes[id]))) return j1bErr('preview_required', 400);
  const r = await adminPushGoogle(env, auth, ids, fc.fields, hashes);
  if (r.res) return r.res;
  kickGoogleSync(env, auth, ctx);
  const stale = r.results.filter(x => x.status === 'stale_preview').map(x => x.employee_id);
  if (stale.length) return j1bErr('stale_preview', 409, { results: r.results, stale });
  return ok({ dry_run: false, results: r.results });
}

// GET getGoogleDiff — the Google vs Podium tab (D11, HR). Per person × field: Podium's value, Google's, and the state
// (equal / differs / podium_blank / changed_in_google). Nothing is written to Google; an unset org_unit_path is
// backfilled from the live list (D5, without dirtying anyone).
async function getGoogleDiff(url, auth, env, ctx) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!googleConfigured(env)) return j1bErr('google_not_configured', 400);
  let gusers;
  try { gusers = await fetchGoogleUsers(env); }
  catch (e) { return err('google_sync_failed: ' + (e?.message || e), 502); }
  const [er, sr, sctx, gAdmin, paused] = await Promise.all([
    sb(`/rest/v1/employees?status=neq.exited&select=${SYNC_EMP_SELECT}&order=full_name.asc&limit=5000`, env),
    sb(`/rest/v1/google_sync_state?select=employee_id,status,dirty_fields,last_error,skip_reason,last_pushed,last_pushed_at&limit=5000`, env),
    googleSyncContext(env, gusers),
    isGoogleAdmin(auth, env),
    bulkPushPaused(env),
  ]);
  if (!er.ok || !sr.ok || !sctx) return j1bErr('context_failed', 500);
  kickGoogleSync(env, auth, ctx);
  const gByEmail = new Map(gusers.map(u => [String(u.primaryEmail || '').toLowerCase(), u]));
  const stateById = new Map((sr.data || []).map(x => [x.employee_id, x]));
  const people = [], skipped = [], backfill = [];
  for (const e of er.data || []) {
    const g = gByEmail.get(String(e.work_email || '').toLowerCase()) || null;
    const sc = scopeOf(e, g, sctx);
    if (!sc.ok) { skipped.push({ id: e.id, full_name: e.full_name, work_email: e.work_email, reason: sc.reason }); continue; }
    if (!e.org_unit_path && g.orgUnitPath) { backfill.push({ employee_id: e.id, ou: g.orgUnitPath }); e.org_unit_path = g.orgUnitPath; }
    const st = stateById.get(e.id) || null;
    const fields = diffPerson(desiredFor(e), googleFieldsOf(g), st?.last_pushed || null);
    people.push({
      id: e.id, full_name: e.full_name, employee_code: e.employee_code, work_email: e.work_email, fields,
      differing: SYNC_FIELDS.filter(f => fields[f].state === 'differs' || fields[f].state === 'changed_in_google'),
      sync: st ? { status: st.status, dirty_fields: st.dirty_fields, last_error: st.last_error, last_pushed_at: st.last_pushed_at } : null,
    });
  }
  await backfillOrgUnits(env, backfill);
  return ok({
    fields: SYNC_FIELDS, people, skipped, can_push: gAdmin, bulk_paused: paused, push_chunk: GSYNC_CAP,
    counts: { in_scope: people.length, differing: people.filter(p => p.differing.length).length, skipped: skipped.length, backfilled_ou: backfill.length },
  });
}

// GET getOrgUnitOptions — EmployeeForm's Org unit picker (HR): Google's live OUs minus the excluded ones, and the
// L2 suggestion per department: defaultOu over the department's active people, by org_unit_path (what Podium
// owns), falling back to google_org_unit. Never '/' (that is "no suggestion"). Empty when Google is not set up.
// R7: the OU list is the OUs Google users sit in (fetchGoogleUsers), not orgunits.list — no new Directory scope for
// J1b. So an empty OU is not offered (the form says so), and a stored OU
// Google no longer has is a push-time skip of the org_unit FIELD only (effectiveFields → target_ou_unknown).
async function getOrgUnitOptions(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!googleConfigured(env)) return ok({ configured: false, ous: [], default_by_department: {} });
  let gusers;
  try { gusers = await fetchGoogleUsers(env); }
  catch (e) { return err('google_sync_failed: ' + (e?.message || e), 502); }
  const [sres, er] = await Promise.all([
    sb(`/rest/v1/settings?id=eq.1&select=directory_excluded_ous&limit=1`, env),
    sb(`/rest/v1/employees?status=eq.active&select=department_id,status,org_unit_path,google_org_unit&limit=5000`, env),
  ]);
  if (!sres.ok || !er.ok) return err('db_error', 500);
  const excluded = sres.data?.[0]?.directory_excluded_ous || ['/Admin and general'];
  const ous = liveOus(gusers).filter(ou => !ouExcluded(ou, excluded));
  const rows = (er.data || []).map(x => ({ department_id: x.department_id, status: x.status, google_org_unit: x.org_unit_path || x.google_org_unit || null }));
  const deptIds = [...new Set(rows.map(x => x.department_id).filter(Boolean))];
  const def = {};
  for (const id of deptIds) { const ou = defaultOu(id, rows); if (ou && ou !== '/' && ous.includes(ou)) def[id] = ou; }
  return ok({ configured: true, ous, default_by_department: def });
}
// ── end J1b

// ────────────────────────────────────────────────────────────────────────────
// X1 — EXITS + NO-DUES (plan docs/superpowers/plans/2026-11-11-podium-x1-exits.md, spec "X1" + L4–L8).
// The exit flow is the ONLY path to `exited`: startExit (exit + checklist snapshot, exit_start) → owners tick
// lines (updateExitItem → exit_update_item, under the exit lock) → HR closes (exit_close: live asset / Docket
// checks, exited, access revoked, the Google prompt opened) → reports reassigned (RULE-PODIUM-010).
// createEmployee / updateEmployee / the Directory sync all refuse exit writes. "On notice" = an open exit (no
// `notice` status — 0010 deviation 1).
// Gates: HR = isHr · manager = the manager chain · self = the employee row's auth_user_id IS the caller (self
// wins over HR — nobody runs their own exit) · Google admin = isGoogleAdmin (J1). Pure rules: src/exits.js.
// Reach: 60 of 64 employees and 14 of 18 managers hold no podium_view (2026-11-11), so getExit, getMyTeamExits,
// startExit and updateExitItem are self-serve; each self-scopes through exitCtx.
// ────────────────────────────────────────────────────────────────────────────

const X1_COPY = {
  use_exit_flow: 'Exits are recorded through the Exit panel on the person’s page, not by editing status or dates',
  exits_are_recorded_in_podium: 'The sync no longer exits anyone — start the exit on the person’s page',
  forbidden: 'You cannot act on this exit',
  forbidden_item: 'Only HR — or the manager, for manager lines — can set this line',
  set_by_close: 'LOT app access is revoked by closing the exit',
  bad_reason_code: 'Pick a reason',
  reason_note_required: 'Say what the reason is',
  bad_notice_date: 'Pick the date notice was given',
  notice_date_in_future: 'The notice date cannot be in the future',
  notice_date_too_old: 'The notice date can be at most 7 days back — HR can record an older one',
  notice_before_joining: 'The notice date is before the person joined',
  bad_lwd: 'Pick the last working day',
  lwd_before_notice: 'The last working day is before the notice date',
  lwd_before_joining: 'The last working day is before the person joined',
  lwd_override_hr_only: 'Only HR can change the last working day from the notice period',
  lwd_closed_month_hr_only: 'A last working day in an earlier month changes a closed SG&A month — only HR can set it, with a reason',
  lwd_override_reason_required: 'Say why the last working day differs from the notice period (at least 5 characters)',
  bad_rehire: 'Rehire must be yes, no or not recorded',
  already_exited: 'This person has already exited',
  exit_already_open: 'An exit is already open for this person',
  employee_not_found: 'Employee not found',
  item_not_found: 'Checklist line not found',
  exit_not_found: 'Exit not found',
  exit_not_open: 'This exit is not open',
  before_lwd: 'The exit can close on or after the last working day',
  checklist_incomplete: 'Required checklist lines are still open',
  assets_outstanding: 'Assets are still assigned to this person in Snorkel',
  assets_unverifiable: 'Snorkel cannot verify this person’s assets automatically — HR marks this line with a note',
  open_work: 'This person still owns or is assigned open Docket tasks',
  leave_after_lwd: 'This person has leave pending or approved after the last working day — cancel it first',
  leave_pending: 'This person has a leave request still pending — decide or withdraw it first',
  leave_changed: 'Leave changed since the balance was confirmed — confirm it again',
  exit_blocked: 'The exit cannot close yet — clear the blockers listed',
  live_check_failed: 'Could not check Snorkel / Docket right now — try again',
  org_check_failed: 'Could not check the reporting line right now — try again',
  bad_item_status: 'Pick Done, N/A or Open',
  na_not_allowed: 'This line cannot be marked N/A',
  na_note_required: 'Say why this line does not apply',
  bad_document: 'That document is not on this person’s record',
  cancel_reason_required: 'Say why the exit is cancelled (at least 5 characters)',
  not_exited: 'Only an exited person can be handled here',
  already_backfilled: 'This exit already has a record',
  no_work_email: 'This person has no work email',
  bad_google_action: 'Pick an action',
  google_item_closed: 'This Google account has already been actioned',
  transfer_in_progress: 'The Drive transfer is under way — use Check transfer',
  no_transfer_to_check: 'There is no transfer to check',
  in_progress: 'Someone else is acting on this account right now — wait a moment and reload',
  keep_until_future: 'Pick a future date to keep the account until',
  keep_reason_required: 'Say why the account stays active (at least 5 characters)',
  google_account_mismatch: 'The Google account no longer matches this address — not touched',
  manager_has_no_google_account: 'The manager has no Google account to receive the Drive — suspend only, or fix the manager',
  drive_app_not_found: 'Google did not list the Drive and Docs transfer app',
  google_error: 'Google refused the request',
  google_item_exists: 'This person already has an open Google item',
  bad_line: 'Check the line: key, title and owner are required',
  bad_tool: 'A tool needs a name',
  conflict: 'This conflicts with an existing record — reload and retry',
  check_failed: 'The record failed a consistency check',
};
// J1's errCode shape ({ ok:false, error:<code>, message }) + optional extras (blockers, detail).
const x1Err = (code, status = 409, extra = {}) =>
  json({ ok: false, error: code, message: X1_COPY[code] || code.replace(/_/g, ' '), ...extra }, status);
function x1DbError(r) {
  const m = exitDbErrorCode(r?.data);
  if (m) return x1Err(m.code, m.status, m.detail ? { detail: m.detail } : {});
  const d = r?.data && typeof r.data === 'object' ? r.data : {};
  return err(`db_error: ${[d.code, d.message].filter(Boolean).join(' ') || r?.status}`, 400);
}

// PostgREST read in another exposed schema (docket); service-role, like sb/sbStore.
async function sbSchema(schema, path, env) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, { headers: {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Accept-Profile': schema,
  } });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// loadOrgEdges returns [] on a DB error, which reads as "no chain" — fine for display, wrong for a gate.
async function loadOrgEdgesStrict(env) {
  const r = await sb(`/rest/v1/employees?select=id,manager_id,auth_user_id&limit=5000`, env);
  return r.ok && Array.isArray(r.data) ? r.data : null;
}

const EXIT_EMP_SELECT = 'id,employee_code,full_name,status,employment_type,auth_user_id,work_email,google_user_id,manager_id,date_joined';

// The employee + the caller's role on THIS person's exit. → { emp, me, role } | { res }
// Self comes from the loaded row (emp.auth_user_id === caller), never from the org graph: an edges failure
// must not turn an HR person's own exit into an HR exit. The chain is only consulted when it decides the role,
// and then a failed read fails closed.
async function exitCtx(auth, env, employeeId) {
  if (!isUuid(employeeId)) return { res: err('employee_id required', 400) };
  const er = await sb(`/rest/v1/employees?id=eq.${employeeId}&select=${EXIT_EMP_SELECT}&limit=1`, env);
  if (!er.ok) return { res: err('db_error', 500) };
  const emp = er.data?.[0];
  if (!emp) return { res: err('not_found', 404) };
  const self = !!emp.auth_user_id && emp.auth_user_id === auth.userId;
  const hr = isHr(auth);
  let chain = false;
  if (!self && !hr) {
    const edges = await loadOrgEdgesStrict(env);
    if (!edges) return { res: x1Err('org_check_failed', 503) };
    const me = callerEmployee(edges, auth.userId);
    chain = !!me && me.id !== emp.id && inManagerChain(edges, emp.id, me.id);
  }
  return { emp, role: exitRole({ hr, self, chain }) };
}
async function loadExit(env, id) {
  if (!isUuid(id)) return null;
  return (await sb(`/rest/v1/employee_exits?id=eq.${id}&select=*&limit=1`, env)).data?.[0] || null;
}
async function exitItems(env, exitId) {
  const r = await sb(`/rest/v1/exit_checklist_items?exit_id=eq.${exitId}&select=*&order=sort.asc,line_key.asc`, env);
  return r.ok && Array.isArray(r.data) ? r.data : null;
}
async function exitNoticeDays(env) {
  const r = await sb(`/rest/v1/settings?id=eq.1&select=exit_notice_days&limit=1`, env);
  const n = r.ok ? r.data?.[0]?.exit_notice_days : null;
  return n == null ? 30 : Number(n);
}
// PostgREST `ilike` with no `*` is a case-insensitive equality; LIKE's own % / _ are escaped.
const ilikeExact = (s) => encodeURIComponent(String(s || '').trim().replace(/([%_\\])/g, '\\$1'));

// The live lists under the checklist: Snorkel assets held, assets under the person's NAME with no custodian user
// (unlinked — cannot be verified automatically), open Docket tasks, open payment requests.
// → { ok, assets, unlinked_assets, assets_verifiable, tasks, payment_requests, payment_requests_verifiable }
// (ok=false if any source failed — callers that GATE on it fail closed).
async function exitLive(env, emp) {
  const authId = isUuid(emp.auth_user_id) ? emp.auth_user_id : null;
  const empty = Promise.resolve({ ok: true, data: [] });
  const closed = ASSET_CLOSED_STATUSES.join(',');
  const [ar, ur, tr, pr] = await Promise.all([
    authId ? sbStore(`/rest/v1/assets?custodian_user_id=eq.${authId}&status=not.in.(${closed})&select=id,asset_code,name,status,category:category_id(name)&order=asset_code.asc&limit=200`, env) : empty,
    emp.full_name ? sbStore(`/rest/v1/assets?custodian_user_id=is.null&custodian_name=ilike.${ilikeExact(emp.full_name)}&status=not.in.(${closed})&select=id,asset_code,name,status,custodian_name&limit=200`, env) : empty,
    sbSchema('docket', `/rest/v1/tasks?or=(assignee_employee_id.eq.${emp.id},owner_employee_id.eq.${emp.id})&status=in.(${DOCKET_OPEN_STATUSES.join(',')})&archived_at=is.null&select=id,task_no,title,status,assignee_employee_id,owner_employee_id&order=task_no.asc&limit=200`, env),
    authId ? sbStore(`/rest/v1/payment_requests?requested_by_user_id=eq.${authId}&status=in.(${PR_OPEN_STATUSES.join(',')})&select=id,request_no,purpose,status,amount_to_pay,invoice_total&order=id.desc&limit=100`, env) : empty,
  ]);
  const okAll = [ar, ur, tr, pr].every(x => x.ok && Array.isArray(x.data));
  const rows = (r) => (r.ok && Array.isArray(r.data) ? r.data : []);
  const unlinked = rows(ur).map(a => ({ id: a.id, asset_code: a.asset_code, name: a.name, status: a.status, custodian_name: a.custodian_name }));
  return {
    ok: okAll,
    assets: rows(ar).map(a => ({ id: a.id, asset_code: a.asset_code, name: a.name, status: a.status, category: a.category?.name || null })),
    unlinked_assets: unlinked,
    assets_verifiable: assetsVerifiable(authId, unlinked.length),
    tasks: rows(tr).map(t => ({ id: t.id, task_no: t.task_no, title: t.title, status: t.status,
      as: t.assignee_employee_id === emp.id && t.owner_employee_id === emp.id ? 'owner_assignee' : t.assignee_employee_id === emp.id ? 'assignee' : 'owner' })),
    payment_requests: rows(pr),
    payment_requests_verifiable: !!authId,
  };
}

// GET getExit?employee_id= — self, the manager chain or HR. The open exit (else the latest) + its checklist + the
// live lists + what still blocks the close. rehire_eligible / F&F: HR only; payment-request amounts: HR only.
async function getExit(url, auth, env) {
  const c = await exitCtx(auth, env, url.searchParams.get('employee_id'));
  if (c.res) return c.res;
  if (!canSeeExit(c.role)) return x1Err('forbidden', 403);
  const today = istToday();
  const [xr, days] = await Promise.all([
    sb(`/rest/v1/employee_exits?employee_id=eq.${c.emp.id}&select=*&order=created_at.desc&limit=10`, env),
    exitNoticeDays(env),
  ]);
  if (!xr.ok) return err('db_error', 500);
  const rows = xr.data || [];
  const exit = rows.find(x => x.status === 'open') || rows[0] || null;
  const base = {
    employee: { id: c.emp.id, employee_code: c.emp.employee_code, full_name: c.emp.full_name, status: c.emp.status,
      date_joined: c.emp.date_joined },
    role: c.role, can_manage: canManageExit(c.role), notice_days: days, today,
    history: rows.filter(x => x !== exit).map(x => ({ id: x.id, status: x.status, reason_code: x.reason_code, lwd: x.lwd })),
  };
  if (!exit) return ok({ ...base, exit: null, items: [], live: null, blockers: [], progress: null });
  const items = await exitItems(env, exit.id);
  if (!items) return err('db_error', 500);
  let live = null, blockers = [];
  if (exit.status === 'open') {
    const leaveItem = items.find(i => i.auto_source === 'leave_ledger') || null;
    const [l, lv] = await Promise.all([exitLive(env, c.emp), leaveItem ? exitLeaveLive(env, c.emp.id, exit.lwd) : Promise.resolve(null)]);
    const leaveChanged = !!lv?.ok && exitLeaveStale({ exit, item: leaveItem, requests: lv.requests, ledger: lv.covered ? lv.figures?.expected : null });
    live = { ...l, payment_requests: l.payment_requests.map(p => projectPaymentRequest(p, c.role)), leave: lv ? { ...lv, changed: leaveChanged } : null };
    blockers = closeBlockers(exit, items, { assets: l.assets.length, tasks: l.tasks.length, leave_changed: leaveChanged }, today);
    if (!l.ok || (lv && !lv.ok)) blockers.push({ code: 'live_check_failed' });
  }
  return ok({ ...base, exit: projectExit(exit, c.role), items, live, blockers, progress: itemProgress(items),
    days_left: exit.status === 'open' ? daysLeft(exit.lwd, today) : null });
}

// GET getMyTeamExits — self-serve: the caller's own exit status + everyone below them in the chain (the /me
// "Your team" list, for the managers who hold no podium_view). Directory-level fields only.
async function getMyTeamExits(url, auth, env) {
  const edges = await loadOrgEdgesStrict(env);
  if (!edges) return x1Err('org_check_failed', 503);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return ok({ employee_id: null, team: [] });
  const ids = [...descendantsOf(edges, me.id)].filter(isUuid);
  const [tr, onNotice] = await Promise.all([
    ids.length ? sb(`/rest/v1/employees?id=in.(${ids.join(',')})&status=neq.exited&select=id,employee_code,full_name,job_title,manager_id&order=full_name.asc`, env) : Promise.resolve({ ok: true, data: [] }),
    openExitEmployeeIds(env),
  ]);
  if (!tr.ok) return err('db_error', 500);
  return ok({ employee_id: me.id, on_notice: onNotice.has(me.id),
    team: (tr.data || []).map(e => ({ ...e, direct: e.manager_id === me.id, on_notice: onNotice.has(e.id) })) });
}

// GET getExits (HR) — the board: open exits, Google accounts to action (due first), the backfill queue with what
// each exited person can still reach (never revoked automatically — revokeExitedAccess, per person).
async function getExits(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const today = istToday();
  const [xr, gr, er, ar, gAdmin] = await Promise.all([
    sb(`/rest/v1/employee_exits?status=eq.open&select=id,employee_id,reason_code,initiated_by,notice_date,lwd,created_at,leave_confirmed_at,leave_as_at,leave_ledger_pl,leave_ledger_sl,employee:employee_id(id,employee_code,full_name,job_title,auth_user_id,leave_policy,department:department_id(name))&order=lwd.asc`, env),
    sb(`/rest/v1/google_exit_items?status=in.(${GOOGLE_LIVE_STATUSES.join(',')})&select=*,employee:employee_id(id,employee_code,full_name,manager_id)&order=created_at.asc`, env),
    sb(`/rest/v1/employees?status=eq.exited&select=id,employee_code,full_name,exit_reason,date_exited,date_joined,work_email,auth_user_id&order=date_exited.desc.nullslast&limit=1000`, env),
    sb(`/rest/v1/employee_exits?select=employee_id&limit=5000`, env),
    isGoogleAdmin(auth, env),
  ]);
  if (![xr, gr, er, ar].every(r => r.ok && Array.isArray(r.data))) return err('db_error', 500);
  const exits = xr.data;
  const ids = exits.map(x => x.id);
  const empIds = exits.map(x => x.employee_id).filter(isUuid);
  const authIds = exits.map(x => x.employee?.auth_user_id).filter(isUuid);
  const exitedAuth = er.data.map(e => e.auth_user_id).filter(isUuid);
  const none = Promise.resolve({ ok: true, data: [] });
  const inA = (list) => list.join(',');
  const [ir, asr, tkr, upr, rlr, car, gar, xar, gir] = await Promise.all([
    ids.length ? sb(`/rest/v1/exit_checklist_items?exit_id=in.(${inA(ids)})&select=exit_id,line_key,title,owner,required,allow_na,auto_source,status,sort`, env) : none,
    authIds.length ? sbStore(`/rest/v1/assets?custodian_user_id=in.(${inA(authIds)})&status=not.in.(${ASSET_CLOSED_STATUSES.join(',')})&select=custodian_user_id&limit=2000`, env) : none,
    empIds.length ? sbSchema('docket', `/rest/v1/tasks?or=(assignee_employee_id.in.(${inA(empIds)}),owner_employee_id.in.(${inA(empIds)}))&status=in.(${DOCKET_OPEN_STATUSES.join(',')})&archived_at=is.null&select=assignee_employee_id,owner_employee_id&limit=5000`, env) : none,
    // What exited people can still reach (backfill review).
    exitedAuth.length ? sbStore(`/rest/v1/users_profile?id=in.(${inA(exitedAuth)})&active=eq.true&select=id`, env) : none,
    exitedAuth.length ? sbStore(`/rest/v1/podium_user_roles?user_id=in.(${inA(exitedAuth)})&select=user_id`, env) : none,
    exitedAuth.length ? sb(`/rest/v1/comp_access?auth_user_id=in.(${inA(exitedAuth)})&select=auth_user_id`, env) : none,
    exitedAuth.length ? sb(`/rest/v1/google_admin_access?auth_user_id=in.(${inA(exitedAuth)})&select=auth_user_id`, env) : none,
    exitedAuth.length ? sbStore(`/rest/v1/assets?custodian_user_id=in.(${inA(exitedAuth)})&status=not.in.(${ASSET_CLOSED_STATUSES.join(',')})&select=custodian_user_id&limit=2000`, env) : none,
    sb(`/rest/v1/google_exit_items?select=employee_id&limit=5000`, env),
  ]);
  if (!ir.ok) return err('db_error', 500);
  // Leave R2 review A: exits whose leave line is done — is the confirmation still true? (read only: no lazy accrual
  // here; closeExit / exit_close are the authority). Batched: one request read + one ledger read.
  const leaveDone = exits.filter(x => (ir.data || []).some(i => i.exit_id === x.id && i.auto_source === 'leave_ledger' && i.status === 'done'));
  const lids = leaveDone.map(x => x.employee_id).filter(isUuid);
  const [lrq, lled] = lids.length ? await Promise.all([
    sbPaged(env, `/rest/v1/leave_requests?employee_id=in.(${inA(lids)})&status=in.(pending,approved)&select=employee_id,status,end_date&order=id.asc`),
    sbPaged(env, `/rest/v1/leave_ledger?employee_id=in.(${inA(lids)})&select=employee_id,leave_type,delta&order=id.asc`),
  ]) : [[], []];
  const leaveOk = !!lrq && !!lled;
  const sums = {};
  for (const r of lled || []) { const o = (sums[r.employee_id] ||= { PL: 0, SL: 0 }); o[r.leave_type] = halfRound(o[r.leave_type] + Number(r.delta)); }
  const liveOk = asr.ok && tkr.ok && leaveOk;
  const board = exits.map(x => {
    const items = (ir.data || []).filter(i => i.exit_id === x.id);
    const assets = (asr.data || []).filter(a => a.custodian_user_id && a.custodian_user_id === x.employee?.auth_user_id).length;
    const tasks = (tkr.data || []).filter(t => t.assignee_employee_id === x.employee_id || t.owner_employee_id === x.employee_id).length;
    const leaveItem = items.find(i => i.auto_source === 'leave_ledger') || null;
    const leave_changed = leaveOk && exitLeaveStale({ exit: x, item: leaveItem, requests: (lrq || []).filter(r => r.employee_id === x.employee_id),
      ledger: x.employee?.leave_policy ? (sums[x.employee_id] || { PL: 0, SL: 0 }) : null });
    const blockers = closeBlockers({ ...x, status: 'open' }, items, { assets, tasks, leave_changed }, today);
    if (!liveOk) blockers.push({ code: 'live_check_failed' });
    const { auth_user_id, leave_policy, ...employee } = x.employee || {};
    return { exit_id: x.id, employee, reason_code: x.reason_code, initiated_by: x.initiated_by, notice_date: x.notice_date,
      lwd: x.lwd, days_left: daysLeft(x.lwd, today), progress: itemProgress(items), blockers };
  });
  const google = gr.data.map(g => {
    const { acting_id, ...row } = g;
    return { ...row, due: googleItemDue(g, today), days_open: googleItemDaysOpen(g, today) };
  }).sort((a, b) => (Number(b.due) - Number(a.due)) || ((b.days_open || 0) - (a.days_open || 0)));
  const accessOk = [upr, rlr, car, gar, xar].every(r => r.ok && Array.isArray(r.data));
  const count = (r, col, id) => (r.data || []).filter(x => x[col] === id).length;
  // Any Google item at all (live or actioned) → never offered again (exit_open_google_item refuses too).
  const hasItem = new Set([...gr.data, ...(gir.ok && Array.isArray(gir.data) ? gir.data : [])].map(g => g.employee_id));
  const exited = er.data.map(e => {
    const a = isUuid(e.auth_user_id) ? {
      login_active: count(upr, 'id', e.auth_user_id) > 0, podium_roles: count(rlr, 'user_id', e.auth_user_id),
      comp_access: count(car, 'auth_user_id', e.auth_user_id) > 0, google_admin: count(gar, 'auth_user_id', e.auth_user_id) > 0,
      assets: count(xar, 'custodian_user_id', e.auth_user_id),
    } : { login_active: false, podium_roles: 0, comp_access: false, google_admin: false, assets: 0 };
    const { auth_user_id, ...row } = e;
    return { ...row, auth_linked: isUuid(auth_user_id), access: a, access_left: accessLeft(a),
      can_open_google_item: !!e.work_email && gir.ok && !hasItem.has(e.id) };
  });
  const recorded = new Set(ar.data.map(x => x.employee_id));
  return ok({ today, exits: board, google, google_due: google.filter(g => g.due).length, can_act_google: gAdmin,
    backfill: exited.filter(e => !recorded.has(e.id)),
    access_left: exited.filter(e => recorded.has(e.id) && e.access_left.length),
    access_check_ok: accessOk, reason_codes: EXIT_REASON_CODES });
}

// POST startExit {employee_id, reason_code, reason_note, notice_date, lwd?, lwd_override_reason?, rehire_eligible?}
// Self-serve (self-scoped): self → resignation, notice today, default LWD. Manager chain → any reason, default
// LWD, notice ≤ 7 days back. HR → LWD override with a reason + the private rehire flag. One transaction: exit_start.
async function startExit(body, auth, env) {
  const d = body.data || body;
  const c = await exitCtx(auth, env, d.employee_id);
  if (c.res) return c.res;
  if (!canSeeExit(c.role)) return x1Err('forbidden', 403);
  if (c.emp.status === 'exited') return x1Err('already_exited');
  const [days, lr, tr] = await Promise.all([
    exitNoticeDays(env),
    sb(`/rest/v1/exit_checklist_lines?active=eq.true&select=*`, env),
    sb(`/rest/v1/exit_tools?active=eq.true&select=id,name,sort,active`, env),
  ]);
  if (!lr.ok || !tr.ok || !Array.isArray(lr.data) || !Array.isArray(tr.data)) return err('db_error', 500);
  const s = buildStartExit(d, c.role, days, istToday(), c.emp.date_joined);
  if (s.error) return x1Err(s.error, s.error === 'forbidden' ? 403 : 400);
  const items = snapshotItems(lr.data, tr.data, c.emp.employment_type);
  const r = await hiringRpc(env, 'exit_start', { employee_id: c.emp.id, started_by: auth.userId, ...s, items });
  return r.ok ? ok(r.data) : x1DbError(r);
}

// The exit, its employee and the caller's role, for the item/exit writes. → { exit, emp, role } | { res }
async function exitWriteCtx(auth, env, exitId) {
  const exit = await loadExit(env, exitId);
  if (!exit) return { res: x1Err('exit_not_found', 404) };
  const c = await exitCtx(auth, env, exit.employee_id);
  if (c.res) return c;
  return { exit, emp: c.emp, role: c.role };
}

// POST updateExitItem {item_id, status: done|na|open, note, document_id?} — self-serve: HR any line; the manager
// chain only `owner = 'manager'` lines. The write is exit_update_item: under the exit lock it re-runs every rule
// and the live asset / Docket checks itself, so a tick can never race a close.
async function updateExitItem(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.item_id)) return err('item_id required', 400);
  const item = (await sb(`/rest/v1/exit_checklist_items?id=eq.${d.item_id}&select=*&limit=1`, env)).data?.[0];
  if (!item) return err('not_found', 404);
  const c = await exitWriteCtx(auth, env, item.exit_id);
  if (c.res) return c.res;
  if (c.exit.status !== 'open') return x1Err('exit_not_open');
  const te = canTickItem(c.role, item);
  if (te) return x1Err(te, 403);
  const note = String(d.note || '').trim().slice(0, 2000) || null;
  // Pre-check for a clear answer (the RPC is the authority).
  let live = {};
  if (d.status === 'done' && (item.auto_source === 'snorkel_assets' || item.auto_source === 'open_work')) {
    const l = await exitLive(env, c.emp);
    if (!l.ok) return x1Err('live_check_failed', 502);
    live = { assets: l.assets.length, tasks: l.tasks.length, assets_verifiable: l.assets_verifiable };
  }
  // Leave R2 E2: the leave line's Done carries the PL / SL figures at the LWD (exit_update_item re-checks the guard and
  // the ledger under the person's leave lock, then writes the snapshot onto employee_exits).
  let leave = null;
  if (d.status === 'done' && item.auto_source === 'leave_ledger') {
    const lv = await exitLeaveLive(env, c.emp.id, c.exit.lwd);
    if (!lv.ok) return x1Err('live_check_failed', 502);
    live.leave_block = lv.block;
    if (lv.covered && lv.figures) {
      leave = { pl_balance: lv.figures.PL, sl_balance: lv.figures.SL, lop_days: lv.figures.lop_days,
        expected_pl: lv.figures.expected.PL, expected_sl: lv.figures.expected.SL, as_at: c.exit.lwd };
    }
  }
  const ce = checkItemUpdate(item, { status: d.status, note }, live, c.role);
  if (ce) return x1Err(ce, ce === 'bad_item_status' ? 400 : 409);
  if ('document_id' in d && d.document_id && !isUuid(d.document_id)) return x1Err('bad_document', 400);
  const p = { item_id: item.id, status: d.status, note, actor_user_id: auth.userId, role: c.role };
  if ('document_id' in d) p.document_id = d.document_id || null;
  if (leave) p.leave = leave;
  const r = await hiringRpc(env, 'exit_update_item', p);
  return r.ok ? ok(r.data) : x1DbError(r);
}

// POST updateExit {exit_id, lwd?, lwd_override_reason?, rehire_eligible?, exit_interview?, reason_code?, reason_note?}
// HR. Only CHANGED fields count. LWD + reason only while open (the PATCH is guarded status=eq.open; 0 rows =
// exit_not_open); a closed exit takes only the exit interview and the rehire flag.
async function updateExit(body, auth, env) {
  const d = body.data || body;
  const c = await exitWriteCtx(auth, env, d.exit_id);
  if (c.res) return c.res;
  if (!canManageExit(c.role)) return x1Err('forbidden', 403);
  const b = buildExitPatch(c.exit, d, await exitNoticeDays(env), istToday());
  if (b.error) return x1Err(b.error, b.error === 'exit_not_open' ? 409 : 400);
  if (!Object.keys(b.patch).length) return ok(projectExit(c.exit, 'hr'));
  // Leave R2 review A: a new LWD invalidates a confirmed leave balance — re-open the leave line first, then clear the
  // snapshot columns in the same exit PATCH (exit_close refuses a stale one anyway).
  if ('lwd' in b.patch && b.patch.lwd !== c.exit.lwd) {
    const ri = await sb(`/rest/v1/exit_checklist_items?exit_id=eq.${c.exit.id}&auto_source=eq.leave_ledger&status=neq.open`, env, { method: 'PATCH',
      body: JSON.stringify({ status: 'open', done_by: null, done_at: null }) });
    if (!ri.ok) return x1DbError(ri);
    Object.assign(b.patch, { leave_pl_balance: null, leave_sl_balance: null, leave_lop_days: null, leave_confirmed_at: null,
      leave_confirmed_by: null, leave_as_at: null, leave_ledger_pl: null, leave_ledger_sl: null });
  }
  const guard = b.openOnly ? '&status=eq.open' : '';
  const r = await sb(`/rest/v1/employee_exits?id=eq.${c.exit.id}${guard}`, env, { method: 'PATCH', body: JSON.stringify(b.patch) });
  if (!r.ok) return x1DbError(r);
  if (!r.data?.length) return x1Err('exit_not_open');
  return ok(projectExit(r.data[0], 'hr'));
}

// POST cancelExit {exit_id, reason} (HR) — e.g. the resignation was withdrawn. The checklist stays as history.
async function cancelExit(body, auth, env) {
  const d = body.data || body;
  const c = await exitWriteCtx(auth, env, d.exit_id);
  if (c.res) return c.res;
  if (!canManageExit(c.role)) return x1Err('forbidden', 403);
  const reason = String(d.reason || '').trim();
  if (reason.length < 5) return x1Err('cancel_reason_required', 400);
  const r = await sb(`/rest/v1/employee_exits?id=eq.${c.exit.id}&status=eq.open`, env, { method: 'PATCH',
    body: JSON.stringify({ status: 'cancelled', cancelled_at: nowIso(), cancelled_by: auth.userId, cancel_reason: reason.slice(0, 500) }) });
  if (!r.ok) return x1DbError(r);
  if (!r.data?.length) return x1Err('exit_not_open');
  return ok({ exit_id: c.exit.id, status: 'cancelled' });
}

// POST closeExit {exit_id} (HR) — the only path to `exited`. The blockers are computed here first and returned
// verbatim; exit_close re-checks under the lock (and is the authority). Then reports are reassigned.
async function closeExit(body, auth, env, ctx) {
  const d = body.data || body;
  const c = await exitWriteCtx(auth, env, d.exit_id);
  if (c.res) return c.res;
  if (!canManageExit(c.role)) return x1Err('forbidden', 403);
  if (c.exit.status !== 'open') return x1Err('exit_not_open');
  const [items, l] = await Promise.all([exitItems(env, c.exit.id), exitLive(env, c.emp)]);
  if (!items) return err('db_error', 500);
  if (!l.ok) return x1Err('live_check_failed', 502);
  // Leave R2 review A: a confirmed leave line must still hold (exit_close re-checks under the leave lock).
  const leaveItem = items.find(i => i.auto_source === 'leave_ledger') || null;
  let leaveChanged = false;
  if (leaveItem && leaveItem.status === 'done') {
    const lv = await exitLeaveLive(env, c.emp.id, c.exit.lwd);
    if (!lv.ok) return x1Err('live_check_failed', 502);
    leaveChanged = exitLeaveStale({ exit: c.exit, item: leaveItem, requests: lv.requests, ledger: lv.covered ? lv.figures?.expected : null });
  }
  const blockers = closeBlockers(c.exit, items, { assets: l.assets.length, tasks: l.tasks.length, leave_changed: leaveChanged }, istToday());
  if (blockers.length) return x1Err('exit_blocked', 409, { blockers });
  const r = await hiringRpc(env, 'exit_close', { exit_id: c.exit.id, actor_user_id: auth.userId }, { headers: actorHeaders(auth) });
  if (!r.ok) return x1DbError(r);
  // Exiting someone must never leave their reports pointing at an exited row (RULE-PODIUM-010).
  const reassigned = await reassignReportsOnExit(c.emp.id, auth, env);
  // J1b: the reassigned reports were marked pending (manager_id changed); their new manager goes to Google after the response.
  kickGoogleSync(env, auth, ctx);
  return ok({ ...(r.data || {}), reassigned });
}

// POST backfillExit {employee_id, reason_code, lwd} (HR) — the one-time review of exits recorded before X1: a
// closed exit with the HR-confirmed reason code + LWD; the old free text is kept as the note. No guessing.
async function backfillExit(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  if (!isUuid(d.employee_id)) return err('employee_id required', 400);
  if (!EXIT_REASON_CODES.includes(d.reason_code)) return x1Err('bad_reason_code', 400);
  // No allowFuture: date_exited is what the SG&A feed reads to STOP charging someone. (≥ date_joined: the RPC.)
  const e = badDate(d.lwd, 'Last working day', {}); if (e) return x1Err('bad_lwd', 400, { detail: e });
  const r = await hiringRpc(env, 'exit_backfill', { employee_id: d.employee_id, reason_code: d.reason_code, lwd: d.lwd, actor_user_id: auth.userId });
  return r.ok ? ok(r.data) : x1DbError(r);
}

// POST revokeExitedAccess {employee_id} (HR) — backfill review: for an EXITED person, deactivate the LOT login
// and remove the Podium role, salary access and Google-admin power (exit_revoke_access, logged in exit_events).
// Never automatic — the lane decided HR presses it per person.
async function revokeExitedAccess(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  if (!isUuid(d.employee_id)) return err('employee_id required', 400);
  const r = await hiringRpc(env, 'exit_revoke_access', { employee_id: d.employee_id, actor_user_id: auth.userId });
  return r.ok ? ok(r.data) : x1DbError(r);
}

// POST openGoogleExitItem {employee_id} (HR) — backfill review: open the Google prompt for an exited person with a
// work email and no live item (exit_open_google_item, logged in exit_events). Never suspends anything itself.
async function openGoogleExitItem(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  if (!isUuid(d.employee_id)) return err('employee_id required', 400);
  const r = await hiringRpc(env, 'exit_open_google_item', { employee_id: d.employee_id, actor_user_id: auth.userId });
  return r.ok ? ok(r.data) : x1DbError(r);
}

// Google user by id, else by address, verified to BE the address Podium holds.
// → { guser } | { gone: true } (404 by id AND by address) | { res }
async function verifiedGoogleUser(token, id, workEmail) {
  const get = (k) => fetch(`${GDIR_USERS}/${encodeURIComponent(k)}?projection=basic`, { headers: { Authorization: `Bearer ${token}` } });
  let r = id ? await get(id) : null;
  if (!r || r.status === 404) r = await get(workEmail);   // a stale / absent id → the address, exact match below
  if (r.status === 404) return { gone: true };
  const gu = await r.json().catch(() => ({}));
  if (!r.ok) return { res: x1Err('google_error', 502) };
  if (!googleUserMatches(gu, workEmail)) return { res: x1Err('google_account_mismatch') };
  return { guser: gu };
}

// POST actGoogleExitItem {item_id, action: transfer_and_suspend|suspend|keep|check_transfer, keep_until?, keep_reason?}
// Google admin (L3). Never automatic (L5); the employee must still be `exited`. The item is CLAIMED first
// (acting_id lease) so two admins can never act at once, and every write is guarded on the claim. The Google user
// is verified to BE the recorded address before any write. transfer = Drive and Docs → the manager (L6), then
// suspend → transfer_pending until "Check transfer" sees it completed. Every outcome lands in google_admin_log.
async function actGoogleExitItem(body, auth, env) {
  const gate = await requireGoogleAdmin(auth, env); if (gate) return gate;
  const d = body.data || body;
  if (!isUuid(d.item_id)) return err('item_id required', 400);
  // `op`, not `action`: every POST body's `action` is the route name (podiumopsPost sends {action, ...body}).
  const op = d.op;
  const item = (await sb(`/rest/v1/google_exit_items?id=eq.${d.item_id}&select=*,employee:employee_id(id,status,manager_id)&limit=1`, env)).data?.[0];
  if (!item) return err('not_found', 404);
  if (item.employee?.status !== 'exited') return x1Err('not_exited');
  const today = istToday();
  const ce = checkGoogleAction(item, { ...d, action: op }, today);
  if (ce) return x1Err(ce, ce === 'bad_google_action' ? 400 : 409);
  if (op !== 'keep' && !googleWriteConfigured(env)) return err('google_write_not_configured', 400);

  // Claim (J1 attempt pattern). Losers get in_progress.
  const actingId = crypto.randomUUID();
  const cr = await sb(`/rest/v1/google_exit_items?id=eq.${item.id}&${googleClaimFilter()}`, env, { method: 'PATCH',
    body: JSON.stringify({ acting_id: actingId, acting_until: new Date(Date.now() + GOOGLE_LEASE_MS).toISOString() }) });
  if (!cr.ok) return x1DbError(cr);
  if (!cr.data?.length) return x1Err('in_progress');
  const mine = `id=eq.${item.id}&${googleClaimGuard(actingId)}`;
  // Every write during the action: guarded on the claim AND checked. `finish` also releases the claim.
  const write = async (patch) => {
    const r = await sb(`/rest/v1/google_exit_items?${mine}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
    return r.ok && r.data?.length ? r.data[0] : null;
  };
  const release = () => write({ acting_id: null, acting_until: null });
  const finish = async (patch) => {
    const row = await write({ ...patch, acted_by: auth.userId, acted_at: nowIso(), acting_id: null, acting_until: null });
    if (!row) return x1Err('conflict', 500);
    const { acting_id, ...out } = row;
    return ok(out);
  };
  const fail = async (res, patch = {}) => { await write({ ...patch, acting_id: null, acting_until: null }); return res; };
  const logBase = { target_email: item.work_email, request: { google_exit_item_id: item.id } };

  try {
    if (op === 'keep') {
      await googleAdminLog(env, auth, { ...logBase, action: 'keep_active', google_user_id: item.google_user_id,
        request: { ...logBase.request, keep_until: d.keep_until }, ok: true });
      return await finish({ status: 'kept', keep_until: d.keep_until, keep_reason: String(d.keep_reason).trim().slice(0, 500), last_error: null });
    }

    if (op === 'check_transfer') {
      let dtToken;
      try { dtToken = await googleWriteToken(env, 'datatransfer'); }
      catch (e) { return await fail(err('google_write_not_configured: ' + (e?.message || e), 502)); }
      const tr = await fetch(`https://admin.googleapis.com/admin/datatransfer/v1/transfers/${encodeURIComponent(item.transfer_id)}`, { headers: { Authorization: `Bearer ${dtToken}` } });
      const td = await tr.json().catch(() => ({}));
      const outcome = tr.ok ? transferOutcome(td) : 'error';
      await googleAdminLog(env, auth, { ...logBase, action: 'transfer_checked', google_user_id: item.google_user_id,
        request: { ...logBase.request, transfer_id: item.transfer_id, outcome, google_status: td?.overallTransferStatusCode || null },
        ok: tr.ok, error: tr.ok ? null : (td?.error?.message || `HTTP ${tr.status}`) });
      if (!tr.ok) return await fail(x1Err('google_error', 502));
      if (outcome === 'completed') return await finish({ status: 'transferred_suspended', last_error: null });
      if (outcome === 'failed') {
        // Back to open with the error, transfer_id cleared — so a new transfer can be started deliberately.
        return await finish({ status: 'open', transfer_id: null, transfer_to_employee_id: null,
          last_error: `Drive transfer failed (${td?.overallTransferStatusCode || 'failed'})` });
      }
      await release();
      return ok({ id: item.id, status: 'transfer_pending', still_running: true });
    }

    let token;
    try { token = await googleWriteToken(env, 'directory'); }
    catch (e) { return await fail(err('google_write_not_configured: ' + (e?.message || e), 502)); }
    // Only 22 of 64 active employees carry google_user_id (2026-11-11): a 404 by id retries by address, and
    // either way the user must BE that address. Gone both ways → terminal `gone`, logged.
    const v = await verifiedGoogleUser(token, item.google_user_id, item.work_email);
    if (v.gone) {
      await googleAdminLog(env, auth, { ...logBase, action: 'account_gone', google_user_id: item.google_user_id, ok: true });
      return await finish({ status: 'gone', last_error: null });
    }
    if (v.res) return await fail(v.res);
    const gid = String(v.guser.id);
    const patch = { google_user_id: gid };

    if (op === 'transfer_and_suspend' && !item.transfer_id) {
      const mgr = item.employee?.manager_id && isUuid(item.employee.manager_id)
        ? (await sb(`/rest/v1/employees?id=eq.${item.employee.manager_id}&select=id,status,work_email,google_user_id&limit=1`, env)).data?.[0]
        : null;
      if (!mgr || mgr.status === 'exited' || !mgr.work_email) return await fail(x1Err('manager_has_no_google_account'));
      const mv = await verifiedGoogleUser(token, mgr.google_user_id, mgr.work_email);
      if (!mv.guser) return await fail(x1Err('manager_has_no_google_account'));
      let dtToken;
      try { dtToken = await googleWriteToken(env, 'datatransfer'); }
      catch (e) { return await fail(err('google_write_not_configured: ' + (e?.message || e), 502)); }
      const lr = await fetch('https://admin.googleapis.com/admin/datatransfer/v1/applications', { headers: { Authorization: `Bearer ${dtToken}` } });
      const ld = await lr.json().catch(() => ({}));
      if (!lr.ok) return await fail(x1Err('google_error', 502));
      const tb = driveTransferBody(gid, mv.guser.id, ld.applications);
      if (!tb) return await fail(x1Err('drive_app_not_found', 502));
      const trr = await fetch('https://admin.googleapis.com/admin/datatransfer/v1/transfers', { method: 'POST',
        headers: { ...gJson, Authorization: `Bearer ${dtToken}` }, body: JSON.stringify(tb) });
      const trd = await trr.json().catch(() => ({}));
      await googleAdminLog(env, auth, { ...logBase, action: 'drive_transfer', google_user_id: gid,
        request: { ...logBase.request, ...tb, to_employee_id: mgr.id }, ok: trr.ok && !!trd.id, error: trr.ok ? (trd.id ? null : 'no transfer id') : (trd?.error?.message || `HTTP ${trr.status}`) });
      if (!trr.ok || !trd.id) return await fail(x1Err('google_error', 502));
      // Recorded before the suspend, so a failed suspend retried later never starts a second transfer.
      const saved = await write({ transfer_id: String(trd.id), transfer_to_employee_id: mgr.id, google_user_id: gid });
      if (!saved) return x1Err('conflict', 500);   // claim lost after Google accepted the transfer — reload shows it
      item.transfer_id = String(trd.id);
    }

    const request = { suspended: true };
    if (v.guser.suspended) {
      await googleAdminLog(env, auth, { ...logBase, action: 'suspend_exited', google_user_id: gid,
        request: { ...logBase.request, ...request, already: true }, ok: true });
    } else {
      const ur = await fetch(`${GDIR_USERS}/${encodeURIComponent(gid)}`, { method: 'PUT',
        headers: { ...gJson, Authorization: `Bearer ${token}` }, body: JSON.stringify(request) });
      const ud = await ur.json().catch(() => ({}));
      await googleAdminLog(env, auth, { ...logBase, action: 'suspend_exited', google_user_id: gid,
        request: { ...logBase.request, ...request }, ok: ur.ok, error: ur.ok ? null : (ud?.error?.message || `HTTP ${ur.status}`) });
      if (!ur.ok) return await fail(x1Err('google_error', 502), patch);
    }
    // J1's row for a Podium-made account follows Google (best-effort; the item is the record).
    await sb(`/rest/v1/work_accounts?email=eq.${encodeURIComponent(item.work_email)}&status=eq.created`, env, { method: 'PATCH',
      prefer: 'return=minimal', body: JSON.stringify({ status: 'suspended', suspended_at: nowIso(), suspended_by: auth.userId }) });
    return await finish({ ...patch, status: item.transfer_id ? 'transfer_pending' : 'suspended', last_error: null });
  } catch (e) {
    await release();
    throw e;
  }
}

// ── Checklist template + tools (admin data, L4/L8): HR or podium_admin ──────
async function getExitChecklist(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const [lr, tr, days] = await Promise.all([
    sb(`/rest/v1/exit_checklist_lines?select=*&order=sort.asc,key.asc`, env),
    sb(`/rest/v1/exit_tools?select=*&order=sort.asc,name.asc`, env),
    exitNoticeDays(env),
  ]);
  if (!lr.ok || !tr.ok) return err('db_error', 500);
  return ok({ lines: lr.data || [], tools: tr.data || [], notice_days: days, owners: CHECKLIST_OWNERS, auto_sources: AUTO_SOURCES,
    can_edit_notice_days: isAdmin(auth) });
}

// POST saveExitChecklistLine {key, title, owner, required, allow_na, applies_to, sort, active} — upsert by key.
// auto_source is never written here: it is behaviour (a live check), not wording, so a new line is always manual.
async function saveExitChecklistLine(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  const key = String(d.key || '').trim();
  const title = String(d.title || '').trim();
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(key) || !title || title.length > 120 || !CHECKLIST_OWNERS.includes(d.owner)) return x1Err('bad_line', 400);
  const applies = Array.isArray(d.applies_to) ? [...new Set(d.applies_to.map(String))].slice(0, 10) : [];
  const row = { key, title, owner: d.owner, required: d.required !== false, allow_na: !!d.allow_na, applies_to: applies,
    sort: (d.sort === '' || d.sort == null || !Number.isFinite(Number(d.sort)) ? 100 : Math.round(Number(d.sort))), active: d.active !== false };
  const r = await sb(`/rest/v1/exit_checklist_lines?on_conflict=key`, env, { method: 'POST',
    prefer: 'return=representation,resolution=merge-duplicates', body: JSON.stringify([row]) });
  if (!r.ok) return x1DbError(r);
  return ok(r.data?.[0] || null);
}

// POST saveExitTool {id?, name, active, sort}
async function saveExitTool(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  const name = String(d.name || '').trim();
  if (!name || name.length > 80) return x1Err('bad_tool', 400);
  const row = { name, active: d.active !== false, sort: (d.sort === '' || d.sort == null || !Number.isFinite(Number(d.sort)) ? 100 : Math.round(Number(d.sort))) };
  const r = d.id
    ? (isUuid(d.id) ? await sb(`/rest/v1/exit_tools?id=eq.${d.id}`, env, { method: 'PATCH', body: JSON.stringify(row) }) : { ok: false, data: {} })
    : await sb(`/rest/v1/exit_tools`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return d.id && !isUuid(d.id) ? err('bad id', 400) : x1DbError(r);
  return ok(r.data?.[0] || null);
}
// ── end X1

// ────────────────────────────────────────────────────────────────────────────
// J2 — ONBOARDING (joiners) + PROFILE COMPLETION (everyone, once). Plan docs/superpowers/plans/
// 2026-11-12-podium-j2-onboarding.md. Pure rules: src/onboarding.js · SQL: migrations/0011_onboarding.sql.
// Sensitive fields live in podium.employee_private (decision 1), read ONLY by getMyProfile (self, full),
// getEmployeePrivate (HR: bank masked; comp: + salary fields, logged) and exportXPayroll (comp, logged).
// Self-change of a filled PAN / bank field → profile_change_requests, HR approves (decision 4). Onboarding starts
// from confirmJoining (best-effort, decision 5); auto lines are computed, never ticked (decision 6); nothing here
// gates payroll (decision 7).
// Reach: a brand-new joiner has NO Podium role (permissions {} → no podium_view), so every self action below is in
// SELF_SERVE_* and self-scopes on employees.auth_user_id = the caller. getOnboarding / updateOnboardingItem are
// self-serve for the manager chain (most managers hold no podium_view, as X1).
// ────────────────────────────────────────────────────────────────────────────

const J2_COPY = {
  no_employee: 'Your login is not linked to an employee profile yet — ask HR',
  invalid_fields: 'Some fields need fixing',
  cannot_clear_protected: 'PAN and bank details cannot be cleared once filled — enter the new value to request a change',
  forbidden: 'You cannot act on this onboarding',
  forbidden_item: 'Only HR — or the manager, for manager lines — can set this line',
  set_automatically: 'This line is checked automatically and is already done',
  auto_line_open: 'This line is checked automatically — fix the source (profile, Snorkel, policies…) instead of ticking it',
  unverifiable_note_required: 'This line cannot be checked automatically — say how it was verified',
  na_not_allowed: 'This line cannot be marked N/A',
  na_note_required: 'Say why this line does not apply',
  bad_item_status: 'Pick Done, N/A or Open',
  item_not_found: 'Checklist line not found',
  onboarding_not_found: 'Onboarding not found',
  onboarding_not_open: 'This onboarding is not open',
  onboarding_already_open: 'An onboarding is already open for this person',
  onboarding_already_complete: 'This person has already completed onboarding',
  onboarding_incomplete: 'Required lines are still open',
  onboarding_blocked: 'The onboarding cannot complete yet — clear the open lines listed',
  already_exited: 'This person has exited',
  employee_not_found: 'Employee not found',
  no_lines: 'The onboarding checklist has no active lines — add some under Admin → Onboarding Checklist',
  cancel_reason_required: 'Say why the onboarding is cancelled (at least 5 characters)',
  change_request_not_found: 'Change request not found',
  change_request_not_pending: 'This change request has already been decided',
  bad_decision: 'Approve or reject',
  decision_note_required: 'Say why the change is rejected',
  own_change_request: 'Another HR person decides your own change request',
  change_already_pending: 'A change is already awaiting HR approval',
  change_request_changed: 'The person changed this request since you loaded it — reload and look again',
  bad_group: 'Pick PAN or bank details',
  bad_pan: 'PAN looks like ABCDE1234F (5 letters, 4 digits, 1 letter)',
  upload_not_found: 'The upload did not arrive — pick the file and upload again',
  storage_check_failed: 'Could not check the upload right now — try again',
  audit_failed: 'The export could not be logged, so it was not produced — try again',
  policy_not_found: 'Policy not found',
  policy_not_applicable: 'This policy does not apply to you',
  policy_version_stale: 'A newer version of this policy was published — reload and read it',
  already_acknowledged: 'Already acknowledged',
  bad_policy: 'A policy needs a title and an uploaded PDF',
  bad_doc_type: 'Pick a document type',
  bad_file_type: 'Upload a PDF or an image (JPG, PNG, WEBP)',
  file_too_large: 'The file is over 15 MB',
  bad_file_size: 'The file is empty or over 15 MB',
  bad_line: 'Check the line: key, title, owner and the due offset (−60 to 365 days)',
  live_check_failed: 'Could not check the profile / Snorkel right now — try again',
  org_check_failed: 'Could not check the reporting line right now — try again',
  conflict: 'This conflicts with an existing record — reload and retry',
  check_failed: 'The record failed a consistency check',
};
const j2Err = (code, status = 409, extra = {}) =>
  json({ ok: false, error: code, message: J2_COPY[code] || code.replace(/_/g, ' '), ...extra }, status);
function j2DbError(r) {
  const m = onboardingDbErrorCode(r?.data);
  if (m) return j2Err(m.code, m.status, m.detail ? { detail: m.detail } : {});
  const d = r?.data && typeof r.data === 'object' ? r.data : {};
  return err(`db_error: ${[d.code, d.message].filter(Boolean).join(' ') || r?.status}`, 400);
}

// Everything the completion rule and the auto lines read off the employee row (values never leave the worker
// except to the person themselves).
const OB_EMP_SELECT = 'id,employee_code,full_name,preferred_name,status,employment_type,auth_user_id,manager_id,work_email,job_title,'
  + 'date_joined,probation_end_date,date_of_birth,gender,blood_group,personal_email,phone,emergency_contact_name,emergency_contact_phone,pan_number';
const OB_EMP_PUBLIC = (e) => ({ id: e.id, employee_code: e.employee_code, full_name: e.full_name, job_title: e.job_title ?? null,
  status: e.status, date_joined: e.date_joined ?? null, employment_type: e.employment_type ?? null });
const inList = (l) => l.join(',');

async function j2Settings(env) {
  const r = await sb(`/rest/v1/settings?id=eq.1&select=profile_campaign_launched_at,profile_campaign_launched_by,profile_required_doc_types,pt_state&limit=1`, env);
  const s = r.ok && Array.isArray(r.data) ? r.data[0] : null;
  return {
    ok: !!s,
    launched_at: s?.profile_campaign_launched_at || null,
    required_doc_types: Array.isArray(s?.profile_required_doc_types) ? s.profile_required_doc_types : DEFAULT_REQUIRED_DOC_TYPES,
    pt_state: s?.pt_state || 'Karnataka',
  };
}

// The caller's own employee row (self = employees.auth_user_id IS the caller — never the org graph).
async function myOnboardingEmployee(auth, env) {
  const r = await sb(`/rest/v1/employees?auth_user_id=eq.${auth.userId}&status=neq.exited&select=${OB_EMP_SELECT}&limit=1`, env);
  if (!r.ok || !Array.isArray(r.data)) return { res: err('db_error', 500) };
  return { emp: r.data[0] || null };
}

// Batched facts for the completion rule + the auto lines, for many employees at once (no per-row awaits).
// → { ok, byId: Map(id → facts), policies } ; facts = { priv, doc_types, missing, docs_missing, policies_applicable,
//   policies_pending, auth_linked, assets, probation_set }. ok=false if any source failed (gates fail closed).
async function loadProfileFacts(env, emps, requiredDocTypes) {
  const ids = emps.map(e => e.id).filter(isUuid);
  const authIds = emps.map(e => e.auth_user_id).filter(isUuid);
  const none = Promise.resolve({ ok: true, data: [] });
  const [pr, dr, pol, ar, asr] = await Promise.all([
    ids.length ? sb(`/rest/v1/employee_private?employee_id=in.(${inList(ids)})&select=*`, env) : none,
    ids.length ? sb(`/rest/v1/documents?employee_id=in.(${inList(ids)})&select=employee_id,doc_type`, env) : none,
    sb(`/rest/v1/policies?active=eq.true&select=id,title,version,applies_to,active,published_at&order=title.asc`, env),
    ids.length ? sb(`/rest/v1/policy_acknowledgements?employee_id=in.(${inList(ids)})&select=employee_id,policy_id,version`, env) : none,
    authIds.length ? sbStore(`/rest/v1/assets?custodian_user_id=in.(${inList(authIds)})&status=not.in.(${ASSET_CLOSED_STATUSES.join(',')})&select=custodian_user_id`, env) : none,
  ]);
  const okAll = [pr, dr, pol, ar, asr].every(x => x.ok && Array.isArray(x.data));
  const rows = (r) => (r.ok && Array.isArray(r.data) ? r.data : []);
  const privBy = new Map(rows(pr).map(p => [p.employee_id, p]));
  const docsBy = new Map();
  for (const d of rows(dr)) { if (!docsBy.has(d.employee_id)) docsBy.set(d.employee_id, new Set()); docsBy.get(d.employee_id).add(d.doc_type); }
  const acked = new Set(rows(ar).map(a => `${a.employee_id}|${a.policy_id}|${a.version}`));
  const assetsBy = new Map();
  for (const a of rows(asr)) assetsBy.set(a.custodian_user_id, (assetsBy.get(a.custodian_user_id) || 0) + 1);
  const policies = rows(pol);
  const byId = new Map();
  for (const e of emps) {
    const priv = privBy.get(e.id) || null;
    const have = docsBy.get(e.id) || new Set();
    const applicable = policies.filter(p => policyApplies(p, e.employment_type));
    byId.set(e.id, {
      priv,
      doc_types: [...have],
      missing: profileMissing(e, priv, [...have], requiredDocTypes),
      docs_missing: (requiredDocTypes || []).filter(t => !have.has(t)),
      policies_applicable: applicable.length,
      policies_pending: applicable.filter(p => !acked.has(`${e.id}|${p.id}|${p.version}`)).length,
      auth_linked: isUuid(e.auth_user_id),
      assets: isUuid(e.auth_user_id) ? (assetsBy.get(e.auth_user_id) || 0) : 0,
      probation_set: !!e.probation_end_date,
      acked_ids: applicable.filter(p => acked.has(`${e.id}|${p.id}|${p.version}`)).map(p => p.id),
    });
  }
  return { ok: okAll, byId, policies };
}

// Items as every caller sees them: + the live state, overdue (IST), and whether THIS caller may set the line.
function decorateItems(items, facts, today, role) {
  return (items || []).map(i => {
    const s = itemState(i, facts);
    return { ...i, state: s.state, live: s.live, resolved: s.resolved, overdue: itemOverdue(i, facts, today),
      can_set: !canTickOnboardingItem(role, i) && (!i.auto_source || s.live === 'unverifiable' || !!i.allow_na || i.status !== 'open') };
  });
}

// The employee + the caller's role on THIS person's onboarding (X1's exitCtx shape). → { emp, role } | { res }
async function onboardingCtx(auth, env, employeeId) {
  if (!isUuid(employeeId)) return { res: err('employee_id required', 400) };
  const er = await sb(`/rest/v1/employees?id=eq.${employeeId}&select=${OB_EMP_SELECT}&limit=1`, env);
  if (!er.ok) return { res: err('db_error', 500) };
  const emp = er.data?.[0];
  if (!emp) return { res: err('not_found', 404) };
  const self = !!emp.auth_user_id && emp.auth_user_id === auth.userId;
  const hr = isHr(auth);
  let chain = false;
  if (!self && !hr) {
    const edges = await loadOrgEdgesStrict(env);
    if (!edges) return { res: j2Err('org_check_failed', 503) };
    const me = callerEmployee(edges, auth.userId);
    chain = !!me && me.id !== emp.id && inManagerChain(edges, emp.id, me.id);
  }
  return { emp, role: onboardingRole({ hr, self, chain }) };
}

// Start an onboarding (the J1 hook + HR's Start). → the PostgREST result of onboarding_start.
async function startOnboardingFor(env, employeeId, actorUserId, via) {
  const [er, lr] = await Promise.all([
    sb(`/rest/v1/employees?id=eq.${employeeId}&select=id,status,employment_type&limit=1`, env),
    sb(`/rest/v1/onboarding_lines?active=eq.true&select=*`, env),
  ]);
  if (!er.ok || !lr.ok || !Array.isArray(lr.data)) return { ok: false, status: 500, data: { message: 'db_error' } };
  const emp = er.data?.[0];
  if (!emp) return { ok: false, status: 404, data: { message: 'podium_employee_not_found' } };
  const items = snapshotOnboardingItems(lr.data, emp.employment_type);
  return hiringRpc(env, 'onboarding_start', { employee_id: emp.id, started_by: actorUserId, started_via: via, items });
}

// ── Self-serve ───────────────────────────────────────────────────────────────

// GET getMyProfile — the caller's own profile, private details (full), documents, policies with ack status, open
// onboarding (read-only), pending change requests and the completion rule's missing list.
async function getMyProfile(url, auth, env) {
  const m = await myOnboardingEmployee(auth, env);
  if (m.res) return m.res;
  if (!m.emp) return ok({ employee: null });
  const emp = m.emp;
  const today = istToday();
  const st = await j2Settings(env);
  const [facts, dr, obr, cr] = await Promise.all([
    loadProfileFacts(env, [emp], st.required_doc_types),
    sb(`/rest/v1/documents?employee_id=eq.${emp.id}&select=id,doc_type,title,file_name,uploaded_at,storage_path&order=uploaded_at.desc`, env),
    sb(`/rest/v1/employee_onboardings?employee_id=eq.${emp.id}&status=eq.open&select=*&limit=1`, env),
    sb(`/rest/v1/profile_change_requests?employee_id=eq.${emp.id}&select=id,field,new_value,status,rev,requested_at,decided_at,decision_note&order=requested_at.desc&limit=20`, env),
  ]);
  if (!facts.ok || !dr.ok || !obr.ok || !cr.ok) return err('db_error', 500);
  const f = facts.byId.get(emp.id);
  const ob = obr.data?.[0] || null;
  let items = [];
  if (ob) {
    const ir = await sb(`/rest/v1/onboarding_items?onboarding_id=eq.${ob.id}&select=*&order=sort.asc,line_key.asc`, env);
    if (!ir.ok) return err('db_error', 500);
    items = decorateItems(ir.data || [], f, today, 'employee').map(selfViewItem);
  }
  const { auth_user_id, manager_id, ...profile } = emp;
  const acked = new Set(f.acked_ids);
  const policies = facts.policies.filter(p => policyApplies(p, emp.employment_type))
    .map(p => ({ id: p.id, title: p.title, version: p.version, published_at: p.published_at, acknowledged: acked.has(p.id) }));
  // Own documents: their own, restricted types included. Who uploaded is not exposed; self uploads are marked.
  const documents = (dr.data || []).map(({ storage_path, ...d }) => ({ ...d, self_uploaded: isSelfDocPath(emp.id, storage_path) }));
  return ok({
    today, employee: profile, private: f.priv || {}, documents, policies,
    onboarding: ob ? { ...selfViewOnboarding(ob), items, progress: onboardingProgress(items, f) } : null,
    change_requests: cr.data || [],
    missing: f.missing, completion_pct: completionPct(f.missing, st.required_doc_types),
    required_doc_types: st.required_doc_types, self_doc_types: selfDocTypes(st.required_doc_types),
    campaign_launched: !!st.launched_at,
    show_banner: (!!st.launched_at || !!ob) && f.missing.length > 0,
    fy_label: fyLabelFor(today),
  });
}

// POST saveMyProfile {fields} — whitelist only (onboarding.js PROFILE_*_FIELDS). Validated + normalised here;
// profile_save_self writes first fills and turns a change to a filled PAN / bank field into a change request.
async function saveMyProfile(body, auth, env, ctx) {
  const d = body.data || body;
  const m = await myOnboardingEmployee(auth, env);
  if (m.res) return m.res;
  if (!m.emp) return j2Err('no_employee', 404);
  const v = validateProfileInput(d.fields, istToday());
  if (v.errors.length) return j2Err('invalid_fields', 400, { errors: v.errors });
  if (!Object.keys(v.employee).length && !Object.keys(v.private).length) return ok({ written: [], change_requests: [] });
  const r = await hiringRpc(env, 'profile_save_self', { employee_id: m.emp.id, actor_user_id: auth.userId,
    employee: v.employee, private: v.private }, { headers: actorHeaders(auth) });
  if (!r.ok) return j2DbError(r);
  // J1b D7/D8: no self-profile field is a Google field since 0019 (phones stay in Podium); this only kicks the drain.
  return ok({ ...(r.data || {}), google_sync: await googleSyncAfterSave(env, auth, ctx, m.emp.id) });
}

// POST createMyDocumentUploadUrl {doc_type, file_name, file_size} — the person's own ID / address / bank proof (+
// education / other). Path under <employee_id>/self/ with a timestamp: never an HR upload's object.
async function createMyDocumentUploadUrl(body, auth, env) {
  const d = body.data || body;
  const m = await myOnboardingEmployee(auth, env);
  if (m.res) return m.res;
  if (!m.emp) return j2Err('no_employee', 404);
  const st = await j2Settings(env);
  if (!selfDocTypes(st.required_doc_types).includes(d.doc_type)) return j2Err('bad_doc_type', 400);
  const fe = fileOk(String(d.file_name || ''), SELF_DOC_EXTS, d.file_size);
  if (fe) return j2Err(fe, 400);
  const path = selfDocPath(m.emp.id, d.doc_type, d.file_name);
  const seg = path.split('/').map(encodeURIComponent).join('/');
  const sr = await storageFetch(`/object/upload/sign/${DOC_BUCKET}/${seg}`, env, { method: 'POST' });
  if (!sr.ok || !sr.data?.url) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
  const tokenMatch = String(sr.data.url).match(/token=([^&]+)/);
  return ok({ storage_path: path, token: tokenMatch ? decodeURIComponent(tokenMatch[1]) : null });
}

// HEAD on the private bucket (service role) → { ok, status, size, mime } from the response headers.
async function storageHead(env, path) {
  const seg = String(path).split('/').map(encodeURIComponent).join('/');
  try {
    const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/authenticated/${DOC_BUCKET}/${seg}`, { method: 'HEAD',
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
    return { ok: r.ok, status: r.status, size: r.headers.get('content-length'), mime: r.headers.get('content-type') };
  } catch (_e) { return { ok: false, status: 502 }; }
}

// POST recordMyDocument {doc_type, storage_path, file_name, title} — size + mime type are read from storage.
async function recordMyDocument(body, auth, env) {
  const d = body.data || body;
  const m = await myOnboardingEmployee(auth, env);
  if (m.res) return m.res;
  if (!m.emp) return j2Err('no_employee', 404);
  const st = await j2Settings(env);
  if (!selfDocTypes(st.required_doc_types).includes(d.doc_type)) return j2Err('bad_doc_type', 400);
  if (!isSelfDocPath(m.emp.id, d.storage_path) || !String(d.storage_path).startsWith(`${m.emp.id}/self/${d.doc_type}/`))
    return err('storage_path must be under your own upload folder', 400);
  const fe = fileOk(String(d.file_name || ''), SELF_DOC_EXTS, null);
  if (fe) return j2Err(fe, 400);
  // The object must EXIST under their own path; size + mime type come from storage, never from the client.
  const so = checkStoredObject(await storageHead(env, d.storage_path));
  if (so.error) return j2Err(so.error, so.error === 'storage_check_failed' ? 502 : 400);
  const name = String(d.file_name).slice(0, 200);
  const row = { employee_id: m.emp.id, uploaded_by: auth.userId, doc_type: d.doc_type, storage_path: d.storage_path,
    title: String(d.title || DOC_TYPE_LABELS[d.doc_type] || name).trim().slice(0, 200), file_name: name,
    mime_type: so.mime, file_size: so.size };
  const r = await sb(`/rest/v1/documents`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return j2DbError(r);
  const { storage_path, ...out } = r.data?.[0] || {};
  return ok(out);
}

// POST acknowledgePolicy {policy_id, version} — the current active version of a policy that applies to you.
// Append-only (0011 trigger); a repeat is a no-op (ignore-duplicates).
async function acknowledgePolicy(body, auth, env) {
  const d = body.data || body;
  const m = await myOnboardingEmployee(auth, env);
  if (m.res) return m.res;
  if (!m.emp) return j2Err('no_employee', 404);
  if (!isUuid(d.policy_id)) return err('policy_id required', 400);
  const pr = await sb(`/rest/v1/policies?id=eq.${d.policy_id}&select=id,version,applies_to,active&limit=1`, env);
  if (!pr.ok) return err('db_error', 500);
  const ce = checkAcknowledge(pr.data?.[0] || null, d.version, m.emp.employment_type);
  if (ce) return j2Err(ce, ce === 'policy_not_found' ? 404 : 409);
  const p = pr.data[0];
  const r = await sb(`/rest/v1/policy_acknowledgements?on_conflict=employee_id,policy_id,version`, env, { method: 'POST',
    prefer: 'return=minimal,resolution=ignore-duplicates', body: JSON.stringify([{ employee_id: m.emp.id, policy_id: p.id, version: p.version }]) });
  if (!r.ok) return j2DbError(r);
  return ok({ policy_id: p.id, version: p.version, acknowledged: true });
}

// POST withdrawMyChangeRequest {group: pan|bank} — the person takes back their own pending change (every pending
// field of the group). Guarded on status=pending, so a request HR has just decided is not touched.
async function withdrawMyChangeRequest(body, auth, env) {
  const d = body.data || body;
  const m = await myOnboardingEmployee(auth, env);
  if (m.res) return m.res;
  if (!m.emp) return j2Err('no_employee', 404);
  const fields = CHANGE_GROUPS[d.group];
  if (!fields) return j2Err('bad_group', 400);
  const r = await sb(`/rest/v1/profile_change_requests?employee_id=eq.${m.emp.id}&status=eq.pending&field=in.(${fields.join(',')})`, env, {
    method: 'PATCH', body: JSON.stringify({ status: 'withdrawn', decided_by: auth.userId, decided_at: nowIso(), decision_note: 'Withdrawn by the person' }) });
  if (!r.ok) return j2DbError(r);
  if (!r.data?.length) return j2Err('change_request_not_pending');
  return ok({ group: d.group, withdrawn: r.data.length });
}

// GET getPolicyFile?policy_id= — a 2-minute signed URL. HR any policy; anyone else only a policy that applies to them.
async function getPolicyFile(url, auth, env) {
  const id = url.searchParams.get('policy_id');
  if (!isUuid(id)) return err('policy_id required', 400);
  const pr = await sb(`/rest/v1/policies?id=eq.${id}&select=id,title,version,storage_path,applies_to,active&limit=1`, env);
  if (!pr.ok) return err('db_error', 500);
  const p = pr.data?.[0];
  if (!p) return j2Err('policy_not_found', 404);
  if (!isHr(auth)) {
    const m = await myOnboardingEmployee(auth, env);
    if (m.res) return m.res;
    if (!m.emp || !policyApplies(p, m.emp.employment_type)) return err('forbidden', 403);
  }
  if (!String(p.storage_path).startsWith('policies/')) return err('forbidden', 403);
  const seg = String(p.storage_path).split('/').map(encodeURIComponent).join('/');
  const sr = await storageFetch(`/object/sign/${DOC_BUCKET}/${seg}`, env, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 120 }) });
  if (!sr.ok || !sr.data?.signedURL) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
  return ok({ url: `${env.SUPABASE_URL}/storage/v1${sr.data.signedURL}`, title: p.title, version: p.version });
}

// ── One person's onboarding (self read-only · manager chain ticks manager lines · HR all) ──

// GET getOnboarding?employee_id= — the open onboarding (else the latest) + live line states + blockers.
async function getOnboarding(url, auth, env) {
  const c = await onboardingCtx(auth, env, url.searchParams.get('employee_id'));
  if (c.res) return c.res;
  if (!canSeeOnboarding(c.role)) return j2Err('forbidden', 403);
  const today = istToday();
  const st = await j2Settings(env);
  const [or, facts] = await Promise.all([
    sb(`/rest/v1/employee_onboardings?employee_id=eq.${c.emp.id}&select=*&order=created_at.desc&limit=10`, env),
    loadProfileFacts(env, [c.emp], st.required_doc_types),
  ]);
  if (!or.ok || !facts.ok) return err('db_error', 500);
  const rows = or.data || [];
  const ob = rows.find(o => o.status === 'open') || rows[0] || null;
  const f = facts.byId.get(c.emp.id);
  const base = { employee: OB_EMP_PUBLIC(c.emp), role: c.role, can_manage: canManageOnboarding(c.role), today,
    can_start: canManageOnboarding(c.role) && c.emp.status !== 'exited' && !rows.some(o => o.status === 'open' || o.status === 'complete'),
    history: rows.filter(o => o !== ob).map(o => ({ id: o.id, status: o.status, created_at: o.created_at })),
    // The completion rule's labels only (never values) — the manager sees what is left, not the data.
    profile_missing: f.missing.map(x => x.label) };
  if (!ob) return ok({ ...base, onboarding: null, items: [], blockers: [], progress: null });
  const ir = await sb(`/rest/v1/onboarding_items?onboarding_id=eq.${ob.id}&select=*&order=sort.asc,line_key.asc`, env);
  if (!ir.ok) return err('db_error', 500);
  const self = c.role === 'employee';
  const items = decorateItems(ir.data || [], f, today, c.role).map(i => (self ? selfViewItem(i) : i));
  return ok({ ...base, onboarding: self ? selfViewOnboarding(ob) : ob, items, blockers: ob.status === 'open' ? onboardingBlockers(ir.data || [], f) : [],
    progress: onboardingProgress(ir.data || [], f) });
}

// POST updateOnboardingItem {item_id, status: done|na|open, note} — self-serve: HR any line (auto lines only while
// unverifiable, with a note); the manager chain only owner='manager' manual lines. onboarding_update_item re-checks
// every rule under the onboarding lock, including the live auto check.
async function updateOnboardingItem(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.item_id)) return err('item_id required', 400);
  const item = (await sb(`/rest/v1/onboarding_items?id=eq.${d.item_id}&select=*&limit=1`, env)).data?.[0];
  if (!item) return j2Err('item_not_found', 404);
  const ob = (await sb(`/rest/v1/employee_onboardings?id=eq.${item.onboarding_id}&select=id,employee_id,status&limit=1`, env)).data?.[0];
  if (!ob) return j2Err('onboarding_not_found', 404);
  const c = await onboardingCtx(auth, env, ob.employee_id);
  if (c.res) return c.res;
  if (ob.status !== 'open') return j2Err('onboarding_not_open');
  const te = canTickOnboardingItem(c.role, item);
  if (te) return j2Err(te, 403);
  const note = String(d.note || '').trim().slice(0, OB_NOTE_MAX) || null;
  let live = null;
  if (item.auto_source && d.status === 'done') {
    const st = await j2Settings(env);
    const facts = await loadProfileFacts(env, [c.emp], st.required_doc_types);
    if (!facts.ok) return j2Err('live_check_failed', 502);
    live = autoStatus(item.auto_source, facts.byId.get(c.emp.id));
  }
  const ce = checkOnboardingItemUpdate(item, { status: d.status, note }, live, c.role);
  if (ce) return j2Err(ce, ce === 'bad_item_status' ? 400 : ce === 'forbidden_item' ? 403 : 409);
  const r = await hiringRpc(env, 'onboarding_update_item', { item_id: item.id, status: d.status, note,
    actor_user_id: auth.userId, role: c.role });
  return r.ok ? ok(r.data) : j2DbError(r);
}

// POST startOnboarding {employee_id} (HR) — for an active employee with no open / complete onboarding (joiners added
// outside J1, or a J1 hook that failed).
async function startOnboarding(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  const c = await onboardingCtx(auth, env, d.employee_id);
  if (c.res) return c.res;
  if (!canManageOnboarding(c.role)) return j2Err('forbidden', 403);
  const r = await startOnboardingFor(env, c.emp.id, auth.userId, 'hr');
  return r.ok ? ok(r.data) : j2DbError(r);
}

async function onboardingWriteCtx(auth, env, onboardingId) {
  if (!isUuid(onboardingId)) return { res: err('onboarding_id required', 400) };
  const ob = (await sb(`/rest/v1/employee_onboardings?id=eq.${onboardingId}&select=*&limit=1`, env)).data?.[0];
  if (!ob) return { res: j2Err('onboarding_not_found', 404) };
  const c = await onboardingCtx(auth, env, ob.employee_id);
  if (c.res) return c;
  if (!canManageOnboarding(c.role)) return { res: j2Err('forbidden', 403) };
  return { ob, emp: c.emp };
}

// POST completeOnboarding {onboarding_id} (HR, never one's own) — blockers computed here and returned verbatim;
// onboarding_complete re-checks every line (auto lines live) under the lock and is the authority.
async function completeOnboarding(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  const c = await onboardingWriteCtx(auth, env, d.onboarding_id);
  if (c.res) return c.res;
  if (c.ob.status !== 'open') return j2Err('onboarding_not_open');
  const st = await j2Settings(env);
  const [ir, facts] = await Promise.all([
    sb(`/rest/v1/onboarding_items?onboarding_id=eq.${c.ob.id}&select=*`, env),
    loadProfileFacts(env, [c.emp], st.required_doc_types),
  ]);
  if (!ir.ok) return err('db_error', 500);
  if (!facts.ok) return j2Err('live_check_failed', 502);
  const blockers = onboardingBlockers(ir.data || [], facts.byId.get(c.emp.id));
  if (blockers.length) return j2Err('onboarding_blocked', 409, { blockers });
  const r = await hiringRpc(env, 'onboarding_complete', { onboarding_id: c.ob.id, actor_user_id: auth.userId });
  return r.ok ? ok(r.data) : j2DbError(r);
}

// POST cancelOnboarding {onboarding_id, reason} (HR) — e.g. started for the wrong person. Items stay as history.
async function cancelOnboarding(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  const c = await onboardingWriteCtx(auth, env, d.onboarding_id);
  if (c.res) return c.res;
  const reason = String(d.reason || '').trim();
  if (reason.length < 5) return j2Err('cancel_reason_required', 400);
  const r = await sb(`/rest/v1/employee_onboardings?id=eq.${c.ob.id}&status=eq.open`, env, { method: 'PATCH',
    body: JSON.stringify({ status: 'cancelled', cancelled_at: nowIso(), cancelled_by: auth.userId, cancel_reason: reason.slice(0, 500) }) });
  if (!r.ok) return j2DbError(r);
  if (!r.data?.length) return j2Err('onboarding_not_open');
  return ok({ onboarding_id: c.ob.id, status: 'cancelled' });
}

// ── HR boards ────────────────────────────────────────────────────────────────

// Every active employee's completion (labels only, never values). → { ok, rows, totals, incomplete, active }
async function completionSnapshot(env, st) {
  const er = await sb(`/rest/v1/employees?status=eq.active&select=${OB_EMP_SELECT},department:department_id(name)&order=full_name.asc&limit=2000`, env);
  if (!er.ok || !Array.isArray(er.data)) return { ok: false };
  const emps = er.data;
  const facts = await loadProfileFacts(env, emps, st.required_doc_types);
  if (!facts.ok) return { ok: false };
  const totals = {};
  const rows = emps.map(e => {
    const f = facts.byId.get(e.id);
    for (const x of f.missing) { totals[x.key] = totals[x.key] || { key: x.key, label: x.label, missing: 0 }; totals[x.key].missing += 1; }
    return { employee: { ...OB_EMP_PUBLIC(e), department: e.department?.name || null }, missing: f.missing.map(x => x.label),
      missing_keys: f.missing.map(x => x.key), completion_pct: completionPct(f.missing, st.required_doc_types) };
  });
  return { ok: true, rows, totals: Object.values(totals).sort((a, b) => b.missing - a.missing), active: rows.length,
    incomplete: rows.filter(r => r.missing.length).length };
}

// GET getProfileCompletion (HR) — per active employee: the missing labels + completion %; per-field totals.
async function getProfileCompletion(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const st = await j2Settings(env);
  const s = await completionSnapshot(env, st);
  if (!s.ok) return err('db_error', 500);
  return ok({ launched_at: st.launched_at, required_doc_types: st.required_doc_types, active: s.active, incomplete: s.incomplete,
    totals: s.totals, people: s.rows });
}

// GET getOnboardingBoard (HR) — open onboardings × lines (overdue = unresolved + due before IST today), joiners in
// the last 90 days with no onboarding, and the campaign stats.
async function getOnboardingBoard(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const today = istToday();
  const st = await j2Settings(env);
  const from = dueDate(today, -JOINER_WINDOW_DAYS);
  const [or, jr, s] = await Promise.all([
    sb(`/rest/v1/employee_onboardings?status=eq.open&select=*&order=created_at.asc&limit=500`, env),
    sb(`/rest/v1/employees?status=eq.active&date_joined=gte.${from}&select=id,employee_code,full_name,job_title,status,date_joined,employment_type&order=date_joined.desc&limit=500`, env),
    completionSnapshot(env, st),
  ]);
  if (!or.ok || !jr.ok || !Array.isArray(or.data) || !Array.isArray(jr.data) || !s.ok) return err('db_error', 500);
  const obs = or.data;
  const obIds = obs.map(o => o.id).filter(isUuid);
  const empIds = obs.map(o => o.employee_id).filter(isUuid);
  const joinerIds = jr.data.map(e => e.id).filter(isUuid);
  const none = Promise.resolve({ ok: true, data: [] });
  const [ir, er, cov] = await Promise.all([
    obIds.length ? sb(`/rest/v1/onboarding_items?onboarding_id=in.(${inList(obIds)})&select=*&order=sort.asc`, env) : none,
    empIds.length ? sb(`/rest/v1/employees?id=in.(${inList(empIds)})&select=${OB_EMP_SELECT}`, env) : none,
    joinerIds.length ? sb(`/rest/v1/employee_onboardings?employee_id=in.(${inList(joinerIds)})&status=in.(open,complete)&select=employee_id,status`, env) : none,
  ]);
  if (![ir, er, cov].every(x => x.ok && Array.isArray(x.data))) return err('db_error', 500);
  const facts = await loadProfileFacts(env, er.data, st.required_doc_types);
  if (!facts.ok) return err('db_error', 500);
  const empBy = new Map(er.data.map(e => [e.id, e]));
  const board = obs.map(o => {
    const e = empBy.get(o.employee_id) || { id: o.employee_id };
    const f = facts.byId.get(o.employee_id) || {};
    const raw = ir.data.filter(i => i.onboarding_id === o.id);
    const items = decorateItems(raw, f, today, 'hr');
    return { onboarding_id: o.id, started_via: o.started_via, created_at: o.created_at, employee: OB_EMP_PUBLIC(e),
      items: items.map(i => ({ id: i.id, line_key: i.line_key, title: i.title, owner: i.owner, required: i.required,
        auto_source: i.auto_source, due_date: i.due_date, state: i.state, overdue: i.overdue })),
      overdue: items.filter(i => i.overdue).length, progress: onboardingProgress(raw, f), blockers: onboardingBlockers(raw, f) };
  });
  return ok({ today, onboardings: board, joiners_without: joinersWithoutOnboarding(jr.data, cov.data, today),
    campaign: { launched_at: st.launched_at, active: s.active, incomplete: s.incomplete }, can_export: canComp(auth) });
}

// POST launchProfileCampaign (HR) — stamps settings once (idempotent: a second press keeps the first stamp).
async function launchProfileCampaign(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const r = await sb(`/rest/v1/settings?id=eq.1&profile_campaign_launched_at=is.null`, env, { method: 'PATCH',
    body: JSON.stringify({ profile_campaign_launched_at: nowIso(), profile_campaign_launched_by: auth.userId, updated_at: nowIso() }) });
  if (!r.ok) return j2DbError(r);
  const st = await j2Settings(env);
  const s = await completionSnapshot(env, st);
  if (!s.ok) return err('db_error', 500);
  return ok({ launched_at: st.launched_at, already: !r.data?.length, active: s.active, incomplete: s.incomplete });
}

// GET getProfileChangeRequests (HR) — pending changes grouped per person: PAN alone, the bank fields as ONE "Bank
// details" change. Each row carries its rev (decideProfileChange must send them back). Bank account masked (new +
// current). Then the last 50 decided / withdrawn.
async function getProfileChangeRequests(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const [pr, dr] = await Promise.all([
    sb(`/rest/v1/profile_change_requests?status=eq.pending&select=*,employee:employee_id(id,employee_code,full_name,pan_number,auth_user_id)&order=requested_at.asc`, env),
    sb(`/rest/v1/profile_change_requests?status=neq.pending&select=*,employee:employee_id(id,employee_code,full_name)&order=decided_at.desc&limit=50`, env),
  ]);
  if (!pr.ok || !dr.ok || !Array.isArray(pr.data)) return err('db_error', 500);
  const ids = [...new Set(pr.data.map(x => x.employee_id).filter(isUuid))];
  const vr = ids.length ? await sb(`/rest/v1/employee_private?employee_id=in.(${inList(ids)})&select=employee_id,bank_account_number,bank_ifsc,bank_account_name`, env) : { ok: true, data: [] };
  if (!vr.ok) return err('db_error', 500);
  const privBy = new Map((vr.data || []).map(p => [p.employee_id, p]));
  const empBy = new Map(pr.data.map(x => [x.employee_id, x.employee || {}]));
  const rows = pr.data.map(x => {
    const cur = x.field === 'pan_number' ? x.employee?.pan_number : privBy.get(x.employee_id)?.[x.field];
    const { employee, ...r } = projectChangeRequest(x);
    return { ...r, current_value: x.field === 'bank_account_number' ? maskAccount(cur) : (cur ?? null) };
  });
  const pending = groupChangeRequests(rows).map(g => {
    const { pan_number, auth_user_id, ...employee } = empBy.get(g.employee_id) || {};
    return { ...g, employee, own: !!auth_user_id && auth_user_id === auth.userId };
  });
  return ok({ pending, decided: (dr.data || []).map(projectChangeRequest) });
}

// POST decideProfileChange {employee_id, group: pan|bank, items: [{id, rev}], decision: approved|rejected, note}
// (HR; never one's own). One decision for the whole group; profile_change_decide refuses if any pending row of the
// group is not exactly at the rev HR saw (podium_change_request_changed).
async function decideProfileChange(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  if (!isUuid(d.employee_id)) return err('employee_id required', 400);
  const c = cleanChangeDecision(d);
  if (c.error) return j2Err(c.error, 400);
  const er = await sb(`/rest/v1/employees?id=eq.${d.employee_id}&select=id,auth_user_id&limit=1`, env);
  if (!er.ok) return err('db_error', 500);
  if (!er.data?.[0]) return j2Err('employee_not_found', 404);
  if (er.data[0].auth_user_id === auth.userId) return j2Err('own_change_request', 403);
  const r = await hiringRpc(env, 'profile_change_decide', { employee_id: d.employee_id, group: c.group, expected: c.expected,
    decision: c.decision, note: c.note, actor_user_id: auth.userId });
  return r.ok ? ok(r.data) : j2DbError(r);
}

// GET getEmployeePrivate?employee_id= — self (full) · HR (addresses / UAN / ESIC / IFSC, bank account masked) ·
// comp (+ the salary-tier fields; a cross-person read → comp_access_log, decision 2).
async function getEmployeePrivate(url, auth, env) {
  const id = url.searchParams.get('employee_id');
  if (!isUuid(id)) return err('employee_id required', 400);
  const er = await sb(`/rest/v1/employees?id=eq.${id}&select=id,full_name,auth_user_id&limit=1`, env);
  if (!er.ok) return err('db_error', 500);
  const emp = er.data?.[0];
  if (!emp) return err('not_found', 404);
  const self = !!emp.auth_user_id && emp.auth_user_id === auth.userId;
  const hr = isHr(auth), comp = canComp(auth);
  if (!self && !hr && !comp) return err('forbidden', 403);
  const pr = await sb(`/rest/v1/employee_private?employee_id=eq.${id}&select=*&limit=1`, env);
  if (!pr.ok) return err('db_error', 500);
  const row = pr.data?.[0] || { employee_id: id };
  if (comp && !self) await logCompAccess(auth, 'getEmployeePrivate', id, null, env, { fields: SALARY_PRIVATE_FIELDS });
  return ok({ employee_id: id, private: projectPrivate(row, { self, hr, comp }), tier: { self, hr, comp } });
}

// GET exportXPayroll?employee_ids=a,b — canComp (decision 3: it carries Annual CTC + past salary); one
// comp_access_log row per employee. The CSV reproduces the XPayroll sheet's headers verbatim (onboarding.js).
async function exportXPayroll(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const ids = [...new Set(String(url.searchParams.get('employee_ids') || '').split(',').map(s => s.trim()).filter(isUuid))].slice(0, 200);
  if (!ids.length) return err('employee_ids required', 400);
  const st = await j2Settings(env);
  const [er, pr, cr, car] = await Promise.all([
    sb(`/rest/v1/employees?id=in.(${inList(ids)})&select=id,employee_code,full_name,work_email,date_joined,job_title,pan_number,phone,gender,date_of_birth,department:department_id(name)&order=full_name.asc`, env),
    sb(`/rest/v1/employee_private?employee_id=in.(${inList(ids)})&select=*`, env),
    sb(`/rest/v1/compensation_events?employee_id=in.(${inList(ids)})&select=employee_id,event_type,new_ctc,effective_date,created_at&order=effective_date.desc,created_at.desc`, env),
    sb(`/rest/v1/candidates?employee_id=in.(${inList(ids)})&select=id,employee_id`, env),
  ]);
  if (![er, pr, cr, car].every(x => x.ok && Array.isArray(x.data))) return err('db_error', 500);
  const candIds = car.data.map(c => c.id).filter(isUuid);
  const offr = candIds.length
    ? await sb(`/rest/v1/offers?candidate_id=in.(${inList(candIds)})&status=eq.accepted&select=candidate_id,pf_opt_out,revision,accepted_at&order=accepted_at.desc.nullslast,revision.desc`, env)
    : { ok: true, data: [] };
  if (!offr.ok) return err('db_error', 500);
  const empOfCand = new Map(car.data.map(c => [c.id, c.employee_id]));
  const pfBy = new Map();
  for (const o of offr.data || []) { const e = empOfCand.get(o.candidate_id); if (e && !pfBy.has(e)) pfBy.set(e, o.pf_opt_out); }
  const privBy = new Map(pr.data.map(p => [p.employee_id, p]));
  const rows = er.data.map(e => xpayrollRow({ emp: e, priv: privBy.get(e.id) || {}, department: e.department?.name || null,
    ctc: currentCtc(cr.data.filter(x => x.employee_id === e.id)), pf_opt_out: pfBy.has(e.id) ? pfBy.get(e.id) : null, pt_state: st.pt_state }));
  // PF Y/N blank = no accepted offer carried the flag — the UI warns before HR uploads.
  const pfBlank = er.data.filter(e => !pfBy.has(e.id) || (pfBy.get(e.id) !== true && pfBy.get(e.id) !== false))
    .map(e => ({ id: e.id, employee_code: e.employee_code, full_name: e.full_name }));
  // One audit row per employee, in ONE insert — and unlike a single read, the export FAILS CLOSED without it: a
  // bulk salary + bank file must never leave unlogged.
  let ar;
  try {
    ar = await sb(`/rest/v1/comp_access_log`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(er.data.map(e => ({
      viewer_user_id: auth.userId, viewer_name: auth.fullName || null, action: 'exportXPayroll', subject_employee_id: e.id,
      subject_label: null, detail: { count: er.data.length } }))) });
  } catch (_e) { ar = { ok: false }; }
  if (!ar?.ok) return j2Err('audit_failed', 500);
  // rows = typed cells for the app's .xlsx writer (text_columns written as text); csv = the fallback (="…" text).
  return ok({ headers: XPAYROLL_HEADERS, rows, text_columns: XPAYROLL_TEXT_COLUMNS, csv: xpayrollCsv(rows),
    file_name: `xpayroll-onboarding-${istToday()}.xlsx`, count: rows.length, pf_blank: pfBlank });
}

// ── Admin: the onboarding template + policies (HR / podium_admin) ────────────

async function getOnboardingTemplate(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const r = await sb(`/rest/v1/onboarding_lines?select=*&order=sort.asc,key.asc`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ lines: r.data || [], owners: OB_OWNERS, auto_sources: OB_AUTO_SOURCES });
}

// POST saveOnboardingLine {key, title, owner, required, allow_na, applies_to, due_offset_days, sort, active} — upsert
// by key. auto_source is never written here (behaviour, not wording — as X1): a new line is always manual.
async function saveOnboardingLine(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const row = cleanOnboardingLine(body.data || body);
  if (row.error) return j2Err(row.error, 400);
  const r = await sb(`/rest/v1/onboarding_lines?on_conflict=key`, env, { method: 'POST',
    prefer: 'return=representation,resolution=merge-duplicates', body: JSON.stringify([row]) });
  if (!r.ok) return j2DbError(r);
  return ok(r.data?.[0] || null);
}

// GET getPolicies (HR) — every version, with the acknowledgement count per row.
async function getPolicies(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const [pr, ar] = await Promise.all([
    sb(`/rest/v1/policies?select=id,title,version,applies_to,active,published_at&order=title.asc,version.desc`, env),
    sb(`/rest/v1/policy_acknowledgements?select=policy_id`, env),
  ]);
  if (!pr.ok || !ar.ok) return err('db_error', 500);
  const counts = {};
  for (const a of ar.data || []) counts[a.policy_id] = (counts[a.policy_id] || 0) + 1;
  return ok({ policies: (pr.data || []).map(p => ({ ...p, acknowledgements: counts[p.id] || 0 })) });
}

// POST createPolicyUploadUrl {file_name, file_size} (HR) — a PDF under policies/ in the private bucket.
async function createPolicyUploadUrl(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  const fe = fileOk(String(d.file_name || ''), ['pdf'], d.file_size);
  if (fe) return j2Err(fe === 'bad_file_type' ? 'bad_policy' : fe, 400);
  const path = policyPath(d.file_name);
  const seg = path.split('/').map(encodeURIComponent).join('/');
  const sr = await storageFetch(`/object/upload/sign/${DOC_BUCKET}/${seg}`, env, { method: 'POST' });
  if (!sr.ok || !sr.data?.url) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
  const tokenMatch = String(sr.data.url).match(/token=([^&]+)/);
  return ok({ storage_path: path, token: tokenMatch ? decodeURIComponent(tokenMatch[1]) : null });
}

// POST savePolicy {title, storage_path, applies_to} (HR) — publishes a new title, or the next version of one
// (policy_publish: the old version is deactivated; its acks stay valid for it only).
async function savePolicy(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  const applies = Array.isArray(d.applies_to) ? [...new Set(d.applies_to.map(String))].slice(0, 10) : [];
  const r = await hiringRpc(env, 'policy_publish', { title: String(d.title || '').trim(), storage_path: d.storage_path,
    applies_to: applies, actor_user_id: auth.userId });
  return r.ok ? ok(r.data) : j2DbError(r);
}

// POST setPolicyActive {id, active} (HR) — withdraw a policy (or bring an old version back if none is active).
async function setPolicyActive(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  if (!isUuid(d.id) || typeof d.active !== 'boolean') return err('id + active required', 400);
  const r = await sb(`/rest/v1/policies?id=eq.${d.id}`, env, { method: 'PATCH', body: JSON.stringify({ active: d.active }) });
  if (!r.ok) return j2DbError(r);
  if (!r.data?.length) return j2Err('policy_not_found', 404);
  return ok(r.data[0]);
}
// ── end J2

// ────────────────────────────────────────────────────────────────────────────
// Hiring C4 — bulk CV import: read each CV with OpenAI, fill the fields, HR confirms.
// Plan: docs/superpowers/plans/2026-11-12-podium-c4-cv-import.md · pure rules in src/cvimport.js.
// Nothing reaches candidates until HR presses Accept, which goes through createCandidate / addApplication.
// ────────────────────────────────────────────────────────────────────────────

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const AI_ERR = {
  podium_ai_cap: 'This month\'s AI reading budget is used up — enter this one by hand, or ask a super admin to raise the cap',
  podium_ai_disabled: 'AI reading is switched off — enter this one by hand',
};

async function cvImportCtx(auth, env, importId) {
  if (!isUuid(importId)) return { res: err('import_id required', 400) };
  const ir = await sb(`/rest/v1/cv_imports?id=eq.${importId}&select=*&limit=1`, env);
  const imp = ir.data?.[0];
  if (!imp) return { res: err('not_found', 404) };
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, imp.opening_id);
  if (!x || !canManageApps(x.roles)) return { res: err('forbidden', 403) };
  return { imp, x, me, salary: canSeeSalary(x.roles) };
}

async function cvItemCtx(auth, env, itemId) {
  if (!isUuid(itemId)) return { res: err('item_id required', 400) };
  const r = await sb(`/rest/v1/cv_import_items?id=eq.${itemId}&select=*&limit=1`, env);
  const item = r.data?.[0];
  if (!item) return { res: err('not_found', 404) };
  const c = await cvImportCtx(auth, env, item.import_id);
  return c.res ? c : { ...c, item };
}

// CTC never leaves the worker for a caller who can't see salary on the opening.
function cvItemView(item, salary) {
  const strip = (o) => {
    if (!o || salary) return o;
    const { current_ctc, expected_ctc, ...rest } = o;
    return rest;
  };
  const ex = item.extracted ? { ...item.extracted, fields: strip(item.extracted.fields),
    evidence: salary ? item.extracted.evidence : { experience: item.extracted.evidence?.experience ?? null, notice: item.extracted.evidence?.notice ?? null } } : null;
  const warnings = salary ? item.warnings : (item.warnings || []).filter(w => !/CTC/.test(w));
  return { id: item.id, import_id: item.import_id, file_name: item.file_name, mime_type: item.mime_type, file_size: item.file_size,
    sha256: item.sha256, status: item.status, extract_mode: item.extract_mode, model: item.model, warnings,
    extracted: ex, final: strip(item.final), candidate_id: item.candidate_id, application_id: item.application_id,
    document_id: item.document_id, attempts: item.attempts, last_error: item.last_error, created_at: item.created_at, updated_at: item.updated_at };
}

async function touchCvImport(env, id) {
  await sb(`/rest/v1/cv_imports?id=eq.${id}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ updated_at: nowIso() }) });
}

async function storageDeletePaths(env, paths) {
  const list = paths.filter(Boolean);
  if (!list.length) return true;
  const r = await storageFetch(`/object/${DOC_BUCKET}`, env, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: list }) });
  return r.ok;
}

async function storageDownload(env, path) {
  const seg = String(path).split('/').map(encodeURIComponent).join('/');
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/authenticated/${DOC_BUCKET}/${seg}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function loadAiSettings(env) {
  return (await sb(`/rest/v1/ai_settings?id=eq.1&select=*&limit=1`, env)).data?.[0] || null;
}
async function aiMonthSpend(env) {
  const r = await sb(`/rest/v1/rpc/ai_month_spend`, env, { method: 'POST', body: '{}' });
  return r.ok ? r.data : null;
}

// D10 — batches untouched for 7 days: un-accepted files + rows go. Bounded to 5 batches per call.
async function purgeStaleCvImports(env) {
  const cutoff = new Date(Date.now() - CV_PURGE_AFTER_DAYS * 86400000).toISOString();
  const ir = await sb(`/rest/v1/cv_imports?updated_at=lt.${cutoff}&select=id&limit=5`, env);
  for (const imp of ir.data || []) {
    // Conditional delete: only rows no accept has touched (candidate_id null), re-checked in the DELETE itself.
    const del = await sb(`/rest/v1/cv_import_items?import_id=eq.${imp.id}&candidate_id=is.null&status=neq.accepted`, env, { method: 'DELETE' });
    if (!del.ok) continue;
    await storageDeletePaths(env, (del.data || []).map(i => i.storage_path));
    const left = await sb(`/rest/v1/cv_import_items?import_id=eq.${imp.id}&select=id&limit=1`, env);
    if (left.ok && !(left.data || []).length) await sb(`/rest/v1/cv_imports?id=eq.${imp.id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
    else await touchCvImport(env, imp.id);   // keep the accepted record; don't re-scan it every load
  }
}

// GET getCvImports — the caller's batches (HR / podium_hiring: all), newest first, + this month's AI spend.
async function getCvImports(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  if (!(await hiringAccess(auth, me, env))) return err('forbidden', 403);
  try { await purgeStaleCvImports(env); } catch (e) { console.error('[cv-purge]', e?.message || e); }
  const ir = await sb(`/rest/v1/cv_imports?select=*&order=created_at.desc&limit=100`, env);
  const imps = ir.data || [];
  const ops = await loadOpeningsWithRoles(auth, me, env, { ids: [...new Set(imps.map(i => i.opening_id))] });
  const opById = Object.fromEntries(ops.filter(x => canManageApps(x.roles)).map(x => [x.o.id, x.o]));
  const mine = imps.filter(i => opById[i.opening_id]);
  const counts = {};
  if (mine.length) {
    const cr = await sb(`/rest/v1/cv_import_items?import_id=in.(${mine.map(i => i.id).join(',')})&select=import_id,status`, env);
    for (const c of cr.data || []) ((counts[c.import_id] ||= {})[c.status] = ((counts[c.import_id] || {})[c.status] || 0) + 1);
  }
  return ok({
    imports: mine.map(i => ({ ...i, opening: { id: opById[i.opening_id].id, opening_code: opById[i.opening_id].opening_code,
      designation: opById[i.opening_id].designation, status: opById[i.opening_id].status }, counts: counts[i.id] || {} })),
    spend: await aiMonthSpend(env),
    ai_ready: !!env.OPENAI_API_KEY,
  });
}

// Existing candidates matching these drafts' email / phone. matches = people the caller may see;
// hidden_keys = the email / phone keys that match someone they can't see (they learn THAT, not who —
// the findCandidateDuplicates rule). Throws on a DB error: an empty answer must never mean "couldn't check".
async function cvImportDuplicates(auth, me, env, drafts) {
  const emails = new Set(), phones = new Set();
  for (const f of drafts) {
    const e = normEmailKey(f?.email); if (e) emails.add(e.replace(/["\\]/g, ''));
    const p = normPhoneKey(f?.phone); if (p && p.length >= 6) phones.add(p);
  }
  if (!emails.size && !phones.size) return { matches: [], hidden_keys: [] };
  const ors = [];
  if (emails.size) ors.push(`email_norm.in.(${[...emails].map(e => encodeURIComponent(`"${e}"`)).join(',')})`);
  if (phones.size) ors.push(`phone_norm.in.(${[...phones].join(',')})`);
  const cr = await sb(`/rest/v1/candidates?or=(${ors.join(',')})&merged_into_id=is.null&select=id,candidate_code,full_name,email_norm,phone_norm&limit=500`, env);
  if (!cr.ok || !Array.isArray(cr.data)) throw new Error('duplicate check failed');
  const hits = cr.data;
  const view = (h) => ({ id: h.id, candidate_code: h.candidate_code, full_name: h.full_name, email_norm: h.email_norm, phone_norm: h.phone_norm });
  if (!hits.length) return { matches: [], hidden_keys: [] };
  if (isHr(auth) || hasPerm(auth, 'podium_hiring')) return { matches: hits.map(view), hidden_keys: [] };
  const ar = await sb(`/rest/v1/applications?candidate_id=in.(${hits.map(h => h.id).join(',')})&select=candidate_id,opening_id`, env);
  const apps = ar.data || [];
  const ops = await loadOpeningsWithRoles(auth, me, env, { ids: [...new Set(apps.map(a => a.opening_id))] });
  const vis = new Set(ops.filter(x => canSeeOpening(x.roles)).map(x => x.o.id));
  const seen = hits.filter(h => apps.some(a => a.candidate_id === h.id && vis.has(a.opening_id)));
  const hidden = hits.filter(h => !seen.includes(h));
  const keys = new Set();
  for (const h of hidden) { if (emails.has(h.email_norm)) keys.add(h.email_norm); if (phones.has(h.phone_norm)) keys.add(h.phone_norm); }
  return { matches: seen.map(view), hidden_keys: [...keys] };
}
const itemDraft = (i) => i.final || i.extracted?.fields || {};

// GET getCvImport?id= — the batch, its items (salary-stripped when needed) and duplicate matches.
async function getCvImport(url, auth, env) {
  const c = await cvImportCtx(auth, env, url.searchParams.get('id'));
  if (c.res) return c.res;
  const it = await sb(`/rest/v1/cv_import_items?import_id=eq.${c.imp.id}&select=*&order=created_at.asc&limit=${CV_MAX_ITEMS}`, env);
  const items = it.data || [];
  const dupes = await cvImportDuplicates(auth, c.me, env, items.map(itemDraft));
  const o = c.x.o;
  return ok({
    import: c.imp,
    opening: { id: o.id, opening_code: o.opening_code, designation: o.designation, status: o.status },
    can_see_salary: c.salary,
    items: items.map(i => cvItemView(i, c.salary)),
    duplicates: dupes.matches, hidden_keys: dupes.hidden_keys,
    spend: await aiMonthSpend(env),
    ai_ready: !!env.OPENAI_API_KEY,
  });
}

// GET getCvImportFileUrl?item_id= — the staged CV, so HR can check the fields against it.
async function getCvImportFileUrl(url, auth, env) {
  const c = await cvItemCtx(auth, env, url.searchParams.get('item_id'));
  if (c.res) return c.res;
  if (c.item.status === 'skipped') return err('This CV was skipped and deleted', 410);
  if (c.item.document_id) {
    const dr = await sb(`/rest/v1/candidate_documents?id=eq.${c.item.document_id}&select=storage_path,file_name,mime_type&limit=1`, env);
    const doc = dr.data?.[0];
    if (doc) return signDownload(doc.storage_path, doc.file_name, doc.mime_type, env);
  }
  return signDownload(c.item.storage_path, c.item.file_name, c.item.mime_type, env);
}

// POST createCvImport {opening_id, source, source_detail}
async function createCvImport(body, auth, env) {
  const d = body.data || body;
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const { x, res } = await intakeOpening(auth, me, env, d.opening_id);
  if (res) return res;
  if (!APP_SOURCES.includes(d.source)) return err('bad source', 400);
  const r = await sb(`/rest/v1/cv_imports`, env, { method: 'POST', body: JSON.stringify([{
    opening_id: x.o.id, source: d.source, source_detail: String(d.source_detail || '').trim().slice(0, 200) || null, created_by: auth.userId }]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data[0]);
}

// POST cvImportUploadUrl {import_id, file_name, file_size}
async function cvImportUploadUrl(body, auth, env) {
  const d = body.data || body;
  const c = await cvImportCtx(auth, env, d.import_id);
  if (c.res) return c.res;
  const fe = fileOk(d.file_name, CV_IMPORT_EXTS, d.file_size);
  if (fe) return err(fe === 'bad_file_type' ? 'Only PDF, Word or image files' : 'Files must be under 15 MB', 400);
  // Every row counts (skipped too) so the batch read (limit CV_MAX_ITEMS) always shows all of them.
  const cr = await sb(`/rest/v1/cv_import_items?import_id=eq.${c.imp.id}&select=id&limit=${CV_MAX_ITEMS}`, env);
  if (!cr.ok) return err('db_error', 500);
  if ((cr.data || []).length >= CV_MAX_ITEMS) return errCode('import_full', `A batch holds up to ${CV_MAX_ITEMS} CVs (skipped ones included) — start another batch`, 409);
  // Microsecond-ish stamp so two same-named files signed in one millisecond don't collide.
  return signUpload(importItemPath(c.imp.id, d.file_name, Date.now() * 1000 + Math.floor(Math.random() * 1000)), env);
}

// POST cvImportFileDone {import_id, storage_path, file_name} — size + type read from storage, not trusted.
async function cvImportFileDone(body, auth, env) {
  const d = body.data || body;
  const c = await cvImportCtx(auth, env, d.import_id);
  if (c.res) return c.res;
  if (checkImportItemPath(d.storage_path, c.imp.id)) return err('bad storage_path', 400);
  const name = String(d.file_name || '').trim().slice(0, 200) || d.storage_path.split('/').pop();
  if (!CV_IMPORT_EXTS.includes(cvFileExt(name))) return err('bad file type', 400);
  const h = await storageHead(env, d.storage_path);
  if (!h.ok) return err('upload not found — try again', 400);
  const size = Number(h.size);
  if (!(size >= 1 && size <= 15 * 1024 * 1024)) {
    await storageDeletePaths(env, [d.storage_path]);
    return err('Files must be under 15 MB', 400);
  }
  const r = await sb(`/rest/v1/cv_import_items?on_conflict=storage_path`, env, { method: 'POST',
    prefer: 'return=representation,resolution=ignore-duplicates', body: JSON.stringify([{
      import_id: c.imp.id, storage_path: d.storage_path, file_name: name, mime_type: h.mime || null, file_size: size }]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  let row = r.data?.[0];
  if (!row) row = (await sb(`/rest/v1/cv_import_items?storage_path=eq.${encodeURIComponent(d.storage_path)}&select=*&limit=1`, env)).data?.[0];
  await touchCvImport(env, c.imp.id);
  return ok(cvItemView(row, c.salary));
}

async function setCvItem(env, id, patch, extraFilter = '') {
  const r = await sb(`/rest/v1/cv_import_items?id=eq.${id}${extraFilter}`, env, { method: 'PATCH',
    body: JSON.stringify({ ...patch, updated_at: nowIso() }) });
  return r.ok ? (r.data || []) : null;
}

// POST cvImportExtract {item_id} — claim → cache → local text → reserve → OpenAI → validate → extracted.
// Any dead end lands the item on needs_manual with a reason; a transient failure (429 / 5xx / timeout)
// goes back to `uploaded` for the browser to retry, up to 3 attempts.
async function cvImportExtract(body, auth, env) {
  const d = body.data || body;
  const c = await cvItemCtx(auth, env, d.item_id);
  if (c.res) return c.res;
  const item = c.item;
  const stale = new Date(Date.now() - CV_STALE_EXTRACT_MS).toISOString();
  const claimable = `or=(status.eq.uploaded,and(status.eq.extracting,extracting_since.lt.${stale}))`;
  // A run that died mid-read (OOM / CPU) never reached retryOrManual: past 3 attempts it goes to manual, no 4th call.
  if ((item.attempts || 0) >= 3) {
    const rows = await setCvItem(env, item.id, { status: 'needs_manual', extract_mode: 'manual', extracting_since: null,
      last_error: 'This file could not be read after 3 tries — enter by hand' }, `&${claimable}`);
    if (rows === null) return err('db_error', 502);
    return ok({ item: cvItemView(rows[0] || item, c.salary), busy: !rows.length });
  }
  const claimed = await setCvItem(env, item.id, { status: 'extracting', extracting_since: nowIso(), attempts: (item.attempts || 0) + 1 },
    `&${claimable}&attempts=lt.3`);
  if (claimed === null) return err('db_error', 502);
  if (!claimed.length) return ok({ item: cvItemView(item, c.salary), busy: true });
  const it = claimed[0];
  // Every closing write is guarded on status=extracting: a late original run can't overwrite a reclaimed one.
  const MINE = '&status=eq.extracting';
  const dupesFor = async (fields) => { try { return await cvImportDuplicates(auth, c.me, env, [fields || {}]); } catch { return null; } };
  const manual = async (reason) => {
    const rows = await setCvItem(env, it.id, { status: 'needs_manual', extract_mode: 'manual', extracting_since: null, last_error: reason }, MINE);
    return ok({ item: cvItemView(rows?.[0] || it, c.salary) });
  };
  const retryOrManual = async (reason) => {
    if ((it.attempts || 0) >= 3) return manual(`${reason} — gave up after 3 tries`);
    const rows = await setCvItem(env, it.id, { status: 'uploaded', extracting_since: null, last_error: reason }, MINE);
    return ok({ item: cvItemView(rows?.[0] || it, c.salary), retry: true });
  };

  try {
    const bytes = await storageDownload(env, it.storage_path);
    if (!bytes) return manual('The file could not be read back from storage');
    const sha = await sha256Hex(bytes);
    const st = await loadAiSettings(env);
    const model = st?.extract_model || 'gpt-6-luna';

    // Cache: the same file already read with this model + prompt → copy, no call.
    const hit = (await sb(`/rest/v1/cv_import_items?sha256=eq.${sha}&model=eq.${encodeURIComponent(model)}&prompt_version=eq.${CV_PROMPT_VERSION}&extracted=not.is.null&id=neq.${it.id}&select=extracted,warnings&limit=1`, env)).data?.[0];
    if (hit) {
      const rows = await setCvItem(env, it.id, { sha256: sha, status: 'extracted', extract_mode: 'cache', model, prompt_version: CV_PROMPT_VERSION,
        extracted: hit.extracted, warnings: hit.warnings || [], extracting_since: null, last_error: null }, MINE);
      return ok({ item: cvItemView(rows?.[0] || it, c.salary), duplicates: await dupesFor(hit.extracted?.fields) });
    }
    await setCvItem(env, it.id, { sha256: sha });

    const ext = cvFileExt(it.file_name);
    if (ext === 'doc') return manual('Old Word (.doc) files can\'t be read — enter by hand, or save it as PDF and upload again');
    let text = null, truncated = false, mode = 'text', file = null;
    if (ext === 'pdf' || ext === 'docx') {
      try {
        const t = cleanCvText((await cvText(bytes, ext)).text);
        text = t.text; truncated = t.truncated;
      } catch (e) { console.error('[cv-text]', ext, e?.message || e); text = ''; }
      if (text.length < CV_MIN_TEXT_CHARS) {
        if (ext === 'docx') return manual('No readable text in this Word file — enter by hand');
        text = null; mode = 'file'; file = { kind: 'pdf', name: safeFileName(it.file_name), b64: bytesToB64(bytes) };
      }
    } else if (CV_IMAGE_MIME[ext]) {
      mode = 'image'; file = { kind: 'image', mime: CV_IMAGE_MIME[ext], b64: bytesToB64(bytes) };
    } else {
      return manual('Unsupported file type');
    }
    if (file && bytes.length > CV_SCAN_MAX_BYTES) return manual('Scanned CVs over 5 MB can\'t be read — enter by hand, or upload a smaller copy');

    if (!env.OPENAI_API_KEY) return manual('AI reading isn\'t set up yet — enter by hand');
    if (!st?.enabled) return manual(AI_ERR.podium_ai_disabled);
    const price = st.prices?.[model];
    if (!price) return manual(`No price set for ${model} — ask a super admin`);
    const fx = Number(st.usd_inr) || 90;

    const rr = await sb(`/rest/v1/rpc/ai_reserve`, env, { method: 'POST', body: JSON.stringify({ p: {
      feature: 'cv_extract', model, prompt_version: CV_PROMPT_VERSION, ref_id: it.id,
      estimate_inr: cvEstimateInr(text == null ? null : text.length, price, fx), actor_user_id: auth.userId } }) });
    const rcode = rpcError(rr);
    if (rcode) return manual(AI_ERR[rcode] || `Couldn't start the AI call (${rcode})`);
    const callId = rr.data?.id;

    const reqBody = buildCvExtractRequest({ model, text, file, today: istToday() });
    let res, j = null, netErr = null;
    try {
      res = await fetch(OPENAI_URL, { method: 'POST', signal: AbortSignal.timeout(90000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: JSON.stringify(reqBody) });
      try { j = await res.json(); } catch { j = null; }
    } catch (e) { netErr = e?.name === 'TimeoutError' ? 'timed out' : (e?.message || 'network error'); }

    const usage = readCvUsage(j);
    const settle = async (status, error) => {
      const known = usage.input_tokens || usage.output_tokens;
      await sb(`/rest/v1/ai_calls?id=eq.${callId}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({
        status, error: error ? String(error).slice(0, 500) : null, finished_at: nowIso(), ...usage,
        // Unknown spend (timeout / network) keeps the reservation as the cost — conservative.
        cost_inr: known ? cvCostInr(usage, price, fx) : (netErr ? null : 0) }) });
    };

    if (netErr) { await settle('failed', netErr); return retryOrManual(`The AI call ${netErr}`); }
    if (!res.ok) {
      const msg = j?.error?.message || `HTTP ${res.status}`;
      await settle('failed', msg);
      if (res.status === 429 || res.status >= 500) return retryOrManual(`The AI service is busy (${res.status})`);
      console.error('[cv-openai]', res.status, msg);
      return manual(res.status === 401 ? 'The AI key was rejected — ask a super admin' : `The AI call failed (${res.status}) — enter by hand`);
    }
    const parsed = parseCvExtractResponse(j);
    if (!parsed.ok) { await settle('failed', parsed.reason); return manual(`The AI couldn't read this CV (${parsed.reason}) — enter by hand`); }
    await settle('ok', null);

    const v = validateCvExtraction(parsed.raw, text);
    const warnings = [...v.warnings];
    if (truncated) warnings.push('Very long CV — only the first part was read');
    const rows = await setCvItem(env, it.id, { status: 'extracted', extract_mode: mode, model, prompt_version: CV_PROMPT_VERSION,
      ai_call_id: callId, extracted: { fields: v.fields, evidence: v.evidence }, warnings, extracting_since: null, last_error: null }, MINE);
    await touchCvImport(env, it.import_id);
    return ok({ item: cvItemView(rows?.[0] || it, c.salary), duplicates: await dupesFor(v.fields) });
  } catch (e) {
    console.error('[cv-extract]', e?.message || e);
    return retryOrManual(`Something went wrong reading this file (${String(e?.message || e).slice(0, 120)})`);
  }
}

// POST cvImportSaveItem {item_id, draft} — keep HR's edits between sessions.
async function cvImportSaveItem(body, auth, env) {
  const d = body.data || body;
  const c = await cvItemCtx(auth, env, d.item_id);
  if (c.res) return c.res;
  if (!['extracted', 'needs_manual'].includes(c.item.status)) return errCode('not_editable', 'This CV is already done', 409);
  let draft = pickCvDraft(d.draft || {});
  if (!c.salary) { const { current_ctc, expected_ctc, ...rest } = draft; draft = { ...rest, current_ctc: c.item.final?.current_ctc ?? null, expected_ctc: c.item.final?.expected_ctc ?? null }; }
  const rows = await setCvItem(env, c.item.id, { final: draft }, '&status=in.(extracted,needs_manual)');
  if (!rows?.length) return errCode('not_editable', 'This CV is already done', 409);
  await touchCvImport(env, c.imp.id);
  let duplicates = null;
  try { duplicates = await cvImportDuplicates(auth, c.me, env, [draft]); } catch { duplicates = null; }
  return ok({ item: cvItemView(rows[0], c.salary), duplicates });
}

async function callAction(fn, data, auth, env) {
  const res = await fn({ data }, auth, env);
  let j = null;
  try { j = await res.json(); } catch { j = null; }
  return { status: res.status, j: j || {} };
}

// POST cvImportAccept {item_id, draft, candidate_id?}
//   no candidate_id → a new candidate + application (createCandidate: JD + open gate, CTC only with salary access)
//   candidate_id    → attach: an application on that existing person (addApplication: visibility gate)
// Then the file moves to candidates/<id>/cv/ and a CV document row is recorded. Each step is resumable:
// a failure puts the item back where it was, with the reason, and a retry skips what's already done.
async function cvImportAccept(body, auth, env) {
  const d = body.data || body;
  const c = await cvItemCtx(auth, env, d.item_id);
  if (c.res) return c.res;
  // An accept that died mid-way (tab closed, worker killed) leaves `accepting`; after 5 minutes it can be re-run.
  const staleIso = new Date(Date.now() - CV_STALE_EXTRACT_MS).toISOString();
  const stuck = c.item.status === 'accepting' && Date.parse(c.item.updated_at) < Date.now() - CV_STALE_EXTRACT_MS;
  const prev = stuck ? 'extracted' : c.item.status;
  if (!stuck && !['extracted', 'needs_manual'].includes(prev)) return errCode('not_acceptable', 'This CV is already done', 409);
  if (d.candidate_id && !isUuid(d.candidate_id)) return err('bad candidate_id', 400);
  const claimed = await setCvItem(env, c.item.id, { status: 'accepting' },
    stuck ? `&status=eq.accepting&updated_at=lt.${staleIso}` : `&status=eq.${prev}`);
  if (claimed === null) return err('db_error', 502);
  if (!claimed.length) return errCode('busy', 'Someone else is working on this CV', 409);
  let item = claimed[0];
  const fail = async (msg, status = 400, code = null) => {
    await setCvItem(env, item.id, { status: prev, last_error: String(msg).slice(0, 300) });
    return code ? errCode(code, msg, status) : err(msg, status);
  };
  try {
    const draft = pickCvDraft(d.draft || item.final || item.extracted?.fields || {});
    const appData = { opening_id: c.imp.opening_id, source: c.imp.source, source_detail: c.imp.source_detail,
      notice_period_days: draft.notice_period_days, current_ctc: draft.current_ctc, expected_ctc: draft.expected_ctc };
    let candidateId = item.candidate_id, applicationId = item.application_id;
    if (!candidateId) {
      if (d.candidate_id) {
        const mc = await sb(`/rest/v1/candidates?id=eq.${d.candidate_id}&select=merged_into_id&limit=1`, env);
        if (!mc.data?.[0]) return fail('That candidate no longer exists', 404);
        if (mc.data[0].merged_into_id) return fail('That candidate was merged into another — attach to the surviving record', 409);
        const a = await callAction(addApplication, { ...appData, candidate_id: d.candidate_id }, auth, env);
        if (a.j.ok) applicationId = a.j.data.id;
        else if (a.j.error === 'already_active') {
          applicationId = (await sb(`/rest/v1/applications?candidate_id=eq.${d.candidate_id}&opening_id=eq.${c.imp.opening_id}&status=in.(${ACTIVE_APP_STATUSES.join(',')})&select=id&limit=1`, env)).data?.[0]?.id || null;
        } else return fail(a.j.message || a.j.error || 'Could not attach', a.status);
        candidateId = d.candidate_id;
      } else {
        if (!String(draft.full_name || '').trim()) return fail('Enter the candidate\'s name first');
        // Server-side duplicate guard: the page's list can be stale; "Accept anyway" sends force.
        if (!d.force) {
          const dp = await cvImportDuplicates(auth, c.me, env, [draft]);
          if (dp.matches.length || dp.hidden_keys.length) {
            return fail(dp.matches.length ? `Already in Podium: ${dp.matches.map(m => `${m.full_name} (${m.candidate_code})`).join(', ')} — attach to them, or accept anyway`
              : 'Someone with this email or phone is already in Podium on an opening you can\'t see — ask HR, or accept anyway', 409, 'duplicate');
          }
        }
        const r = await callAction(createCandidate, { ...appData, ...draft }, auth, env);
        if (!r.j.ok) return fail(r.j.message || r.j.error || 'Could not create the candidate', r.status, r.j.error === 'jd_required' || r.j.error === 'opening_not_open' ? r.j.error : null);
        candidateId = r.j.data.candidate.id; applicationId = r.j.data.application.id;
      }
      const upd = await setCvItem(env, item.id, { candidate_id: candidateId, application_id: applicationId, final: draft });
      // Fatal: without candidate_id on the item a retry would create the person twice (the duplicate guard is the backstop).
      if (!upd?.length) return fail('The candidate was created but this CV couldn\'t be linked — refresh before trying again', 500);
      item = upd[0];
    }

    if (!item.document_id) {
      // Deterministic destination (keyed on the item's created_at) so a retry finds a file it already moved.
      const dest = candidateDocPath(candidateId, 'cv', item.file_name, Date.parse(item.created_at));
      const mv = await storageFetch(`/object/move`, env, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucketId: DOC_BUCKET, sourceKey: item.storage_path, destinationKey: dest }) });
      if (!mv.ok && !(await storageHead(env, dest)).ok) return fail('Could not file the CV — try again', 502);
      // A retry after the row was written but not linked finds it by its (unique) path instead of re-inserting.
      let docId = (await sb(`/rest/v1/candidate_documents?storage_path=eq.${encodeURIComponent(dest)}&select=id&limit=1`, env)).data?.[0]?.id || null;
      if (!docId) {
        const dr = await sb(`/rest/v1/candidate_documents`, env, { method: 'POST', body: JSON.stringify([{
          candidate_id: candidateId, application_id: applicationId || null, doc_type: 'cv', title: item.file_name, storage_path: dest,
          file_name: item.file_name, mime_type: item.mime_type || null, file_size: Number(item.file_size), uploaded_by: auth.userId, source: 'cv_import' }]) });
        if (!dr.ok) return fail(`Could not record the CV (${JSON.stringify(dr.data).slice(0, 120)})`, 400);
        docId = dr.data[0].id;
        await hiringEvents(env, auth, c.me, [{ candidate_id: candidateId, application_id: applicationId || null, event_type: 'document_added', detail: { doc_type: 'cv', source: 'cv_import' } }]);
      }
      const upd = await setCvItem(env, item.id, { document_id: docId });
      if (!upd?.length) return fail('The CV was filed but couldn\'t be linked — press Accept again', 500);
      item = upd[0];
    }
    const rows = await setCvItem(env, item.id, { status: 'accepted', last_error: null });
    await touchCvImport(env, item.import_id);
    return ok(cvItemView(rows?.[0] || item, c.salary));
  } catch (e) {
    console.error('[cv-accept]', e?.message || e);
    return fail(`Something went wrong (${String(e?.message || e).slice(0, 120)}) — try again`, 500);
  }
}

// POST cvImportSkip {item_id} — not this one; the staged file is deleted.
async function cvImportSkip(body, auth, env) {
  const d = body.data || body;
  const c = await cvItemCtx(auth, env, d.item_id);
  if (c.res) return c.res;
  // Never once an accept created the person (candidate_id set) — finish that accept instead.
  const rows = await setCvItem(env, c.item.id, { status: 'skipped', extracting_since: null }, '&status=in.(uploaded,extracted,needs_manual)&candidate_id=is.null');
  if (!rows?.length) return errCode('not_skippable', c.item.candidate_id ? 'This person was already added — press Accept to finish filing the CV' : 'This CV is already done or being read', 409);
  await storageDeletePaths(env, [c.item.storage_path]);
  await touchCvImport(env, c.imp.id);
  return ok(cvItemView(rows[0], c.salary));
}

// POST discardCvImport {import_id} — drop every un-accepted file; the batch row goes too if nothing was accepted.
async function discardCvImport(body, auth, env) {
  const d = body.data || body;
  const c = await cvImportCtx(auth, env, d.import_id);
  if (c.res) return c.res;
  // The status test lives in the DELETE itself, so an accept / read that claims a row meanwhile keeps it.
  const stale = new Date(Date.now() - CV_STALE_EXTRACT_MS).toISOString();
  const del = await sb(`/rest/v1/cv_import_items?import_id=eq.${c.imp.id}&candidate_id=is.null`
    + `&or=(status.in.(uploaded,extracted,needs_manual,skipped),and(status.in.(extracting,accepting),updated_at.lt.${stale}))`, env, { method: 'DELETE' });
  if (!del.ok) return err('db_error', 502);
  const gone = del.data || [];
  await storageDeletePaths(env, gone.map(i => i.storage_path));
  const left = (await sb(`/rest/v1/cv_import_items?import_id=eq.${c.imp.id}&select=id`, env)).data || [];
  if (!left.length) await sb(`/rest/v1/cv_imports?id=eq.${c.imp.id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  return ok({ discarded: gone.length, kept: left.length });
}

// GET getAiSettings — HR reads; super_admin edits (updateAiSettings).
async function getAiSettings(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const [s, spend] = await Promise.all([loadAiSettings(env), aiMonthSpend(env)]);
  return ok({ settings: s, spend, ai_ready: !!env.OPENAI_API_KEY, can_edit: !!auth.isSuperAdmin });
}

async function updateAiSettings(body, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  const s = await loadAiSettings(env);
  if (!s) return err('settings missing', 500);
  const p = {};
  if ('enabled' in d) p.enabled = !!d.enabled;
  if ('extract_model' in d) { if (!s.prices?.[d.extract_model]) return err('No price is set for that model', 400); p.extract_model = d.extract_model; }
  if ('monthly_cap_inr' in d) { const n = Number(d.monthly_cap_inr); if (!(n >= 0 && n <= 100000)) return err('Cap must be ₹0–1,00,000', 400); p.monthly_cap_inr = Math.round(n); }
  if ('usd_inr' in d) { const n = Number(d.usd_inr); if (!(n >= 50 && n <= 200)) return err('₹/$ must be 50–200', 400); p.usd_inr = n; }
  if (!Object.keys(p).length) return err('no_patch', 400);
  const r = await sb(`/rest/v1/ai_settings?id=eq.1`, env, { method: 'PATCH', body: JSON.stringify({ ...p, updated_by: auth.userId, updated_at: nowIso() }) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data[0]);
}

// ────────────────────────────────────────────────────────────────────────────
// Hiring O2 — interview rounds + panel feedback.
// Plan: docs/superpowers/plans/2026-11-12-podium-o2-interviews.md (D1–D9) · pure rules in src/interviews.js.
// Two surfaces: the CHAIN (canSeeOpening / canManageApps / canEditOpening on the opening, exactly as C1–C3) and
// the PANEL (getMyInterviews / getPanelInterview / getPanelDocUrl / submitInterviewFeedback). Being a panelist
// grants nothing on the C1/C2/C3 reads (D5). Feedback is blind until you submit (D4); free-text verdict and
// cancel notes follow the salary-chain note rule (redactEvent), feedback notes do not (D8).
// ────────────────────────────────────────────────────────────────────────────

const IV_SELECT = 'id,application_id,opening_id,candidate_id,round_id,round_name,scorecard,scheduled_at,duration_min,mode,location,'
  + 'status,jd_id,verdict,verdict_reason,verdict_note,verdict_by_employee_id,verdict_at,cancel_reason,cancelled_at,created_at,updated_at';
const PANEL_SELECT = 'id,interview_id,employee_id,due_at,rating,recommendation,scores,notes,submitted_at,reminded_at,remind_count,created_at';
const ROUND_SELECT = 'id,opening_id,seq,name,default_interviewer_ids,scorecard,active,created_at,updated_at';
const PANEL_CANDIDATE_SELECT = 'id,candidate_code,full_name,current_employer,current_title,total_experience_years,skills,education,location,linkedin_url';
const ivErr = (code, status = 400) => errCode(code, IV_COPY[code] || code, status);
const IV_COPY = {
  opening_not_open: 'The opening is not open',
  application_not_schedulable: 'Interviews are scheduled only while the application is New, Screening or Interviewing',
  round_required: 'Pick a round from the plan',
  bad_round: 'That round is not on this opening, or is inactive',
  round_already_scheduled: 'This application already has a live interview for that round',
  panel_required: 'Add at least one interviewer',
  panel_too_large: 'At most 10 interviewers',
  panelist_inactive: 'Interviewers must be active employees with a Podium login',
  panel_submitted: 'An interviewer who has submitted feedback cannot be removed',
  interview_closed: 'This interview is cancelled or a no-show',
  not_scheduled: 'Only a scheduled interview can be changed',
  too_early: 'The interview time has not passed yet',
  verdict_exists: 'This interview already has a verdict',
  already_submitted: 'Your feedback is already in, it cannot be edited',
  feedback_locked: 'Your feedback is already in, it cannot be edited',
  scores_incomplete: 'Score every criterion (1 to 5)',
  bad_rating: 'Pick an overall rating from 1 to 5',
  bad_recommendation: 'Pick a recommendation',
  bad_scores: 'The scores do not match this interview\'s scorecard',
  notes_too_long: 'Notes can be at most 5,000 characters',
  remind_too_soon: 'A reminder went out in the last 12 hours',
  feedback_not_owed: 'This interviewer owes no feedback right now',
  no_work_mailbox: 'You need an active work mailbox to send reminders',
  panelist_no_email: 'That interviewer has no work email',
  mail_failed: 'The reminder could not be sent, try again',
  mail_unknown: 'The reminder may not have gone out, check your Sent folder before retrying',
  stale: 'This changed since you loaded it, refresh and try again',
  bad_time: 'Pick a time within the next year (or the last 30 days)',
  time_required: 'Pick the interview time',
  bad_mode: 'Pick in person, video or phone',
  bad_duration: 'Duration must be 10 to 480 minutes',
  location_too_long: 'Location can be at most 500 characters',
  cancel_reason_required: 'Say why the interview is cancelled',
  round_name_required: 'Name the round',
  round_name_too_long: 'Round names can be at most 80 characters',
  bad_order: 'The round list changed, refresh and try again',
  check_failed: 'The record failed a consistency check',
  panel_self: 'You cannot add or remove yourself from a panel; ask another member of the hiring team',
  reschedule_after_feedback: 'Feedback is in, so the time cannot move. Cancel this interview and schedule a new one',
};

// Every O2 read goes through rowsOf: a failed read (a deploy ahead of 0014, a PostgREST error) reads as no rows,
// so getMe / getOpening / getCandidate never 500 on it. Long id lists are fetched ≤150 ids per request.
const IN_CHUNK = 150;
async function sbInChunks(env, ids, build) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return [];
  const parts = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) parts.push(list.slice(i, i + IN_CHUNK));
  return (await Promise.all(parts.map(c => sb(build(c), env)))).flatMap(rowsOf);
}
async function empNames(env, ids) {
  const rows = await sbInChunks(env, (ids || []).filter(isUuid), (c) => `/rest/v1/employees?id=in.(${c.join(',')})&select=id,full_name`);
  return Object.fromEntries(rows.map(e => [e.id, e.full_name]));
}
// D3: interviewers are active employees with a Podium login.
async function validInterviewers(env, ids) {
  const list = [...new Set((ids || []).filter(isUuid))];
  if (!list.length) return new Set();
  const r = await sb(`/rest/v1/employees?id=in.(${list.join(',')})&status=eq.active&auth_user_id=not.is.null&select=id`, env);
  return new Set(rowsOf(r).map(e => e.id));
}
// D9: a seat on any non-cancelled interview panel. Kept OUT of hiringAccess: that gate also opens
// getHiringLookups / findCandidateDuplicates and podium_hiring_access, which a pure panelist must not get (D5).
async function panelSeat(me, env) {
  if (!me) return false;
  const r = await sb(`/rest/v1/interview_panel?employee_id=eq.${me.id}&select=id,interview:interview_id!inner(id,status)`
    + `&interview.status=neq.cancelled&limit=1`, env);
  return rowsOf(r).length > 0;
}
async function loadInterview(env, id) {
  if (!isUuid(id)) return null;
  return (await sb(`/rest/v1/interviews?id=eq.${id}&select=${IV_SELECT}&limit=1`, env)).data?.[0] || null;
}
// The chain's hold on one interview: manage = canManageApps, else canSeeOpening.
async function interviewCtx(auth, env, interviewId, { manage = true } = {}) {
  const iv = await loadInterview(env, interviewId);
  if (!iv) return { res: err('not_found', 404) };
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, iv.opening_id);
  if (!x || !(manage ? canManageApps(x.roles) : canSeeOpening(x.roles))) return { res: err('forbidden', 403) };
  return { iv, me, x };
}
// The panel's hold: the caller's own row on a non-cancelled interview (D5).
async function panelCtx(auth, env, interviewId) {
  const iv = await loadInterview(env, interviewId);
  if (!iv) return { res: err('not_found', 404) };
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return { res: err('forbidden', 403) };
  const [er, pr] = await Promise.all([
    sb(`/rest/v1/employees?id=eq.${me.id}&select=status&limit=1`, env),
    sb(`/rest/v1/interview_panel?interview_id=eq.${iv.id}&select=${PANEL_SELECT}&order=created_at.asc`, env),
  ]);
  // An interviewer who has left (or is not active) loses the panel surface.
  if (rowsOf(er)[0]?.status !== 'active') return { res: err('forbidden', 403) };
  const rows = rowsOf(pr);
  const mine = rows.find(r => r.employee_id === me.id);
  if (!mine || iv.status === 'cancelled') return { res: err('forbidden', 403) };
  return { iv, me, rows, mine };
}

// Interviews of these applications as the chain sees them. apps = [{id, opening_id}], rolesByOpening = {openingId: roles}.
// → { [applicationId]: [interview…] } — panel feedback per D4 / D8, free-text notes per the salary rule.
async function chainInterviews(env, me, apps, rolesByOpening, now = Date.now()) {
  const ids = (apps || []).map(a => a.id);
  if (!ids.length) return {};
  const ivs = (await sbInChunks(env, ids, (c) => `/rest/v1/interviews?application_id=in.(${c.join(',')})&select=${IV_SELECT}`))
    .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));
  if (!ivs.length) return {};
  const [panelRaw, jds, calLinks] = await Promise.all([
    sbInChunks(env, ivs.map(i => i.id), (c) => `/rest/v1/interview_panel?interview_id=in.(${c.join(',')})&select=${PANEL_SELECT}`),
    sbInChunks(env, ivs.map(i => i.jd_id), (c) => `/rest/v1/opening_jds?id=in.(${c.join(',')})&select=id,version`),
    calendarLinks(env, ivs.map(i => i.id)),   // O3
  ]);
  const panel = panelRaw.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const jdVer = Object.fromEntries(jds.map(j => [j.id, j.version]));
  const names = await empNames(env, [...panel.map(p => p.employee_id), ...ivs.map(i => i.verdict_by_employee_id)]);
  const out = {};
  for (const iv of ivs) {
    const roles = rolesByOpening[iv.opening_id];
    const manage = canManageApps(roles);
    const sal = canSeeSalary(roles);
    const rows = panel.filter(p => p.interview_id === iv.id);
    const mine = rows.find(r => me && r.employee_id === me.id) || null;
    const view = panelView(rows, me?.id || null, canSeeOpening(roles), { interview: iv, now, names })
      .map((v, i) => ({ ...v, can_remind: manage && remindAllowed(rows[i], now, iv) }));
    (out[iv.application_id] ||= []).push({
      id: iv.id, application_id: iv.application_id, round_id: iv.round_id, round_name: iv.round_name, scorecard: iv.scorecard || [],
      scheduled_at: iv.scheduled_at, duration_min: iv.duration_min, mode: iv.mode, location: iv.location, status: iv.status,
      jd_id: iv.jd_id, jd_version: jdVer[iv.jd_id] ?? null,
      verdict: iv.verdict, verdict_reason: redactReason(iv.verdict_reason, sal), verdict_note: sal ? iv.verdict_note : null,
      verdict_at: iv.verdict_at, verdict_by_name: names[iv.verdict_by_employee_id] || null,
      cancel_reason: sal ? iv.cancel_reason : null, cancelled_at: iv.cancelled_at, updated_at: iv.updated_at,
      panel: view,
      feedback_hidden: !!mine && !mine.submitted_at,
      can_edit: manage && iv.status === 'scheduled',
      can_cancel: manage && iv.status === 'scheduled',
      can_no_show: manage && iv.status === 'scheduled' && Date.parse(iv.scheduled_at) <= now,
      can_verdict: manage && !verdictBlock(iv, now),
      // O3: the calendar state; Add to Calendar = manage, scheduled, in the future, not yet (fully) linked.
      calendar: calendarView(calLinks[iv.id], manage),
      can_add_calendar: manage && iv.status === 'scheduled' && Date.parse(iv.scheduled_at) > now
        && (!calLinks[iv.id] || calLinks[iv.id].state === 'pending' || (calLinks[iv.id].state === 'linked' && calLinks[iv.id].candidate_state === 'pending')),
    });
  }
  return out;
}

const roundView = (r) => ({ ...r, seq: Number(r.seq), scorecard: r.scorecard || [], default_interviewer_ids: r.default_interviewer_ids || [] });
async function openingRounds(env, openingIds, { activeOnly = false } = {}) {
  if (!openingIds.length) return [];
  const rows = await sbInChunks(env, openingIds,
    (c) => `/rest/v1/opening_rounds?opening_id=in.(${c.join(',')})${activeOnly ? '&active=eq.true' : ''}&select=${ROUND_SELECT}&order=seq.asc`);
  return rows.map(roundView).sort((a, b) => a.seq - b.seq);
}

// ── Rounds (D1): the opening's plan — canEditOpening edits, canSeeOpening reads ──

async function getOpeningRounds(url, auth, env) {
  const id = url.searchParams.get('opening_id');
  if (!isUuid(id)) return err('opening_id required', 400);
  const edges = await loadOrgEdges(env);
  const x = await loadOneOpening(auth, callerEmployee(edges, auth.userId), env, id);
  if (!x) return err('not_found', 404);
  if (!canSeeOpening(x.roles)) return err('forbidden', 403);
  const rounds = await openingRounds(env, [id]);
  const names = await empNames(env, rounds.flatMap(r => r.default_interviewer_ids));
  return ok({ rounds: rounds.map(r => ({ ...r, default_interviewers: r.default_interviewer_ids.map(e => ({ id: e, full_name: names[e] || null })) })),
    can_edit: canEditOpening(x.roles) });
}

// POST saveOpeningRound {opening_id, id?, name, default_interviewer_ids[], scorecard[{key?, label}]}
// Editing a round never touches interviews already scheduled (they keep their snapshot).
async function saveOpeningRound(body, auth, env) {
  const d = body.data || body;
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, d.opening_id);
  if (!x) return err('not_found', 404);
  if (!canEditOpening(x.roles)) return err('forbidden', 403);
  const nm = cleanRoundName(d.name);
  if (nm.error) return ivErr(nm.error);
  const sc = cleanScorecard(d.scorecard);
  if (sc.error) return errCode(sc.error, sc.error === 'too_many_criteria' ? 'At most 10 criteria' : sc.error === 'duplicate_criteria'
    ? 'Two criteria have the same name' : 'Each criterion needs a label (up to 80 characters)', 400);
  const pi = cleanPanelIds(d.default_interviewer_ids, { min: 0 });
  if (pi.error) return ivErr(pi.error);
  if (pi.ids.length) {
    const live = await validInterviewers(env, pi.ids);
    if (pi.ids.some(i => !live.has(i))) return ivErr('panelist_inactive');
  }
  const row = { name: nm.name, scorecard: sc.scorecard, default_interviewer_ids: pi.ids };
  let r;
  if (d.id) {
    if (!isUuid(d.id)) return err('bad id', 400);
    r = await sb(`/rest/v1/opening_rounds?id=eq.${d.id}&opening_id=eq.${x.o.id}`, env, { method: 'PATCH', body: JSON.stringify(row) });
    if (r.ok && !r.data?.length) return err('not_found', 404);
  } else {
    const last = await sb(`/rest/v1/opening_rounds?opening_id=eq.${x.o.id}&select=seq&order=seq.desc&limit=1`, env);
    const seq = Number(last.data?.[0]?.seq || 0) + 1;
    r = await sb(`/rest/v1/opening_rounds`, env, { method: 'POST', body: JSON.stringify({ ...row, opening_id: x.o.id, seq, created_by: auth.userId }) });
    if (r.data?.code === '23505') return ivErr('stale', 409);
  }
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  const saved = r.data?.[0];
  await hiringEvents(env, auth, me, [{ opening_id: x.o.id, event_type: d.id ? 'round_updated' : 'round_added', detail: { round_id: saved?.id || d.id } }]);
  return ok(saved ? roundView(saved) : null);
}

// POST setOpeningRoundActive {id, active} — a round with interviews is never deleted, only deactivated (D1).
async function setOpeningRoundActive(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.id)) return err('id required', 400);
  const rr = await sb(`/rest/v1/opening_rounds?id=eq.${d.id}&select=id,opening_id&limit=1`, env);
  const round = rr.data?.[0];
  if (!round) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, round.opening_id);
  if (!x || !canEditOpening(x.roles)) return err('forbidden', 403);
  // Strictly boolean true: the string "false" must never reactivate a round.
  const active = d.active === true;
  const r = await sb(`/rest/v1/opening_rounds?id=eq.${round.id}`, env, { method: 'PATCH', body: JSON.stringify({ active }) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  await hiringEvents(env, auth, me, [{ opening_id: x.o.id, event_type: active ? 'round_activated' : 'round_deactivated', detail: { round_id: round.id } }]);
  return ok(roundView(r.data[0]));
}

// POST reorderOpeningRounds {opening_id, ids[]} — the full plan, in the new order (one statement, 0014).
async function reorderOpeningRounds(body, auth, env) {
  const d = body.data || body;
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, d.opening_id);
  if (!x) return err('not_found', 404);
  if (!canEditOpening(x.roles)) return err('forbidden', 403);
  if (!Array.isArray(d.ids) || !d.ids.length || !d.ids.every(isUuid)) return ivErr('bad_order');
  const r = await hiringRpc(env, 'hiring_reorder_rounds', { opening_id: x.o.id, ids: d.ids });
  const code = interviewDbErrorCode(r);
  if (code) return ivErr(code, code === 'bad_order' ? 409 : 400);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok({ opening_id: x.o.id, count: d.ids.length });
}

// ── Interviews (D2 / D6 / D7): the chain ─────────────────────────────────────

// GET getApplicationInterviews?application_id — canSeeOpening on the application's opening.
async function getApplicationInterviews(url, auth, env) {
  const app = await loadApplication(env, url.searchParams.get('application_id'));
  if (!app) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, app.opening_id);
  if (!x || !canSeeOpening(x.roles)) return err('forbidden', 403);
  const manage = canManageApps(x.roles);
  const [byApp, rounds, calOn] = await Promise.all([
    chainInterviews(env, me, [app], { [x.o.id]: x.roles }),
    manage ? openingRounds(env, [x.o.id], { activeOnly: true }) : Promise.resolve([]),
    manage ? calendarEnabled(env) : Promise.resolve(false),
  ]);
  return ok({ application_id: app.id, application_status: app.status, can_manage: manage, calendar_enabled: calOn,
    can_schedule: manage && canSchedule(app.status) && x.o.status === 'open' && !jdGate(x.o),
    rounds, interviews: byApp[app.id] || [] });
}

// Shared gate for schedule / edit (D2): JD present, opening open, application new / screening / interviewing.
function scheduleGate(x, app) {
  if (jdGate(x.o)) return errCode('jd_required', JD_REQUIRED_MSG, 409);
  if (x.o.status !== 'open') return ivErr('opening_not_open', 409);
  if (!canSchedule(app.status)) return ivErr('application_not_schedulable', 409);
  return null;
}

// POST scheduleInterview {application_id, round_id?, round_name?, scheduled_at (ISO), duration_min, mode, location, panel[]}
async function scheduleInterview(body, auth, env) {
  const d = body.data || body;
  const app = await loadApplication(env, d.application_id);
  if (!app) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const x = await loadOneOpening(auth, me, env, app.opening_id);
  if (!x || !canManageApps(x.roles)) return err('forbidden', 403);
  const gate = scheduleGate(x, app);
  if (gate) return gate;
  // D1: a round from the plan (name + scorecard snapshotted), or free text only when the opening has no active plan.
  let roundId = null, roundName, scorecard = [];
  if (d.round_id) {
    if (!isUuid(d.round_id)) return ivErr('bad_round');
    const rr = await sb(`/rest/v1/opening_rounds?id=eq.${d.round_id}&opening_id=eq.${x.o.id}&active=eq.true&select=${ROUND_SELECT}&limit=1`, env);
    const round = rr.data?.[0];
    if (!round) return ivErr('bad_round');
    roundId = round.id; roundName = round.name; scorecard = round.scorecard || [];
  } else {
    const ar = await sb(`/rest/v1/opening_rounds?opening_id=eq.${x.o.id}&active=eq.true&select=id&limit=1`, env);
    if (ar.data?.length) return ivErr('round_required');
    const nm = cleanRoundName(d.round_name);
    if (nm.error) return ivErr(nm.error);
    roundName = nm.name;
  }
  const t = parseScheduledAt(d.scheduled_at);
  if (t.error) return ivErr(t.error);
  const f = cleanInterviewFields(d, { requireAll: true });
  if (f.error) return ivErr(f.error);
  const pi = cleanPanelIds(d.panel);
  if (pi.error) return ivErr(pi.error);
  const live = await validInterviewers(env, pi.ids);
  if (pi.ids.some(i => !live.has(i))) return ivErr('panelist_inactive');
  const due = dueAt(t.iso);
  // Interview + panel + (new|screening → interviewing, with its event) in one transaction (0014).
  const r = await hiringRpc(env, 'hiring_schedule_interview', {
    interview: { application_id: app.id, round_id: roundId, round_name: roundName, scorecard, scheduled_at: t.iso,
      duration_min: f.patch.duration_min, mode: f.patch.mode, location: f.patch.location ?? null },
    panel: pi.ids.map(e => ({ employee_id: e, due_at: due })),
    expected_status: app.status, actor_user_id: auth.userId, actor_employee_id: me?.id || null,
  });
  const code = interviewDbErrorCode(r);
  if (code === 'jd_required') return errCode('jd_required', JD_REQUIRED_MSG, 409);
  if (code) return ivErr(code, ['stale', 'round_already_scheduled', 'opening_not_open'].includes(code) ? 409 : 400);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok({ interview: r.data?.interview, application_status: r.data?.application_status });
}

// POST updateInterview {id, scheduled_at?, duration_min?, mode?, location?, add_panel[]?, remove_panel[]?}
// A reschedule moves every pending panelist's due_at to the new time + 24h (D3).
async function updateInterview(body, auth, env) {
  const d = body.data || body;
  const c = await interviewCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { iv, me, x } = c;
  if (iv.status !== 'scheduled') return ivErr('not_scheduled', 409);
  const app = await loadApplication(env, iv.application_id);
  if (!app) return err('not_found', 404);
  const gate = scheduleGate(x, app);
  if (gate) return gate;
  const patch = {};
  let at = iv.scheduled_at;
  // Only a time that actually changes is parsed / validated (an unchanged time 31+ days back must not block an edit).
  if (d.scheduled_at != null && d.scheduled_at !== '' && Date.parse(d.scheduled_at) !== Date.parse(iv.scheduled_at)) {
    const t = parseScheduledAt(d.scheduled_at);
    if (t.error) return ivErr(t.error);
    patch.scheduled_at = t.iso; at = t.iso;
  }
  const f = cleanInterviewFields(Object.fromEntries(['mode', 'duration_min', 'location'].filter(k => k in d).map(k => [k, d[k]])));
  if (f.error) return ivErr(f.error);
  for (const [k, v] of Object.entries(f.patch)) if (v !== iv[k]) patch[k] = v;
  const add = cleanPanelIds(d.add_panel, { min: 0 });
  const remove = cleanPanelIds(d.remove_panel, { min: 0 });
  if (add.error || remove.error) return ivErr(add.error || remove.error);
  // D4: nobody seats or unseats themselves on an existing panel.
  if (panelSelfBlock(me?.id || null, add.ids, remove.ids)) return ivErr('panel_self', 403);
  const pr = await sb(`/rest/v1/interview_panel?interview_id=eq.${iv.id}&select=employee_id,submitted_at`, env);
  if (!pr.ok) return err('db_error', 500);
  const current = rowsOf(pr);
  // Feedback is anchored to the time it was given for (re-checked under the lock in hiring_update_interview).
  if (patch.scheduled_at && current.some(p => p.submitted_at)) return ivErr('reschedule_after_feedback', 409);
  const have = new Set(current.map(p => p.employee_id));
  const addIds = add.ids.filter(e => !have.has(e));
  const removeIds = remove.ids.filter(e => have.has(e) && !addIds.includes(e));
  if (current.some(p => removeIds.includes(p.employee_id) && p.submitted_at)) return ivErr('panel_submitted', 409);
  if (current.length + addIds.length - removeIds.length < 1) return ivErr('panel_required');
  if (current.length + addIds.length - removeIds.length > MAX_PANEL) return ivErr('panel_too_large');
  if (addIds.length) {
    const live = await validInterviewers(env, addIds);
    if (addIds.some(i => !live.has(i))) return ivErr('panelist_inactive');
  }
  if (!Object.keys(patch).length && !addIds.length && !removeIds.length) return err('no_patch', 400);
  const r = await hiringRpc(env, 'hiring_update_interview', {
    interview_id: iv.id, expected_updated_at: iv.updated_at, patch,
    add: addIds.map(e => ({ employee_id: e, due_at: dueAt(at) })), remove: removeIds,
    new_due_at: patch.scheduled_at ? dueAt(at) : null,
    actor_user_id: auth.userId, actor_employee_id: me?.id || null,
  });
  const code = interviewDbErrorCode(r);
  if (code === 'jd_required') return errCode('jd_required', JD_REQUIRED_MSG, 409);
  if (code) return ivErr(code, ['stale', 'panel_submitted', 'round_already_scheduled', 'reschedule_after_feedback',
    'application_not_schedulable', 'opening_not_open'].includes(code) ? 409 : 400);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  // O3 D6: mirror the change on the calendar (best effort, after the Podium write).
  const calendar = await calendarAfterChange(env, r.data?.interview);
  return ok({ interview: r.data?.interview, rescheduled: !!r.data?.rescheduled, calendar });
}

// POST cancelInterview {id, reason} — no JD / opening / application gate: a cancel is the clean-up path (e.g. after
// the application was closed by hand), and refusing it would strand panelists with feedback they can never give.
async function cancelInterview(body, auth, env) {
  const d = body.data || body;
  const reason = String(d.reason || '').trim();
  if (!reason) return ivErr('cancel_reason_required');
  if (reason.length > CANCEL_REASON_MAX) return errCode('cancel_reason_too_long', 'At most 500 characters', 400);
  const c = await interviewCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { iv, me } = c;
  if (iv.status !== 'scheduled') return ivErr('not_scheduled', 409);
  const r = await sb(`/rest/v1/interviews?id=eq.${iv.id}&status=eq.scheduled`, env, { method: 'PATCH',
    body: JSON.stringify({ status: 'cancelled', cancel_reason: reason, cancelled_by: auth.userId, cancelled_at: nowIso() }) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  if (!r.data?.length) return ivErr('stale', 409);
  await hiringEvents(env, auth, me, [{ candidate_id: iv.candidate_id, opening_id: iv.opening_id, application_id: iv.application_id,
    event_type: 'interview_cancelled', detail: { interview_id: iv.id } }]);
  const calendar = await calendarAfterChange(env, r.data[0]);   // O3 D6: the guests are told
  return ok({ id: iv.id, status: 'cancelled', calendar });
}

// POST markInterviewNoShow {id} — the candidate did not turn up. The application does not move (D6); the round can
// be scheduled again, and no panelist owes feedback on it.
async function markInterviewNoShow(body, auth, env) {
  const d = body.data || body;
  const c = await interviewCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { iv, me } = c;
  if (iv.status !== 'scheduled') return ivErr('not_scheduled', 409);
  if (Date.parse(iv.scheduled_at) > Date.now()) return ivErr('too_early', 409);
  // Guarded on the time we read (a reschedule in between → stale) and on that time having passed.
  const r = await sb(`/rest/v1/interviews?id=eq.${iv.id}&status=eq.scheduled&scheduled_at=eq.${encodeURIComponent(iv.scheduled_at)}`
    + `&scheduled_at=lte.${encodeURIComponent(nowIso())}`, env, { method: 'PATCH', body: JSON.stringify({ status: 'no_show' }) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  if (!r.data?.length) return ivErr('stale', 409);
  await hiringEvents(env, auth, me, [{ candidate_id: iv.candidate_id, opening_id: iv.opening_id, application_id: iv.application_id,
    event_type: 'interview_no_show', detail: { interview_id: iv.id } }]);
  return ok({ id: iv.id, status: 'no_show' });
}

// POST recordInterviewVerdict {id, verdict, reason?, note?} (D6). reject → rejected (reason code), hold → on_hold,
// advance → nothing on the application. The move reuses setApplicationStatus's rules. Missing feedback is a UI
// warning, never a server block.
async function recordInterviewVerdict(body, auth, env, ctx) {
  const d = body.data || body;
  const c = await interviewCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { iv, me, x } = c;
  const block = verdictBlock(iv);
  if (block) return ivErr(block, 409);
  const move = verdictMove(d.verdict);
  if (move?.error) return errCode('bad_verdict', 'Pick advance, reject or hold', 400);
  const app = await loadApplication(env, iv.application_id);
  if (!app) return err('not_found', 404);
  if (jdGate(x.o)) return errCode('jd_required', JD_REQUIRED_MSG, 409);
  if (!canSchedule(app.status)) return ivErr('application_not_schedulable', 409);
  const reason = move?.reasonRequired ? (String(d.reason || '').trim() || null) : null;
  if (move) {
    const bad = checkTransition(app.status, move.to, reason);
    if (bad === 'reason_required') return errCode('reason_required', 'A reason is required to reject', 400);
    if (bad === 'bad_reason') return errCode('bad_reason', `reason must be one of: ${OUTCOME_REASON_CODES.join(', ')}`, 400);
    if (bad) return errCode('invalid_transition', `Cannot move ${app.status} → ${move.to} here`, 409);
    if (needsNoLiveOffer(move.to) && await hasLiveOffer(env, app.id)) return errCode('close_offers_first', OFFER_COPY.close_offers_first, 409);
  }
  const note = String(d.note || '').trim();
  if (note.length > 2000) return errCode('note_too_long', 'At most 2,000 characters', 400);
  const r = await hiringRpc(env, 'hiring_interview_verdict', {
    interview_id: iv.id, verdict: d.verdict, reason, note: note || null, to_status: move?.to || null,
    expected_status: app.status, actor_user_id: auth.userId, actor_employee_id: me?.id || null,
  });
  const code = interviewDbErrorCode(r);
  if (code === 'close_offers_first') return errCode('close_offers_first', OFFER_COPY.close_offers_first, 409);
  if (code) return ivErr(code, code === 'stale' ? 409 : 400);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  if (move && isTerminalStatus(move.to)) await maybeStartRetention(app.candidate_id, env);
  // O3 D8: a reject closes the application, and the DB cancels its other rounds → remove their events.
  if (move && isTerminalStatus(move.to)) await later(ctx, calendarSweepApplication(env, app.id));
  return ok({ interview: r.data?.interview, application_status: r.data?.application_status });
}

// POST remindPanelist {panel_id} (D7) — a short plain-text mail from the CALLER's own work mailbox to the panelist's,
// naming the candidate code + round. At most one per panelist per 12h (claimed on reminded_at before sending).
async function remindPanelist(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.panel_id)) return err('panel_id required', 400);
  const rr = await sb(`/rest/v1/interview_panel?id=eq.${d.panel_id}&select=${PANEL_SELECT}&limit=1`, env);
  const row = rr.data?.[0];
  if (!row) return err('not_found', 404);
  const c = await interviewCtx(auth, env, row.interview_id);
  if (c.res) return c.res;
  const { iv, me } = c;
  const now = Date.now();
  if (row.submitted_at || !FEEDBACK_OPEN_STATUSES.includes(iv.status) || Date.parse(iv.scheduled_at) > now) return ivErr('feedback_not_owed', 409);
  if (!remindAllowed(row, now, iv)) return ivErr('remind_too_soon', 409);
  if (!me) return ivErr('no_work_mailbox');
  const er = await sb(`/rest/v1/employees?id=in.(${[me.id, row.employee_id].join(',')})&select=id,full_name,preferred_name,work_email,status`, env);
  const by = Object.fromEntries(rowsOf(er).map(e => [e.id, e]));
  const mailOf = (e) => {
    const m = String(e?.work_email || '').trim().toLowerCase();
    return e && e.status !== 'exited' && m.endsWith(`@${WORK_DOMAIN}`) && addressOk(m) ? m : null;
  };
  const sender = mailOf(by[me.id]);
  if (!sender) return ivErr('no_work_mailbox');
  const to = mailOf(by[row.employee_id]);
  if (!to) return ivErr('panelist_no_email');
  const cr = await sb(`/rest/v1/candidates?id=eq.${iv.candidate_id}&select=candidate_code&limit=1`, env);
  const mail = buildReminderMail({
    from: sender, fromName: by[me.id].full_name, to, toFirst: String(by[row.employee_id].preferred_name || '').trim() || firstName(by[row.employee_id].full_name),
    candidateCode: cr.data?.[0]?.candidate_code || 'a candidate', roundName: iv.round_name, scheduledAt: iv.scheduled_at, dueAt: row.due_at,
    link: `${podiumAppUrl(env)}/hiring/interviews/detail/?id=${iv.id}`, messageId: reminderMessageId(row.id, crypto.randomUUID().slice(0, 8)),
  });
  if (mail.error) return ivErr('mail_failed', 400);
  // Claim the 12h slot first (guarded on the reminded_at we read), so two clicks cannot both send.
  const claimAt = nowIso();
  const prev = { reminded_at: row.reminded_at || null, remind_count: Number(row.remind_count || 0) };
  const guard = prev.reminded_at ? `reminded_at=eq.${encodeURIComponent(prev.reminded_at)}` : 'reminded_at=is.null';
  const cl = await sb(`/rest/v1/interview_panel?id=eq.${row.id}&submitted_at=is.null&${guard}`, env, { method: 'PATCH',
    body: JSON.stringify({ reminded_at: claimAt, remind_count: prev.remind_count + 1 }) });
  if (!cl.ok) return err(`db_error: ${JSON.stringify(cl.data)}`, 400);
  if (!cl.data?.length) return ivErr('stale', 409);
  const g = await gmailSend(env, sender, mail.raw);
  if (!g.ok) {
    console.error('[interview-remind]', g.status, g.error);
    // Gmail answered no → the mail did not go: give the slot back. A timeout may have sent it → keep the claim.
    if (g.definite) {
      await sb(`/rest/v1/interview_panel?id=eq.${row.id}&reminded_at=eq.${encodeURIComponent(claimAt)}`, env, { method: 'PATCH',
        prefer: 'return=minimal', body: JSON.stringify(prev) });
      return ivErr('mail_failed', 502);
    }
    return ivErr('mail_unknown', 502);
  }
  await hiringEvents(env, auth, me, [{ candidate_id: iv.candidate_id, opening_id: iv.opening_id, application_id: iv.application_id,
    event_type: 'feedback_reminded', detail: { interview_id: iv.id, panel_id: row.id } }]);
  return ok({ panel_id: row.id, reminded_at: claimAt, remind_count: prev.remind_count + 1 });
}

// ── O3 — Calendar (plan docs/superpowers/plans/2026-11-13-podium-o3-calendar.md) ──────────────────────
// Writes go through the podiumops-only write SA (D1), acting as the organiser's mailbox. Off until the
// super-admin check proves the calendar.events delegation (D2). Every Google call is best-effort AFTER the
// Podium write: a failed push never undoes an interview change, it leaves last_error and a Retry.

const calErr = (code, status = 400) => errCode(code, CAL_COPY[code] || IV_COPY[code] || code, status);
const CAL_BASE = 'https://www.googleapis.com/calendar/v3';
const CAL_LINK_SELECT = 'interview_id,calendar_id,organiser_employee_id,event_id,candidate_event_id,candidate_email,invite_candidate,'
  + 'meet_url,conference_id,state,candidate_state,synced_start,synced_end,synced_hash,last_error,last_synced_at,updated_at';
const calTokens = new Map();
async function calendarToken(env, mailbox) {
  const hit = calTokens.get(mailbox);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  // Never the shared key (D1): no GOOGLE_ADMIN_SA_JSON → no calendar.
  if (!env.GOOGLE_ADMIN_SA_JSON) throw new Error('google_write_not_configured');
  const token = await googleAccessToken(env, { saJson: env.GOOGLE_ADMIN_SA_JSON, scope: CAL_SCOPE, sub: mailbox });
  calTokens.set(mailbox, { token, exp: Date.now() + 3300 * 1000 });
  return token;
}
// → { ok, status, definite, data }. definite = Google answered (a 5xx / timeout may still have applied).
async function gcal(env, mailbox, method, path, { query = {}, body } = {}) {
  let token;
  try { token = await calendarToken(env, mailbox); }
  catch (e) { return { ok: false, status: 0, definite: true, data: { error: { message: `token: ${String(e?.message || e).slice(0, 200)}` } } }; }
  const u = new URL(`${CAL_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(u, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  } catch (e) { return { ok: false, status: 0, definite: false, data: { error: { message: String(e?.message || e).slice(0, 200) } } }; }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, definite: res.status > 0 && res.status < 500, data };
}
const gErr = (r) => String(r?.data?.error?.message || `HTTP ${r?.status}`).slice(0, 400);
const gGone = (r) => r && (r.status === 404 || r.status === 410);
const evPath = (cal, id) => `/calendars/${encodeURIComponent(cal)}/events${id ? `/${encodeURIComponent(id)}` : ''}`;
const WRITE_Q = { conferenceDataVersion: 1, sendUpdates: 'all' };

function workMailOf(e) {
  const m = String(e?.work_email || '').trim().toLowerCase();
  return e && e.status === 'active' && m.endsWith(`@${WORK_DOMAIN}`) && addressOk(m) ? m : null;
}
async function calendarSettings(env) {
  return rowsOf(await sb('/rest/v1/calendar_settings?id=eq.1&select=*&limit=1', env))[0] || null;
}
async function calendarEnabled(env) {
  return googleWriteConfigured(env) && !!(await calendarSettings(env))?.enabled;
}
async function loadCalLink(env, interviewId) {
  return rowsOf(await sb(`/rest/v1/interview_calendar?interview_id=eq.${interviewId}&select=${CAL_LINK_SELECT}&limit=1`, env))[0] || null;
}
async function patchCalLink(env, interviewId, patch) {
  return sb(`/rest/v1/interview_calendar?interview_id=eq.${interviewId}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
}
// The people / names an event shows: panel mailboxes (active only), whether any feedback is in, candidate + opening.
async function calendarContext(env, iv) {
  const [pr, cr, or] = await Promise.all([
    sb(`/rest/v1/interview_panel?interview_id=eq.${iv.id}&select=employee_id,submitted_at,employee:employee_id(work_email,status)`, env),
    sb(`/rest/v1/candidates?id=eq.${iv.candidate_id}&select=candidate_code,full_name&limit=1`, env),
    sb(`/rest/v1/openings?id=eq.${iv.opening_id}&select=opening_code,designation&limit=1`, env),
  ]);
  if (!pr.ok) throw new Error('panel_read_failed');
  const panel = rowsOf(pr);
  return { panelEmails: panel.map(p => workMailOf(p.employee)).filter(Boolean), hasFeedback: panel.some(p => p.submitted_at),
    candidate: rowsOf(cr)[0] || {}, opening: rowsOf(or)[0] || {} };
}
const panelLink = (env, ivId) => `${podiumAppUrl(env)}/hiring/interviews/detail/?id=${ivId}`;
const hashOf = (iv, cx) => syncedHash({ ...iv, panelEmails: cx.panelEmails });

// Create (409 → adopt) one event. → { ok, event } | { ok: false, gone?, error, definite }
async function calInsertOrAdopt(env, cal, body) {
  const r = await gcal(env, cal, 'POST', evPath(cal), { query: WRITE_Q, body });
  if (r.ok) return { ok: true, event: r.data };
  if (r.status === 409) {
    const g = await gcal(env, cal, 'GET', evPath(cal, body.id));
    if (g.ok && g.data?.status !== 'cancelled') return { ok: true, event: g.data, adopted: true };
    // 409 then 404 is ambiguous (the calendar may be unreachable): only 410 / status cancelled count as deleted.
    if (g.status === 410 || (g.ok && g.data?.status === 'cancelled')) return { ok: false, gone: true, error: 'deleted_in_calendar', definite: true };
    return { ok: false, error: gErr(g), definite: g.definite };
  }
  return { ok: false, error: gErr(r), definite: r.definite };
}

// The conference id to remember: a live Meet, or one Google is still creating (so a later push keeps it, not a second one).
const conferenceIdOf = (ev) => ev?.conferenceData?.conferenceId
  || (ev?.conferenceData?.createRequest?.status?.statusCode === 'pending' ? 'pending' : null);   // 'failure' → null → a new Meet next push

// Finish a claimed link (D5): internal event, then the candidate's. Safe to re-run (deterministic ids).
// A linked row only retries the candidate's invite: the internal event is read, never re-stamped (its synced_* /
// last_error stay as they are, so a missed push or a Calendar move is still seen by the next sync).
async function completeCalendarLink(env, iv, link) {
  const cx = await calendarContext(env, iv);
  const ids = calendarEventIds(iv.id);
  let internal, patch;
  if (link.state === 'linked') {
    const g = await gcal(env, link.calendar_id, 'GET', evPath(link.calendar_id, link.event_id));
    if (gGone(g) || g.data?.status === 'cancelled') return { error: 'calendar_event_deleted' };
    if (!g.ok) return { error: 'calendar_failed', detail: gErr(g) };
    internal = g.data;
    patch = {};
  } else {
    const a = await calInsertOrAdopt(env, link.calendar_id, buildInternalEvent({ id: ids.internal, iv, candidate: cx.candidate,
      opening: cx.opening, panelEmails: cx.panelEmails, organiserEmail: link.calendar_id, link: panelLink(env, iv.id),
      conference: 'create', requestId: `${iv.id}-${crypto.randomUUID().slice(0, 8)}` }));
    if (!a.ok) {
      if (a.gone) { await patchCalLink(env, iv.id, { state: 'cancelled', last_error: 'The event was deleted in Google Calendar' }); return { error: 'calendar_event_deleted' }; }
      await patchCalLink(env, iv.id, { last_error: a.error });
      return { error: 'calendar_failed', detail: a.error };
    }
    internal = a.event;
    const t = eventTimes(internal);
    // An adopted event (an earlier try's create that did land) may predate an edit: leave synced_hash empty so the
    // next sync pushes Podium's version onto it.
    patch = { event_id: ids.internal, meet_url: meetUrlOf(internal), conference_id: conferenceIdOf(internal),
      synced_start: t ? new Date(t.start).toISOString() : null, synced_end: t ? new Date(t.end).toISOString() : null,
      synced_hash: a.adopted ? null : hashOf(iv, cx), last_error: null, last_synced_at: nowIso(), state: 'linked' };
  }
  const meet = meetUrlOf(internal);
  if (link.invite_candidate && link.candidate_email && link.candidate_state !== 'linked') {
    const b = await calInsertOrAdopt(env, link.calendar_id, buildCandidateEvent({ id: ids.candidate, iv, designation: cx.opening.designation,
      candidateEmail: link.candidate_email, conf: conferenceOf(internal), meetUrl: meet }));
    let bOk = b.ok;
    // An adopted candidate invite (an earlier create that did land) may predate an edit: bring it to Podium's version.
    if (b.ok && b.adopted) {
      const fix = await gcal(env, link.calendar_id, 'PATCH', evPath(link.calendar_id, ids.candidate), { query: WRITE_Q,
        body: buildCandidateEvent({ iv, designation: cx.opening.designation, candidateEmail: link.candidate_email, conf: conferenceOf(internal), meetUrl: meet }) });
      if (!fix.ok) { bOk = false; b.error = gErr(fix); }
    }
    if (bOk) { patch.candidate_event_id = ids.candidate; patch.candidate_state = 'linked'; if (link.state === 'linked') patch.last_error = null; }
    else if (b.gone) patch.candidate_state = 'cancelled';
    else { patch.candidate_state = 'pending'; patch.candidate_event_id = ids.candidate; patch.last_error = `Candidate invite: ${b.error}`; }
  }
  if (Object.keys(patch).length) await patchCalLink(env, iv.id, patch);
  return { ok: true, meet_url: meet, candidate_invited: (patch.candidate_state || link.candidate_state) === 'linked',
    partial: !!patch.last_error };
}

// D6: Podium → Calendar. Patches the internal event (and the candidate's) to the interview as it now is.
// notifyInternal:false = Google already told the guests (the organiser moved the event); only re-stamp quietly.
async function calendarPush(env, iv, link, cx = null, { notifyInternal = true } = {}) {
  cx = cx || await calendarContext(env, iv);
  const conference = iv.mode !== 'video' ? 'remove' : (link.conference_id || link.meet_url) ? 'keep' : 'create';
  const h = hashOf(iv, cx);
  const a = await gcal(env, link.calendar_id, 'PATCH', evPath(link.calendar_id, link.event_id), {
    query: notifyInternal ? WRITE_Q : { conferenceDataVersion: 1, sendUpdates: 'none' },
    body: buildInternalEvent({ iv, candidate: cx.candidate, opening: cx.opening, panelEmails: cx.panelEmails,
      organiserEmail: link.calendar_id, link: panelLink(env, iv.id), conference, requestId: `${iv.id}-${crypto.randomUUID().slice(0, 8)}` }) });
  if (!a.ok) {
    await patchCalLink(env, iv.id, { last_error: gErr(a) });
    return { ok: false, gone: gGone(a), error: gErr(a) };
  }
  const meet = iv.mode === 'video' ? meetUrlOf(a.data) : null;
  const t = eventTimes(a.data);
  const patch = { meet_url: meet, conference_id: iv.mode === 'video' ? conferenceIdOf(a.data) : null, synced_start: t ? new Date(t.start).toISOString() : null, synced_end: t ? new Date(t.end).toISOString() : null,
    synced_hash: h, last_error: null, last_synced_at: nowIso() };
  if (link.candidate_event_id && link.candidate_state === 'linked') {
    const b = await gcal(env, link.calendar_id, 'PATCH', evPath(link.calendar_id, link.candidate_event_id), { query: WRITE_Q,
      body: buildCandidateEvent({ iv, designation: cx.opening.designation, candidateEmail: link.candidate_email,
        conf: conferenceOf(a.data), meetUrl: meet }) });
    if (gGone(b)) patch.candidate_state = 'cancelled';
    // The candidate's invite did not move: keep the old hash so the next sync pushes again (the internal PATCH is idempotent).
    else if (!b.ok) { patch.last_error = `Candidate invite: ${gErr(b)}`; patch.synced_hash = null; }
  }
  await patchCalLink(env, iv.id, patch);
  return { ok: !patch.last_error, error: patch.last_error || null };
}

// Podium cancelled → delete both events (guests are told). 404 / 410 = already gone.
// A pending row is deleted by its deterministic ids too: a create that timed out may still have landed (and mailed).
async function calendarDelete(env, link) {
  const ids = calendarEventIds(link.interview_id) || {};
  const del = async (id) => {
    if (!id) return true;
    const r = await gcal(env, link.calendar_id, 'DELETE', evPath(link.calendar_id, id), { query: { sendUpdates: 'all' } });
    return r.ok || gGone(r);
  };
  const okA = await del(link.event_id || ids.internal);
  const candId = link.candidate_event_id || (link.invite_candidate ? ids.candidate : null);
  // Always tried (404 = fine): a candidate create racing a cancel may have landed after the state said cancelled.
  const okB = await del(candId);
  await patchCalLink(env, link.interview_id, okA && okB
    ? { state: 'cancelled', candidate_state: link.invite_candidate ? 'cancelled' : link.candidate_state, last_error: null, last_synced_at: nowIso() }
    : { last_error: 'Could not remove the calendar event; it is retried when the interview is opened' });
  return okA && okB;
}

// After a Podium change to one interview: push or delete. Never throws; → 'synced' | 'failed' | null (not linked).
async function calendarAfterChange(env, iv) {
  try {
    if (!iv?.id || !googleWriteConfigured(env)) return null;
    const link = await loadCalLink(env, iv.id);
    if (!link || link.state === 'cancelled') return null;
    // Removing invites of a cancelled interview is always safe (even with O3 switched off, even for a pending row).
    if (iv.status === 'cancelled') return (await calendarDelete(env, link)) ? 'synced' : 'failed';
    if (iv.status !== 'scheduled' || link.state !== 'linked' || !(await calendarEnabled(env))) return null;
    return (await calendarPush(env, iv, link)).ok ? 'synced' : 'failed';
  } catch (e) {
    console.error('[calendar-after-change]', e?.message || e);
    return 'failed';
  }
}
// D8: interviews the DB auto-cancelled when an application closed still hold live events → delete them.
async function calendarSweepApplication(env, applicationId) {
  try {
    if (!isUuid(applicationId) || !googleWriteConfigured(env)) return;
    const r = await sb(`/rest/v1/interview_calendar?state=in.(linked,pending)&select=${CAL_LINK_SELECT},interview:interview_id!inner(application_id,status)`
      + `&interview.application_id=eq.${applicationId}&interview.status=eq.cancelled`, env);
    for (const link of rowsOf(r)) await calendarDelete(env, link);
  } catch (e) { console.error('[calendar-sweep]', e?.message || e); }
}
const later = (ctx, p) => (ctx?.waitUntil ? ctx.waitUntil(p) : p);

// GET getCalendarCheck — super-admin, read-only: can the write SA act on the caller's calendar?
async function calendarProbe(env, auth) {
  const s = await calendarSettings(env);
  const base = { enabled: !!s?.enabled, checked_at: s?.checked_at || null, scope: CAL_SCOPE };
  if (!googleWriteConfigured(env)) return { ...base, configured: false, all_good: false, error: 'google_write_not_configured' };
  const er = await sb(`/rest/v1/employees?auth_user_id=eq.${auth.userId}&select=work_email,status&limit=1`, env);
  const mailbox = workMailOf(rowsOf(er)[0]);
  if (!mailbox) return { ...base, configured: true, all_good: false, error: 'your employee record has no active work mailbox' };
  calTokens.delete(mailbox);
  // events.list is covered by calendar.events (calendars.get is not).
  const r = await gcal(env, mailbox, 'GET', evPath('primary'), { query: { maxResults: 1, timeMin: nowIso(), singleEvents: true } });
  return { ...base, configured: true, mailbox, call: r.ok, status: r.status, time_zone: r.data?.timeZone || null,
    error: r.ok ? null : gErr(r), all_good: r.ok };
}
async function getCalendarCheck(url, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  return ok(await calendarProbe(env, auth));
}
// POST calendarCheck {enable} — super-admin. enable:true only after a passing probe; enable:false switches O3 off.
async function calendarCheck(body, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (d.enable !== true) {
    const r = await sb('/rest/v1/calendar_settings?id=eq.1', env, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
    return ok({ enabled: false });
  }
  const p = await calendarProbe(env, auth);
  if (!p.all_good) return ok({ ...p, enabled: false, refused: true });
  const r = await sb('/rest/v1/calendar_settings?id=eq.1', env, { method: 'PATCH',
    body: JSON.stringify({ enabled: true, checked_at: nowIso(), checked_by: auth.userId, checked_mailbox: p.mailbox }) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok({ ...p, enabled: true });
}

// POST linkInterviewCalendar {id, invite_candidate} — the caller organises (D3); gates re-checked (D8).
async function linkInterviewCalendar(body, auth, env) {
  const d = body.data || body;
  if (!(await calendarEnabled(env))) return calErr('calendar_off', 409);
  const c = await interviewCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { iv, me, x } = c;
  if (iv.status !== 'scheduled') return calErr('calendar_not_scheduled', 409);
  if (Date.parse(iv.scheduled_at) <= Date.now()) return calErr('calendar_past', 409);
  const app = await loadApplication(env, iv.application_id);
  if (!app) return err('not_found', 404);
  const gate = scheduleGate(x, app);
  if (gate) return gate;
  let link = await loadCalLink(env, iv.id);
  // A linked interview whose candidate invite failed may retry just that part.
  if (link?.state === 'linked' && link.candidate_state !== 'pending') return calErr('calendar_linked', 409);
  if (link?.state === 'cancelled') return calErr('calendar_event_deleted', 409);
  if (!link) {
    if (!me) return calErr('calendar_no_mailbox');
    const er = await sb(`/rest/v1/employees?id=eq.${me.id}&select=id,work_email,status&limit=1`, env);
    const mailbox = workMailOf(rowsOf(er)[0]);
    if (!mailbox) return calErr('calendar_no_mailbox');
    const invite = d.invite_candidate === true;
    let candidateEmail = null;
    if (invite) {
      const cr = await sb(`/rest/v1/candidates?id=eq.${iv.candidate_id}&select=email&limit=1`, env);
      candidateEmail = String(rowsOf(cr)[0]?.email || '').trim().toLowerCase();
      if (!addressOk(candidateEmail)) return calErr('calendar_no_candidate_email');
    }
    const ids = calendarEventIds(iv.id);
    const ins = await sb('/rest/v1/interview_calendar', env, { method: 'POST', body: JSON.stringify({
      interview_id: iv.id, calendar_id: mailbox, organiser_employee_id: me.id, event_id: ids.internal,
      invite_candidate: invite, candidate_email: candidateEmail, candidate_state: invite ? 'pending' : null, created_by: auth.userId }) });
    if (ins.status === 409 || ins.data?.code === '23505') return calErr('calendar_busy', 409);
    if (!ins.ok) return err(`db_error: ${JSON.stringify(ins.data)}`, 400);
    link = ins.data?.[0];
  }
  // A pending row (an earlier try that did not finish) resumes as its own organiser; the ids make it idempotent.
  const res = await completeCalendarLink(env, iv, link);
  if (res.error) return calErr(res.error, res.error === 'calendar_failed' ? 502 : 409);
  // The interview may have been cancelled or edited while Google was answering: settle against a fresh read.
  // A failed read settles nothing (the next sync on open does): never delete on a read error.
  const fr = await sb(`/rest/v1/interviews?id=eq.${iv.id}&select=${IV_SELECT}&limit=1`, env);
  const fresh = fr.ok && Array.isArray(fr.data) ? fr.data[0] || null : undefined;
  const nowLink = fresh === undefined ? null : await loadCalLink(env, iv.id);
  if (nowLink && fresh && fresh.status !== 'scheduled') {
    if (fresh.status === 'cancelled') await calendarDelete(env, nowLink);
    return calErr('calendar_not_scheduled', 409);
  }
  if (fresh && nowLink?.state === 'linked' && fresh.updated_at !== iv.updated_at) await calendarPush(env, fresh, nowLink);
  await hiringEvents(env, auth, me, [{ candidate_id: iv.candidate_id, opening_id: iv.opening_id, application_id: iv.application_id,
    event_type: 'interview_calendar_linked', detail: { interview_id: iv.id, candidate_invited: res.candidate_invited } }]);
  return ok({ id: iv.id, state: 'linked', meet_url: res.meet_url, candidate_invited: res.candidate_invited, partial: res.partial });
}

// POST syncInterviewCalendar {id} — D7, called by the interview block on open. → { changed } (true = reload).
async function syncInterviewCalendar(body, auth, env) {
  const d = body.data || body;
  const c = await interviewCtx(auth, env, d.id);
  if (c.res) return c.res;
  const { iv, me } = c;
  if (!googleWriteConfigured(env)) return ok({ linked: false, changed: false });
  const link = await loadCalLink(env, iv.id);
  if (!link || link.state === 'cancelled') return ok({ linked: !!link, changed: false, state: link?.state || null });
  // A cancelled interview's invites go, whatever the state (a pending row's create may have landed).
  if (iv.status === 'cancelled') return ok({ linked: true, changed: await calendarDelete(env, link), action: 'delete_events' });
  if (link.state === 'pending') return ok({ linked: false, changed: false, state: 'pending' });
  // O3 switched off (D2) → no pull / push / cancel from a page open.
  if (!(await calendarEnabled(env))) return ok({ linked: true, changed: false, action: 'off' });
  const cx = await calendarContext(env, iv);
  let event = null;
  if (link.state === 'linked' && iv.status === 'scheduled') {
    const g = await gcal(env, link.calendar_id, 'GET', evPath(link.calendar_id, link.event_id));
    if (!g.ok && !gGone(g)) { await patchCalLink(env, iv.id, { last_error: gErr(g) }); return calErr('calendar_failed', 502); }
    // A 404 can also mean "this calendar is not reachable" (a suspended organiser, lost delegation): only a calendar
    // we can still list counts the event as deleted. 410 / status cancelled are definite.
    if (g.status === 404) {
      const probe = await gcal(env, link.calendar_id, 'GET', evPath(link.calendar_id), { query: { maxResults: 1 } });
      if (!probe.ok) {
        await patchCalLink(env, iv.id, { last_error: `The organiser's calendar cannot be reached: ${gErr(probe)}` });
        return calErr('calendar_failed', 502);
      }
    }
    event = g.ok ? g.data : null;
  }
  const act = calendarSyncAction({ iv, link, event, podiumHash: hashOf(iv, cx), hasFeedback: cx.hasFeedback });
  if (act.action === 'none') {
    const meet = event && iv.mode === 'video' ? meetUrlOf(event) : link.meet_url;
    // A Meet that finished creating after the invites went out: re-stamp so the candidate's invite gets the link.
    if (meet && meet !== link.meet_url) {
      await calendarPush(env, iv, { ...link, conference_id: conferenceIdOf(event) || link.conference_id }, cx, { notifyInternal: false });
      return ok({ linked: true, changed: true, action: 'meet_ready' });
    }
    await patchCalLink(env, iv.id, { last_synced_at: nowIso() });
    return ok({ linked: true, changed: false, action: 'none' });
  }
  if (act.action === 'delete_events') return ok({ linked: true, changed: await calendarDelete(env, link), action: act.action });
  if (act.action === 'detach') {
    await patchCalLink(env, iv.id, { state: 'cancelled', last_synced_at: nowIso() });
    return ok({ linked: true, changed: true, action: act.action });
  }
  if (act.action === 'push') {
    const p = await calendarPush(env, iv, link, cx);
    return ok({ linked: true, changed: true, action: 'push', reason: act.reason, ok: p.ok });
  }
  if (act.action === 'cancel_interview') {
    const r = await sb(`/rest/v1/interviews?id=eq.${iv.id}&status=eq.scheduled&updated_at=eq.${encodeURIComponent(iv.updated_at)}`, env, { method: 'PATCH',
      body: JSON.stringify({ status: 'cancelled', cancel_reason: 'Cancelled in Google Calendar', cancelled_by: auth.userId, cancelled_at: nowIso() }) });
    if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
    if (!r.data?.length) return ivErr('stale', 409);
    await hiringEvents(env, auth, me, [{ candidate_id: iv.candidate_id, opening_id: iv.opening_id, application_id: iv.application_id,
      event_type: 'interview_cancelled', detail: { interview_id: iv.id, source: 'google_calendar' } }]);
    await calendarDelete(env, link);   // the candidate's invite goes too
    return ok({ linked: true, changed: true, action: act.action });
  }
  // pull: Calendar moved the time → the same RPC as an edit (pending due dates move with it).
  const r = await hiringRpc(env, 'hiring_update_interview', {
    interview_id: iv.id, expected_updated_at: iv.updated_at, patch: { scheduled_at: act.scheduled_at, duration_min: act.duration_min },
    add: [], remove: [], new_due_at: dueAt(act.scheduled_at), actor_user_id: auth.userId, actor_employee_id: me?.id || null,
  });
  const code = interviewDbErrorCode(r);
  // Someone else's open already took it (or edited): pushing our stale copy would flip Calendar back and mail everyone.
  if (code === 'stale') return ok({ linked: true, changed: true, action: 'none', reason: 'stale' });
  if (code || !r.ok) {
    // Podium cannot take the new time (closed opening, feedback in a race…) → put Calendar back to Podium's time,
    // read fresh (never the copy this request started with).
    const fresh = await loadInterview(env, iv.id);
    if (!fresh || fresh.status !== 'scheduled') return ok({ linked: true, changed: true, action: 'none', reason: code || 'pull_failed' });
    const p = await calendarPush(env, fresh, link);
    return ok({ linked: true, changed: true, action: 'push', reason: code || 'pull_failed', ok: p.ok });
  }
  const after = r.data?.interview || { ...iv, scheduled_at: act.scheduled_at, duration_min: act.duration_min };
  // Records the new synced_* and moves the candidate's invite; the panel was already told by Google.
  await calendarPush(env, after, link, cx, { notifyInternal: false });
  await hiringEvents(env, auth, me, [{ candidate_id: iv.candidate_id, opening_id: iv.opening_id, application_id: iv.application_id,
    event_type: 'interview_rescheduled_from_calendar', detail: { interview_id: iv.id, from: iv.scheduled_at, to: act.scheduled_at } }]);
  return ok({ linked: true, changed: true, action: 'pull' });
}

// The calendar part of each interview in a chain view (D9). → { [interviewId]: row }
async function calendarLinks(env, interviewIds) {
  const rows = await sbInChunks(env, interviewIds, (c) => `/rest/v1/interview_calendar?interview_id=in.(${c.join(',')})&select=${CAL_LINK_SELECT}`);
  return Object.fromEntries(rows.map(r => [r.interview_id, r]));
}
function calendarView(link, manage) {
  if (!link) return null;
  return { state: link.state, meet_url: link.state === 'linked' ? link.meet_url : null,
    candidate_invited: link.candidate_state === 'linked', candidate_pending: link.invite_candidate && link.candidate_state === 'pending',
    last_error: manage ? link.last_error : null, organiser: link.calendar_id };
}

// ── The panel (D5): my interviews, one interview, its documents, my feedback ──

// GET getMyInterviews[?count_only=1] → { upcoming, owed, done, overdue_count } (cancelled interviews dropped).
async function getMyInterviews(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const countOnly = url.searchParams.get('count_only') === '1';
  const empty = { upcoming: [], owed: [], done: [], overdue_count: 0, owed_count: 0 };
  if (!me) return ok(countOnly ? { overdue_count: 0, owed_count: 0 } : empty);
  // One inner join (cancelled interviews dropped in the DB) + the application's status for the terminal net.
  const pr = await sb(`/rest/v1/interview_panel?employee_id=eq.${me.id}&select=${PANEL_SELECT},`
    + `interview:interview_id!inner(id,application_id,opening_id,candidate_id,round_name,scheduled_at,duration_min,mode,location,status,`
    + `application:application_id(status))&interview.status=neq.cancelled&order=created_at.desc&limit=1000`, env);
  if (!pr.ok) return err('db_error', 500);
  const mine = rowsOf(pr).filter(r => r.interview).map(r => {
    const { application, ...iv } = r.interview;
    return { ...r, interview: { ...iv, application_status: application?.status || null } };
  });
  if (!mine.length) return ok(countOnly ? { overdue_count: 0, owed_count: 0 } : empty);
  const b = myInterviewBuckets(mine);
  if (countOnly) return ok({ overdue_count: b.overdue_count, owed_count: b.owed.length });
  const ivs = mine.map(r => r.interview);
  const [cands, opns, myCal] = await Promise.all([
    sbInChunks(env, ivs.map(i => i.candidate_id), (c) => `/rest/v1/candidates?id=in.(${c.join(',')})&select=id,candidate_code,full_name,current_title,current_employer`),
    sbInChunks(env, ivs.map(i => i.opening_id), (c) => `/rest/v1/openings?id=in.(${c.join(',')})&select=id,opening_code,designation,department:department_id(name)`),
    sbInChunks(env, ivs.filter(i => i.status === 'scheduled').map(i => i.id),
      (c) => `/rest/v1/interview_calendar?interview_id=in.(${c.join(',')})&state=eq.linked&select=interview_id,meet_url`),   // O3 D9
  ]);
  const meetOf = Object.fromEntries(myCal.map(r => [r.interview_id, r.meet_url]));
  const cand = Object.fromEntries(cands.map(c => [c.id, c]));
  const opn = Object.fromEntries(opns.map(o => [o.id, o]));
  const now = Date.now();
  const shape = (r) => {
    const iv = r.interview, c = cand[iv.candidate_id] || {}, o = opn[iv.opening_id] || {};
    return {
      interview_id: iv.id, panel_id: r.id, round_name: iv.round_name, scheduled_at: iv.scheduled_at, duration_min: iv.duration_min,
      mode: iv.mode, location: iv.location, status: iv.status, due_at: r.due_at, submitted_at: r.submitted_at || null,
      meet_url: meetOf[iv.id] || null,
      state: seatState(r, now),
      candidate: { candidate_code: c.candidate_code || null, full_name: c.full_name || null, current_title: c.current_title || null, current_employer: c.current_employer || null },
      opening: { opening_code: o.opening_code || null, designation: o.designation || null, department: o.department?.name || null },
    };
  };
  return ok({ upcoming: b.upcoming.map(shape), owed: b.owed.map(shape), done: b.done.map(shape),
    overdue_count: b.overdue_count, owed_count: b.owed.length });
}

// GET getPanelInterview?id — the panelist's view (D5): candidate summary (no contact details, CTC, notes, offers,
// events or other applications), the opening's code / designation / department, the JD the interview ran against,
// the scorecard, the CV-tier documents, my feedback, and the others' only once mine is in (D4).
async function getPanelInterview(url, auth, env) {
  const c = await panelCtx(auth, env, url.searchParams.get('id'));
  if (c.res) return c.res;
  const { iv, me, rows, mine } = c;
  const [cr, or, jr, dr, calr] = await Promise.all([
    sb(`/rest/v1/candidates?id=eq.${iv.candidate_id}&select=${PANEL_CANDIDATE_SELECT}&limit=1`, env),
    sb(`/rest/v1/openings?id=eq.${iv.opening_id}&select=opening_code,designation,department:department_id(name)&limit=1`, env),
    sb(`/rest/v1/opening_jds?id=eq.${iv.jd_id}&select=id,version,source,jd_text,file_name,storage_path,created_at&limit=1`, env),
    sb(`/rest/v1/candidate_documents?candidate_id=eq.${iv.candidate_id}&doc_type=in.(${PANEL_DOC_TYPES.join(',')})`
      + `&select=id,doc_type,title,file_name,application_id,uploaded_at&order=uploaded_at.desc`, env),
    sb(`/rest/v1/interview_calendar?interview_id=eq.${iv.id}&state=eq.linked&select=meet_url&limit=1`, env),   // O3 D9
  ]);
  const cand = cr.data?.[0];
  if (!cand) return err('not_found', 404);
  const { id: _cid, ...candidate } = cand;
  const o = or.data?.[0] || {};
  const jd = jr.data?.[0] || null;
  const now = Date.now();
  const names = await empNames(env, rows.map(r => r.employee_id));
  const view = panelView(rows, me.id, false, { interview: iv, now, names });
  const own = view.find(v => v.is_me);
  return ok({
    interview: { id: iv.id, round_name: iv.round_name, scorecard: iv.scorecard || [], scheduled_at: iv.scheduled_at,
      duration_min: iv.duration_min, mode: iv.mode, location: iv.location, status: iv.status,
      meet_url: iv.status === 'scheduled' ? rowsOf(calr)[0]?.meet_url || null : null },
    candidate: { ...candidate, total_experience_years: numOrNull(candidate.total_experience_years) },
    opening: { opening_code: o.opening_code || null, designation: o.designation || null, department: o.department?.name || null },
    jd: jd ? { id: jd.id, version: jd.version, source: jd.source, jd_text: jd.jd_text || null, file_name: jd.file_name || null,
      has_file: !!jd.storage_path, created_at: jd.created_at } : null,
    documents: panelDocs(rowsOf(dr), iv.application_id).map(({ application_id, ...doc }) => doc),
    me: { panel_id: mine.id, due_at: mine.due_at, submitted_at: mine.submitted_at || null, state: own.state, feedback: own.feedback },
    panel: view.map(v => ({ id: v.id, name: v.name, is_me: v.is_me, state: v.state, submitted_at: v.submitted_at, feedback: v.feedback })),
    can_submit: !feedbackBlock(iv, mine, now),
  });
}

// GET getPanelDocUrl?interview_id&document_id | &jd=1 — a CV-tier document of that interview's candidate, or its JD.
async function getPanelDocUrl(url, auth, env) {
  const c = await panelCtx(auth, env, url.searchParams.get('interview_id'));
  if (c.res) return c.res;
  const { iv } = c;
  if (url.searchParams.get('jd') === '1') {
    const jr = await sb(`/rest/v1/opening_jds?id=eq.${iv.jd_id}&select=storage_path,file_name,mime_type&limit=1`, env);
    const jd = jr.data?.[0];
    if (!jd?.storage_path) return err('no_file', 400);
    return signDownload(jd.storage_path, jd.file_name, jd.mime_type, env);
  }
  const docId = url.searchParams.get('document_id');
  if (!isUuid(docId)) return err('document_id required', 400);
  const dr = await sb(`/rest/v1/candidate_documents?id=eq.${docId}&candidate_id=eq.${iv.candidate_id}&select=*&limit=1`, env);
  const doc = panelDocs(rowsOf(dr), iv.application_id)[0];
  if (!doc) return err('forbidden', 403);
  return signDownload(doc.storage_path, doc.file_name, doc.mime_type, env);
}

// POST submitInterviewFeedback {interview_id, rating, recommendation, scores{}, notes} — once, after the interview
// time, never on a cancelled / no-show interview (D3). The 0014 trigger refuses any later edit.
async function submitInterviewFeedback(body, auth, env) {
  const d = body.data || body;
  const c = await panelCtx(auth, env, d.interview_id);
  if (c.res) return c.res;
  const { iv, me, mine } = c;
  const block = feedbackBlock(iv, mine);
  if (block) return ivErr(block, 409);
  const fb = checkFeedback(iv.scorecard || [], d);
  if (fb.error) return ivErr(fb.error);
  const submittedAt = nowIso();
  const r = await sb(`/rest/v1/interview_panel?id=eq.${mine.id}&submitted_at=is.null`, env, { method: 'PATCH',
    body: JSON.stringify({ ...fb.feedback, submitted_at: submittedAt }) });
  const code = interviewDbErrorCode(r);
  if (code === 'feedback_locked') return ivErr('already_submitted', 409);
  // The 0014 window trigger (FOR SHARE on the interview) lost a race to a cancel / no-show / reschedule.
  if (code === 'interview_closed' || code === 'too_early') return ivErr(code, 409);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  if (!r.data?.length) return ivErr('already_submitted', 409);
  // ids only — never the content (the timeline is read by the whole chain).
  await hiringEvents(env, auth, me, [{ candidate_id: iv.candidate_id, opening_id: iv.opening_id, application_id: iv.application_id,
    event_type: 'feedback_submitted', detail: { interview_id: iv.id, panel_id: mine.id } }]);
  return ok({ interview_id: iv.id, submitted_at: submittedAt });
}
// ── end O2

// ────────────────────────────────────────────────────────────────────────────
// Leave R1 — apply, approve, balances, holidays.
// Plan: docs/superpowers/plans/2026-11-13-podium-leave-r1.md (D1–D15) · pure rules in src/leave.js · migration 0016.
// Surfaces: the PERSON (covered: employees.leave_policy not null) · the CHAIN (descendantsOf the caller; deciding =
// the snapshotted approver or that approver's manager, D9) · HR (isHr: everyone, settings, holidays, opening
// balances, adjustments). Every leave action is in SELF_SERVE_*: a covered employee may hold no Podium role, and each
// handler self-scopes. The ledger is the only balance; ensureLeaveCurrent writes the lazy accrual + year-end rows
// before every balance read (D4 / D5). Mail goes from the CALLER's own work mailbox and never fails the action (D12).
// ────────────────────────────────────────────────────────────────────────────

const LEAVE_EMP_SELECT = 'id,employee_code,full_name,preferred_name,job_title,manager_id,status,gender,date_joined,date_exited,leave_policy,leave_covered_from,work_email';
const LEAVE_REQ_SELECT = 'id,employee_id,leave_type,start_date,end_date,start_half,end_half,days,borrowed_days,lop_days,status,reason,'
  + 'approver_employee_id,decided_by_employee_id,decided_at,decision_note,cancelled_at,cancel_note,created_at,updated_at';
const LEAVE_STATUS = { report_changed: 409, not_covered: 403, forbidden: 403, no_self_approval: 403, not_found: 404, overlap: 409, period_used: 409,
  optional_used: 409, balance_changed: 409, not_pending: 409, not_approved: 409, opening_exists: 409, cutover_locked: 409 };
const leaveErr = (code, extra = null) => (extra
  ? json({ ok: false, error: code, message: LEAVE_COPY[code] || code.replace(/_/g, ' '), ...extra }, LEAVE_STATUS[code] || 400)
  : errCode(code, LEAVE_COPY[code] || code.replace(/_/g, ' '), LEAVE_STATUS[code] || 400));
const LEAVE_PAGE = 5000;   // = db-max-rows; the ledger outgrows one page in ~2 years, so every ledger read pages
const halfRound = (n) => Math.round(Number(n) * 2) / 2;
const numRow = (r) => ({ ...r, days: Number(r.days), borrowed_days: Number(r.borrowed_days || 0), lop_days: Number(r.lop_days || 0) });

// All rows of a PostgREST read, page by page (path must carry an order). → rows | null on any failed page
async function sbPaged(env, path) {
  const out = [];
  for (let off = 0, g = 0; g < 40; g++, off += LEAVE_PAGE) {
    const r = await sb(`${path}&limit=${LEAVE_PAGE}&offset=${off}`, env);
    if (!r.ok || !Array.isArray(r.data)) return null;
    out.push(...r.data);
    if (r.data.length < LEAVE_PAGE) break;
  }
  return out;
}
async function loadLeaveSettings(env) {
  const r = await sb(`/rest/v1/leave_settings?id=eq.1&select=cutover_month,updated_at&limit=1`, env);
  if (!r.ok) return null;
  return { cutover_month: r.data?.[0]?.cutover_month || DEFAULT_CUTOVER_MONTH, updated_at: r.data?.[0]?.updated_at || null };
}
async function loadHolidays(env, y1, y2) {
  const r = await sb(`/rest/v1/holidays?date=gte.${y1}-01-01&date=lte.${y2}-12-31&select=date,name,kind&order=date.asc&limit=1000`, env);
  return r.ok && Array.isArray(r.data) ? r.data : null;
}
async function loadLeaveEmployees(env, ids) {
  const list = [...new Set((ids || []).filter(isUuid))];
  if (!list.length) return [];
  return applyOpenExits(env, await sbInChunks(env, list, (c) => `/rest/v1/employees?id=in.(${c.join(',')})&select=${LEAVE_EMP_SELECT}`));
}
// Review I: an OPEN exit's LWD is the person's exit date for accrual and the borrow cap (date_exited is written only
// at the close). Marks each row `_exit_checked` so ensureLeaveCurrent does not re-read. Re-verify I': the read is
// STRICT — any failed chunk throws (leave.js applyOpenExitsWith), so no accrual is written for people whose exit could
// not be read; the GET/POST handler turns it into a 500.
async function applyOpenExits(env, emps) {
  return applyOpenExitsWith(emps, async (ids) => {
    const out = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const r = await sb(`/rest/v1/employee_exits?status=eq.open&employee_id=in.(${ids.slice(i, i + IN_CHUNK).join(',')})&select=employee_id,lwd`, env);
      if (!r.ok || !Array.isArray(r.data)) return null;
      out.push(...r.data);
    }
    return out;
  });
}
const leaveCovered = (e) => !!(e && e.leave_policy && e.status !== 'exited');

// D4 + D5 — the lazy, idempotent writer. For the covered ids: insert the missing accrual rows through the current IST
// month, then close every completed year ≥ the cutover year that has no leave_year_closes row (RPC
// podium.leave_close_years, under the lock). A late approve / cancel into a closed year is re-closed inside the RPC
// (podium.leave_reclose). Batched: one read + one insert per step, never per row.
// pre: { settings, emps } already loaded. → { ok } | { ok: false, error }
async function ensureLeaveCurrent(env, employeeIds, pre = {}) {
  const ids = [...new Set((employeeIds || []).filter(isUuid))];
  if (!ids.length) return { ok: true };
  const settings = pre.settings || await loadLeaveSettings(env);
  if (!settings) return { ok: false, error: 'settings' };
  const emps = (await applyOpenExits(env, pre.emps || await loadLeaveEmployees(env, ids))).filter(e => ids.includes(e.id) && e.leave_policy);
  if (!emps.length) return { ok: true };
  const today = istToday(), cur = monthOf(today), cy = yearOf(today), cutover = settings.cutover_month;
  const idf = emps.map(e => e.id).join(',');
  const have = await sbPaged(env, `/rest/v1/leave_ledger?employee_id=in.(${idf})&kind=eq.accrual&select=employee_id,leave_type,period&order=id.asc`);
  if (!have) return { ok: false, error: 'accrual_read' };
  const existing = {};
  for (const r of have) (existing[r.employee_id] ||= new Set()).add(`${r.leave_type}:${r.period}`);
  const rows = emps.flatMap(e => accrualPlan({ employee: e, cutoverMonth: cutover, currentMonth: cur, existing: existing[e.id] }));
  const insertLedger = async (list) => {
    for (let i = 0; i < list.length; i += 1000) {
      const w = await sb(`/rest/v1/leave_ledger?on_conflict=employee_id,leave_type,kind,period`, env, { method: 'POST',
        prefer: 'resolution=ignore-duplicates,return=minimal', body: JSON.stringify(list.slice(i, i + 1000)) });
      if (!w.ok) return false;
    }
    return true;
  };
  if (rows.length && !(await insertLedger(rows))) return { ok: false, error: 'accrual_write' };
  const cutY = Number(cutover.slice(0, 4));
  if (cy <= cutY) return { ok: true };
  const cr = await sb(`/rest/v1/leave_year_closes?employee_id=in.(${idf})&select=employee_id,year&limit=${LEAVE_PAGE}`, env);
  if (!cr.ok) return { ok: false, error: 'close_read' };
  const closed = {};
  for (const r of cr.data || []) (closed[r.employee_id] ||= new Set()).add(Number(r.year));
  const open = emps.filter(e => { for (let y = cutY; y < cy; y++) if (!closed[e.id]?.has(y)) return true; return false; });
  if (!open.length) return { ok: true };
  // The close runs in podium.leave_close_years under each person's leave lock, reading the ledger there — so an
  // approve / cancel can never land between its read and its write (Codex S453). Pending requests do not hold it.
  const cl = await hiringRpc(env, 'leave_close_years', { employee_ids: open.map(e => e.id), from_year: cutY, to_year: cy - 1 });
  if (!cl.ok) return { ok: false, error: 'close_write' };
  return { ok: true };
}

// Ledger + requests for a set of people (after ensureLeaveCurrent). Requests = every pending one (they hold balance)
// + anything ending this year or later. → { ledger: {id: rows}, reqs: {id: rows} } | null
async function leaveBooks(env, ids, cy) {
  const list = [...new Set((ids || []).filter(isUuid))];
  const ledger = {}, reqs = {};
  if (!list.length) return { ledger, reqs };
  const idf = list.join(',');
  const [led, rq] = await Promise.all([
    sbPaged(env, `/rest/v1/leave_ledger?employee_id=in.(${idf})&select=id,employee_id,leave_type,delta,kind,period,effective_date,request_id,note,created_at&order=id.asc`),
    sbPaged(env, `/rest/v1/leave_requests?employee_id=in.(${idf})&or=(status.eq.pending,end_date.gte.${cy}-01-01)&select=${LEAVE_REQ_SELECT}&order=id.asc`),
  ]);
  if (!led || !rq) return null;
  for (const r of led) (ledger[r.employee_id] ||= []).push({ ...r, delta: Number(r.delta) });
  for (const r of rq) (reqs[r.employee_id] ||= []).push(numRow(r));
  return { ledger, reqs };
}

// The person's balances as shown everywhere (getMyLeave, getTeamLeave, HR). cap = the D7 borrow cap for a leave in
// the current year.
function leaveBalances(emp, ledger, reqs, cutover, today) {
  const cm = monthOf(today), cy = yearOf(today), out = {};
  for (const t of LEDGER_TYPES) {
    const balance = ledgerBalance(ledger, t), pending = pendingDebit(reqs, t);
    out[t] = { balance, pending, available: halfRound(balance - pending),
      cap: borrowCap({ leaveType: t, leaveYear: cy, currentMonth: cm, employee: emp, cutoverMonth: cutover }) };
  }
  out.PERIOD = { used_this_month: periodUsed(reqs, cm) };
  out.OPTIONAL_HOLIDAY = { used_this_year: optionalUsed(reqs, cy) };
  return out;
}

// D6 / D7 for one request input: validate, count, check overlap + the monthly / yearly limit, and split.
// opts: { notice, settings, exceptId }. → { error } | { v, split, snapshot: {expected_balance, expected_pending} | null, balances }
async function leaveQuote(env, emp, d, { notice = true, settings, exceptId = null } = {}) {
  const today = istToday();
  const y = isIsoDay(d?.start_date) ? yearOf(d.start_date) : yearOf(today);
  const holidays = await loadHolidays(env, y, y);
  if (!holidays) return { error: 'db' };
  // The leave's year has no fixed holiday in Podium → its list was never added; refuse rather than count every weekday.
  if (isIsoDay(d?.start_date) && holidayListMissing(holidays)) return { error: 'no_holiday_list', message: noHolidayListMessage(y) };
  const vr = validateLeaveInput(d, { today, gender: emp.gender, holidays, notice });
  if (vr.error) return { error: vr.error };
  const v = vr.value;
  const ens = await ensureLeaveCurrent(env, [emp.id], { settings, emps: [emp] });
  if (!ens.ok) return { error: 'db' };
  const books = await leaveBooks(env, [emp.id], yearOf(today));
  if (!books) return { error: 'db' };
  const ledger = books.ledger[emp.id] || [], reqs = books.reqs[emp.id] || [];
  const balances = leaveBalances(emp, ledger, reqs, settings.cutover_month, today);
  if (overlaps(reqs, v.start_date, v.end_date, exceptId)) return { error: 'overlap', v, balances };
  const lim = limitBlock(v, reqs);
  if (lim) return { error: lim, v, balances };
  if (!LEDGER_TYPES.includes(v.leave_type)) {
    return { v, split: { available: null, from_balance: v.days, borrowed_days: 0, lop_days: 0 }, snapshot: null, balances };
  }
  const balance = ledgerBalance(ledger, v.leave_type), pending = pendingDebit(reqs, v.leave_type, exceptId);
  const split = leaveSplitFor({ emp, ledger, reqs, leaveType: v.leave_type, startDate: v.start_date, days: v.days, exceptId, cutover: settings.cutover_month, today });
  return { v, split, snapshot: { expected_balance: balance, expected_pending: pending }, balances };
}

// D7 split for one PL / SL request, the same at preview, apply, the approver's list and decide. → split + cap
function leaveSplitFor({ emp, ledger, reqs, leaveType, startDate, days, exceptId = null, cutover, today }) {
  const cm = monthOf(today), cy = yearOf(today), ly = yearOf(startDate);
  const capOf = (y) => borrowCap({ leaveType, leaveYear: y, currentMonth: cm, employee: emp, cutoverMonth: cutover });
  const cap = capOf(ly);
  const base = splitBase({ leaveType, ledger, leaveYear: ly, currentYear: cy, nextCap: ly === cy ? capOf(cy + 1) : 0 });
  return { ...splitLeave({ days, balance: base, pending: pendingDebit(reqs, leaveType, exceptId), cap }), cap };
}

// The approver's own manager (D9 cover) from the org edges.
const approverManagerOf = (edges, approverId) => (approverId ? edges.find(e => e.id === approverId)?.manager_id || null : null);

// Who the request is for: the caller, or (HR only) employee_id. → { emp, other } | { res }
async function leaveTarget(auth, me, employeeId) {
  const other = !!employeeId && employeeId !== me?.id;
  if (other && !isHr(auth)) return { res: leaveErr('forbidden') };
  const id = other ? employeeId : me?.id;
  if (!isUuid(id)) return { res: leaveErr(other ? 'not_found' : 'not_covered') };
  return { id, other };
}

// D12 — best effort, from the caller's own work mailbox. → 'sent' | 'failed' | 'skipped'
async function leaveMail(env, { kind, senderId, toId, personId, request }) {
  if (!isUuid(senderId) || !isUuid(toId) || senderId === toId) return 'skipped';
  try {
    const ids = [...new Set([senderId, toId, personId].filter(isUuid))];
    const er = await sb(`/rest/v1/employees?id=in.(${ids.join(',')})&select=id,full_name,preferred_name,work_email,status`, env);
    const by = Object.fromEntries(rowsOf(er).map(e => [e.id, e]));
    const mailOf = (e) => {
      const m = String(e?.work_email || '').trim().toLowerCase();
      return e && e.status !== 'exited' && m.endsWith(`@${WORK_DOMAIN}`) && addressOk(m) ? m : null;
    };
    const from = mailOf(by[senderId]), to = mailOf(by[toId]);
    if (!from || !to) return 'skipped';
    const mail = buildLeaveMail({ kind, from, fromName: by[senderId].full_name, to,
      toFirst: String(by[toId].preferred_name || '').trim() || firstName(by[toId].full_name),
      personName: by[personId]?.full_name || '', request, link: `${podiumAppUrl(env)}/leave/`,
      messageId: leaveMessageId(request.id, kind, crypto.randomUUID().slice(0, 8)) });
    if (mail.error) return 'failed';
    const g = await gmailSend(env, from, mail.raw);
    if (!g.ok) { console.error('[leave-mail]', kind, g.status, g.error); return 'failed'; }
    return 'sent';
  } catch (e) {
    console.error('[leave-mail]', kind, e?.message || e);
    return 'failed';
  }
}

async function leaveEvent(env, auth, me, row) {
  try {
    await sb(`/rest/v1/leave_events`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{
      employee_id: null, request_id: null, detail: null, ...row, actor_user_id: auth.userId, actor_employee_id: me?.id || null }]) });
  } catch (_e) { /* best-effort: the write already landed */ }
}

// D15 — getMe flags. access = covered OR ≥1 active direct report OR HR; pending = the pending requests the caller may
// decide (approver, approver's manager, or HR — never their own). Reads go through rowsOf: before 0016 is applied both
// read as nothing, so getMe never 500s on them.
async function leaveNavState(auth, me, edges, env) {
  const hr = isHr(auth);
  if (!me && !hr) return { access: false, pending: 0 };
  const reports = me ? edges.filter(e => e.manager_id === me.id).map(e => e.id) : [];
  const [cov, hasReports, pr] = await Promise.all([
    me ? sb(`/rest/v1/employees?id=eq.${me.id}&select=leave_policy,status&limit=1`, env) : Promise.resolve(null),
    hasActiveReports(me, env),
    hr ? sb(`/rest/v1/leave_requests?status=eq.pending&select=id,employee_id,approver_employee_id&limit=${LEAVE_PAGE}`, env)
      : sb(`/rest/v1/leave_requests?status=eq.pending&approver_employee_id=in.(${[me.id, ...reports].join(',')})&select=id,employee_id,approver_employee_id&limit=${LEAVE_PAGE}`, env),
  ]);
  const covered = leaveCovered(rowsOf(cov)[0]);
  const pending = rowsOf(pr).filter(r => !decideBlock({ req: r, meId: me?.id || null, hr, approverManagerId: approverManagerOf(edges, r.approver_employee_id) })).length;
  return { access: covered || hasReports || hr, pending };
}

// ── The person ───────────────────────────────────────────────────────────────

// GET getMyLeave — balances, my requests (this year + future, and any still pending), holidays this + next year.
async function getMyLeave(url, auth, env) {
  const edges = await loadOrgEdgesStrict(env);
  if (!edges) return err('db_error: org read', 500);   // fail closed: [] would read as "not me" (Codex S453)
  const me = callerEmployee(edges, auth.userId);
  if (!me) return leaveErr('not_covered');
  const [settings, emps] = await Promise.all([loadLeaveSettings(env), loadLeaveEmployees(env, [me.id])]);
  const emp = emps[0];
  if (!settings) return err('db_error: leave settings', 500);
  if (!leaveCovered(emp)) return leaveErr('not_covered');
  const ens = await ensureLeaveCurrent(env, [emp.id], { settings, emps: [emp] });
  if (!ens.ok) return err(`db_error: leave ${ens.error}`, 500);
  const today = istToday(), cy = yearOf(today);
  const [books, holidays, founders] = await Promise.all([
    leaveBooks(env, [emp.id], cy), loadHolidays(env, cy, cy + 1), emp.manager_id ? Promise.resolve([]) : loadFounders(env),
  ]);
  if (!books || !holidays) return err('db_error: leave read', 500);
  const reqs = books.reqs[emp.id] || [];
  const approverId = resolveLeaveApprover(emp, founders);
  const wfhId = wfhApprover(emp);   // E4: the manager → HR
  const names = await empNames(env, [approverId, wfhId, ...reqs.map(r => r.decided_by_employee_id)]);
  return ok({
    employee: { id: emp.id, full_name: emp.full_name, employee_code: emp.employee_code, leave_policy: emp.leave_policy },
    today, cutover_month: settings.cutover_month,
    balances: leaveBalances(emp, books.ledger[emp.id] || [], reqs, settings.cutover_month, today),
    requests: [...reqs].sort((a, b) => (a.start_date < b.start_date ? 1 : a.start_date > b.start_date ? -1 : 0))
      .map(r => ({ ...r, decided_by_name: names[r.decided_by_employee_id] || null })),
    holidays,
    can_period: emp.gender === 'f',
    approver: approverId ? { id: approverId, full_name: names[approverId] || null } : null,
    wfh_approver: wfhId ? { id: wfhId, full_name: names[wfhId] || null } : null,
    type_labels: TYPE_LABELS,
  });
}

// POST previewLeave {leave_type, start_date, end_date, start_half, end_half, employee_id?} — no request is written.
// → { days, split, refusal, refusal_message, balances } (a refusal is data, so the live preview can show it).
async function previewLeave(body, auth, env) {
  const d = body.data || body;
  const edges = await loadOrgEdgesStrict(env);
  if (!edges) return err('db_error: org read', 500);   // fail closed: [] would read as "not me" (Codex S453)
  const me = callerEmployee(edges, auth.userId);
  const t = await leaveTarget(auth, me, d.employee_id);
  if (t.res) return t.res;
  const [settings, emps] = await Promise.all([loadLeaveSettings(env), loadLeaveEmployees(env, [t.id])]);
  if (!settings) return err('db_error: leave settings', 500);
  const emp = emps[0];
  if (!leaveCovered(emp)) return leaveErr('not_covered');
  const q = await leaveQuote(env, emp, d, { notice: !t.other, settings });
  if (q.error === 'db') return err('db_error: leave read', 500);
  return ok({ employee_id: emp.id, days: q.v?.days ?? null, start_half: q.v?.start_half ?? null, end_half: q.v?.end_half ?? null,
    split: q.split || null, refusal: q.error || null, refusal_message: q.error ? (q.message || LEAVE_COPY[q.error] || q.error) : null,
    balances: q.balances || null });
}

// POST applyLeave {…previewLeave, reason} — self, or HR for someone else (no notice rule then; it still needs the
// approver). RPC podium.leave_apply under the per-employee lock; mail the approver. → { request, email }
async function applyLeave(body, auth, env) {
  const d = body.data || body;
  const edges = await loadOrgEdgesStrict(env);
  if (!edges) return err('db_error: org read', 500);   // fail closed: [] would read as "not me" (Codex S453)
  const me = callerEmployee(edges, auth.userId);
  const t = await leaveTarget(auth, me, d.employee_id);
  if (t.res) return t.res;
  const [settings, emps] = await Promise.all([loadLeaveSettings(env), loadLeaveEmployees(env, [t.id])]);
  if (!settings) return err('db_error: leave settings', 500);
  const emp = emps[0];
  if (!leaveCovered(emp)) return leaveErr('not_covered');
  const q = await leaveQuote(env, emp, d, { notice: !t.other, settings });
  if (q.error === 'db') return err('db_error: leave read', 500);
  if (q.error) return leaveErr(q.error, q.message ? { message: q.message } : null);
  // E4: WFH goes to the manager (the skip-level may also decide, D9), else HR; leave as D9.
  const approverId = q.v.leave_type === 'WFH' ? wfhApprover(emp)
    : resolveLeaveApprover(emp, emp.manager_id ? [] : await loadFounders(env));
  const r = await hiringRpc(env, 'leave_apply', {
    employee_id: emp.id, ...q.v, borrowed_days: q.split.borrowed_days, lop_days: q.split.lop_days,
    approver_employee_id: approverId, ...(q.snapshot || {}), actor_user_id: auth.userId, actor_employee_id: me?.id || null,
  });
  const code = leaveDbErrorCode(r);
  if (code) return leaveErr(code);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  const request = numRow(r.data);
  const email = approverId ? await leaveMail(env, { kind: 'submitted', senderId: me?.id, toId: approverId, personId: emp.id, request }) : 'skipped';
  return ok({ request, email });
}

// ── The chain ────────────────────────────────────────────────────────────────

// GET getTeamLeave?from&to — pending requests the caller may decide (with the split as of now + balances), the team's
// pending / approved requests in [from, to] (the "who's out" calendar) and the team's balances. Team = descendantsOf
// the caller (HR: every covered person). Types and reasons are shown: this is the chain's own view (D11).
async function getTeamLeave(url, auth, env) {
  const edges = await loadOrgEdgesStrict(env);
  if (!edges) return err('db_error: org read', 500);   // fail closed: [] would read as "not me" (Codex S453)
  const me = callerEmployee(edges, auth.userId);
  const hr = isHr(auth);
  if (!me && !hr) return leaveErr('forbidden');
  const today = istToday(), cy = yearOf(today);
  const from = url.searchParams.get('from') || today, to = url.searchParams.get('to') || from;
  if (!isIsoDay(from) || !isIsoDay(to) || to < from || yearOf(to) - yearOf(from) > 1) return leaveErr('bad_dates');
  const settings = await loadLeaveSettings(env);
  if (!settings) return err('db_error: leave settings', 500);
  let team;
  if (hr) {
    const r = await sb(`/rest/v1/employees?leave_policy=not.is.null&status=neq.exited&select=${LEAVE_EMP_SELECT}&order=full_name.asc&limit=${LEAVE_PAGE}`, env);
    if (!r.ok) return err('db_error: leave team', 500);
    team = (await applyOpenExits(env, r.data || [])).filter(e => e.id !== me?.id);
  } else {
    team = (await loadLeaveEmployees(env, [...descendantsOf(edges, me.id)])).filter(leaveCovered);
  }
  const reports = me ? edges.filter(e => e.manager_id === me.id).map(e => e.id) : [];
  const pr = hr
    ? await sb(`/rest/v1/leave_requests?status=eq.pending&select=${LEAVE_REQ_SELECT}&order=start_date.asc&limit=${LEAVE_PAGE}`, env)
    : await sb(`/rest/v1/leave_requests?status=eq.pending&approver_employee_id=in.(${[me.id, ...reports].join(',')})&select=${LEAVE_REQ_SELECT}&order=start_date.asc&limit=${LEAVE_PAGE}`, env);
  if (!pr.ok) return err('db_error: leave pending', 500);
  const toDecide = (pr.data || []).map(numRow)
    .filter(r => !decideBlock({ req: r, meId: me?.id || null, hr, approverManagerId: approverManagerOf(edges, r.approver_employee_id) }));
  const byId = Object.fromEntries(team.map(e => [e.id, e]));
  const extra = toDecide.map(r => r.employee_id).filter(id => !byId[id]);
  for (const e of await loadLeaveEmployees(env, extra)) byId[e.id] = e;
  const people = Object.values(byId);
  const ens = await ensureLeaveCurrent(env, people.map(e => e.id), { settings, emps: people });
  if (!ens.ok) return err(`db_error: leave ${ens.error}`, 500);
  const [books, inRange] = await Promise.all([
    leaveBooks(env, people.map(e => e.id), cy),
    team.length ? sbPaged(env, `/rest/v1/leave_requests?employee_id=in.(${team.map(e => e.id).join(',')})&status=in.(pending,approved)`
      + `&start_date=lte.${to}&end_date=gte.${from}&select=${LEAVE_REQ_SELECT}&order=start_date.asc,id.asc`) : Promise.resolve([]),
  ]);
  if (!books || !inRange) return err('db_error: leave read', 500);
  const canCancel = (r) => !cancelBlock({ mode: 'cancel', req: r, meId: me?.id || null, hr, approverManagerId: approverManagerOf(edges, r.approver_employee_id), today });
  const person = (id) => { const e = byId[id]; return e ? { id: e.id, full_name: e.full_name, employee_code: e.employee_code, job_title: e.job_title } : { id }; };
  const balOf = (id) => (byId[id] ? leaveBalances(byId[id], books.ledger[id] || [], books.reqs[id] || [], settings.cutover_month, today) : null);
  return ok({
    from, to, today,
    to_decide: toDecide.map(r => {
      const e = byId[r.employee_id];
      let split = null;
      if (e && LEDGER_TYPES.includes(r.leave_type)) {
        split = leaveSplitFor({ emp: e, ledger: books.ledger[e.id] || [], reqs: books.reqs[e.id] || [], leaveType: r.leave_type,
          startDate: r.start_date, days: r.days, exceptId: r.id, cutover: settings.cutover_month, today });
      } else split = { available: null, from_balance: r.days, borrowed_days: 0, lop_days: 0 };
      return { ...r, employee: person(r.employee_id), split, split_changed: !sameSplit(split, r), balances: balOf(r.employee_id), can_cancel: canCancel(r) };
    }),
    // can_cancel = the cancelLeave rule (cancelBlock 'cancel'): the app shows Cancel only when it is true.
    requests: inRange.map(r => { const n = numRow(r); return { ...n, employee: person(r.employee_id), can_cancel: canCancel(n) }; }),
    people: team.map(e => ({ ...person(e.id), balances: balOf(e.id) })),
    type_labels: TYPE_LABELS,
  });
}

async function loadLeaveRequest(env, id) {
  if (!isUuid(id)) return null;
  const r = await sb(`/rest/v1/leave_requests?id=eq.${id}&select=${LEAVE_REQ_SELECT}&limit=1`, env);
  return r.data?.[0] ? numRow(r.data[0]) : null;
}

// POST decideLeave {id, decision: approve|reject, note, expected_split: {borrowed_days, lop_days}} (D9). Approve
// recomputes the split; a different one than the approver saw → 409 balance_changed with the current split. Reject
// needs a note. RPC podium.leave_decide; mail the person. → { request, email }
async function decideLeave(body, auth, env) {
  const d = body.data || body;
  const req = await loadLeaveRequest(env, d.id);
  if (!req) return leaveErr('not_found');
  const edges = await loadOrgEdgesStrict(env);
  if (!edges) return err('db_error: org read', 500);   // fail closed: [] would read as "not me" (Codex S453)
  const me = callerEmployee(edges, auth.userId);
  const block = decideBlock({ req, meId: me?.id || null, hr: isHr(auth), approverManagerId: approverManagerOf(edges, req.approver_employee_id) });
  if (block) return leaveErr(block);
  if (!['approve', 'reject'].includes(d.decision)) return leaveErr('bad_decision');
  if (req.status !== 'pending') return leaveErr('not_pending');
  const note = cleanNote(d.note, { required: d.decision === 'reject' });
  if (note.error) return leaveErr(note.error);
  const p = { request_id: req.id, decision: d.decision, note: note.value, actor_user_id: auth.userId, actor_employee_id: me?.id || null };
  if (d.decision === 'approve' && LEDGER_TYPES.includes(req.leave_type)) {
    const [settings, emps] = await Promise.all([loadLeaveSettings(env), loadLeaveEmployees(env, [req.employee_id])]);
    if (!settings || !emps[0]) return err('db_error: leave read', 500);
    const ens = await ensureLeaveCurrent(env, [req.employee_id], { settings, emps });
    if (!ens.ok) return err(`db_error: leave ${ens.error}`, 500);
    const today = istToday();
    const books = await leaveBooks(env, [req.employee_id], yearOf(today));
    if (!books) return err('db_error: leave read', 500);
    const ledger = books.ledger[req.employee_id] || [], reqs = books.reqs[req.employee_id] || [];
    const balance = ledgerBalance(ledger, req.leave_type), pending = pendingDebit(reqs, req.leave_type, req.id);
    const split = leaveSplitFor({ emp: emps[0], ledger, reqs, leaveType: req.leave_type, startDate: req.start_date, days: req.days,
      exceptId: req.id, cutover: settings.cutover_month, today });
    if (!sameSplit(split, d.expected_split)) return leaveErr('balance_changed', { split });
    Object.assign(p, { borrowed_days: split.borrowed_days, lop_days: split.lop_days, expected_balance: balance, expected_pending: pending });
  }
  const r = await hiringRpc(env, 'leave_decide', p);
  const code = leaveDbErrorCode(r);
  if (code) return leaveErr(code);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  const request = numRow(r.data);
  const email = await leaveMail(env, { kind: d.decision === 'approve' ? 'approved' : 'rejected', senderId: me?.id, toId: request.employee_id, personId: request.employee_id, request });
  return ok({ request, email });
}

// D10 — withdraw (pending: the person / HR) and cancel (approved: the person before it starts; the approver, their
// manager or HR otherwise). RPC podium.leave_cancel (cancel writes the +ledger row). Mail the person when someone
// else did it. → { request, email }
async function leaveCancelAction(body, auth, env, mode) {
  const d = body.data || body;
  const req = await loadLeaveRequest(env, d.id);
  if (!req) return leaveErr('not_found');
  const edges = await loadOrgEdgesStrict(env);
  if (!edges) return err('db_error: org read', 500);   // fail closed: [] would read as "not me" (Codex S453)
  const me = callerEmployee(edges, auth.userId);
  const block = cancelBlock({ mode, req, meId: me?.id || null, hr: isHr(auth), approverManagerId: approverManagerOf(edges, req.approver_employee_id), today: istToday() });
  if (block) return leaveErr(block);
  const note = cleanNote(d.note);
  if (note.error) return leaveErr(note.error);
  const r = await hiringRpc(env, 'leave_cancel', { request_id: req.id, mode, note: note.value, actor_user_id: auth.userId, actor_employee_id: me?.id || null });
  const code = leaveDbErrorCode(r);
  if (code) return leaveErr(code);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  const request = numRow(r.data);
  const email = await leaveMail(env, { kind: mode === 'withdraw' ? 'withdrawn' : 'cancelled', senderId: me?.id, toId: request.employee_id, personId: request.employee_id, request });
  return ok({ request, email });
}
async function withdrawLeave(body, auth, env) { return leaveCancelAction(body, auth, env, 'withdraw'); }
async function cancelLeave(body, auth, env) { return leaveCancelAction(body, auth, env, 'cancel'); }

// GET getLeaveLedger?employee_id — self / chain (descendantsOf) / HR; rows newest first + balances.
async function getLeaveLedger(url, auth, env) {
  const edges = await loadOrgEdgesStrict(env);
  if (!edges) return err('db_error: org read', 500);   // fail closed: [] would read as "not me" (Codex S453)
  const me = callerEmployee(edges, auth.userId);
  const id = url.searchParams.get('employee_id') || me?.id;
  if (!isUuid(id)) return leaveErr('not_found');
  if (!(isHr(auth) || id === me?.id || (me && descendantsOf(edges, me.id).has(id)))) return leaveErr('forbidden');
  const [settings, emps] = await Promise.all([loadLeaveSettings(env), loadLeaveEmployees(env, [id])]);
  if (!settings) return err('db_error: leave settings', 500);
  const emp = emps[0];
  if (!emp) return leaveErr('not_found');
  const ens = await ensureLeaveCurrent(env, [id], { settings, emps });
  if (!ens.ok) return err(`db_error: leave ${ens.error}`, 500);
  const today = istToday();
  const books = await leaveBooks(env, [id], yearOf(today));
  if (!books) return err('db_error: leave read', 500);
  const rows = [...(books.ledger[id] || [])].sort((a, b) => (a.effective_date !== b.effective_date
    ? (a.effective_date < b.effective_date ? 1 : -1) : (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)));
  return ok({ employee: { id: emp.id, full_name: emp.full_name, employee_code: emp.employee_code, leave_policy: emp.leave_policy },
    rows, balances: leaveCovered(emp) ? leaveBalances(emp, books.ledger[id] || [], books.reqs[id] || [], settings.cutover_month, today) : null });
}

// ── HR (D13 / D14) ───────────────────────────────────────────────────────────

// GET getLeaveAdmin — settings, holidays (all), covered people with balances + whether each opening is set, and the
// non-exited people who are NOT covered (HR flips them on EmployeeForm).
async function getLeaveAdmin(url, auth, env) {
  if (!isHr(auth)) return leaveErr('forbidden');
  const [settings, hr, er] = await Promise.all([
    loadLeaveSettings(env),
    sb(`/rest/v1/holidays?select=date,name,kind,updated_at&order=date.asc&limit=2000`, env),
    sb(`/rest/v1/employees?status=neq.exited&select=${LEAVE_EMP_SELECT}&order=full_name.asc&limit=${LEAVE_PAGE}`, env),
  ]);
  if (!settings || !hr.ok || !er.ok) return err('db_error: leave admin', 500);
  const covered = await applyOpenExits(env, (er.data || []).filter(leaveCovered));
  const ens = await ensureLeaveCurrent(env, covered.map(e => e.id), { settings, emps: covered });
  if (!ens.ok) return err(`db_error: leave ${ens.error}`, 500);
  const today = istToday();
  const books = await leaveBooks(env, covered.map(e => e.id), yearOf(today));
  if (!books) return err('db_error: leave read', 500);
  const ye = yearEndYear(today);   // E5: shown 1 Nov – 31 Jan
  return ok({
    settings, today, holidays: hr.data || [], year_end_year: ye,
    people: covered.map(e => {
      const ledger = books.ledger[e.id] || [];
      return { id: e.id, employee_code: e.employee_code, full_name: e.full_name, job_title: e.job_title, date_joined: e.date_joined,
        leave_policy: e.leave_policy, gender: e.gender,
        opening_set: Object.fromEntries(LEDGER_TYPES.map(t => [t, ledger.some(r => r.kind === 'opening' && r.leave_type === t)])),
        balances: leaveBalances(e, ledger, books.reqs[e.id] || [], settings.cutover_month, today),
        year_end: ye == null ? null : yearEndPreview({ employee: e, ledger, requests: books.reqs[e.id] || [], cutoverMonth: settings.cutover_month, today, year: ye }) };
    }),
    not_covered: (er.data || []).filter(e => !e.leave_policy).map(e => ({ id: e.id, employee_code: e.employee_code, full_name: e.full_name })),
  });
}

// POST setLeaveSettings {cutover_month} — the cutover may move later only while no accrual row predates it.
async function setLeaveSettings(body, auth, env) {
  if (!isHr(auth)) return leaveErr('forbidden');
  const d = body.data || body;
  if (!isMonth(d.cutover_month)) return leaveErr('bad_month');
  const [cur, first] = await Promise.all([
    loadLeaveSettings(env),
    sb(`/rest/v1/leave_ledger?kind=eq.accrual&select=period&order=period.asc&limit=1`, env),
  ]);
  if (!cur || !first.ok) return err('db_error: leave settings', 500);
  const earliest = first.data?.[0]?.period || null;
  if (earliest && d.cutover_month > earliest) return leaveErr('cutover_locked');
  const r = await sb(`/rest/v1/leave_settings?id=eq.1`, env, { method: 'PATCH',
    body: JSON.stringify({ cutover_month: d.cutover_month, updated_by: auth.userId }) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  await leaveEvent(env, auth, await meOf(auth, env), { event_type: 'settings_changed', detail: { cutover_month: { from: cur.cutover_month, to: d.cutover_month } } });
  return ok({ cutover_month: d.cutover_month });
}

// Pending / approved requests whose range includes the date (D13: a holiday change does not recount them — R1).
async function requestsOnDate(env, date) {
  const r = await sb(`/rest/v1/leave_requests?status=in.(pending,approved)&start_date=lte.${date}&end_date=gte.${date}&select=id&limit=${LEAVE_PAGE}`, env);
  return rowsOf(r).length;
}

// POST saveHoliday {date, name, kind} — add a FUTURE date, or rename an existing one (its kind changes only while
// it is in the future). → { holiday, affected_requests }
async function saveHoliday(body, auth, env) {
  if (!isHr(auth)) return leaveErr('forbidden');
  const h = cleanHoliday(body.data || body);
  if (h.error) return leaveErr(h.error);
  const ex = await sb(`/rest/v1/holidays?date=eq.${h.value.date}&select=date,name,kind&limit=1`, env);
  if (!ex.ok) return err('db_error: holiday read', 500);
  const old = ex.data?.[0] || null;
  const future = h.value.date > istToday();
  if ((!old || old.kind !== h.value.kind) && !future) return leaveErr('holiday_past');
  const r = old
    ? await sb(`/rest/v1/holidays?date=eq.${h.value.date}`, env, { method: 'PATCH', body: JSON.stringify({ name: h.value.name, kind: h.value.kind }) })
    : await sb(`/rest/v1/holidays`, env, { method: 'POST', body: JSON.stringify([{ ...h.value, created_by: auth.userId }]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  await leaveEvent(env, auth, await meOf(auth, env), { event_type: 'holiday_saved', detail: { date: h.value.date, kind: h.value.kind, from: old } });
  return ok({ holiday: r.data?.[0] || h.value, affected_requests: await requestsOnDate(env, h.value.date) });
}

// POST deleteHoliday {date} — future dates only. → { date, affected_requests }
async function deleteHoliday(body, auth, env) {
  if (!isHr(auth)) return leaveErr('forbidden');
  const d = body.data || body;
  if (!isIsoDay(d.date)) return leaveErr('bad_holiday');
  if (d.date <= istToday()) return leaveErr('holiday_past');
  const r = await sb(`/rest/v1/holidays?date=eq.${d.date}`, env, { method: 'DELETE' });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  if (!r.data?.length) return leaveErr('not_found');
  await leaveEvent(env, auth, await meOf(auth, env), { event_type: 'holiday_deleted', detail: { date: d.date, name: r.data[0].name, kind: r.data[0].kind } });
  return ok({ date: d.date, affected_requests: await requestsOnDate(env, d.date) });
}

// HR ledger writes share the target checks: a covered person, PL / SL, an effective date (default today, IST).
async function hrLedgerTarget(auth, env, d) {
  if (!isHr(auth)) return { res: leaveErr('forbidden') };
  if (!isUuid(d.employee_id)) return { res: leaveErr('not_found') };
  if (!LEDGER_TYPES.includes(d.leave_type)) return { res: leaveErr('bad_type') };
  const eff = d.effective_date || istToday();
  if (!isIsoDay(eff)) return { res: leaveErr('bad_dates') };
  const emp = (await loadLeaveEmployees(env, [d.employee_id]))[0];
  if (!emp) return { res: leaveErr('not_found') };
  if (!leaveCovered(emp)) return { res: leaveErr('not_covered') };
  return { emp, eff };
}

// POST setOpeningBalance {employee_id, leave_type, days, note?, effective_date?} — once per person × type (L5); a
// second entry → 409 opening_exists (use adjustLeave). 0 is allowed (records "opening set").
async function setOpeningBalance(body, auth, env) {
  const d = body.data || body;
  const t = await hrLedgerTarget(auth, env, d);
  if (t.res) return t.res;
  const amt = cleanAmount(d.days, { allowZero: true });
  if (amt.error) return leaveErr(amt.error);
  const note = cleanNote(d.note);
  if (note.error) return leaveErr(note.error);
  const r = await sb(`/rest/v1/leave_ledger`, env, { method: 'POST', body: JSON.stringify([{ employee_id: t.emp.id, leave_type: d.leave_type,
    delta: amt.value, kind: 'opening', effective_date: t.eff, note: note.value, created_by: auth.userId }]) });
  if (!r.ok) {
    if (r.data?.code === '23505' || r.status === 409) return leaveErr('opening_exists');
    return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  }
  await leaveEvent(env, auth, await meOf(auth, env), { employee_id: t.emp.id, event_type: 'opening_set', detail: { leave_type: d.leave_type, days: amt.value } });
  return ok({ row: r.data?.[0] || null });
}

// POST adjustLeave {employee_id, leave_type, delta, note, effective_date?} — ± in 0.5 steps, a note required.
async function adjustLeave(body, auth, env) {
  const d = body.data || body;
  const t = await hrLedgerTarget(auth, env, d);
  if (t.res) return t.res;
  const amt = cleanAmount(d.delta);
  if (amt.error) return leaveErr(amt.error);
  const note = cleanNote(d.note, { required: true });
  if (note.error) return leaveErr(note.error);
  const r = await sb(`/rest/v1/leave_ledger`, env, { method: 'POST', body: JSON.stringify([{ employee_id: t.emp.id, leave_type: d.leave_type,
    delta: amt.value, kind: 'adjustment', effective_date: t.eff, note: note.value, created_by: auth.userId }]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  await leaveEvent(env, auth, await meOf(auth, env), { employee_id: t.emp.id, event_type: 'adjusted', detail: { leave_type: d.leave_type, delta: amt.value } });
  return ok({ row: r.data?.[0] || null });
}
// ── end Leave R1

// ────────────────────────────────────────────────────────────────────────────
// Leave R2 — LOP report (E1), exit leave fill (E2), maternity / paternity grants (E3), WFH (E4, inside applyLeave /
// getMyLeave above), year-end preview (E5, inside getLeaveAdmin above).
// Plan: docs/superpowers/plans/2026-11-13-podium-leave-r2.md · pure rules in src/leave.js · migration 0020.
// RazorpayX has no leave / LOP write (reference/integrations.md), so payroll gets a report + CSV HR enters by hand.
// ────────────────────────────────────────────────────────────────────────────

const monthLastDay = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);

// E1 — the month's unpaid days (approved PL / SL lop_days, placed on the request's last working halves) + the pending
// PL / SL requests touching the month (they may still add LOP). → { rows, pending } | null
async function lopReportData(env, month) {
  const from = `${month}-01`, to = monthLastDay(month), y = Number(month.slice(0, 4));
  const touch = `leave_type=in.(${LEDGER_TYPES.join(',')})&start_date=lte.${to}&end_date=gte.${from}&select=${LEAVE_REQ_SELECT}&order=id.asc`;
  const [ar, pr, hol] = await Promise.all([
    sbPaged(env, `/rest/v1/leave_requests?status=eq.approved&lop_days=gt.0&${touch}`),
    sbPaged(env, `/rest/v1/leave_requests?status=eq.pending&${touch}`),
    loadHolidays(env, y, y),   // PL / SL never cross 31 Dec, so the month's year is the request's year
  ]);
  if (!ar || !pr || !hol) return null;
  const ids = [...new Set([...ar, ...pr].map(r => r.employee_id))].filter(isUuid);
  // Strict (review G): any failed chunk → null (500), never a row with null codes in a report or an export.
  const employees = {};
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const er = await sb(`/rest/v1/employees?id=in.(${ids.slice(i, i + IN_CHUNK).join(',')})&select=id,employee_code,full_name,razorpayx_employee_id`, env);
    if (!er.ok || !Array.isArray(er.data)) return null;
    for (const e of er.data) employees[e.id] = e;
  }
  if (ids.some(id => !employees[id])) return null;
  const { rows, warnings } = lopReport({ month, requests: ar.map(numRow), employees,
    fixedHolidays: new Set(hol.filter(h => h.kind === 'fixed').map(h => h.date)) });
  const pend = {};
  for (const r of pr) {
    const e = employees[r.employee_id] || {};
    (pend[r.employee_id] ||= { employee_id: r.employee_id, employee_code: e.employee_code || null, full_name: e.full_name || null, requests: 0 }).requests++;
  }
  const exportRows = lopExportRows(rows);
  // report_hash (review D) binds "Mark exported" to what HR downloaded: the rows (as stored) + the warnings (they
  // shape the CSV's check column).
  const report_hash = await sha256Hex(new TextEncoder().encode(canonicalJson({ rows: exportRows, warnings })));
  return { rows, exportRows, warnings, report_hash,
    pending: Object.values(pend).sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || ''))) };
}

// GET getLeaveLopReport?month=YYYY-MM (HR; default this IST month) — rows, the pending warning, the last export and
// what changed since it (per person: was X, now Y — HR carries it into next month's payroll).
async function getLeaveLopReport(url, auth, env) {
  if (!isHr(auth)) return leaveErr('forbidden');
  const month = url.searchParams.get('month') || monthOf(istToday());
  if (!isMonth(month)) return leaveErr('bad_month');
  const [data, xr] = await Promise.all([
    lopReportData(env, month),
    sb(`/rest/v1/leave_lop_exports?month=eq.${month}&select=id,rows,exported_by_employee_id,exported_at&order=exported_at.desc&limit=1`, env),
  ]);
  if (!data || !xr.ok) return err('db_error: leave lop report', 500);
  const last = xr.data?.[0] || null;
  const names = last?.exported_by_employee_id ? await empNames(env, [last.exported_by_employee_id]) : {};
  return ok({
    month, today: istToday(), rows: data.rows, warnings: data.warnings, report_hash: data.report_hash, pending: data.pending,
    total_lop_days: halfRound(data.rows.reduce((s, r) => s + Number(r.lop_days), 0)),
    last_export: last ? { id: last.id, exported_at: last.exported_at, exported_by_name: names[last.exported_by_employee_id] || null,
      people: Array.isArray(last.rows) ? last.rows.length : 0 } : null,
    changes_since_export: last ? lopDiff(Array.isArray(last.rows) ? last.rows : [], data.rows) : [],
  });
}

// POST markLopExported {month, report_hash} (HR) — recomputes the report; a hash other than the one HR loaded (and
// downloaded) → 409 report_changed. Stores exactly the recomputed rows in podium.leave_lop_exports (a new row each time).
async function markLopExported(body, auth, env) {
  if (!isHr(auth)) return leaveErr('forbidden');
  const d = body.data || body;
  if (!isMonth(d.month)) return leaveErr('bad_month');
  const data = await lopReportData(env, d.month);
  if (!data) return err('db_error: leave lop report', 500);
  if (typeof d.report_hash !== 'string' || d.report_hash !== data.report_hash) return leaveErr('report_changed');
  const me = await meOf(auth, env);
  const rows = data.exportRows;
  const r = await sb(`/rest/v1/leave_lop_exports`, env, { method: 'POST', body: JSON.stringify([{ month: d.month, rows,
    exported_by: auth.userId, exported_by_employee_id: me?.id || null }]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  await leaveEvent(env, auth, me, { event_type: 'lop_exported', detail: { month: d.month, people: rows.length,
    lop_days: halfRound(rows.reduce((s, x) => s + Number(x.lop_days), 0)), pending: data.pending.length } });
  return ok({ export: { id: r.data?.[0]?.id || null, month: d.month, exported_at: r.data?.[0]?.exported_at || null, people: rows.length } });
}

// POST grantLeave {employee_id, leave_type: MATERNITY|PATERNITY, start_date, end_date?, note} (HR, never for yourself;
// end_date ≤ the full length — returning early = cancel + grant again with the actual end) — the
// request is written APPROVED by RPC podium.leave_grant (lock, covered, gender, overlap). Mail the person. → { request, email }
async function grantLeave(body, auth, env) {
  if (!isHr(auth)) return leaveErr('forbidden');
  const d = body.data || body;
  const edges = await loadOrgEdgesStrict(env);
  if (!edges) return err('db_error: org read', 500);
  const me = callerEmployee(edges, auth.userId);
  if (!isUuid(d.employee_id)) return leaveErr('not_found');
  if (me && me.id === d.employee_id) return leaveErr('no_self_approval');
  const emp = (await loadLeaveEmployees(env, [d.employee_id]))[0];
  if (!emp) return leaveErr('not_found');
  if (!leaveCovered(emp)) return leaveErr('not_covered');
  const g = grantPlan(d, { gender: emp.gender, today: istToday() });   // calendar days: no holiday list needed
  if (g.error) return leaveErr(g.error);
  const r = await hiringRpc(env, 'leave_grant', { employee_id: emp.id, ...g.value, actor_user_id: auth.userId, actor_employee_id: me?.id || null });
  const code = leaveDbErrorCode(r);
  if (code) return leaveErr(code);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  const request = numRow(r.data);
  const email = await leaveMail(env, { kind: 'granted', senderId: me?.id, toId: emp.id, personId: emp.id, request });
  return ok({ request, email });
}

// E2 — the exit's leave line: PL / SL at the LWD (exitLeaveFigures, after the lazy accrual) + the Done guard
// (exitLeaveBlock) + the requests behind it. Not covered → no figures, the line ticks by hand.
// → { ok, covered, figures, block, requests }
async function exitLeaveLive(env, employeeId, lwd) {
  try { return await exitLeaveLiveInner(env, employeeId, lwd); }
  catch (e) { console.error('[exit-leave]', e?.message || e); return { ok: false }; }   // fail closed (re-verify I')
}
async function exitLeaveLiveInner(env, employeeId, lwd) {
  if (!isUuid(employeeId) || !isIsoDay(lwd)) return { ok: false };
  const [settings, emps, rq] = await Promise.all([
    loadLeaveSettings(env), loadLeaveEmployees(env, [employeeId]),
    sb(`/rest/v1/leave_requests?employee_id=eq.${employeeId}&status=in.(pending,approved)&or=(status.eq.pending,end_date.gt.${lwd})`
      + `&select=id,leave_type,start_date,end_date,start_half,end_half,days,status&order=start_date.asc&limit=200`, env),
  ]);
  const emp = emps[0];
  if (!settings || !emp || !rq.ok || !Array.isArray(rq.data)) return { ok: false };
  const requests = rq.data.map(r => ({ ...r, days: Number(r.days) }));
  const block = exitLeaveBlock(requests, lwd);
  if (!emp.leave_policy) return { ok: true, covered: false, figures: null, block, requests };
  const ens = await ensureLeaveCurrent(env, [emp.id], { settings, emps: [emp] });
  if (!ens.ok) return { ok: false };
  const led = await sbPaged(env, `/rest/v1/leave_ledger?employee_id=eq.${emp.id}&select=leave_type,delta,kind,period,effective_date&order=id.asc`);
  if (!led) return { ok: false };
  const figures = exitLeaveFigures({ employee: emp, ledger: led, cutoverMonth: settings.cutover_month, lwd, today: istToday() });
  return { ok: !!figures, covered: true, figures, block, requests };
}
// ── end Leave R2

const GET_ACTIONS = {
  getMe, getSettings,
  getEmployees, getEmployee,
  getOrgChart, getOrgSnapshots,
  getDepartments,
  getJobRoles, getJobRole,
  getCompensation, getMyCompensation,
  getPayouts, getMyPayouts, getPayoutPeriodSheet, getBulkPayouts,
  getRazorpayxPayrollScan,
  getDocuments, getDocumentDownloadUrl,
  // Phase 2 — performance capture
  getObservations, getAccomplishments, getOneOnOnes,
  getMyPerformance, getTeamActivity,
  // Permission layer (Podium-managed)
  getPodiumRoles, getPodiumUsers,
  // Salary-access allow-list (super_admin)
  getCompAccess, getCompAccessLog,
  // Google Directory sync
  getDirectorySyncPreview,
  // J1b — Podium → Google field sync (status: HR or Google admin; diff + OU options: HR)
  getGoogleSyncStatus, getGoogleDiff, getOrgUnitOptions,
  getGoogleWriteCheck,
  getCalendarCheck,
  // Appraisal engine
  getAppraisalConfig, getMyAppraisals, getAppraisal, getTeamAppraisals,
  getAppraisals, getCycleOverview, getAppraisalCycles, getAppraisalCycle, getEnrollmentPreview,
  // Factory cost module (compensation-tier)
  getFactoryWorkforce, getFactoryCostInputs,
  // Phase 6 — analytics
  getAnalyticsOrg, getAnalyticsComp, getAnalyticsPerf,
  // Phase 4 — OKRs
  getOkrConfig, getOkrCycle, getObjective, getMyOkrs, getTeamOkrs,
  // Hiring C1/C2
  getOpenings, getOpening, getJdDownloadUrl, getHiringLookups,
  getCandidates, getCandidate, getCandidateDocumentUrl, findCandidateDuplicates,
  // Hiring C3 — offers
  getOfferSetup, getOffers, getOffer, getOfferPdfUrl, getOfferTemplates,
  // Hiring O1 — offer email + link (getOfferMailCheck = super_admin)
  getOfferResponses, getOfferMailCheck,
  // Hiring J1 — work accounts (podium_view required: none of these is self-serve)
  getWorkAccount, checkWorkEmail,
  // X1 — exits (getExit is self-serve, self-scoped by exitCtx; the rest need podium_view)
  getExit, getExits, getExitChecklist, getMyTeamExits,
  // J2 — onboarding + profile completion (self-serve ones listed in SELF_SERVE_GET)
  getMyProfile, getPolicyFile, getOnboarding, getEmployeePrivate, exportXPayroll,
  getOnboardingBoard, getProfileCompletion, getProfileChangeRequests, getOnboardingTemplate, getPolicies,
  // C4 — bulk CV import
  getCvImports, getCvImport, getCvImportFileUrl, getAiSettings,
  // O2 — interview rounds + feedback (chain reads + the panel's own surface)
  getOpeningRounds, getApplicationInterviews, getMyInterviews, getPanelInterview, getPanelDocUrl,
  // Leave R1 — the person / the chain / HR (each self-scopes; all in SELF_SERVE_GET)
  getMyLeave, getTeamLeave, getLeaveLedger, getLeaveAdmin,
  getLeaveLopReport,   // Leave R2 E1 (isHr inside)
};

const POST_ACTIONS = {
  createEmployee, updateEmployee,
  createDepartment, updateDepartment,
  createJobRole, updateJobRole, setRoleKpis,
  addCompensationEvent,
  createDocumentUploadUrl, recordDocument, deleteDocument,
  captureOrgSnapshot,
  updateSettings,
  // Phase 2 — performance capture
  createObservation, updateObservation, deleteObservation,
  createAccomplishment, updateAccomplishment, deleteAccomplishment,
  createOneOnOne, updateOneOnOne, deleteOneOnOne,
  // Permission layer (Podium-managed)
  createPodiumRole, updatePodiumRole, deletePodiumRole, assignPodiumRole,
  // Payouts ledger (comp-gated)
  upsertPayouts, generateFixedPayouts, deletePayout, applyRazorpayxPayouts,
  // Salary-access allow-list (super_admin)
  addCompAccess, removeCompAccess,
  // Google Directory sync
  importDirectoryCandidates,
  // J1b — Podium → Google field sync (Google admins; requireGoogleAdmin inside)
  retryGoogleSync, pushGoogleFields,
  // Appraisal engine
  createAppraisalCycle, setCycleStatus, enrollAppraisalCycle,
  submitSelfReview, submitManagerReview, acknowledgeAppraisal,
  finalizeAppraisal, shareAppraisal, saveCalibratedComp, acceptManagerRecommendation, lockAppraisalComp, waiveSelfReview, setCycleBudget,
  // Factory cost module (compensation-tier)
  setFactoryWorkforce, setFactoryPay, bulkUploadFactoryPay, setFactoryCostInput, setFactoryOtRates,
  // Phase 4 — OKRs
  createOkrCycle, updateOkrCycle, setOkrCycleStatus, deleteOkrCycle,
  createObjective, updateObjective, deleteObjective,
  createKeyResult, updateKeyResult, deleteKeyResult,
  recordCheckin, gradeObjective,
  // Hiring C1/C2
  createOpening, updateOpening, setOpeningStatus, addOpeningJd, createJdUploadUrl, requestBandChange, decideBand,
  createCandidate, addApplication, updateCandidate, updateApplication, setApplicationStatus, moveApplication,
  createCandidateDocUploadUrl, recordCandidateDocument, deleteCandidateDocument,
  // Hiring C3 — offers
  previewOffer, createOffer, updateOfferDraft, submitOffer, decideOffer, markOfferSent, recordOfferAcceptance,
  recordOfferDecline, withdrawOffer, createOfferDocUploadUrl, previewOfferTemplate, saveOfferTemplate, saveSignatory,
  // Hiring O1 — offer email + link
  sendOfferEmail, resendOfferConfirmation, markOfferResponseSeen, verifyCandidateDocument, allowCandidateBankUpdate,
  revealCandidateBank,
  // Hiring J1 — work accounts + confirm joining (podium_view required: none of these is self-serve)
  createWorkAccount, resetWorkAccountPassword, confirmJoining, markNoShow, suspendWorkAccount,
  // X1 — exits (startExit is self-serve, self-scoped by exitCtx; the rest need podium_view)
  startExit, updateExitItem, updateExit, cancelExit, closeExit, backfillExit, actGoogleExitItem,
  saveExitChecklistLine, saveExitTool, revokeExitedAccess, openGoogleExitItem,
  // J2 — onboarding + profile completion (self-serve ones listed in SELF_SERVE_POST)
  saveMyProfile, createMyDocumentUploadUrl, recordMyDocument, acknowledgePolicy, updateOnboardingItem, withdrawMyChangeRequest,
  startOnboarding, completeOnboarding, cancelOnboarding, launchProfileCampaign, decideProfileChange,
  saveOnboardingLine, createPolicyUploadUrl, savePolicy, setPolicyActive,
  // C4 — bulk CV import
  createCvImport, cvImportUploadUrl, cvImportFileDone, cvImportExtract, cvImportSaveItem, cvImportAccept, cvImportSkip,
  discardCvImport, updateAiSettings,
  // O2 — interview rounds + feedback
  saveOpeningRound, setOpeningRoundActive, reorderOpeningRounds, scheduleInterview, updateInterview, cancelInterview,
  markInterviewNoShow, recordInterviewVerdict, remindPanelist, submitInterviewFeedback,
  calendarCheck, linkInterviewCalendar, syncInterviewCalendar,   // O3
  // Leave R1 — the person / the chain / HR (each self-scopes; all in SELF_SERVE_POST)
  previewLeave, applyLeave, decideLeave, withdrawLeave, cancelLeave,
  setLeaveSettings, saveHoliday, deleteHoliday, setOpeningBalance, adjustLeave,
  markLopExported, grantLeave,   // Leave R2 E1 / E3 (isHr inside)
};

// Self-only baseline (RULE-PODIUM-006): actions reachable WITHOUT podium_view.
// getMe + getPodiumRoles are pure metadata; the rest are self-scoped by canSeeFull
// (which treats self as visible) or callerEmployee, so a no-role user can only ever
// reach their OWN profile + wins via /me. Everything else still requires podium_view.
const SELF_SERVE_GET = new Set([
  'getMe', 'getPodiumRoles',
  // Salary-access admin — internally super_admin-gated.
  'getCompAccess', 'getCompAccessLog',
  'getEmployee', 'getMyPerformance', 'getAccomplishments', 'getObservations', 'getOneOnOnes',
  // Own-salary view — parameter-less, self-scoped by callerEmployee.
  'getMyCompensation', 'getMyPayouts',
  // Appraisal participation — relationship-scoped inside each handler, not podium_view-gated.
  'getAppraisalConfig', 'getMyAppraisals', 'getAppraisal', 'getTeamAppraisals',
  // Factory cost — self-gated by requireComp (a comp-only role need not hold podium_view).
  'getFactoryWorkforce', 'getFactoryCostInputs',
  // RazorpayX payroll actuals — self-gated by requireComp (comp-only need not hold podium_view).
  'getRazorpayxPayrollScan',
  // Comp analytics — self-gated by requireComp (a comp-only user need not hold podium_view).
  'getAnalyticsComp',
  // OKR participation — relationship-scoped inside each handler, not podium_view-gated.
  // (getObjective self-scopes via canSeeObjectiveRow; getMyOkrs/getTeamOkrs are chain-scoped.)
  'getMyOkrs', 'getObjective', 'getTeamOkrs',
  // Hiring — every handler self-scopes via openingRoles (owner / reporting manager / approver /
  // podium_hiring / HR), so a manager with no Podium role reaches only their own openings.
  'getOpenings', 'getOpening', 'getJdDownloadUrl', 'getHiringLookups',
  'getCandidates', 'getCandidate', 'getCandidateDocumentUrl', 'findCandidateDuplicates',
  // Hiring C3 — offers self-scope the same way (opening chain + snapshotted offer approver); the
  // template admin reads are gated inside to the salary allow-list / podium_admin.
  'getOfferSetup', 'getOffers', 'getOffer', 'getOfferPdfUrl', 'getOfferTemplates',
  // Hiring O1 — getOfferResponses filters to the offers the caller manages (canManageOffers per opening).
  'getOfferResponses',
  // X1 — your own exit (Resign) / your reports' exits; exitCtx self-scopes (self, manager chain, HR).
  // getMyTeamExits = the caller's own chain only (the /me "Your team" list).
  'getExit', 'getMyTeamExits',
  // J2 — a brand-new joiner holds NO Podium role, so their own profile / policies / onboarding must be here.
  // getMyProfile self-scopes on auth_user_id; getPolicyFile = HR or a policy that applies to the caller;
  // getOnboarding self-scopes via onboardingCtx (self, manager chain, HR); getEmployeePrivate = self / HR / comp
  // inside; exportXPayroll = requireComp (a comp-only user need not hold podium_view).
  'getMyProfile', 'getPolicyFile', 'getOnboarding', 'getEmployeePrivate', 'exportXPayroll',
  // C4 — bulk CV import self-scopes like createCandidate (cvImportCtx → canManageApps on the batch's opening).
  'getCvImports', 'getCvImport', 'getCvImportFileUrl',
  // O2 — rounds / application interviews self-scope via openingRoles (canSeeOpening) like getOpening; the panel
  // reads (getMyInterviews / getPanelInterview / getPanelDocUrl) self-scope on the caller's own interview_panel row.
  'getOpeningRounds', 'getApplicationInterviews', 'getMyInterviews', 'getPanelInterview', 'getPanelDocUrl',
  // Leave R1 — a covered employee may hold no Podium role. getMyLeave = the caller's own row; getTeamLeave = descendantsOf
  // the caller (+ the requests they may decide) or HR; getLeaveLedger = self / chain / HR; getLeaveAdmin = isHr inside.
  'getMyLeave', 'getTeamLeave', 'getLeaveLedger', 'getLeaveAdmin',
  // Leave R2 — the payroll LOP report is isHr inside (like getLeaveAdmin).
  'getLeaveLopReport',
]);
const SELF_SERVE_POST = new Set([
  'createAccomplishment', 'updateAccomplishment', 'deleteAccomplishment',
  // Salary-access admin — internally super_admin-gated.
  'addCompAccess', 'removeCompAccess',
  // Appraisal participation (self-review / manager-review / acknowledge).
  'submitSelfReview', 'submitManagerReview', 'acknowledgeAppraisal',
  // Factory cost — self-gated by requireComp (a comp-only role need not hold podium_view).
  'setFactoryWorkforce', 'setFactoryPay', 'bulkUploadFactoryPay', 'setFactoryCostInput', 'setFactoryOtRates',
  // RazorpayX payroll actuals writer — self-gated by requireComp.
  'applyRazorpayxPayouts',
  // OKR participation — each handler is authorship-gated (owner / manager-chain / HR),
  // so a self-only user can act only on their OWN objectives + KRs + check-ins.
  'createObjective', 'updateObjective', 'deleteObjective',
  'createKeyResult', 'updateKeyResult', 'deleteKeyResult',
  'recordCheckin', 'gradeObjective',
  // Hiring — each handler self-scopes (see SELF_SERVE_GET).
  'createOpening', 'updateOpening', 'setOpeningStatus', 'addOpeningJd', 'createJdUploadUrl', 'requestBandChange', 'decideBand',
  'createCandidate', 'addApplication', 'updateCandidate', 'updateApplication', 'setApplicationStatus', 'moveApplication',
  'createCandidateDocUploadUrl', 'recordCandidateDocument', 'deleteCandidateDocument',
  // Hiring C3 — offers (see SELF_SERVE_GET).
  'previewOffer', 'createOffer', 'updateOfferDraft', 'submitOffer', 'decideOffer', 'markOfferSent', 'recordOfferAcceptance',
  'recordOfferDecline', 'withdrawOffer', 'createOfferDocUploadUrl', 'previewOfferTemplate', 'saveOfferTemplate', 'saveSignatory',
  // Hiring O1 — send / resend / mark seen self-scope via offerCtx + canManageOffers; revealCandidateBank is
  // requireComp inside (a comp-only user need not hold podium_view). verify / allow-update are requireHr (not here).
  'sendOfferEmail', 'resendOfferConfirmation', 'markOfferResponseSeen', 'revealCandidateBank',
  // X1 — Resign (self) / start a report's exit (manager chain) / tick manager lines; exitCtx self-scopes and
  // canTickItem limits a manager to owner='manager' lines (exit_update_item re-checks).
  'startExit', 'updateExitItem',
  // J2 — the joiner's own profile, documents and policy acks (self-scoped on auth_user_id), and the manager
  // chain's onboarding lines (onboardingCtx + canTickOnboardingItem; onboarding_update_item re-checks).
  'saveMyProfile', 'createMyDocumentUploadUrl', 'recordMyDocument', 'acknowledgePolicy', 'updateOnboardingItem',
  'withdrawMyChangeRequest',
  // C4 — see SELF_SERVE_GET.
  'createCvImport', 'cvImportUploadUrl', 'cvImportFileDone', 'cvImportExtract', 'cvImportSaveItem', 'cvImportAccept',
  'cvImportSkip', 'discardCvImport',
  // O2 — rounds = canEditOpening; interviews / verdict / remind = canManageApps on the opening; feedback = the
  // caller's own panel row (see SELF_SERVE_GET).
  'saveOpeningRound', 'setOpeningRoundActive', 'reorderOpeningRounds', 'scheduleInterview', 'updateInterview',
  'cancelInterview', 'markInterviewNoShow', 'recordInterviewVerdict', 'remindPanelist', 'submitInterviewFeedback',
  // O3 — Add to Calendar / sync = canManageApps on the interview's opening (interviewCtx), like cancelInterview.
  'linkInterviewCalendar', 'syncInterviewCalendar',
  // Leave R1 — preview / apply = self (HR for others); decide = decideBlock (approver, their manager, HR; never self);
  // withdraw / cancel = cancelBlock; the HR writes are isHr inside (see SELF_SERVE_GET).
  'previewLeave', 'applyLeave', 'decideLeave', 'withdrawLeave', 'cancelLeave',
  'setLeaveSettings', 'saveHoliday', 'deleteHoliday', 'setOpeningBalance', 'adjustLeave',
  // Leave R2 — mark the LOP report exported / grant maternity or paternity: isHr inside (grant: never yourself).
  'markLopExported', 'grantLeave',
]);

async function handleGet(url, request, env, ctx) {
  const action = url.searchParams.get('action');
  if (!action) return err('action_required', 400);
  if (action === 'ping') return ok({ pong: true });
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);

  const handler = GET_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
  if (!auth.permissions?.podium_view && !SELF_SERVE_GET.has(action)) return err('forbidden_podium_view', 403);
  // J1b: ctx (the Worker ExecutionContext) is an optional 4th argument — handlers that drain the Google sync after
  // the response use ctx.waitUntil; every other handler ignores it.
  try { return await handler(url, auth, env, ctx); }
  catch (e) { return err(`server_error: ${e?.message || String(e)}`, 500); }
}

async function handlePost(request, env, ctx) {
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('bad_json', 400); }
  const action = body?.action;
  if (!action) return err('action_required', 400);
  const handler = POST_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
  if (!auth.permissions?.podium_view && !SELF_SERVE_POST.has(action)) return err('forbidden_podium_view', 403);
  try { return await handler(body, auth, env, ctx); }
  catch (e) { return err(`server_error: ${e?.message || String(e)}`, 500); }
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/healthz') {
      return ok({ service: 'podiumops', time: nowIso() });
    }

    // O1 — the candidate's offer link: no login, the token is the credential. Before the JWT gate.
    if (url.pathname.startsWith('/public/offer')) {
      try { return await handlePublicOffer(request, url, env); }
      catch (e) {
        console.error('[public-offer]', e?.message || e);
        return err('Something went wrong. Please try again.', 500);
      }
    }

    if (request.method === 'GET')  return handleGet(url, request, env, ctx);
    if (request.method === 'POST') return handlePost(request, env, ctx);
    return err('method_not_allowed', 405);
  },
};
