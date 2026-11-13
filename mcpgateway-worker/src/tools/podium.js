// Podium hiring tools: read the openings a person can hire for and their CV-import batches, start a batch,
// and accept one read CV as a candidate. Every call reaches podiumops AS THE PERSON (their own Supabase JWT,
// service binding PODIUMOPS), so Podium's own hiring gates decide (hiring team / the opening's hiring owner /
// its reporting manager; HR and budget approvers can see an opening but not import into it).
// SALARY RULE (Afshaan 2026-11-13, non-negotiable): no output ever carries salary or personal-finance data,
// even when the person could see it in Podium. Every result (reads AND writes) goes through `clean`.
// The CV files themselves are uploaded in the Podium app (podiumops signs the upload per file); the AI never
// handles a file.
import { T, reportTool } from './build.js';
import { getAs, postAs, scrub, capPayload } from '../workers.js';

export const PODIUM_APP = 'https://podium.legendoftoys.com';
// trailingSlash: true in apps/podium/next.config.js, so the page lives at /batch/ (the app routes there too).
export const uploadLink = id => `${PODIUM_APP}/hiring/import/batch/?id=${id}`;

// Keys dropped wherever they appear. Unambiguous fragments match anywhere (current_ctc, expected_ctc, ctc_*,
// salary_band_max, can_see_salary, compensation_*, aadhaar_*, ifsc); short words only as a whole snake_case
// token, so company / panel / expand / span / payload-free keys survive (band, pending_band, has_band, band_min,
// pay_*, payslip, pan, pan_number, bank, bank_name, account_number, increment_*, stipend, wage, bonus, comp).
export const SALARY_KEY = /ctc|salar|compensation|aadha+r|ifsc|(^|_)(band|bands|pay|payslip|payout|pan|bank|account_number|increment|increments|stipend|wage|wages|bonus|comp)(_|$)/i;
// Internal / housekeeping fields: auth ids (userId, created_by — dropIds also catches *_by / *_user_id uuids),
// storage paths and hashes, the AI-reading internals, and evidence quotes (they can quote a CTC line from the CV).
const PODIUM_DROP = ['userId', 'auth_user_id', 'created_by', 'storage_path', 'sha256', 'ai_call_id', 'prompt_version',
  'evidence', 'spend', 'ai_ready', 'extracting_since', 'attempts', 'model', 'extract_mode', 'mime_type', 'file_size', 'document_id'];
