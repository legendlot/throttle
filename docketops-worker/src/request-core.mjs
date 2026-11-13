// Request hardening shared by the worker router and test/request-core.test.mjs (2026-11-14): uuid canonicalisation
// before any handler (mirrors podiumops-worker's canonicalIds / canonicalizeUrlUuids), and the size caps every write
// checks before it touches the database.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres accepts an UPPERCASE uuid and answers lowercase, so a request id compared in JS (`newParent === task.id`,
// `d.id === d.other_id`, `space.owner_user_id === d.user_id`) could slip a self-check by changing case. Canonicalised
// ONCE, in the router, before any handler — but ONLY under an id-bearing KEY (id / ids / *_id / *_ids, any case): a
// whole-string uuid there (or in an array there) is lowercased in place. Titles, bodies, notes, urls are never
// touched. Iterative and bounded (depth / node caps) so a hostile body cannot blow the stack. → false when over a cap.
const ID_KEY_RE = /^ids?$|_ids?$/i;
// Generous on purpose: the walk is a loop, so the caps only stop an abusive body, never a real bulk request.
const CANON_MAX_DEPTH = 64, CANON_MAX_NODES = 500000;
export function canonicalIds(root) {
  const stack = [[root, false, 0]];
  let nodes = 0;
  while (stack.length) {
    const [v, idKey, depth] = stack.pop();
    if (depth > CANON_MAX_DEPTH) return false;
    const keys = Array.isArray(v) ? null : (v && typeof v === 'object' ? Object.keys(v) : []);
    const n = keys ? keys.length : v.length;
    for (let i = 0; i < n; i++) {
      if (++nodes > CANON_MAX_NODES) return false;
      const k = keys ? keys[i] : i;
      const isId = keys ? ID_KEY_RE.test(k) : idKey;   // an array element takes its array's key
      const x = v[k];
      if (typeof x === 'string') { if (isId && UUID_RE.test(x)) v[k] = x.toLowerCase(); }
      else if (x && typeof x === 'object') stack.push([x, isId, depth + 1]);
    }
  }
  return true;
}
export function canonicalizeUrlUuids(url) {
  for (const k of [...new Set(url.searchParams.keys())]) {
    if (!ID_KEY_RE.test(k)) continue;
    const vals = url.searchParams.getAll(k);
    if (!vals.some(x => UUID_RE.test(x) && x !== x.toLowerCase())) continue;
    url.searchParams.delete(k);
    for (const x of vals) url.searchParams.append(k, UUID_RE.test(x) ? x.toLowerCase() : x);
  }
  return url;
}

// ── Size caps ────────────────────────────────────────────────────────────────
// Checked before any DB call; a request over one gets a 400 naming it. Each is far above anything real (live
// 2026-11-14: longest task title 159 chars, description 786, comment 2,130, scratch note 712, doc url 118, 6
// collaborators on one task, custom_fields always '{}', 88 tasks in the biggest space) — they stop abuse, not use.
// Bulk ids: a list's select-all sends at most its visible rows, and an `id=in.(…)` read of ~1,000 uuids is already
// past what the URL carries.
export const LIMITS = {
  title: 500,                  // task title
  description: 100000,         // task description
  customFieldsBytes: 32768,    // JSON of tasks.custom_fields (a plain object)
  comment: 50000,              // task comment body
  docTitle: 500,               // task document title
  docUrl: 4000,                // task document url
  documents: 100,              // documents in one createTask
  collaborators: 200,          // collaborators in one createTask
  bulkIds: 1000,               // ids in one bulkUpdateTasks / bulkSetCollaborator / bulkMoveTasks / bulkAbandonTasks
  scratchBody: 500000,         // scratch note body
};
const len = (v) => (v == null ? 0 : String(v).length);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// tasks.custom_fields: absent (undefined / null) is fine — create stores {}; anything else must be a plain object.
export function customFieldsError(v) {
  if (v === undefined || v === null) return null;
  if (!isPlainObject(v)) return 'custom_fields_not_object';
  return new TextEncoder().encode(JSON.stringify(v)).length > LIMITS.customFieldsBytes ? 'custom_fields_too_large' : null;
}
export function docError(doc) {
  if (!doc || typeof doc !== 'object') return null;   // a non-object entry is dropped by the url filter, as before
  if (len(doc.title) > LIMITS.docTitle) return 'document_title_too_long';
  if (len(doc.url) > LIMITS.docUrl) return 'document_url_too_long';
  return null;
}
// createTask / updateTask payload (only the fields present are checked). → error string | null
export function taskFieldsError(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.title != null && String(d.title).trim().length > LIMITS.title) return 'title_too_long';
  if (len(d.description) > LIMITS.description) return 'description_too_long';
  const cf = customFieldsError(d.custom_fields); if (cf) return cf;
  if (Array.isArray(d.documents)) {
    if (d.documents.length > LIMITS.documents) return 'too_many_documents';
    for (const x of d.documents) { const e = docError(x); if (e) return e; }
  }
  if (Array.isArray(d.collaborators) && d.collaborators.length > LIMITS.collaborators) return 'too_many_collaborators';
  return null;
}
export function commentError(body) { return len(body) > LIMITS.comment ? 'comment_too_long' : null; }
export function bulkIdsError(ids) { return Array.isArray(ids) && ids.length > LIMITS.bulkIds ? 'too_many_ids' : null; }
export function scratchBodyError(body) { return len(body) > LIMITS.scratchBody ? 'body_too_long' : null; }
