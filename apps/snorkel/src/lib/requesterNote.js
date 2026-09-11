// The "Note for Finance" on a payment request — no React import here on purpose, so the same
// function is importable from a plain node:test file in snorkelops-worker/test without pulling
// in Next/React. Keep this file free of JSX/hooks.
//
// ⚠️ snorkelops-worker is a zero-import single file and cannot import out of apps/, so it holds
// an INLINE copy of parseRequesterNote (search `REQUESTER NOTE — VERBATIM PORT` in
// snorkelops-worker/src/index.js). Same arrangement as tds.js/computeTds. The tests in
// snorkelops-worker/test/requester-note.test.mjs are the spec both sides must satisfy.
//
// What it is: free text the requester passes to Finance — typically the payee's bank details,
// which procurement sources and used to share separately on Slack (Siddu, #bugs 1789042876.535959).
// ⚠️ PLAIN TEXT, NOT MASKED, and deliberately NOT routed through payment_payee_banks / maskBank()
// (Afshaan, 2026-09-11): the team sourcing the details sees them anyway. It lives on the REQUEST,
// not the payee, so it never becomes a bank record anyone else pays against.

export const REQUESTER_NOTE_MAX = 2000;

//   { note: null,   error: null }  → no note (absent, null, '' or whitespace-only)
//   { note: '…',    error: null }  → store this (trimmed; inner line breaks kept)
//   { note: null,   error: '…' }   → the caller must refuse the request with a 400 and say why
export function parseRequesterNote(raw) {
  if (raw === undefined || raw === null) return { note: null, error: null };
  // Reject on TYPE before coercing — String([1,2]) is '1,2' and String({}) is '[object Object]',
  // either of which would be stored as if the requester had typed it. The form only sends strings.
  if (typeof raw !== 'string') return { note: null, error: 'Note for Finance must be text' };
  const note = raw.trim();
  if (note === '') return { note: null, error: null };
  if (note.length > REQUESTER_NOTE_MAX) {
    return { note: null,
      error: `Note for Finance is ${note.length} characters — keep it to ${REQUESTER_NOTE_MAX}` };
  }
  return { note, error: null };
}