// Pay details in FREE TEXT (a CV's education line, a skill, a file name like Asha_CTC_18L.pdf, a warning). The
// boundaries are "not a letter" rather than \b, because \b treats `_` as a word character (Asha_18LPA.pdf).
// Bare words that are also names stay: Salesforce, Pancake, Panasonic, HDFC Bank, Packaging (`pan` / `bank` are
// only caught as a PAN / IFSC-shaped code; `package` only with an amount or current/expected/annual before it).
const NL = '(?<![a-z])', NR = '(?![a-z])';
export const SALARY_TEXT = new RegExp([
  `${NL}ctc${NR}`, `${NL}salar(?:y|ies)`, 'compensation', 'remuneration',
  `${NL}packages?${NR}[\\s:=\\-]*(?:of\\s+|is\\s+)?(?:₹|rs\\.?|inr|\\d)`, `(?:current|expected|annual|take[- ]home)\\s+package`,
  `${NL}l\\.?p\\.?a\\.?${NR}`,                        // LPA, L.P.A., 18LPA
  `${NL}lakhs?${NR}`, `\\d\\s*(?:lacs?|crores?|cr)${NR}`,   // 24 lacs, 1.2 cr
  `(?<![a-z\\d.])\\d{1,3}(?:\\.\\d{1,2})?\\s?l${NR}`,         // 18L, 18.5L, 18 L
  '₹', `${NL}inr${NR}`, `${NL}rs\\.?\\s*[\\d₹]`, 'per\\s+annum', `\\d\\s*(?:p\\.\\s?a\\.?|pa)${NR}`, // '18 p.a.' (not 'P.A. to the director')
  `\\d+(?:\\.\\d+)?\\s*k\\s*(?:\\/|per|a)\\s*(?:month|mo|m|annum|year|yr|y)${NR}`, // 50k/month, 40k a month
  `\\d+(?:\\.\\d+)?\\s*k\\s*(?:pm|p\\.m\\.?|pa)${NR}`,                 // 25k pm
  `\\d{1,3}(?:,\\d{2,3})+\\s*(?:\\/-\\s*)?(?:per|a|\\/)\\s*(?:month|annum|year)`, // 75,000 per month
  '(?<!\\d)\\d{1,2}(?:,\\d{2})+,\\d{3}(?!\\d)',                // Indian grouping 24,00,000 (not 1,200,000 records)
  `${NL}aadha+r${NR}`,
].join('|'), 'i');
// PAN (ABCDE1234F) and IFSC (HDFC0001234) shapes: upper case only, so lower-case ids never match.
const ID_TEXT = /(?<![A-Z0-9])(?:[A-Z]{5}[0-9]{4}[A-Z]|[A-Z]{4}0[A-Z0-9]{6})(?![A-Z0-9])/;
const PAN_ANY_CASE = /(?<![a-z0-9])[a-z]{5}[0-9]{4}[a-z](?![a-z0-9])/i; // 'pan: abcde1234f' (Codex 2026-11-13)
export const payText = s => typeof s === 'string' && (SALARY_TEXT.test(s) || ID_TEXT.test(s) || PAN_ANY_CASE.test(s));
export const REMOVED = '[removed: may contain pay details]';
const maskText = v => typeof v === 'string' ? (payText(v) ? REMOVED : v)
  : Array.isArray(v) ? v.map(maskText)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskText(x)])) : v;
// Every tool result: salary-named keys dropped, then every string that reads like pay details replaced.
export const clean = v => capPayload(maskText(scrub(v, { dropKeys: PODIUM_DROP, dropMatch: SALARY_KEY, dropIds: true })));

// src/cvimport.js DRAFT_FIELDS, CTC included: what is copied from Podium's own held draft back to Podium on accept.
// The AI may correct only CORRECTABLE (these minus the two CTC fields).
const DRAFT_FIELDS = ['full_name', 'email', 'phone', 'location', 'linkedin_url', 'current_employer', 'current_title',
  'total_experience_years', 'skills', 'education', 'notice_period_days', 'current_ctc', 'expected_ctc'];
const str = (max, { required = false } = {}) => v => (v === null && !required) ? { ok: true, value: null }
  : typeof v === 'string' && v.length <= max && !/[\u0000-\u001f]/.test(v) && (!required || v.trim())
    ? { ok: true, value: v.trim() || null } : { ok: false, error: `must be text up to ${max} characters${required ? '' : ' (or null)'}` };
const num = (min, max, int) => v => v === null ? { ok: true, value: null }
  : typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!int || Number.isInteger(v))
    ? { ok: true, value: v } : { ok: false, error: `must be a ${int ? 'whole ' : ''}number ${min}–${max} (or null)` };
