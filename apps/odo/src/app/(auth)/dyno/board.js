'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, Modal } from '@throttle/ui';
import { RefreshCw } from 'lucide-react';
import { salesGet, salesPost, inr, fmtInt } from '../../../lib/api.js';
import { Kpi, SegmentedToggle } from '../../../components/kit.js';
import { PageHead, PanelHead, Bar, Nil } from '../../../components/prism.js';
import { HUE } from '../../../lib/hues.js';
import { DynoTabs } from './tabs.js';

// Dyno board — one row per variant + controls, all against the same gated Worker actions the Brand
// engine uses. Parametrised by `kind`: 'experiment' (creative tests, /dyno) vs 'scale' (graduated
// winners running for volume, /dyno/scaling). The two buckets are physically separated so
// experiment spend never gets confused with scaling spend. Monitor-only is fully supported.

const GATE_INR = 6500;   // the kill-decision spend gate (mirror of settings.ads_kill_after_inr)
const RECENT_DAYS = 3;

// Shared fixed column widths so every table lines up. Order = the 11 columns below.
//    ☐   status variant angle spend buys roas  cpa  ctr verdict actions
const COLS = [30,  92,   240,  200,  104,  52,  100,  76,  60,   92,   272];
const TABLE_MIN = COLS.reduce((a, w) => a + w, 0);
// Screen board (Gate 1) columns — no purchase ROAS/buys; leading indicators + CBO allocation instead.
//    ☐   status variant angle spend·share ctr  cpc  atc cpatc verdict actions
const COLS_SCREEN = [30, 100, 240, 190, 120, 66, 66, 52, 84, 92, 272];
const TABLE_MIN_SCREEN = COLS_SCREEN.reduce((a, w) => a + w, 0);
// Shadow Gate-1 pass line (creative-throughput-loop §4): CPATC ≤ ~₹400. Product-specific later.
const CPATC_PASS_INR = 400;

const N = (v) => Number(v || 0);
// Tint helper. The CHIP/tone values below are CSS custom properties as often as hexes, so the
// old `colour + '1e'` string concat produced invalid CSS (`var(--green)1e`) and silently painted
// nothing. color-mix takes both forms.
const alpha = (c, a) => `color-mix(in srgb, ${c} ${Math.round(a * 100)}%, transparent)`;

const CHIP = {
  winning: { dot: '🟢', label: 'Winning', bg: 'var(--green)' },
  watch:   { dot: '🟡', label: 'Watch',   bg: '#E8A33D' },
  killing: { dot: '🔴', label: 'Killing', bg: 'var(--red)' },
  killed:  { dot: '🔴', label: 'Killed',  bg: 'var(--red)' },
  early:   { dot: '⚪', label: 'Early',    bg: 'var(--t3)' },
  // Screen (Gate 1) status vocabulary — CBO spend-share + CTR/CPATC vs the batch median.
  promote: { dot: '🟢', label: 'Promote', bg: 'var(--green)' },
  starved: { dot: '⚪', label: 'Starved', bg: 'var(--t3)' },
  kill:    { dot: '🔴', label: 'Kill',    bg: 'var(--red)' },
};
const roasTone = (v) => (v == null ? 'var(--t3)' : v >= 4 ? 'var(--green)' : v > 0 && v < 2 ? 'var(--red)' : 'var(--t1)');
const cpatcTone = (v) => (v == null ? 'var(--t3)' : v <= CPATC_PASS_INR ? 'var(--green)' : v <= CPATC_PASS_INR * 1.5 ? '#E8A33D' : 'var(--red)');
const VERDICTS = ['winner', 'promising', 'killed', 'inconclusive', 'paused'];
const DECISION_TYPES = ['kill', 'scale', 'graduate', 'iterate', 'pause', 'hold', 'restore-budget'];

