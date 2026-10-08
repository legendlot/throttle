// The team's calendar is IST. `new Date().toISOString()` is UTC, so from 00:00 to 05:29 IST it
// still reads yesterday — and on the 1st of the month it reads LAST month (B3, S412: Dashboard
// and Targets showed the previous month's target for the first 5½ hours of every month).
// Shifting by +5:30 and reading the UTC fields gives IST regardless of the browser's zone.
const IST_MS = 5.5 * 3600 * 1000;

export function istToday(now = Date.now()) {
  return new Date(now + IST_MS).toISOString().slice(0, 10);
}

export function istMonth(now = Date.now()) {
  return istToday(now).slice(0, 7);
}
