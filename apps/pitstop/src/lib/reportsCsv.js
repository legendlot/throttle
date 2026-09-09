// Reports CSV builders — the three exports behind the one "Export CSV" button on /reports.
//
// ⭐ WHY THESE LIVE HERE AND NOT IN THE PAGE (2026-09-09, S365). On one day this logic shipped
// FOUR defects, every one of them silent — a wrong file, a blank column, a blank metric and an
// off-by-one date — and every test suite in the repo stayed green through all of them, because
// nothing anywhere touched `reports/page.js`. Pulled out as pure `payload -> string` functions so
// `reportsCsv.test.mjs` can pin them against real handler shapes with no browser and no React.
// The page keeps only the Blob/anchor plumbing, which is the part a test could not have caught.
//
// ⛔ THE RULE THAT PREVENTS THE WHOLE DEFECT CLASS: these builders consume the RAW handler
// payload, NOT the shape the on-screen panels use. Those differ, and the difference is invisible:
//   - `getCallReports` sends `{ date, in_total, in_answered, out_total, out_answered, dur_sum,
//     dur_count }` per day. `foldCalls()` in the page RE-KEYS `date` -> `day` and derives
//     `in_missed` / `answer_rate` / `avg_duration` via `finishCallRow()`. The panel therefore
//     reads `day` and the four derived metrics; the RAW payload has neither.
//   - `getAgentConversationDaily` is folded SERVER-side and really does send `day`.
// Copying a line from one export into the other is how three of the four defects happened.

// A value beginning = + - @ is executed as a formula by Excel/Sheets, and a name containing a
// comma would split a row into two columns. Also tests \r, which a lone \n check misses.
// ⚠️ SINGLE IMPLEMENTATION ON PURPOSE — `exportAgentsCsv` used to carry its own weaker copy with
// neither the formula guard nor \r, so the Agents CSV was the soft one of the three (S365).
export const csvEsc = (v) => {
  const s = v == null ? '' : String(v);
  const guarded = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
};

