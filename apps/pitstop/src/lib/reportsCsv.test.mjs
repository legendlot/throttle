// Tests for the /reports CSV builders.
//
// ⭐ WHY THIS FILE EXISTS. On 2026-09-09 (S365) four defects shipped from `reports/page.js` in a
// single day and EVERY suite in the repo stayed green, because nothing anywhere touched that file.
// Each defect below has a named test, so the same mistake fails here instead of in someone's
// spreadsheet. The fixtures are the REAL handler shapes, copied from csops `getCallReports`
// (`index.js:2437`/`:2452`/`:2558`) and `getAgentConversationDaily` — that fidelity is the whole
// point: three of the four defects were the builder reading a key the payload does not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  csvEsc, istDay, finishCallRow,
  buildTicketsCsv, buildAgentsCsv, buildCallsCsv,
} from './reportsCsv.js';

const rows = (csv) => csv.replace(/^﻿/, '').split('\n');
const find = (csv, prefix) => rows(csv).find(l => l.startsWith(prefix));
const after = (csv, prefix, n = 1) => {
  const all = rows(csv);
  const i = all.findIndex(l => l.startsWith(prefix));
  return i === -1 ? undefined : all[i + n];
};

// The exact shape getCallReports returns (csops index.js:2437 team, :2452 per-agent).
const callFixture = () => ({
  range: { from: '2025-12-31T18:30:00.000Z', to: '2026-09-09T18:29:59.999Z', business_hours: false, rows_24x7: 20370 },
  totals: { total: 40, incoming_reached: 31, incoming_not_reached: 9, avg_duration_seconds: 62 },
  by_direction: { incoming: { total: 40, answered: 31, answer_rate_pct: 77.5 }, outgoing: { total: 12, answered: 9, answer_rate_pct: 75 } },
  // ⚠️ BOTH sides of every alias, with DIFFERENT values on purpose. `finishDept`/`finishAccount`
  // (csops :2544-:2555) ALWAYS set `incoming_reached` + `incoming_not_reached`, and `byAgent`
  // always carries `answered_calls` AND `incoming_answered` — so a live row has both, and a
  // fixture with only one side cannot tell `a ?? b` from `b ?? a`. The legacy `answered`/`missed`
  // are the RAW provider counts across BOTH directions (the "false 45" csops :2564 warns about),
  // so picking them for an inbound column is a real, silent wrong number.
  by_department: [{ name: 'Support', slug: 'support', total: 40, incoming_reached: 31, incoming_not_reached: 9, answered: 38, missed: 2, outgoing_total: 12, outgoing_answered: 9, answer_rate_pct: 77.5 }],
  by_account: [{ name: 'MyOp A', slug: 'a', total: 40, incoming_reached: 31, incoming_not_reached: 9, answered: 38, missed: 2, answer_rate_pct: 77.5 }],
  by_agent: [{ name: 'Dhiraj Sharma', incoming_answered: 14, answered_calls: 19, outgoing_total: 5, outgoing_answered: 4, missed_returned: 2, avg_handle_seconds: 60, tickets_opened: 3 }],
  daily: [{ date: '2026-09-08', in_total: 40, in_answered: 31, out_total: 12, out_answered: 9, dur_sum: 2480, dur_count: 40 }],
  daily_by_agent: [{ name: 'Dhiraj Sharma', days: [{ date: '2026-09-08', in_answered: 14, out_total: 5, out_answered: 4, dur_sum: 900, dur_count: 15 }] }],
  hourly: [{ hour: 23, count: 56 }],
});

// ── the four S365 regressions ───────────────────────────────────────────────

test('REGRESSION S365-1: the Calls trend uses `date`, not `day` — no blank date cells', () => {
  const csv = buildCallsCsv({ callData: callFixture(), from: '2026-01-01', to: '2026-09-09' });
  const teamRow = after(csv, 'Day,Agent,');
  assert.match(teamRow, /^2026-09-08,All agents,/, 'team trend row must start with a real ISO date');
  const agentRow = after(csv, 'Day,Agent,', 2);
  assert.match(agentRow, /^2026-09-08,Dhiraj Sharma,/, 'per-agent trend row must carry the date too');
  // The shipped bug produced rows starting with a bare comma.
  assert.equal(rows(csv).some(l => l.startsWith(',All agents')), false);
});

