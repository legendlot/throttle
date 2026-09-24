// Days / hours / minutes <-> the engine's single-unit duration string.
// The engine (commsops-worker journey-graph.js durationToMs) accepts ONE "N unit" term —
// second|minute|hour|day|week, plural optional — so a split entry like 2 h 30 m is stored as
// its total in the largest unit that divides it exactly ("150 minutes", "3 hours", "2 days").
// CommonJS so a plain `node duration.test.js` runs it; webpack interops fine (as graph.js).
const UNIT_MIN = { second: 1 / 60, minute: 1, hour: 60, day: 1440, week: 10080 };

// "6 hours" -> 360. Unparseable / empty -> null.
function durToMinutes(str) {
  const m = String(str || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week)s?$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * UNIT_MIN[m[2]]);
}

// 150 -> { d: 0, h: 2, m: 30 }.
function splitMinutes(total) {
  const t = Math.max(0, Math.round(Number(total) || 0));
  return { d: Math.floor(t / 1440), h: Math.floor((t % 1440) / 60), m: t % 60 };
}

// { d, h, m } -> engine string; 0 total -> '' (the drawer's "not set").
function toDurString({ d = 0, h = 0, m = 0 }) {
  const total = Math.round((Number(d) || 0) * 1440 + (Number(h) || 0) * 60 + (Number(m) || 0));
  if (total <= 0) return '';
  if (total % 1440 === 0) { const n = total / 1440; return `${n} ${n === 1 ? 'day' : 'days'}`; }
  if (total % 60 === 0)   { const n = total / 60;   return `${n} ${n === 1 ? 'hour' : 'hours'}`; }
  return `${total} ${total === 1 ? 'minute' : 'minutes'}`;
}

// Canvas label: "150 minutes" reads as "2h 30m"; a single-unit value ("6 hours") and
// anything unparseable are shown as stored.
function fmtDur(str) {
  const mins = durToMinutes(str);
  if (mins == null || mins <= 0) return str;
  const { d, h, m } = splitMinutes(mins);
  const bits = [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean);
  return bits.length > 1 ? bits.join(' ') : str;
}

module.exports = { durToMinutes, splitMinutes, toDurString, fmtDur };