// The inverse of the page's `istBoundary`, and the ONLY correct way to display a range echoed
// back by a handler. ⛔ `.slice(0, 10)` on those values is PATTERN-221: an IST midnight is the
// PREVIOUS day in UTC, so slicing names 2025-12-31 for a range starting 2026-01-01.
export const istDay = (iso, fallback = '') => {
  const t = Date.parse(iso || '');
  return Number.isNaN(t) ? fallback : new Date(t + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
};

export const CALL_METRICS = [
  { key: 'in_total',     label: 'Inbound',                 kind: 'count', teamOnly: true },
  { key: 'in_answered',  label: 'Reached an agent',        kind: 'count' },
  { key: 'in_missed',    label: 'Did not reach an agent',  kind: 'count', teamOnly: true },
  { key: 'answer_rate',  label: 'Inbound answer rate',     kind: 'pct',   teamOnly: true },
  { key: 'out_total',    label: 'Outbound',                kind: 'count' },
  { key: 'out_answered', label: 'Outbound answered',       kind: 'count' },
  { key: 'avg_duration', label: 'Avg duration',            kind: 'seconds' },
];

// Derives the three metrics the raw payload does not carry. Inbound totals exist only on team
// rows (a call nobody took has no agent), so both inbound-derived figures are team-only —
// deriving them per agent gave negative "missed".
export function finishCallRow(r, isTeam) {
  return {
    ...r,
    in_missed:    isTeam ? (r.in_total || 0) - (r.in_answered || 0) : null,
    answer_rate:  isTeam && r.in_total ? +((100 * r.in_answered) / r.in_total).toFixed(1) : null,
    avg_duration: r.dur_count ? Math.round(r.dur_sum / r.dur_count) : null,
  };
}

export function grainWord(g) {
  if (g === 'month') return { title: 'Monthly', plural: 'months', bucket: 'Month' };
  if (g === 'week')  return { title: 'Weekly',  plural: 'weeks',  bucket: 'Week beginning' };
  return { title: 'Daily', plural: 'days', bucket: 'Day' };
}

// BOM first — Excel ignores the MIME charset on a double-clicked .csv (S349 review).
const withBom = (lines) => '﻿' + lines.join('\n');

// ── Tickets ─────────────────────────────────────────────────────────────────
// ⚠️ EVERY collection is guarded. This function used to dereference `data.by_product`,
// `data.cost_summary.*` and `data.range.total_rows` bare, so a partial payload threw a TypeError
// INSIDE the click handler — the button appeared to do nothing at all, with no error surfaced to
// the user (S365 hostile review). A missing section is now simply an absent section.
export function buildTicketsCsv({ data, from, to }) {
  if (!data) return null;
  const lines = [];
  lines.push(`Pitstop Report,${from} to ${to}`);
  // The cohort travels WITH the file: a filtered export read next week must not be mistaken for
  // the whole month. Read off the RESPONSE, never the live controls — `data` holds the previous
  // payload until a refetch resolves, so the controls could stamp new filters onto old numbers.
  const applied = data.applied_filters || {};
  lines.push(`Agent,${csvEsc((applied.agent || []).join(' · ') || 'All')}`);
  lines.push(`Support channel,${csvEsc((applied.channel || []).join(' · ') || 'All')}`);
  const range = data.range || {};
  lines.push(`Tickets raised,${range.total_rows ?? ''}`);
  if (range.range_total != null && range.range_total !== range.total_rows) {
    lines.push(`Tickets raised in range (before filters),${range.range_total}`);
  }
  if (data.conversations) {
    // `unfiltered` = the counts RPC is date-ranged only, so this figure is the WHOLE range even
    // when the ticket numbers above are a one-agent slice. Say so in the file.
    lines.push(`Conversations handled${data.conversations.unfiltered ? ' (whole range — not filtered)' : ''},${data.conversations.handled ?? ''}`);
    lines.push(`Conversations in range (incl. outbound-only),${data.conversations.total ?? ''}`);
  }
  const breakdown = (title, rows) => {
    if (!rows?.length) return;
    lines.push('');
    lines.push(`${title},Total,Replacements,Refunds,Repairs`);
    for (const r of rows) {
      lines.push([r.name, r.total, r.replacement || 0, r.refund || 0, r.repair || 0].map(csvEsc).join(','));
    }
  };
  breakdown('By Product', data.by_product);
  breakdown('By Platform', data.by_platform);
  if (data.by_agent?.length) {
    lines.push('');
    // Raised and Closed are on different date bases (raised-in-window vs closed-in-window) — the
    // header says so, because a CSV outlives the screen that explained it.
    lines.push('By Agent,Raised in range,Closed in range,Avg close (days)');
    for (const r of data.by_agent) {
      lines.push([r.name, r.total, r.closed, r.avg_close_days ?? ''].map(csvEsc).join(','));
    }
  }
  if (data.cost_summary) {
    lines.push('');
    lines.push('Cost Summary');
    lines.push(`Return cost (₹),${data.cost_summary.return_cost_inr ?? ''}`);
    lines.push(`Replacement cost (₹),${data.cost_summary.replacement_cost_inr ?? ''}`);
    lines.push(`Refund amount (₹),${data.cost_summary.refund_amount_inr ?? ''}`);
  }
  return withBom(lines);
}

// ── Agents ──────────────────────────────────────────────────────────────────
// `cohort` carries the already-resolved filter LABELS ({ channel, tag, agent }) — the page owns
// turning ids into names, this owns the file.
export function buildAgentsCsv({ agentData, waitData, dailyData, from, to, cohort = {} }) {
  if (!agentData?.by_agent?.length) return null;
  const t = agentData.totals || {};
  // The breakdown is a separate request and may legitimately be absent — the CSV then omits those
  // rows rather than exporting blanks that read as zeroes. Same gate as the panel: only export it
  // when its own total agrees with the report's, or the CSV carries three numbers that do not add
  // up to the "Avg to close" two rows above them.
  const wRaw = waitData?.totals || null;
  const wt = (wRaw && t.avg_resolution_min != null && wRaw.avg_resolution_min != null
    && Math.abs(Number(wRaw.avg_resolution_min) - Number(t.avg_resolution_min))
       <= Math.max(60, 0.10 * Number(t.avg_resolution_min))) ? wRaw : null;
  const wByAgent = new Map((waitData?.by_agent || []).map(x => [x.agent_id || x.name, x]));
  const lines = [];
  lines.push(`Pitstop Agent Conversation Report,${from} to ${to}`);
  // The basis and the cohort travel WITH the file — a CSV read a week later must not be ambiguous
  // about whether times are 24x7 or business hours.
  lines.push(`Basis,${agentData.range?.business_hours ? 'Business hours' : '24x7'}`);
  lines.push(`Channel,${csvEsc(cohort.channel || 'All')}`);
  lines.push(`Tag,${csvEsc(cohort.tag || 'All')}`);
  lines.push(`Agent,${csvEsc(cohort.agent || 'All')}`);
  lines.push(`Conversations in range,${t.total ?? ''}`);
  lines.push(`Queries (customer-initiated),${t.queries ?? ''}`);
  lines.push(`Outbound-only (not queries),${t.outbound_only ?? ''}`);
  lines.push(`No stored history,${t.no_history ?? ''}`);
  lines.push(`Assigned in range,${t.assigned ?? ''}`);
  lines.push(`Handled in range,${t.handled ?? ''}`);
  lines.push(`Closed in range,${t.closed ?? ''}`);
  lines.push('');
  // The decomposition travels with the file for the same reason Basis does: "avg to close" is the
  // FULL wall clock, and a reader a week later must be able to see how much of it was waiting
  // rather than working, without re-running the report.
  lines.push(`Avg to close (min) — full wall clock,${t.avg_resolution_min ?? ''}`);
  if (wt) {
    lines.push(`  of which waiting on customer (min),${wt.avg_customer_wait_min ?? ''}`);
    lines.push(`  of which waiting to be closed (min),${wt.avg_close_lag_min ?? ''}`);
  }
  lines.push('');
  lines.push('Assigned/Handled/Resolved/Closed counted on,The day the activity happened');
  lines.push('Queries/Open/Answered/rates/averages counted on,The day the conversation was raised');
  lines.push('');
  lines.push('Agent,Assigned,Handled,Open,Resolved,Closed (operational),Closed (no reason),Closed,Closed rate %,Resolution rate %,Answered,Never answered,Answer rate %,Avg first reply (min),Avg reply (min),Avg to close (min),Avg waiting on customer (min),Avg waiting to be closed (min),Waiting on us,Waiting on customer');
  for (const r of agentData.by_agent) {
    lines.push([r.name, r.assigned, r.handled, r.open, r.resolved, r.closed_ops, r.closed_unspecified,
      r.closed, r.resolution_rate, r.resolve_rate, r.answered, r.unanswered,
      r.answer_rate, r.avg_frt_min, r.avg_response_min, r.avg_resolution_min,
      wt ? wByAgent.get(r.agent_id || r.name)?.avg_customer_wait_min : '',
      wt ? wByAgent.get(r.agent_id || r.name)?.avg_close_lag_min : '',
      r.waiting_agent, r.waiting_customer].map(csvEsc).join(','));
  }
  // Daily trend — every metric, one row per day for the team, then per agent. Only when the panel
  // actually loaded: an absent block is honest, a block of blanks reads as zeros.
  // ⚠️ `d.day` is CORRECT here and would be wrong in the Calls builder — this payload is folded
  // SERVER-side and carries `day`; the calls payload is raw and carries `date`. See the header.
  if (dailyData?.days?.length) {
    const M = dailyData.metrics || [];
    lines.push('');
    const gw = grainWord(dailyData.range?.grain);
    lines.push(`${gw.title} trend (${dailyData.range?.business_hours ? 'business hours' : '24x7'}),${dailyData.days.length} ${gw.plural}`);
    lines.push([gw.bucket, 'Agent', ...M.map(m => m.label + (m.kind === 'minutes' ? ' (min)' : m.kind === 'pct' ? ' %' : ''))].map(csvEsc).join(','));
    for (const d of dailyData.days) lines.push([d.day, 'All agents', ...M.map(m => d[m.key] ?? '')].map(csvEsc).join(','));
    for (const a of (dailyData.by_agent || [])) {
      for (const d of (a.days || [])) lines.push([d.day, a.name, ...M.map(m => d[m.key] ?? '')].map(csvEsc).join(','));
    }
  }
  return withBom(lines);
}

// ── Calls ───────────────────────────────────────────────────────────────────
// Every panel the Calls tab draws, in the order it draws them, so a reader can find each number
// on the screen it came from. Column names come from the TABLE HEADERS, and the `??` aliases
// mirror `CallsBreakdown` exactly (the worker sends `incoming_reached` on newer rows and
// `answered` on older ones) — reading the raw key would print blanks for rows the table renders.
export function buildCallsCsv({ callData, from, to }) {
  // `totals.total`, not just `totals`: the worker always returns a totals object, `total: 0`
  // included, so gating on its presence exported a file with a 0 and no sections while the panel
  // said "No calls in range". Matches `CallsPanel`'s own test.
  if (!callData?.totals?.total) return null;
  const t = callData.totals;
  const lines = [];
  // Range off the RESPONSE (callData is not cleared when a refetch starts or fails, so a failed
  // reload would stamp NEW dates on OLD numbers) and converted to IST before slicing.
  lines.push(`Pitstop Call Report,${istDay(callData.range?.from, from)} to ${istDay(callData.range?.to, to)}`);
  lines.push(`Basis,${callData.range?.business_hours ? 'Business hours' : '24x7'}`);
  if (callData.range?.business_hours && callData.range?.rows_24x7 != null) {
    lines.push(`Calls in range outside business hours (excluded),${Number(callData.range.rows_24x7) - Number(t.total || 0)}`);
  }
  lines.push('');
  lines.push(`Total calls,${t.total ?? ''}`);
  lines.push(`Reached an agent (inbound),${t.incoming_reached ?? ''}`);
  lines.push(`Didn't reach an agent (inbound — incl. IVR drop-offs),${t.incoming_not_reached ?? ''}`);
  lines.push(`Inbound answer rate %,${callData.by_direction?.incoming?.answer_rate_pct ?? ''}`);
  lines.push(`Avg duration (seconds),${t.avg_duration_seconds ?? ''}`);
  lines.push('');

  // Departments and MyOp accounts share a shape — one branch of CallsBreakdown renders both.
  const breakdown = (title, rows) => {
    lines.push(`${title},Total,Answered (in),Not reached (in),Outgoing,Connected,Answer rate (in) %`);
    for (const r of (rows || [])) {
      lines.push([r.name, r.total, r.incoming_reached ?? r.answered, r.incoming_not_reached ?? r.missed,
        r.outgoing_total ?? 0, r.outgoing_answered ?? 0, r.answer_rate_pct ?? ''].map(csvEsc).join(','));
    }
    lines.push('');
  };
  breakdown('By Department', callData.by_department);
  breakdown('By MyOp Account', callData.by_account);

  const d = callData.by_direction;
  if (d) {
    lines.push('By Direction,Total,Answered,Answer rate %');
    lines.push(['Incoming', d.incoming?.total ?? 0, d.incoming?.answered ?? 0, d.incoming?.answer_rate_pct ?? ''].map(csvEsc).join(','));
    lines.push(['Outgoing', d.outgoing?.total ?? 0, d.outgoing?.answered ?? 0, d.outgoing?.answer_rate_pct ?? ''].map(csvEsc).join(','));
    lines.push('');
  }

  lines.push('By Agent,Answered (in),Outgoing,Connected,Not reached → returned,Avg handle (seconds),Tickets opened');
  for (const r of (callData.by_agent || [])) {
    lines.push([r.name, r.incoming_answered ?? r.answered_calls, r.outgoing_total ?? 0, r.outgoing_answered ?? 0,
      r.missed_returned, r.avg_handle_seconds ?? '', r.tickets_opened].map(csvEsc).join(','));
  }
  lines.push('');

  // ⚠️ DAY grain always, even when the on-screen trend is set to week or month: `CallTrend` owns
  // that toggle in its own state and the page cannot read it, so the file states its grain.
  // ⛔ `row.date` and `finishCallRow` — see this file's header for why `row.day` and the raw
  // metric keys were both wrong here, and both failed into empty cells.
  if (callData.daily?.length) {
    lines.push(`Daily trend (${callData.range?.business_hours ? 'business hours' : '24x7'}),${callData.daily.length} days`);
    lines.push(['Day', 'Agent', ...CALL_METRICS.map(m => m.label + (m.kind === 'pct' ? ' %' : m.kind === 'seconds' ? ' (seconds)' : ''))].map(csvEsc).join(','));
    for (const raw of callData.daily) {
      const row = finishCallRow(raw, true);
      lines.push([row.date, 'All agents', ...CALL_METRICS.map(m => row[m.key] ?? '')].map(csvEsc).join(','));
    }
    // Per-agent: `finishCallRow(row, false)` nulls the two inbound-derived metrics on purpose,
    // which is the same set `CALL_METRICS` marks `teamOnly`. Blanked either way — every row keeps
    // the same column count as the header.
    for (const a of (callData.daily_by_agent || [])) {
      for (const raw of (a.days || [])) {
        const row = finishCallRow(raw, false);
        lines.push([row.date, a.name, ...CALL_METRICS.map(m => m.teamOnly ? '' : (row[m.key] ?? ''))].map(csvEsc).join(','));
      }
    }
    lines.push('');
  }

  if (callData.hourly?.length) {
    lines.push('Hourly distribution (IST),Calls');
    for (const h of callData.hourly) lines.push([h.hour, h.count].map(csvEsc).join(','));
  }
  return withBom(lines);
}