test('REGRESSION S365-2: derived metrics are computed, not read raw — no blank metric columns', () => {
  const csv = buildCallsCsv({ callData: callFixture(), from: '2026-01-01', to: '2026-09-09' });
  // in_missed = 40-31 = 9 · answer_rate = 77.5 · avg_duration = 2480/40 = 62
  assert.equal(after(csv, 'Day,Agent,'), '2026-09-08,All agents,40,31,9,77.5,12,9,62');
  // Per-agent: the three teamOnly columns blank BY DESIGN, avg_duration still derived (900/15=60).
  assert.equal(after(csv, 'Day,Agent,', 2), '2026-09-08,Dhiraj Sharma,,14,,,5,4,60');
});

test('REGRESSION S365-3: the header names the IST day, not the UTC slice (PATTERN-221)', () => {
  const csv = buildCallsCsv({ callData: callFixture(), from: '2026-01-01', to: '2026-09-09' });
  // range.from is 2025-12-31T18:30Z — IST midnight on 2026-01-01. Slicing it names the 31st.
  assert.equal(rows(csv)[0], 'Pitstop Call Report,2026-01-01 to 2026-09-09');
});

test('REGRESSION S365-4: every trend row has the same column count as its header', () => {
  const csv = buildCallsCsv({ callData: callFixture(), from: '2026-01-01', to: '2026-09-09' });
  const all = rows(csv);
  const i = all.findIndex(l => l.startsWith('Day,Agent,'));
  const width = all[i].split(',').length;
  assert.equal(width, 9);
  for (const r of [all[i + 1], all[i + 2]]) assert.equal(r.split(',').length, width);
});

// ── gating: each tab exports its own file, or none ──────────────────────────

test('an empty range exports nothing rather than a file saying zero', () => {
  const cd = callFixture();
  cd.totals.total = 0;
  assert.equal(buildCallsCsv({ callData: cd, from: 'a', to: 'b' }), null);
  assert.equal(buildCallsCsv({ callData: null, from: 'a', to: 'b' }), null);
  assert.equal(buildCallsCsv({ callData: { range: {} }, from: 'a', to: 'b' }), null);
});

test('tickets and agents builders refuse an absent payload', () => {
  assert.equal(buildTicketsCsv({ data: null, from: 'a', to: 'b' }), null);
  assert.equal(buildAgentsCsv({ agentData: null, from: 'a', to: 'b' }), null);
  assert.equal(buildAgentsCsv({ agentData: { by_agent: [] }, from: 'a', to: 'b' }), null);
});

test('each builder writes its own title line — no tab can hand you another tab\'s file', () => {
  const t = buildTicketsCsv({ data: { range: { total_rows: 1 } }, from: 'a', to: 'b' });
  const c = buildCallsCsv({ callData: callFixture(), from: 'a', to: 'b' });
  const g = buildAgentsCsv({ agentData: { by_agent: [{ name: 'X' }], totals: {} }, from: 'a', to: 'b' });
  assert.match(rows(t)[0], /^Pitstop Report,/);
  assert.match(rows(c)[0], /^Pitstop Call Report,/);
  assert.match(rows(g)[0], /^Pitstop Agent Conversation Report,/);
});

// ── the tickets export must not throw on a partial payload (S365 review) ────

test('the tickets builder survives a payload missing every optional section', () => {
  // This threw a TypeError inside the click handler before the guards went in: the button
  // appeared to do nothing at all, with nothing surfaced to the user.
  const csv = buildTicketsCsv({ data: { range: { total_rows: 7 } }, from: '2026-01-01', to: '2026-09-09' });
  assert.match(csv, /Tickets raised,7/);
  assert.equal(csv.includes('By Product'), false, 'an absent section is omitted, not blank');
  assert.equal(csv.includes('Cost Summary'), false);
});

test('the tickets builder renders the sections it does have', () => {
  const csv = buildTicketsCsv({
    data: {
      range: { total_rows: 2, range_total: 5 },
      by_product: [{ name: 'Shadow', total: 2, replacement: 1 }],
      by_agent: [{ name: 'Sunitha B', total: 2, closed: 1, avg_close_days: 3.5 }],
      cost_summary: { return_cost_inr: 100, replacement_cost_inr: 200, refund_amount_inr: 0 },
      conversations: { handled: 9, total: 12, unfiltered: true },
    }, from: 'a', to: 'b',
  });
  assert.equal(after(csv, 'By Product,'), 'Shadow,2,1,0,0');
  assert.equal(after(csv, 'By Agent,'), 'Sunitha B,2,1,3.5');
  assert.match(csv, /Tickets raised in range \(before filters\),5/);
  assert.match(csv, /Conversations handled \(whole range — not filtered\),9/);
});

