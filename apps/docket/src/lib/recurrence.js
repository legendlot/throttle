// Docket — recurrence vocabulary + formatting (client mirror of the docketops worker).
// A recurrence is { freq:'daily'|'weekly'|'monthly', days_of_week:[0..6], day_of_month:1..31, time:'HH:MM' }.
// Days: 0=Sun..6=Sat (JS getDay). All times are IST. RULE-DOCKET-008.

export const WEEKDAYS = [
  { v: 0, label: 'Sun', full: 'Sunday' },
  { v: 1, label: 'Mon', full: 'Monday' },
  { v: 2, label: 'Tue', full: 'Tuesday' },
  { v: 3, label: 'Wed', full: 'Wednesday' },
  { v: 4, label: 'Thu', full: 'Thursday' },
  { v: 5, label: 'Fri', full: 'Friday' },
  { v: 6, label: 'Sat', full: 'Saturday' },
];

export function fmtTime(t) {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return '';
  const [h, m] = t.split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function recurrenceSummary(rec) {
  if (!rec || !rec.freq) return '—';
  const at = rec.time ? ` at ${fmtTime(rec.time)}` : '';
  const until = rec.until ? ` · until ${fmtISTDateShort(rec.until)}` : '';
  let base = '—';
  if (rec.freq === 'daily') base = `Daily${at}`;
  else if (rec.freq === 'weekly') {
    const days = (rec.days_of_week || []).slice().map(Number).sort((a, b) => a - b);
    if (days.length === 7) base = `Every day${at}`;
    else if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) base = `Weekdays${at}`;
    else base = `Weekly · ${days.map(d => WEEKDAYS[d]?.label).filter(Boolean).join(', ')}${at}`;
  } else if (rec.freq === 'monthly') base = `Monthly on the ${ordinal(Number(rec.day_of_month))}${at}`;
  return base + until;
}

// IST 'YYYY-MM-DD' today (matches the worker's istDateStr).
export function todayIST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Pretty IST date for a 'YYYY-MM-DD' string (no Date()-timezone drift).
export function fmtISTDate(dateStr) {
  if (!dateStr) return '';
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'long', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}
// Compact 'DD Mon YYYY' (for the recurrence summary's "until …").
export function fmtISTDateShort(dateStr) {
  if (!dateStr) return '';
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

// Client-side validity check (worker re-validates).
export function isValidRecurrence(rec) {
  if (!rec || !['daily', 'weekly', 'monthly'].includes(rec.freq)) return false;
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(rec.time || '')) return false;
  if (rec.until && !/^\d{4}-\d{2}-\d{2}$/.test(rec.until)) return false;
  if (rec.freq === 'weekly') return Array.isArray(rec.days_of_week) && rec.days_of_week.length > 0;
  if (rec.freq === 'monthly') { const d = Number(rec.day_of_month); return Number.isInteger(d) && d >= 1 && d <= 31; }
  return true;
}
