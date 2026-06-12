// Client helpers for checklist runs (progress + completion-time display). RULE-DOCKET-009.
export function runProgress(run) {
  let done = 0, total = 0;
  (run?.sections || []).forEach(s => (s.items || []).forEach(i => { total++; if (i.completed) done++; }));
  return { done, total };
}
// 'h:MM AM/PM' in IST for an ISO timestamp (completion time display).
export function fmtClockIST(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso));
}