// ── escaping is one implementation, and it is the strong one ────────────────

test('csvEsc neutralises spreadsheet formulas', () => {
  // An agent display name is attacker-adjacent enough to matter, and the Agents export used to
  // carry its own copy that did neither of these.
  assert.equal(csvEsc('=1+1'), "'=1+1");
  assert.equal(csvEsc('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvEsc('-2'), "'-2");
  assert.equal(csvEsc('+x'), "'+x");
});

test('csvEsc quotes commas, quotes, CR and LF', () => {
  assert.equal(csvEsc('a,b'), '"a,b"');
  assert.equal(csvEsc('say "hi"'), '"say ""hi"""');
  assert.equal(csvEsc('a\r\nb'), '"a\r\nb"');
  assert.equal(csvEsc(null), '');
  assert.equal(csvEsc(undefined), '');
  assert.equal(csvEsc(0), '0');
});

test('the agents CSV escapes through csvEsc, not a weaker local copy', () => {
  const csv = buildAgentsCsv({
    agentData: { by_agent: [{ name: '=cmd|calc', assigned: 1 }], totals: {} },
    from: 'a', to: 'b',
  });
  assert.match(csv, /'=cmd\|calc/, 'a formula-shaped agent name must be neutralised');
});

test('a comma in a resolved cohort label cannot split the row', () => {
  const csv = buildAgentsCsv({
    agentData: { by_agent: [{ name: 'X' }], totals: {} },
    from: 'a', to: 'b', cohort: { channel: 'WhatsApp | Email', tag: 'refund, urgent' },
  });
  assert.equal(find(csv, 'Tag,'), 'Tag,"refund, urgent"');
});

// ── the two payload shapes are NOT interchangeable ──────────────────────────

test('the AGENTS trend reads `day` — its payload is folded server-side, unlike calls', () => {
  const csv = buildAgentsCsv({
    agentData: { by_agent: [{ name: 'A' }], totals: {}, range: {} },
    dailyData: {
      range: { grain: 'week', business_hours: true },
      metrics: [{ key: 'queries', label: 'Queries', kind: 'count' }],
      days: [{ day: '2026-09-07', queries: 12 }],
      by_agent: [{ name: 'A', days: [{ day: '2026-09-07', queries: 5 }] }],
    }, from: 'a', to: 'b',
  });
  assert.match(csv, /Weekly trend \(business hours\),1 weeks/);
  assert.equal(after(csv, 'Week beginning,Agent,'), '2026-09-07,All agents,12');
  assert.equal(after(csv, 'Week beginning,Agent,', 2), '2026-09-07,A,5');
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('istDay round-trips an IST boundary in both directions', () => {
  assert.equal(istDay('2025-12-31T18:30:00.000Z'), '2026-01-01');  // start of day
  assert.equal(istDay('2026-09-09T18:29:59.999Z'), '2026-09-09');  // end of day
  assert.equal(istDay('2026-12-30T18:30:00.000Z'), '2026-12-31');  // year boundary
  assert.equal(istDay(undefined, 'fb'), 'fb');
  assert.equal(istDay('nonsense', 'fb'), 'fb');
});

test('finishCallRow keeps inbound-derived metrics off per-agent rows', () => {
  const raw = { date: '2026-09-08', in_total: 10, in_answered: 4, dur_sum: 100, dur_count: 5 };
  const team = finishCallRow(raw, true);
  assert.equal(team.in_missed, 6);
  assert.equal(team.answer_rate, 40);
  assert.equal(team.avg_duration, 20);
  const agent = finishCallRow(raw, false);
  // Deriving these per agent produced NEGATIVE "missed", which is why they are team-only.
  assert.equal(agent.in_missed, null);
  assert.equal(agent.answer_rate, null);
  assert.equal(agent.avg_duration, 20);
});

test('finishCallRow does not divide by zero on a day with no timed calls', () => {
  assert.equal(finishCallRow({ dur_sum: 0, dur_count: 0 }, true).avg_duration, null);
  assert.equal(finishCallRow({ in_total: 0, in_answered: 0 }, true).answer_rate, null);
});

// ── the file Excel actually opens ───────────────────────────────────────────

test('every CSV starts with a UTF-8 BOM', () => {
  // Excel ignores the MIME charset on a double-clicked .csv, and these files carry ₹, → and —.
  for (const csv of [
    buildCallsCsv({ callData: callFixture(), from: 'a', to: 'b' }),
    buildTicketsCsv({ data: { range: { total_rows: 1 } }, from: 'a', to: 'b' }),
    buildAgentsCsv({ agentData: { by_agent: [{ name: 'X' }], totals: {} }, from: 'a', to: 'b' }),
  ]) assert.equal(csv.charCodeAt(0), 0xFEFF);
});

test('the calls CSV carries every panel the tab draws', () => {
  const csv = buildCallsCsv({ callData: callFixture(), from: 'a', to: 'b' });
  for (const section of ['By Department,', 'By MyOp Account,', 'By Direction,', 'By Agent,',
                         'Daily trend (', 'Hourly distribution (IST),']) {
    assert.ok(find(csv, section), `missing section: ${section}`);
  }
  assert.equal(after(csv, 'By MyOp Account,'), 'MyOp A,40,31,9,0,0,77.5');
  assert.equal(after(csv, 'Hourly distribution (IST),'), '23,56');
});

test('REGRESSION S365-5: the inbound aliases pick `incoming_*`, never the raw provider count', () => {
  // A live row carries BOTH. `answered`/`missed` are the provider's own words counted across BOTH
  // directions — the number csops :2564 says must never be the inbound headline. Getting the `??`
  // order backwards is silent: the column still fills, with the wrong figure.
  // The session's own mutation set MISSED this; the S365 hostile review found it by swapping the
  // alias order and watching all 23 tests stay green.
  const csv = buildCallsCsv({ callData: callFixture(), from: 'a', to: 'b' });
  assert.equal(after(csv, 'By Department,'), 'Support,40,31,9,12,9,77.5', 'dept must use incoming_reached (31), not answered (38)');
  assert.equal(after(csv, 'By MyOp Account,'), 'MyOp A,40,31,9,0,0,77.5', 'account must use incoming_reached (31), not answered (38)');
  assert.equal(after(csv, 'By Agent,'), 'Dhiraj Sharma,14,5,4,2,60,3', 'agent must use incoming_answered (14), not answered_calls (19)');
});

test('a negative number is NOT formula-guarded — it stays a number', () => {
  // `avg_close_days` divides a signed delta (csops :1841), so it can be negative. A blanket
  // `^[=+\-@]` guard exported it as the TEXT `'-2.5` — un-summable, and it reads as corruption.
  assert.equal(csvEsc(-2.5), '-2.5');
  assert.equal(csvEsc(-0), '0');
  const csv = buildTicketsCsv({ data: { range: {}, by_agent: [{ name: 'A', total: 1, closed: 2, avg_close_days: -2.5 }] }, from: 'a', to: 'b' });
  assert.equal(after(csv, 'By Agent,'), 'A,1,2,-2.5');
  // A STRING that looks like a formula is still guarded.
  assert.equal(csvEsc('-2.5'), "'-2.5");
});

test('an EMPTY section keeps its header; only an ABSENT one is omitted', () => {
  // A zero-ticket range printed `By Product,Total,…` with no rows before the extraction; dropping
  // the header would be an undeclared change on the report most likely to be empty.
  const empty = buildTicketsCsv({ data: { range: { total_rows: 0 }, by_product: [], by_platform: [], by_agent: [] }, from: 'a', to: 'b' });
  assert.ok(empty.includes('By Product,Total,Replacements,Refunds,Repairs'));
  assert.ok(empty.includes('By Agent,Raised in range,Closed in range,Avg close (days)'));
  const absent = buildTicketsCsv({ data: { range: { total_rows: 0 } }, from: 'a', to: 'b' });
  assert.equal(absent.includes('By Product'), false);
});

test('an explicit `cohort: null` does not throw', () => {
  // A default parameter fires on `undefined` ONLY. This threw inside the click handler — the exact
  // class the extraction was meant to end.
  const csv = buildAgentsCsv({ agentData: { by_agent: [{ name: 'X' }], totals: {} }, from: 'a', to: 'b', cohort: null });
  assert.equal(find(csv, 'Channel,'), 'Channel,All');
});
