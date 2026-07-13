const DAY_MS = 86400000;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The IST calendar values of an instant. IST = UTC+5:30, fixed (no DST).
function istCal(now) {
  const ist = new Date(now.getTime() + 330 * 60000);
  return { y: ist.getUTCFullYear(), mo: ist.getUTCMonth(), d: ist.getUTCDate(), h: ist.getUTCHours(), mi: ist.getUTCMinutes() };
}
// A calendar day anchored in UTC. getUTCDay() on it == the IST weekday (we built it from IST Y/M/D).
function anchor(y, mo, d) { return new Date(Date.UTC(y, mo, d)); }

export function addTransit(day, transitDays) {
  return new Date(day.getTime() + Number(transitDays) * DAY_MS);
}

export function dispatchDate(now, cfg) {
  const c = istCal(now);
  let day = anchor(c.y, c.mo, c.d);
  const isWorking = (dt) => !cfg.nonWorkingDays.includes(dt.getUTCDay());
  const beforeCutoff = c.h < cfg.cutoffHour || (c.h === cfg.cutoffHour && c.mi < cfg.cutoffMin);
  if (beforeCutoff && isWorking(day)) return day;
  do { day = new Date(day.getTime() + DAY_MS); } while (!isWorking(day));
  return day;
}

export function formatEdd(day) {
  return `${DOW[day.getUTCDay()]}, ${day.getUTCDate()} ${MON[day.getUTCMonth()]}`;
}
