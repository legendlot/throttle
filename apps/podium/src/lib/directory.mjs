// The People directory's tab + department filter, applied to the full list the page already holds
// (getEmployees status=all). Pure — tested in test/directory.test.mjs.
//
// This replaces a second getEmployees call per tab/department change. It is safe because the worker
// projects each row per (caller, row) — canSeeFull → full row, else projectPublic — independent of the
// filters, so the full list and a filtered call return the same row objects for the same caller; and
// both are ordered full_name.asc. The filters mirror getEmployees exactly:
//   status=active|on_leave|exited → status equals it; status=notice → people with an open exit (the
//   on_notice flag every row carries); status=all → no status filter; department_id → equals it.
// Text search stays on the server (it matches preferred_name / employee_code / work_email too).
export function directoryRows(all, { tab, dept } = {}) {
  return (Array.isArray(all) ? all : []).filter(e => {
    if (tab === 'notice') { if (!e.on_notice) return false; }
    else if (tab && tab !== 'all' && e.status !== tab) return false;
    if (dept && e.department_id !== dept) return false;
    return true;
  });
}

// Filtering locally is only right if the full list IS the full list. getEmployees(status=all) is asked for
// DIRECTORY_ALL_LIMIT rows; a reply that fills it may have been cut off, so then (and for any text search)
// every filter goes back to the server.
export const DIRECTORY_ALL_LIMIT = 2000;
export function filterOnServer({ query, all, limit = DIRECTORY_ALL_LIMIT }) {
  if (String(query || '').trim()) return true;
  return Array.isArray(all) && all.length >= limit;
}