// Shared cell chrome. Fixed columns (§8) mean content must truncate, never burst the column.
// Row separators + hover come from .so-table so the last row still loses its rule.
const TD = { padding: '9px 8px', overflow: 'hidden' };
const TD_CLIP = { ...TD, textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const TD_NUM = { ...TD_CLIP, textAlign: 'right', fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--t2-cell)' };
const TH = { padding: '8px 8px', fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 400, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border-table)',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

function StatusChip({ s }) {
  const c = CHIP[s] || CHIP.early;
  // The emoji dots are existing product vocabulary — verbatim, the one sanctioned exception to
  // the redesign's no-emoji-in-chrome rule.
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--mono)', fontSize: 10,
      fontWeight: 500, padding: '2px 6px', borderRadius: 'var(--r-pill)', color: c.bg,
      background: alpha(c.bg, 0.12), border: `1px solid ${alpha(c.bg, 0.28)}`, whiteSpace: 'nowrap', maxWidth: '100%' }}>
      {c.dot} {c.label}
    </span>
  );
}
function Tag({ children, tone = 'var(--t2)' }) {
  if (!children) return <Nil />;
  return <span style={{ fontFamily: 'var(--mono)', fontSize: 10, padding: '1px 6px', borderRadius: 'var(--r-sm)',
    background: 'rgba(255,255,255,.05)', color: tone, border: '1px solid var(--border-ctl)', display: 'inline-block',
    maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>{children}</span>;
}
function Roas({ recent, life }) {
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
      <b style={{ color: roasTone(recent), fontWeight: 600 }}>{recent == null ? '—' : N(recent).toFixed(2)}</b>
      <span style={{ color: 'var(--t5)', margin: '0 4px' }}>|</span>
      <span style={{ color: roasTone(life) }}>{life == null ? '—' : N(life).toFixed(2)}</span>
    </span>
  );
}
// Spend against the ₹6,500 decision gate as a 4px bar under the number (§6.5).
function GateBar({ spend }) {
  const pct = Math.min(100, (N(spend) / GATE_INR) * 100);
  const tone = pct >= 100 ? '#EC6A5E' : pct >= 70 ? '#E8A33D' : 'var(--accent)';
  return (
    <div title={`${inr(spend)} / ${inr(GATE_INR)} decision gate`} style={{ display: 'inline-block', width: 88, textAlign: 'right', verticalAlign: 'middle' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--t1-cell)' }}>{inr(spend)}</div>
      <Bar pct={pct} height={4} color={tone} style={{ marginTop: 4 }} />
    </div>
  );
}
// Spend-and-share cell for the screen board: absolute spend + this ad's % of the batch's total
// spend, with a bar. In a CBO the allocation IS the verdict, so share is the headline signal.
function SpendShare({ spend, share }) {
  const pct = Math.min(100, N(share));
  const tone = pct >= 15 ? 'var(--green)' : pct < 3 ? 'var(--t3)' : 'var(--accent)';
  return (
    <div title={`${inr(spend)} — ${N(share).toFixed(1)}% of batch spend`} style={{ display: 'inline-block', width: 104, textAlign: 'right', verticalAlign: 'middle' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--t1-cell)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {inr(spend)} <span style={{ color: 'var(--t5)' }}>· {N(share).toFixed(1)}%</span>
      </div>
      <Bar pct={pct} height={4} color={tone} style={{ marginTop: 4 }} />
    </div>
  );
}
// Actual-spend split (experiment vs scaling vs screen × today · lifetime). The active bucket is emphasised.
function SpendSplit({ spend, kind }) {
  const Row = ({ label, v, on }) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, opacity: on ? 1 : 0.62, whiteSpace: 'nowrap' }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase',
        color: on ? 'var(--accent)' : 'var(--t4)', fontWeight: on ? 600 : 400, width: 72, flex: 'none' }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: on ? 'var(--t1-cell)' : 'var(--t2-cell)' }}>{inr(N(v?.today))}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', color: 'var(--t5)' }}>· {inr(N(v?.life))}</span>
    </div>
  );
  return (
    <div style={{ minWidth: 218 }}>
      <div className="so-eyebrow">Spend — today · lifetime</div>
      <div style={{ display: 'grid', gap: 2, marginTop: 6 }}>
        <Row label="Screen" v={spend?.screen} on={kind === 'screen'} />
        <Row label="Experiment" v={spend?.experiment} on={kind === 'experiment'} />
        <Row label="Scaling" v={spend?.scale} on={kind === 'scale'} />
      </div>
    </div>
  );
}

