// /me: which employee record to show, and when the page may say there is none. Pure — tested in
// test/myLink.test.mjs.
//
// The auth context's employee id (getMe, possibly a cached or republished copy) is only ever OPTIMISTIC:
// a positive id may mount the panels at once, but nothing in the context proves a link is absent. The
// one authority is THIS page's own getMyPerformance:
//   ok + id     → that id (it wins over the context's)        ok + no id → "no employee profile linked"
//   loading     → the context's id if it has one, else a neutral loading shell
//   error       → the context's id with a compact error + Retry for the performance bits, else error + Retry
// `perfStatus` is 'loading' | 'ok' | 'error'.
export function decideLink({ contextId, perfStatus, perfId }) {
  if (perfStatus === 'ok') {
    return perfId ? { state: 'panels', employeeId: perfId, perfError: false } : { state: 'noProfile', employeeId: null, perfError: false };
  }
  if (contextId) return { state: 'panels', employeeId: contextId, perfError: perfStatus === 'error' };
  return perfStatus === 'error'
    ? { state: 'error', employeeId: null, perfError: true }
    : { state: 'loading', employeeId: null, perfError: false };
}
