// F9 R9b — the score trend (spec §8.1 #2, §8.5) and the monthly re-plan (§8.7). Pure; no I/O. Every input is
// ALREADY gated by the worker: week_score payloads (the R5 official function — never recomputed from tasks) with,
// below level F, their task rows cut to what the caller may count; plan rows from plan_items_for at level F.
import { addDays, weekEndOf } from './weeks-core.mjs';
import { scoreBlock } from './review-core.mjs';
import { metricByKey } from './plan-metrics.mjs';

export const TREND_DEFAULT = 8, TREND_MAX = 26;
export const REPLAN_RISK_DAYS = 35, REPLAN_ACTION_DAYS = 14;

// ?weeks= → 1..26 (default 8); anything else → null (400).
export function trendWeeksParam(v) {
  if (v === null || v === undefined || v === '') return TREND_DEFAULT;
  if (!/^\d{1,2}$/.test(String(v))) return null;
  const n = Number(v);
  return n >= 1 && n <= TREND_MAX ? n : null;
}
// The last n CLOSED-able week ends before the week holding `today` (oldest first): the current week never counts.
export function trendWeekEnds(today, dow, n) {
  const cur = weekEndOf(today, dow);
  return Array.from({ length: n }, (_, k) => addDays(cur, -7 * (n - k)));
}
const point = (week_end, b) => ({ week_end, on_time: b ? Number(b.on_time) || 0 : 0, cohort: b ? Number(b.cohort) || 0 : 0,
  pct: b && Number(b.cohort) > 0 && b.pct !== null && b.pct !== undefined ? Number(b.pct) : null });

// weekEnds — oldest first; scores — { [week_end]: week_score payload } for CLOSED weeks only (others → no cohort);
// whole — level F: week_score's own team rows + totals; otherwise `rowsOf(score)` (the caller-countable task
// rows) grouped here, as the review pack does. teamId — one team (null = all). deptNames — { id: name }.
// → { weeks, teams: [{ id, name, points }], overall: [point] }
export function trendModel({ weekEnds = [], scores = {}, whole = false, rowsOf = () => [], teamId = null, deptNames = {} }) {
  const per = weekEnds.map(we => {
    const s = scores[we];
    if (!s) return { we, teams: new Map(), overall: null };
    const teams = new Map();
    let overall;
    if (whole) {
      for (const t of Array.isArray(s.teams) ? s.teams : []) teams.set(t.department_id || null, t);
      overall = teamId ? teams.get(teamId) || null : s.totals || null;
    } else {
      const rows = rowsOf(s).filter(r => !teamId || (r.department_id || null) === teamId);
      for (const r of rows) { const k = r.department_id || null; teams.set(k, [...(teams.get(k) || []), r]); }
      for (const [k, rs] of teams) teams.set(k, scoreBlock(rs, true));
      overall = scoreBlock(rows, true);
    }
    return { we, teams, overall };
  });
  const ids = teamId ? [teamId] : [...new Set(per.flatMap(p => [...p.teams.keys()]))];
  ids.sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || String(deptNames[a] || '').localeCompare(String(deptNames[b] || '')));
  return {
    weeks: weekEnds,
    teams: ids.map(id => ({ id, name: id ? deptNames[id] || null : 'No team', points: per.map(p => point(p.we, p.teams.get(id))) })),
    overall: per.map(p => point(p.we, p.overall)),
  };
}

// ?month=YYYY-MM (default: next month in IST) → { month, first, last, prev, prevFirst, prevLast } | null
export function replanMonth(param, today) {
  let y, m;
  if (param === null || param === undefined || param === '') { [y, m] = today.split('-').map(Number); m += 1; if (m > 12) { m = 1; y += 1; } }
  else {
    const x = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(param));
    if (!x) return null;
    y = Number(x[1]); m = Number(x[2]);
  }
  const mm = (yy, mo) => `${yy}-${String(mo).padStart(2, '0')}`;
  const first = `${mm(y, m)}-01`;
  const last = addDays(m === 12 ? `${mm(y + 1, 1)}-01` : `${mm(y, m + 1)}-01`, -1);
  const prevFirst = m === 1 ? `${mm(y - 1, 12)}-01` : `${mm(y, m - 1)}-01`;
  return { month: mm(y, m), first, last, prev: prevFirst.slice(0, 7), prevFirst, prevLast: addDays(first, -1) };
}
// Every week end (dow) falling inside [from, to].
export function weekEndsIn(from, to, dow) {
  const out = [];
  for (let d = weekEndOf(from, dow); d <= to; d = addDays(d, 7)) out.push(d);
  return out;
}

const OPEN = (s) => s !== 'done' && s !== 'abandoned';
// Readiness of one milestone (§8.7): agreed? an ACTIVE owner? a data source (a measure on a registry metric the
// system records today — manual never)? actionable tasks (open, top-level, linked to it or its results, effective
// deadline in the month's first 14 IST days — `tasks` arrive already cut to that window and live)?
export function readiness(ms, { activeOwners = new Set(), tasks = [], resultIds = [] } = {}) {
  const m = ms.measure && typeof ms.measure === 'object' ? ms.measure : null;
  const reg = m ? metricByKey(m.metric) : null;
  const linked = new Set([ms.id, ...resultIds]);
  const r = {
    agreed: ms.state === 'agreed',
    owner: !!ms.owner_employee_id && activeOwners.has(ms.owner_employee_id),
    data_source: !!reg && reg.key !== 'manual' && !!reg.source_ok,
    actionable: tasks.filter(t => linked.has(t.plan_item_id) && !t.parent_task_id && OPEN(t.status)).length,
  };
  return { ...r, ready: r.agreed && r.owner && r.data_source && r.actionable > 0 };
}