const CORRECTABLE = {
  full_name: str(120, { required: true }),
  email: v => v === null ? { ok: true, value: null } : typeof v === 'string' && v.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? { ok: true, value: v.trim().toLowerCase() } : { ok: false, error: 'must be an email address (or null)' },
  phone: v => v === null ? { ok: true, value: null } : typeof v === 'string' && v.length <= 30 && /^[+\d][\d ()\-]{5,29}$/.test(v.trim()) ? { ok: true, value: v.trim() } : { ok: false, error: 'must be a phone number (or null)' },
  // cvimport.js validateExtraction's rule (linkedin.com/in/<slug>), anchored here so nothing else rides along.
  linkedin_url: v => {
    if (v === null) return { ok: true, value: null };
    const m = typeof v === 'string' && v.length <= 300 && v.trim().match(/^(?:https?:\/\/)?(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%.]+)\/*(?:\?[^\s]*)?$/i);
    const slugOk = m && /^[A-Za-z0-9]/.test(m[1]) && !/\.\.|%2e|%2f/i.test(m[1]); // '/in/..' and '/in/%2e%2e' resolve to '/'
    return slugOk ? { ok: true, value: `https://www.linkedin.com/in/${m[1]}` } : { ok: false, error: 'must be a LinkedIn profile link (linkedin.com/in/…) or null' };
  },
  location: str(120), current_employer: str(160), current_title: str(160), education: str(300),
  total_experience_years: num(0, 60, false),
  notice_period_days: num(0, 365, true),
  skills: v => Array.isArray(v) && v.length <= 30 && v.every(s => typeof s === 'string' && s.trim() && s.length <= 60 && !/[\u0000-\u001f]/.test(s))
    ? { ok: true, value: v.map(s => s.trim()) } : { ok: false, error: 'must be a list of up to 30 short skills' },
};
export function parseCorrections(v) {
  if (v === undefined || v === null) return { ok: true, value: {} };
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: '`corrections` must be an object of field: value' };
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (SALARY_KEY.test(k)) return { ok: false, error: `\`corrections.${k}\`: salary fields cannot be set through an AI app. Enter them in Podium on the import page.` };
    if (!Object.prototype.hasOwnProperty.call(CORRECTABLE, k)) return { ok: false, error: `\`corrections.${k}\` is not a candidate field (it takes: ${Object.keys(CORRECTABLE).join(', ')})` };
    if (payText(x) || (Array.isArray(x) && x.some(payText))) return { ok: false, error: `\`corrections.${k}\` looks like it holds pay details. Salary is entered in Podium only.` };
    const c = CORRECTABLE[k](x);
    if (!c.ok) return { ok: false, error: `\`corrections.${k}\` ${c.error}` };
    out[k] = c.value;
  }
  return { ok: true, value: out };
}

// The fields of one CV as Podium holds them (podiumops itemDraft: final || extracted.fields), for reading.
const itemFields = i => (i && (i.final || (i.extracted && i.extracted.fields))) || {};
const READY = ['extracted', 'needs_manual'];
const STATUS_WORDS = { uploaded: 'uploaded, not read yet', extracting: 'being read', extracted: 'read, ready to review and accept',
  needs_manual: 'could not be read automatically: check the fields and fill the gaps before accepting', accepting: 'being accepted',
  accepted: 'accepted', skipped: 'skipped' };
const denied = r => (r.reason === 'worker denied' ? { ok: false, reason: 'podium denied' } : r);
const LAST_ERROR = 'Podium could not read or save this CV; open the import page to see why';

// One CV's existing-candidate matches, exactly as the import page does it (batch/page.js matchesFor + hiddenFor,
// same normEmail / normPhone): getCvImport's batch-wide `duplicates` / `hidden_keys` keyed by this CV's fields.
const normEmail = s => String(s || '').trim().toLowerCase() || null;
const normPhone = s => String(s || '').replace(/\D/g, '').slice(-10) || null;
export function matchesFor(fields, d) {
  const out = new Map();
  const dupes = d && Array.isArray(d.duplicates) ? d.duplicates : [];
  for (const m of dupes) if (m && m.email_norm && m.email_norm === normEmail(fields && fields.email)) out.set(m.id, m);
  for (const m of dupes) if (m && m.phone_norm && m.phone_norm === normPhone(fields && fields.phone)) out.set(m.id, m);
  const hidden = new Set(d && Array.isArray(d.hidden_keys) ? d.hidden_keys : []);
  return { matches: [...out.values()], hidden: hidden.has(normEmail(fields && fields.email)) || hidden.has(normPhone(fields && fields.phone)) };
}

const shapeOpenings = (openings, me) => {
  const emp = me && me.employee_id;
  const team = !!(me && me.permissions && me.permissions.podium_hiring);
  return (Array.isArray(openings) ? openings : []).map(o => {
    // podiumops openingRoles + canManageApps: hiring team, hiring owner or reporting manager can import.
    const role = [team && 'hiring team', emp && o.hiring_owner && o.hiring_owner.id === emp && 'hiring owner',
      emp && o.reporting_manager && o.reporting_manager.id === emp && 'reporting manager'].filter(Boolean);
    return { o, role };
  }).filter(x => x.role.length).map(({ o, role }) => ({
    id: o.id, code: o.opening_code, title: o.designation, department: (o.department && o.department.name) || null,
    job_role: (o.job_role && o.job_role.title) || null, status: o.status, location: o.location_city || null,
    employment_type: o.employment_type || null, headcount: o.headcount, target_join_date: o.target_join_date || null,
    has_jd: !!o.has_jd, can_import_cvs: o.status === 'open' && !!o.has_jd,
    candidate_counts: o.application_counts || {},
    hiring_owner: (o.hiring_owner && o.hiring_owner.full_name) || null,
    reporting_manager: (o.reporting_manager && o.reporting_manager.full_name) || null,
    your_role: role,
  }));
};
const shapeImport = d => {
  const imp = (d && d.import) || {};
  const items = (d && Array.isArray(d.items) ? d.items : []).map(i => {
    const mf = matchesFor(itemFields(i), d);
    return {
      item_id: i.id, file_name: i.file_name, status: i.status, status_words: STATUS_WORDS[i.status] || i.status,
      ready_to_accept: READY.includes(i.status), fields: itemFields(i),
      warnings: (Array.isArray(i.warnings) ? i.warnings : []).filter(w => typeof w === 'string' && !payText(w)),
      // Existing candidates with this CV's email or phone: attach with podium_accept_resume candidate_id.
      matches: mf.matches.map(m => ({ candidate_id: m.id, code: m.candidate_code, name: m.full_name })),
      // Someone on an opening this person cannot see has this email / phone (Podium says THAT, not who).
      matches_someone_hidden: mf.hidden,
      candidate_id: i.candidate_id || null, application_id: i.application_id || null,
      // Podium's own error text can carry DB or CV detail: never passed through.
      problem: i.last_error ? LAST_ERROR : null,
    };
  });
  return {
    import: { id: imp.id, source: imp.source, note: imp.source_detail || null, created_at: imp.created_at, updated_at: imp.updated_at },
    opening: d && d.opening ? { id: d.opening.id, code: d.opening.opening_code, title: d.opening.designation, status: d.opening.status } : null,
    upload_link: imp.id ? uploadLink(imp.id) : null,
    items,
  };
};

const hiring = reportTool({
  system: 'podium', name: 'podium_hiring', title: 'Podium hiring', binding: 'PODIUMOPS',
  description: 'Read Podium hiring: the openings you can hire for (you are on the hiring team, or the opening\'s hiring owner or reporting manager), with candidate counts and whether CVs can be imported, and one CV-import batch with each CV\'s read fields, status and possible duplicates. Never returns salary or CTC.',
  paramAbout: { status: 'For report=openings: open (default), on_hold, draft, filled, cancelled or all.', search: 'For report=openings: text in the opening title or code.', import_id: 'For report=import: the batch id (from podium_start_resume_import).' },
  reports: {
    openings: { action: 'getOpenings', about: 'the openings you can hire for: id, code, title, department, status, candidate counts, your role on it, and whether CVs can be imported (open + has a JD)', params: { status: T.oneOf('open', 'on_hold', 'draft', 'filled', 'cancelled', 'all'), search: T.text } },
    import: { action: 'getCvImport', about: 'one CV-import batch: each CV (item_id, file, status, the fields read from it, warnings) and existing candidates that match', params: { import_id: T.uuid }, required: ['import_id'], rename: { import_id: 'id' } },
  },
});
// podium_hiring needs a finer answer than one worker read: `openings` also reads getMe (the caller's
// employee id + podium_hiring) to keep only the openings they can import into and say why.
hiring.run = async ({ env, sbAccess, input }) => {
  const b = env.PODIUMOPS, p = input.params;
  let result;
  if (input.report === 'openings') {
    const [o, me] = await Promise.all([getAs(b, sbAccess, 'getOpenings', { status: p.status || 'open', search: p.search }), getAs(b, sbAccess, 'getMe', {})]);
    if (!o.ok) return plain(denied(o));
    if (!me.ok) return plain(denied(me));
    result = { openings: shapeOpenings(o.data && o.data.openings, me.data) };
  } else {
    const r = await getAs(b, sbAccess, 'getCvImport', { id: p.id });
    if (!r.ok) return plain(denied(r));
    result = shapeImport(r.data);
  }
  const { data, truncated } = clean(result);
  return { ok: true, data: { report: input.report, params: input.params, ...(truncated.length ? { truncated } : {}), result: data } };
};

// A Podium write tool: whitelisted params, readOnlyHint false, `run` does the call(s).
function writeTool({ name, title, description, action, params, required = [], check, auditArgs, run }) {
  const props = {};
  for (const [k, p] of Object.entries(params)) props[k] = { ...p.schema, description: p.about || '' };
  return {
    system: 'podium', name, title,
    description: `${description} Changes Podium hiring records as you; Podium logs it on the candidate's timeline. Never returns salary or CTC.`,
    inputSchema: { type: 'object', properties: props, required, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    needsSession: true,
    write: true,
    action,   // the one podiumops write it can reach
    auditArgs,  // what the gateway's call audit row keeps of the arguments (src/index.js), when not all of them
    parse: args => {
      const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      for (const k of Object.keys(a)) if (!Object.prototype.hasOwnProperty.call(params, k)) return { ok: false, error: `\`${k}\` is not a field of ${name} (it takes: ${Object.keys(params).join(', ')})` };
      const data = {};
      for (const [k, p] of Object.entries(params)) {
        const v = a[k];
        if (v === undefined || v === null || v === '') { if (required.includes(k)) return { ok: false, error: `\`${k}\` is required` }; continue; }
        const c = p.check(v);
        if (!c.ok) return { ok: false, error: c.error.startsWith('`') ? c.error : `\`${k}\` ${c.error}` };
        data[k] = c.value;
      }
      if (check) { const e = check(data); if (e) return { ok: false, error: e }; }
      return { ok: true, value: data };
    },
    run,
  };
}
// A failed Podium write: 403 → Podium's own rule; a DB-shaped failure or no answer → outcome unknown.
const writeFailed = r => {
  if (r.reason === 'worker denied') return { ok: false, reason: 'podium denied' };
  if (r.serverFail || r.reason === 'unreachable') return { ok: false, reason: 'podium write unconfirmed' };
  return r;
};
const PLAIN = {
  jd_required: 'this opening has no JD yet. Add the JD to the opening in Podium first.',
  opening_not_open: 'this opening is not open, so CVs cannot be added to it.',
  'opening not found': 'no opening with that id that you can see. Use podium_hiring report=openings for the ids.',
  not_found: 'no CV batch or CV with that id that you can see. Use podium_hiring report=import to check the ids.',
  duplicate: 'Podium already has someone with this email or phone (see the CV\'s `matches` / `matches_someone_hidden` in podium_hiring report=import). To add this CV to that person, call again with their candidate_id. If they are hidden from you, ask HR.',
  busy: 'someone else is accepting this CV right now. Check it with podium_hiring report=import in a minute.',
  not_acceptable: 'this CV is already done (accepted or skipped).',
};
const plain = r => (r.userError && PLAIN[r.userError] ? { ok: false, userError: PLAIN[r.userError] } : r);

const NOTE = { schema: { type: 'string', maxLength: 150 }, about: 'Optional short note kept on the batch (for example where the CVs came from).',
  check: v => typeof v !== 'string' || v.length > 150 || /[\u0000-\u001f]/.test(v) ? { ok: false, error: 'must be a short note up to 150 characters' }
    : payText(v) ? { ok: false, error: 'looks like it holds pay details. Leave salary out of the note.' } : { ok: true, value: v.trim() } };
const CORRECTIONS = { schema: { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.keys(CORRECTABLE).map(k => [k, {}])) },
  about: `Optional fixes to the fields Podium read from the CV, only: ${Object.keys(CORRECTABLE).join(', ')}. Salary fields cannot be set here.`,
  check: parseCorrections };

const startImport = writeTool({
  name: 'podium_start_resume_import', title: 'Start a Podium CV import', action: 'createCvImport',
  description: 'Start a CV-import batch on one open opening (it needs a JD). Returns the Podium link where the person drops the CV files; Podium reads each CV, then you review the fields with podium_hiring report=import and accept each with podium_accept_resume.',
  params: { opening_id: { ...T.uuid, about: 'The opening id (from podium_hiring report=openings).' }, note: NOTE },
  required: ['opening_id'],
  run: async ({ env, sbAccess, input }) => {
    // podiumops APP_SOURCES has no 'mcp' (hiring.js: referral … careers_page, other): 'other', and the note says how.
    const note = input.note ? `AI connector: ${input.note}` : 'Started from the LOT AI connector';
    const res = await postAs(env.PODIUMOPS, sbAccess, 'createCvImport', { opening_id: input.opening_id, source: 'other', source_detail: note.slice(0, 200) });
    if (!res.ok) return plain(writeFailed(res));
    const id = res.data && res.data.id;
    return { ok: true, data: { done: 'podium_start_resume_import', result: clean({
      import_id: id, opening_id: input.opening_id, upload_link: uploadLink(id),
      what_next: 'Open the upload link in Podium (signed in), drop the CV files (PDF, Word or images, up to 15 MB each), and keep the page open until every CV shows as read. Then come back here and ask to review the batch (podium_hiring report=import), and accept each CV that looks right.',
    }).data } };
  },
});

const acceptResume = writeTool({
  name: 'podium_accept_resume', title: 'Accept a CV as a Podium candidate', action: 'cvImportAccept',
  description: 'Accept one read CV from an import batch: creates the candidate with an application on the batch\'s opening and files the CV (or, with candidate_id, adds the application to that existing candidate). Uses the fields exactly as Podium holds them, with any corrections given on top; Podium keeps the CTC it read from the CV. With candidate_id only notice_period_days can be corrected (the existing person\'s details are not changed). If Podium hides salary from you on this opening, make corrections on the Podium import page and accept here without them.',
  params: {
    import_id: { ...T.uuid, about: 'The batch id.' },
    item_id: { ...T.uuid, about: 'The CV\'s item_id (from podium_hiring report=import).' },
    corrections: CORRECTIONS,
    candidate_id: { ...T.uuid, about: 'Optional: attach this CV to an existing candidate instead of creating a new one: one of this CV\'s own `matches`.' },
  },
  required: ['import_id', 'item_id'],
  // podiumops addApplication takes only notice_period_days (and CTC) from the draft; the rest would be silently ignored.
  check: d => d.candidate_id && d.corrections && Object.keys(d.corrections).some(k => k !== 'notice_period_days')
    ? 'with candidate_id only notice_period_days can be corrected: the existing candidate\'s details are not changed by an attach.' : null,
  // The call audit row keeps the ids and which fields were corrected, never the values (candidate email / phone).
  auditArgs: a => {
    const o = a && typeof a === 'object' && !Array.isArray(a) ? a : {};
    const id = k => (typeof o[k] === 'string' ? o[k].slice(0, 60) : undefined);
    const c = o.corrections && typeof o.corrections === 'object' && !Array.isArray(o.corrections) ? Object.keys(o.corrections).slice(0, 20).map(k => k.slice(0, 40)) : undefined;
    return { import_id: id('import_id'), item_id: id('item_id'), candidate_id: id('candidate_id'), corrections_keys: c };
  },
  run: async ({ env, sbAccess, input }) => {
    // The draft is read server-side, so the person's CTC (when Podium lets them see it) goes back to Podium
    // untouched and never through the AI.
    const r = await getAs(env.PODIUMOPS, sbAccess, 'getCvImport', { id: input.import_id });
    if (!r.ok) return plain(denied(r));
    const items = (r.data && Array.isArray(r.data.items)) ? r.data.items : [];
    const item = items.find(i => i && i.id === input.item_id);
    const refuse = userError => ({ ok: false, userError, byGateway: true });
    if (!item) return refuse('that CV is not in this batch. Use podium_hiring report=import to check the item_id.');
    // `accepting` goes through: podiumops lets a stuck accept (over 5 minutes old) be re-run, and says `busy` otherwise.
    if (item.status === 'uploaded' || item.status === 'extracting') return refuse('this CV is still being read. Keep the import page open until it shows as read, then accept it.');
    if (item.status === 'accepted' || item.status === 'skipped') return refuse(`this CV is already done (${item.status}).`);
    if (!READY.includes(item.status) && item.status !== 'accepting') return refuse('this CV is not ready to accept. Check it on the import page.');
    const held = itemFields(item);
    const mine = matchesFor(held, r.data).matches;
    if (input.candidate_id && !mine.some(m => m.id === input.candidate_id)) return refuse('that candidate_id is not one of this CV\'s matches (same email or phone). Use a candidate_id from this CV\'s `matches` in podium_hiring report=import.');
    const corrections = input.corrections || {};
    const body = { item_id: input.item_id };
    if (input.candidate_id) body.candidate_id = input.candidate_id;
    // getCvImport strips CTC from `held` for a caller who can't see salary on the opening (podiumops cvItemView), so
    // sending `held` back would wipe the CTC Podium read. Without salary access send no draft at all: podiumops
    // then accepts its own full stored copy (d.draft || item.final || item.extracted.fields).
    if (r.data.can_see_salary === true) {
      const draft = {};
      for (const k of DRAFT_FIELDS) if (k in held) draft[k] = held[k];
      body.draft = Object.assign(draft, corrections);
    } else if (Object.keys(corrections).length) {
      return refuse('Podium hides salary from you on this opening, so corrections here could lose the CTC it read from the CV. Make the corrections on the Podium import page, then accept here (or there).');
    }
    const res = await postAs(env.PODIUMOPS, sbAccess, 'cvImportAccept', body);
    if (!res.ok) {
      // An attach is gated on seeing that existing person (podiumops addApplication), not the opening role.
      if (input.candidate_id && res.reason === 'worker denied') return { ok: false, userError: 'Podium won\'t let you add this CV to that person: ask HR or hiring.' };
      return plain(writeFailed(res));
    }
    const candidateId = (res.data && res.data.candidate_id) || input.candidate_id || null;
    // The code: from this CV's matches (an attach target), else a re-read (the new person now matches their own email/phone).
    let match = mine.find(m => m.id === candidateId);
    if (!match && candidateId) {
      const again = await getAs(env.PODIUMOPS, sbAccess, 'getCvImport', { id: input.import_id });
      match = again.ok ? ((again.data && again.data.duplicates) || []).find(m => m.id === candidateId) : null;
    }
    return { ok: true, data: { done: 'podium_accept_resume', result: clean({
      status: res.data && res.data.status,
      candidate: { id: candidateId, code: (match && match.candidate_code) || null, name: (match && match.full_name) || corrections.full_name || held.full_name || null, new: !input.candidate_id },
      application_id: (res.data && res.data.application_id) || null,
    }).data } };
  },
});

export default [hiring, startImport, acceptResume];
