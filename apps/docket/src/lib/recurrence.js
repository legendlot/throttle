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

// Template recurrences have no single `time` (times live on sections). RULE-DOCKET-009.
export function isValidTemplateRecurrence(rec) {
  if (!rec || !['daily', 'weekly', 'monthly'].includes(rec.freq)) return false;
  if (rec.until && !/^\d{4}-\d{2}-\d{2}$/.test(rec.until)) return false;
  if (rec.freq === 'weekly') return Array.isArray(rec.days_of_week) && rec.days_of_week.length > 0;
  if (rec.freq === 'monthly') { const d = Number(rec.day_of_month); return Number.isInteger(d) && d >= 1 && d <= 31; }
  return true;
}
export function templateRecurrenceSummary(rec) {
  if (!rec || !rec.freq) return '—';
  const until = rec.until ? ` · until ${fmtISTDateShort(rec.until)}` : '';
  if (rec.freq === 'daily') return 'Daily' + until;
  if (rec.freq === 'weekly') {
    const days = (rec.days_of_week || []).slice().map(Number).sort((a, b) => a - b);
    if (days.length === 7) return 'Every day' + until;
    if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) return 'Weekdays' + until;
    return `Weekly · ${days.map(d => WEEKDAYS[d]?.label).filter(Boolean).join(', ')}` + until;
  }
  if (rec.freq === 'monthly') return `Monthly on the ${ordinal(Number(rec.day_of_month))}` + until;
  return '—';
}

// Client mirror of the worker's isDueOn / isExpired (docketops index.js) — used ONLY to
// preview the rest of this week on the checklist; the worker stays the source of due_today.
export function isDueOn(rec, dateStr) {
  if (!rec || !rec.freq) return false;
  if (rec.freq === 'daily') return true;
  if (rec.freq === 'weekly') {
    const wd = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
    return Array.isArray(rec.days_of_week) && rec.days_of_week.map(Number).includes(wd);
  }
  if (rec.freq === 'monthly') {
    const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7), day = +dateStr.slice(8, 10);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const dom = Number(rec.day_of_month);
    return day === dom || (day === lastDay && dom > lastDay);
  }
  return false;
}
export function isExpired(rec, dateStr) { return !!(rec && rec.until && rec.until < dateStr); }

// The IST dates AFTER `dateStr` up to and including that week's Sunday (Mon-start week).
// Empty on a Sunday.
export function restOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const left = (7 - base.getUTCDay()) % 7;          // Sun → 0, Mon → 6, … Sat → 1
  const out = [];
  for (let i = 1; i <= left; i++) {
    const dt = new Date(base); dt.setUTCDate(dt.getUTCDate() + i);
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}