export function DynoBoard({ kind = 'experiment' }) {
  const isScale = kind === 'scale';
  const isScreen = kind === 'screen';
  const { session, perms } = useAuth();
  const P = perms || {};
  const canWrite = !!P.sales_ads_write || !!P.salesops_admin;
  const canApprove = !!P.sales_ads_approve || !!P.salesops_admin;

  // Screen batches are often paused as a whole (Gate-1 read is done) but their ads stay 'active';
  // default to All so a concluded screen batch still shows (per the brief's acceptance criteria).
  const [filter, setFilter] = useState(isScreen ? 'all' : 'active');
  const [vModal, setVModal] = useState(null);   // { mode, target }
  const [board, setBoard] = useState(null);       // { rows, committed_daily_inr, ceiling_inr, write_enabled }
  const [spend, setSpend] = useState(null);       // { experiment:{today,life}, scale:{today,life} }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');           // meta_id currently mutating
  const [sel, setSel] = useState({});             // bulk selection: meta_id → true
  const [expanded, setExpanded] = useState({});   // meta_id → show copy
  const timer = useRef(null);

  const [decisions, setDecisions] = useState({});   // plan_id → rows
  const loadDecisions = useCallback(async (planId) => {
    if (decisions[planId]) return;
    try { const r = await salesGet('getDecisions', { plan_id: planId }, session); setDecisions(x => ({ ...x, [planId]: r.decisions || [] })); }
    catch { /* non-fatal */ }
  }, [decisions, session]);
  const [angles, setAngles] = useState(null);
  const [showAngles, setShowAngles] = useState(false);
  const loadAngles = useCallback(async () => {
    try { const r = await salesGet('getAngles', {}, session); setAngles(r.angles || []); }
    catch (er) { setErr(String(er?.message || er)); }
  }, [session]);
  useEffect(() => { if (showAngles && angles == null) loadAngles(); }, [showAngles, angles, loadAngles]);

  const load = useCallback(async (quiet) => {
    if (!session) return;
    if (!quiet) { setBoard(null); setErr(''); }
    try {
      const b = isScreen
        ? await salesGet('getDynoScreenBoard', { filter, recent_days: RECENT_DAYS }, session)
        : await salesGet('getDynoBoard', { filter, recent_days: RECENT_DAYS, kind }, session);
      setBoard(b || { rows: [] });
    } catch (e) { setErr(String(e?.message || e)); }
    salesGet('getDynoSpend', {}, session).then(setSpend).catch(() => {});   // header split (all buckets, non-fatal)
  }, [session, filter, kind, isScreen]);

  useEffect(() => { load(); }, [load]);
  // Auto-refresh every 60s (quiet — no spinner flash).
  useEffect(() => {
    timer.current = setInterval(() => load(true), 60000);
    return () => clearInterval(timer.current);
  }, [load]);

  const rows = board?.rows || [];
  const groups = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.plan_id)) m.set(r.plan_id, { plan: r, variants: [] });
      m.get(r.plan_id).variants.push(r);
    }
    return [...m.values()];
  }, [rows]);

  const stats = useMemo(() => {
    const s = { groups: new Set(), winning: 0, killing: 0, live: 0, promote: 0, starved: 0 };
    for (const r of rows) {
      s.groups.add(r.plan_id);
      if (r.ad_status === 'active') s.live += 1;
      if (r.computed_status === 'winning') s.winning += 1;
      if (r.computed_status === 'killing' || r.computed_status === 'killed') s.killing += 1;
      if (r.computed_status === 'promote') s.promote += 1;
      if (r.computed_status === 'starved') s.starved += 1;
    }
    return s;
  }, [rows]);

  const run = async (metaId, label, fn) => {
    setBusy(metaId); setErr('');
    try { await fn(); await load(true); }
    catch (e) { setErr(`${label} failed: ${String(e?.message || e)}`); }
    finally { setBusy(''); }
  };

  const pause = (r) => run(r.meta_id, 'Pause', () =>
    salesPost('metaSetStatus', { entity_type: 'ad', meta_id: r.meta_id, status: 'PAUSED', plan_id: r.plan_id }, session));
  const resume = (r) => run(r.meta_id, 'Resume', () =>
    salesPost('metaSetStatus', { entity_type: 'ad', meta_id: r.meta_id, status: 'ACTIVE', plan_id: r.plan_id }, session));
  const kill = (r) => setVModal({ mode: 'variant', target: { ...r, verdict: 'killed', alsoPause: true } });
  const scale = (r) => {
    if (!r.adset_meta_id) { setErr('No ad set on this variant — cannot scale.'); return; }
    const cur = N(r.adset_daily_budget_inr);
    const v = prompt(`New daily budget for the ad set (current ${inr(cur)}). Increases need approval.`, String(cur || 1400));
    if (v == null) return;
    const nb = Number(v);
    if (!(nb > 0)) { setErr('Budget must be a positive number.'); return; }
    run(r.meta_id, 'Scale', () => salesPost('metaSetAdSetBudget', { adset_id: r.adset_meta_id, daily_budget_inr: Math.round(nb) }, session));
  };
  const rename = (r) => {
    const v = prompt('Rename ad:', r.ad_name || '');
    if (!v || !v.trim()) return;
    run(r.meta_id, 'Rename', () => salesPost('metaSetName', { entity_type: 'ad', meta_id: r.meta_id, name: v.trim() }, session));
  };
  const openVerdict = (r) => setVModal({ mode: 'variant', target: r });
  const openConclude = (plan) => setVModal({ mode: 'plan', target: plan });
  const movePlan = (plan) => {
    // Screen survivors graduate INTO the Experiments (proving) bucket; experiment↔scale toggle otherwise.
    const target = (isScale || isScreen) ? 'experiment' : 'scale';
    run(`kind-${plan.plan_id}`, 'Move', () => salesPost('setPlanKind', { plan_id: plan.plan_id, kind: target }, session));
  };

  const selIds = Object.keys(sel).filter(k => sel[k]);
  const bulkPause = async () => {
    if (!selIds.length || !confirm(`Pause ${selIds.length} ad(s)?`)) return;
    for (const id of selIds) {
      const r = rows.find(x => x.meta_id === id); if (!r) continue;
      await run(id, 'Pause', () => salesPost('metaSetStatus', { entity_type: 'ad', meta_id: id, status: 'PAUSED', plan_id: r.plan_id }, session));
    }
    setSel({});
  };

  if (!board && !err) return <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div>;

  const committed = N(board?.committed_daily_inr), ceiling = N(board?.ceiling_inr);
  const ceilPct = ceiling > 0 ? Math.min(100, (committed / ceiling) * 100) : 0;
  const cols = isScreen ? COLS_SCREEN : COLS;

  return (
    <div className="so-page" style={{ gap: 14 }}>
      {/* Header — title + kind description, the spend split, the committed/ceiling bar */}
      <PageHead
        title={`Dyno${isScale ? ' · Scaling' : isScreen ? ' · Screen' : ''}`}
        sub={isScale
          ? <>Scaling — graduated winners running for volume. Separate from experiments so spend stays clear.</>
          : isScreen
            ? <>Gate 1 — the cheap ATC screen. Judged on <b>CTR</b>, <b>cost-per-ATC</b> &amp; <b>CBO spend-share</b> (Meta&apos;s allocation is the verdict) — not purchase ROAS. Promote survivors → Experiments.</>
            : <>Creative testing grounds — ROAS shown <b>recent {RECENT_DAYS}d</b> | <b>lifetime</b>. Decision gate {inr(GATE_INR)}.</>}
        right={<>
          <SpendSplit spend={spend} kind={kind} />
          <div style={{ minWidth: 184 }}>
            <div className="so-eyebrow">Committed budget / day (ceiling)</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 13.5, fontVariantNumeric: 'tabular-nums', color: 'var(--t1-cell)', marginTop: 6 }}>
              {inr(committed)} <span style={{ color: 'var(--t5)' }}>/ {inr(ceiling)}</span>
            </div>
            <Bar pct={ceilPct} height={5} color={ceilPct >= 95 ? 'var(--red)' : 'var(--accent)'} style={{ marginTop: 6 }} />
          </div>
          <button className="so-btn ghost" onClick={() => load()} title="Refresh"
            style={{ display: 'inline-flex', alignItems: 'center', padding: '8px 10px' }}>
            <RefreshCw size={15} strokeWidth={1.75} />
          </button>
        </>}
      />

      {/* Stat row — dense 4-up, one hue per counter (§3.4) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        <Kpi dense hue={HUE.count} lbl={isScale ? 'Campaigns' : isScreen ? 'Batches' : 'Experiments'}
          val={stats.groups.size} sub={`${filter} view`} />
        <Kpi dense hue={HUE.primary} lbl="Live ads" val={stats.live} sub="ad status active" />
        {isScreen ? <>
          <Kpi dense hue={HUE.units} lbl="Promote" val={stats.promote} sub="screen survivors" />
          <Kpi dense hue={HUE.neutral} lbl="Starved" val={stats.starved} sub="starved of CBO spend" />
        </> : <>
          <Kpi dense hue={HUE.units} lbl="Winning" val={stats.winning} sub="winning variants" />
          <Kpi dense hue={HUE.returns} lbl="Killing" val={stats.killing} sub="killing + killed" />
        </>}
      </div>

      <DynoTabs />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <SegmentedToggle value={filter} onChange={setFilter} options={[
          { key: 'active', label: 'Active' }, { key: 'all', label: 'All' }, { key: 'staged', label: 'Staged' }]} />
        {!isScale && !isScreen && <button className="so-btn ghost" onClick={() => setShowAngles(s => !s)}>{showAngles ? 'Hide' : 'Angle library'}</button>}
        {board?.write_enabled === false && <span style={{ fontSize: 11.5, color: 'var(--red)' }}>⚠ Ad writes are OFF (settings.ads_write_enabled=false)</span>}
        <span className="so-qual" style={{ marginLeft: 'auto' }}>
          {isScreen ? `Gate-1 pass: CPATC ≤ ${inr(CPATC_PASS_INR)}` : `Decision gate ${inr(GATE_INR)} · ROAS recent ${RECENT_DAYS}d | lifetime`}
        </span>
        {selIds.length > 0 && canWrite && (
          <button className="so-btn" onClick={bulkPause}>Pause selected ({selIds.length})</button>
        )}
      </div>

      {err && <div className="so-card" style={{ background: alpha('var(--red)', 0.08), border: '1px solid ' + alpha('var(--red)', 0.34),
        color: 'var(--red)', padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}

      {!isScale && showAngles && <AngleLibrary angles={angles} canWrite={canWrite} session={session} onSaved={loadAngles} />}

      {groups.length === 0 && <div className="so-sub" style={{ padding: 30, textAlign: 'center' }}>No {isScale ? 'scaling campaigns' : isScreen ? 'screen batches' : (filter === 'staged' ? 'staged experiments' : 'variants')} in this view.</div>}

      {groups.map(({ plan, variants }) => {
        const staged = plan.plan_status === 'staged';
        return (
          <div key={plan.plan_id} className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
            {/* Experiment / campaign header */}
            <div style={{ padding: '13px 17px', borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,.022)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 15, color: 'var(--t1)' }}>{plan.product} · {plan.batch}</span>
                <Tag>{plan.plan_status}</Tag>
                {plan.plan_verdict && <span className="so-sub" style={{ fontSize: 11.5 }}>verdict: <b style={{ color: 'var(--t1)' }}>{plan.plan_verdict}</b></span>}
                <div style={{ flex: 1 }} />
                {staged && canApprove && (
                  <button className="so-btn"
                    onClick={() => run(`plan-${plan.plan_id}`, 'Approve', () => salesPost('adsApprovePlan', { plan_id: plan.plan_id }, session))}>
                    Approve &amp; Launch
                  </button>
                )}
                {canWrite && !staged && (
                  <div style={{ display: 'inline-flex', gap: 6 }}>
                    <BtnMini onClick={() => movePlan(plan)} disabled={busy === `kind-${plan.plan_id}`}
                      title={isScreen ? 'Graduate this screen survivor into the Experiments (proving) bucket'
                        : isScale ? 'Move back to the Experiments bucket' : 'Move to the Scaling bucket'}>
                      {isScreen ? '→ Promote to Experiments' : isScale ? '→ Experiments' : '→ Scaling'}
                    </BtnMini>
                    <button className="so-btn ghost" onClick={() => openConclude(plan)}>Conclude</button>
                  </div>
                )}
              </div>
              {plan.hypothesis && <div className="so-sub" style={{ fontSize: 12, marginTop: 7, maxWidth: 900 }}><b style={{ color: 'var(--t1)' }}>Hypothesis:</b> {plan.hypothesis}</div>}
              {plan.plan_verdict_reason && <div className="so-sub" style={{ fontSize: 11.5, marginTop: 3, maxWidth: 900 }}><b style={{ color: 'var(--t1)' }}>Verdict:</b> {plan.plan_verdict_reason}</div>}
              <DecisionStrip planId={plan.plan_id} rows={decisions[plan.plan_id]} onOpen={() => loadDecisions(plan.plan_id)} />
            </div>

            {/* Variants table — fixed column widths (§8), horizontal scroll below the min */}
            <div style={{ overflowX: 'auto' }}>
              <table className="so-table" style={{ minWidth: isScreen ? TABLE_MIN_SCREEN : TABLE_MIN, tableLayout: 'fixed' }}>
                <colgroup>{cols.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
                <thead>
                  <tr>
                    <th style={{ ...TH, cursor: 'default' }}></th>
                    <th style={{ ...TH, cursor: 'default' }}>Status</th>
                    <th style={{ ...TH, cursor: 'default' }}>Variant</th>
                    <th style={{ ...TH, cursor: 'default' }}>Angle · Segment</th>
                    {isScreen ? <>
                      <th style={{ ...TH, cursor: 'default', textAlign: 'right' }}>Spend · share</th>
                      <th style={{ ...TH, cursor: 'default', textAlign: 'right' }}>CTR</th>
                      <th style={{ ...TH, cursor: 'default', textAlign: 'right' }}>CPC</th>
                      <th style={{ ...TH, cursor: 'default', textAlign: 'right' }}>ATC</th>
                      <th style={{ ...TH, cursor: 'default', textAlign: 'right' }}>CPATC</th>
                    </> : <>
                      <th style={{ ...TH, cursor: 'default', textAlign: 'right' }}>Spend (gate)</th>
                      <th style={{ ...TH, cursor: 'default', textAlign: 'right' }}>Buys</th>
                      <th style={{ ...TH, cursor: 'default', textAlign: 'right' }}>ROAS r|life</th>
                      <th style={{ ...TH, cursor: 'default', textAlign: 'right' }}>CPA</th>
                      <th style={{ ...TH, cursor: 'default', textAlign: 'right' }}>CTR</th>
                    </>}
                    <th style={{ ...TH, cursor: 'default' }}>Verdict</th>
                    <th style={{ ...TH, cursor: 'default', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {variants.map(r => {
                    const isBusy = busy === r.meta_id;
                    const paused = r.ad_status !== 'active';
                    return (
                      <tr key={r.meta_id} style={{ opacity: isBusy ? 0.5 : 1 }}>
                        <td style={TD}>
                          <input type="checkbox" style={{ accentColor: 'var(--accent)' }} checked={!!sel[r.meta_id]} onChange={e => setSel(s => ({ ...s, [r.meta_id]: e.target.checked }))} />
                        </td>
                        <td style={TD}><StatusChip s={r.computed_status} /></td>
                        <td style={TD}>
                          <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                            <Thumb url={r.asset_url} />
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontWeight: 600, color: 'var(--t1)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.headline || r.ad_name}</div>
                              <div style={{ color: 'var(--t5)', fontSize: 10, fontFamily: 'var(--mono)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.ad_name}{r.parent_meta_id ? ' · ↳ iterated' : ''}</div>
                              {r.primary_text && (
                                <button onClick={() => setExpanded(x => ({ ...x, [r.meta_id]: !x[r.meta_id] }))}
                                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 10.5, padding: '2px 0', fontFamily: 'var(--ui)' }}>
                                  {expanded[r.meta_id] ? 'hide copy' : 'copy'}
                                </button>
                              )}
                              {expanded[r.meta_id] && <div className="so-sub" style={{ fontSize: 11, marginTop: 3, whiteSpace: 'pre-wrap' }}>{r.primary_text}</div>}
                            </div>
                          </div>
                        </td>
                        <td style={TD_CLIP}><Tag>{r.angle}</Tag> <Tag tone="var(--t4)">{r.audience_segment}</Tag></td>
                        {isScreen ? <>
                          <td style={{ ...TD, textAlign: 'right' }}><SpendShare spend={r.spend_life} share={r.spend_share} /></td>
                          <td style={TD_NUM}>{r.ctr_life == null ? <Nil /> : N(r.ctr_life).toFixed(2) + '%'}</td>
                          <td style={TD_NUM}>{r.cpc_life == null ? <Nil /> : inr(r.cpc_life)}</td>
                          <td style={TD_NUM}>{fmtInt(r.atc_life)}</td>
                          <td style={{ ...TD_NUM, color: cpatcTone(r.cpatc_life) }} title={`Gate-1 pass ≤ ${inr(CPATC_PASS_INR)}`}>{r.cpatc_life == null ? <Nil /> : inr(r.cpatc_life)}</td>
                        </> : <>
                          <td style={{ ...TD, textAlign: 'right' }}><GateBar spend={r.spend_life} /></td>
                          <td style={TD_NUM}>{fmtInt(r.purchases_life)}</td>
                          <td style={{ ...TD, textAlign: 'right', whiteSpace: 'nowrap' }}><Roas recent={r.roas_recent} life={r.roas_life} /></td>
                          <td style={TD_NUM}>{r.cpa_life == null ? <Nil /> : inr(r.cpa_life)}</td>
                          <td style={TD_NUM}>{r.ctr_life == null ? <Nil /> : N(r.ctr_life).toFixed(2) + '%'}</td>
                        </>}
                        <td style={TD_CLIP}>{r.verdict ? <Tag tone="var(--t1)">{r.verdict}</Tag> : <Nil />}</td>
                        <td style={{ ...TD, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {canWrite ? (
                            <div style={{ display: 'inline-flex', gap: 4 }}>
                              {paused
                                ? <BtnMini onClick={() => resume(r)} disabled={isBusy}>Resume</BtnMini>
                                : <BtnMini onClick={() => pause(r)} disabled={isBusy}>Pause</BtnMini>}
                              <BtnMini onClick={() => kill(r)} disabled={isBusy} tone="var(--red)">Kill</BtnMini>
                              {!isScreen && <BtnMini onClick={() => scale(r)} disabled={isBusy || !canApprove} title={canApprove ? 'Scale ad-set budget' : 'Scaling needs approver role'}>Scale</BtnMini>}
                              <BtnMini onClick={() => rename(r)} disabled={isBusy}>Rename</BtnMini>
                              <BtnMini onClick={() => openVerdict(r)} disabled={isBusy}>Verdict</BtnMini>
                            </div>
                          ) : <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--t3)' }}>monitor</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {vModal && (
        <VerdictModal mode={vModal.mode} target={vModal.target} session={session}
          onClose={() => setVModal(null)}
          onDone={() => { const pid = vModal?.target?.plan_id; setVModal(null); if (pid) setDecisions(x => { const n = { ...x }; delete n[pid]; return n; }); load(true); }} />
      )}
    </div>
  );
}

function Thumb({ url }) {
  if (!url) return <div style={{ width: 40, height: 40, borderRadius: 6, background: 'rgba(255,255,255,.04)', border: '1px solid var(--border-ctl)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t5)', fontFamily: 'var(--mono)', fontSize: 9 }}>—</div>;
  return <img src={url} alt="" style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', flexShrink: 0, border: '1px solid var(--border-ctl)' }} />;
}
function BtnMini({ children, onClick, disabled, tone, title }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      style={{ fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 500, padding: '4px 9px', borderRadius: 6,
        border: '1px solid var(--border-strong)', background: 'var(--control)', color: tone || 'var(--t1-cell)',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1, whiteSpace: 'nowrap' }}>
      {children}
    </button>
  );
}

// One modal for both grains. mode='variant' → adsSetVerdict(meta_id) (+ optional pause on kill);
// mode='plan' → adsSetPlanVerdict(plan_id). Optionally logs a lab_decisions edge.
function VerdictModal({ mode, target, session, onClose, onDone }) {
  // For mode='plan' the target is the experiment (plan_verdict/_reason); for a variant it's the ad row.
  const [verdict, setVerdict] = useState((mode === 'plan' ? target?.plan_verdict : target?.verdict) || '');
  const [reason, setReason] = useState((mode === 'plan' ? target?.plan_verdict_reason : target?.verdict_reason) || '');
  const [decType, setDecType] = useState('');
  const [decWhy, setDecWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [e, setE] = useState('');
  const submit = async () => {
    if (!verdict) { setE('Pick a verdict.'); return; }
    setBusy(true); setE('');
    try {
      if (mode === 'plan') {
        await salesPost('adsSetPlanVerdict', { plan_id: target.plan_id, verdict, reason }, session);
      } else {
        if (target.alsoPause) await salesPost('metaSetStatus', { entity_type: 'ad', meta_id: target.meta_id, status: 'PAUSED', plan_id: target.plan_id }, session);
        await salesPost('adsSetVerdict', { meta_id: target.meta_id, verdict, reason }, session);
      }
      if (decType) await salesPost('labAddDecision', {
        plan_id: target.plan_id, variant_meta_id: mode === 'variant' ? target.meta_id : null,
        type: decType, rationale: decWhy }, session);
      onDone();
    } catch (err) { setE(String(err?.message || err)); setBusy(false); }
  };
  const title = mode === 'plan' ? `Conclude ${target.product} · ${target.batch}` : `Verdict — ${target.ad_name}`;
  return (
    <Modal open onClose={onClose} title={title}>
      <div style={{ display: 'grid', gap: 12, minWidth: 340 }}>
        <label className="so-sub" style={{ fontSize: 12 }}>Verdict
          <select className="so-select" value={verdict} onChange={ev => setVerdict(ev.target.value)} style={{ width: '100%', marginTop: 5 }}>
            <option value="">— choose —</option>{VERDICTS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="so-sub" style={{ fontSize: 12 }}>Reason / why
          <textarea className="so-input" value={reason} onChange={ev => setReason(ev.target.value)} rows={3} style={{ width: '100%', marginTop: 5, resize: 'vertical' }} />
        </label>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div className="so-qual" style={{ marginBottom: 7 }}>Optionally log a decision (feeds the decision tree)</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="so-select" value={decType} onChange={ev => setDecType(ev.target.value)} style={{ flex: '0 0 150px' }}>
              <option value="">— no decision —</option>{DECISION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className="so-input" value={decWhy} onChange={ev => setDecWhy(ev.target.value)} placeholder="rationale" disabled={!decType} style={{ flex: 1 }} />
          </div>
        </div>
        {e && <div style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{e}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="so-btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="so-btn" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}

function DecisionStrip({ planId, rows, onOpen }) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen(o => !o);
  // Fetch when opened, and re-fetch if the cache was invalidated (rows→undefined) after a new decision.
  useEffect(() => { if (open && rows === undefined) onOpen(); }, [open, rows, onOpen]);
  return (
    <div style={{ marginTop: 6 }}>
      <button onClick={toggle} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, padding: '4px 0 0', fontFamily: 'var(--ui)' }}>
        {open ? 'hide decisions' : 'decisions'}
      </button>
      {open && (
        <div style={{ marginTop: 5, display: 'grid', gap: 3 }}>
          {!rows && <div className="so-qual">loading…</div>}
          {rows && rows.length === 0 && <div className="so-qual">No decisions logged.</div>}
          {rows && rows.map(dc => (
            <div key={dc.id} className="so-sub" style={{ fontSize: 11 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--t1)' }}>{dc.type}</span>
              {dc.rationale ? ` — ${dc.rationale}` : ''} <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--t5)' }}>· {new Date(dc.decided_at).toLocaleDateString('en-IN')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
const ANGLE_STATUS = ['candidate', 'testing', 'proven', 'retired'];
function AngleLibrary({ angles, canWrite, session, onSaved }) {
  const [draft, setDraft] = useState(null);   // { slug, name, psychology_pillar, status, hypothesis, evidence }
  const [busy, setBusy] = useState(false);
  const [e, setE] = useState('');
  const blank = { slug: '', name: '', psychology_pillar: '', status: 'candidate', hypothesis: '', evidence: '' };
  const save = async () => {
    if (!draft.slug.trim() || !draft.name.trim()) { setE('slug and name required'); return; }
    setBusy(true); setE('');
    try { await salesPost('labUpsertAngle', draft, session); setDraft(null); await onSaved(); }
    catch (er) { setE(String(er?.message || er)); } finally { setBusy(false); }
  };
  return (
    <div className="so-card">
      <PanelHead title="Angle library"
        right={canWrite && !draft ? <button className="so-btn ghost" onClick={() => setDraft(blank)}>+ New angle</button> : null} />
      {angles == null && <Spinner />}
      {angles && (
        <div style={{ display: 'grid', gap: 5 }}>
          {angles.map(a => (
            <div key={a.slug} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t1)', minWidth: 190 }}>{a.slug}</span>
              <span style={{ color: 'var(--t2)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
              <Tag tone="var(--t4)">{a.status}</Tag>
              {canWrite && <button onClick={() => setDraft({ slug: a.slug, name: a.name, psychology_pillar: a.psychology_pillar || '', status: a.status, hypothesis: a.hypothesis || '', evidence: a.evidence || '' })} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--ui)' }}>edit</button>}
            </div>
          ))}
        </div>
      )}
      {draft && (
        <div style={{ marginTop: 12, display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="so-input" value={draft.slug} onChange={ev => setDraft({ ...draft, slug: ev.target.value })} placeholder="slug (e.g. working-machine)" style={{ flex: 1 }} />
            <input className="so-input" value={draft.name} onChange={ev => setDraft({ ...draft, name: ev.target.value })} placeholder="name" style={{ flex: 1 }} />
            <select className="so-select" value={draft.status} onChange={ev => setDraft({ ...draft, status: ev.target.value })} style={{ flex: '0 0 130px' }}>{ANGLE_STATUS.map(s => <option key={s} value={s}>{s}</option>)}</select>
          </div>
          <input className="so-input" value={draft.psychology_pillar} onChange={ev => setDraft({ ...draft, psychology_pillar: ev.target.value })} placeholder="psychology_pillar (optional)" />
          <textarea className="so-input" value={draft.hypothesis} onChange={ev => setDraft({ ...draft, hypothesis: ev.target.value })} rows={2} placeholder="hypothesis (optional)" style={{ resize: 'vertical' }} />
          {e && <div style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{e}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="so-btn ghost" onClick={() => setDraft(null)} disabled={busy}>Cancel</button>
            <button className="so-btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save angle'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
