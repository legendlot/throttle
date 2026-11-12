// Hiring O2 — interview rounds + feedback: labels and the client mirror of podiumops-worker/src/interviews.js.
// The worker is the authority on every gate; these only decide what the UI offers.
// Plan: docs/superpowers/plans/2026-11-12-podium-o2-interviews.md.

export const INTERVIEW_MODES = [
  { id: 'in_person', label: 'In person' },
  { id: 'video',     label: 'Video' },
  { id: 'phone',     label: 'Phone' },
];
export const INTERVIEW_STATUSES = [
  { id: 'scheduled', label: 'Scheduled', tone: 'info' },
  { id: 'completed', label: 'Completed', tone: 'ok' },
  { id: 'cancelled', label: 'Cancelled', tone: 'neutral' },
  { id: 'no_show',   label: 'No-show',   tone: 'bad' },
];
export const VERDICTS = [
  { id: 'advance', label: 'Advance', tone: 'ok' },
  { id: 'hold',    label: 'Hold',    tone: 'warn' },
  { id: 'reject',  label: 'Reject',  tone: 'bad' },
];
export const RECOMMENDATIONS = [
  { id: 'strong_yes', label: 'Strong yes', tone: 'ok' },
  { id: 'yes',        label: 'Yes',        tone: 'ok' },
  { id: 'no',         label: 'No',         tone: 'bad' },
  { id: 'strong_no',  label: 'Strong no',  tone: 'bad' },
];
// One panelist's feedback state (feedbackState in the worker).
export const FEEDBACK_STATES = [
  { id: 'upcoming',   label: 'Upcoming',   tone: 'neutral' },
  { id: 'pending',    label: 'Pending',    tone: 'warn' },
  { id: 'overdue',    label: 'Overdue',    tone: 'bad' },
  { id: 'submitted',  label: 'Submitted',  tone: 'ok' },
  { id: 'not_needed', label: 'Not needed', tone: 'neutral' },
];
export const MAX_CRITERIA = 10;
export const MAX_PANEL = 10;
export const DURATIONS = [30, 45, 60, 90, 120];

// datetime-local values are read and written as IST, whatever the browser's own zone is.
// "2026-11-12T15:30" (IST wall time) → ISO instant.
export function istLocalToIso(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}:00+05:30`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
// ISO instant → "2026-11-12T15:30" (IST wall time) for a datetime-local input.
export function isoToIstLocal(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  return new Date(t + 330 * 60000).toISOString().slice(0, 16);
}
export const isPast = (iso) => Number.isFinite(Date.parse(iso || '')) && Date.parse(iso) <= Date.now();
