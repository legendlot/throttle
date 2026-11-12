// F9 R9b — the monthly re-plan page (/plan/replan, spec §8.7; level F). Pure helpers: the month stepper,
// readiness cells and sort, the team filter, and the scores block's shape. Readiness itself is the worker's.
import { istDate } from './weeks.js';

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export function isMonth(s) { return typeof s === 'string' && MONTH_RE.test(s); }
export function stepMonth(ym, n) {
  if (!isMonth(ym)) return null;
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}
// The default: next month in IST.
export function nextMonthIST(now = Date.now()) { return stepMonth((istDate(now) || '').slice(0, 7), 1); }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthLabel(ym) { return isMonth(ym) ? `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : ''; }

export const READINESS = [
  { key: 'agreed', label: 'Agreed' },
  { key: 'owner', label: 'Owner' },
  { key: 'data_source', label: 'Data source' },
  { key: 'actionable', label: 'Tasks (first 2 wks)' },
];
export function readinessCells(m) {
  const r = m?.readiness || {};
  return READINESS.map(c => (c.key === 'actionable'
    ? { key: c.key, ok: Number(r.actionable) > 0, n: Number(r.actionable) || 0 }
    : { key: c.key, ok: r[c.key] === true }));
}
// The worker sends `ready`; recompute only if it's missing (same rule as the contract).
export function isReady(m) {
  if (typeof m?.ready === 'boolean') return m.ready;
  const r = m?.readiness || {};
  return !!(r.agreed && r.owner && r.data_source && Number(r.actionable) > 0);
}
// Not ready first (when asked), then by effective due, then code.
export function sortReadiness(list = [], notReadyFirst = true) {
  return [...(list || [])].filter(Boolean).sort((a, b) =>
    (notReadyFirst ? (isReady(a) ? 1 : 0) - (isReady(b) ? 1 : 0) : 0)
    || String(a.effective_due || '9999').localeCompare(String(b.effective_due || '9999'))
    || String(a.code || '').localeCompare(String(b.code || '')));
}
// `team` may arrive as a name, an { id, name } or alongside a team_id — key and label it either way.
export function teamKey(m) { const t = m?.team; return m?.team_id || (t && typeof t === 'object' ? (t.id || t.name || '') : (t || '')); }
export function teamName(m) { const t = m?.team; return (t && typeof t === 'object' ? t.name : t) || m?.team_name || 'No team'; }
export function teamOptions(list = []) {
  const seen = new Map();
  for (const m of list || []) { const k = teamKey(m); if (k && !seen.has(k)) seen.set(k, teamName(m)); }
  return [{ value: '', label: 'All teams' }, ...[...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))];
}
export function filterTeam(list = [], key) { return key ? (list || []).filter(m => teamKey(m) === key) : (list || []); }

// scores → { weeks: [week_end], rows: [{ key, name, cells: [{ week_end, pct, on_time, cohort }] }] } with
// "All teams" first. Takes the trend shape ({ weeks, overall, teams: [{ id, name, points }] }) or a list of
// week_score-like objects ([{ week_end, totals|overall, teams: [{ department_id|id, name, … }] }]).
export function scoresTable(s) {
  if (!s) return { weeks: [], rows: [] };
  if (Array.isArray(s)) {
    const weeks = s.map(w => w?.week_end).filter(Boolean);
    const byTeam = new Map();
    const overall = { key: 'all', name: 'All teams', cells: [] };
    for (const w of s) {
      if (!w?.week_end) continue;
      const tot = w.totals || w.overall || {};
      overall.cells.push({ week_end: w.week_end, pct: tot.pct ?? null, on_time: tot.on_time ?? 0, cohort: tot.cohort ?? 0 });
      for (const t of w.teams || []) {
        const k = t.department_id || t.id || t.name || 'none';
        if (!byTeam.has(k)) byTeam.set(k, { key: k, name: t.name || t.team_name || 'No team', cells: [] });
        byTeam.get(k).cells.push({ week_end: w.week_end, pct: t.pct ?? null, on_time: t.on_time ?? 0, cohort: t.cohort ?? 0 });
      }
    }
    return { weeks, rows: [overall, ...byTeam.values()] };
  }
  const weeks = s.weeks || (s.overall || []).map(p => p.week_end);
  const cell = (pts, we) => { const p = (pts || []).find(x => x?.week_end === we); return p ? { week_end: we, pct: p.pct ?? null, on_time: p.on_time ?? 0, cohort: p.cohort ?? 0 } : { week_end: we, pct: null, on_time: 0, cohort: 0 }; };
  return { weeks, rows: [{ key: 'all', name: 'All teams', cells: weeks.map(we => cell(s.overall, we)) },
    ...(s.teams || []).map(t => ({ key: t.id || t.name, name: t.name || 'No team', cells: weeks.map(we => cell(t.points, we)) }))] };
}

// A risk proposal's status, worded — never the raw code.
const RISK_STATUS = { submitted: 'Open', accepted: 'Accepted', declined: 'Declined' };
export function riskStatusLabel(status) { return status ? (RISK_STATUS[status] || 'Closed') : ''; }
