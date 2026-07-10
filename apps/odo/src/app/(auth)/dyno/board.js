'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, Modal } from '@throttle/ui';
import { salesGet, salesPost, inr, fmtInt } from '../../../lib/api.js';
import { SegmentedToggle } from '../../../components/kit.js';
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

const N = (v) => Number(v || 0);
const CHIP = {
  winning: { dot: '🟢', label: 'Winning', bg: 'var(--green)' },
  watch:   { dot: '🟡', label: 'Watch',   bg: '#E8A33D' },
  killing: { dot: '🔴', label: 'Killing', bg: 'var(--red)' },
  killed:  { dot: '🔴', label: 'Killed',  bg: 'var(--red)' },
  early:   { dot: '⚪', label: 'Early',    bg: 'var(--t3)' },
};
const roasTone = (v) => (v == null ? 'var(--t3)' : v >= 4 ? 'var(--green)' : v > 0 && v < 2 ? 'var(--red)' : 'var(--t1)');
const VERDICTS = ['winner', 'promising', 'killed', 'inconclusive', 'paused'];
const DECISION_TYPES = ['kill', 'scale', 'graduate', 'iterate', 'pause', 'hold', 'restore-budget'];

function StatusChip({ s }) {
  const c = CHIP[s] || CHIP.early;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
      padding: '2px 8px', borderRadius: 20, color: c.bg, background: c.bg + '1e', border: `1px solid ${c.bg}44`, whiteSpace: 'nowrap' }}>
      {c.dot} {c.label}
    </span>
  );
}
function Tag({ children, tone = 'var(--t2)' }) {
  if (!children) return <span style={{ color: 'var(--t3)' }}>—</span>;
  return <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, padding: '1px 6px', borderRadius: 5,
    background: 'var(--t3)18', color: tone, border: '1px solid var(--border)' }}>{children}</span>;
}
function Roas({ recent, life }) {
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, whiteSpace: 'nowrap' }}>
      <b style={{ color: roasTone(recent) }}>{recent == null ? '—' : N(recent).toFixed(2)}</b>
      <span style={{ color: 'var(--t3)', margin: '0 4px' }}>|</span>
      <span style={{ color: roasTone(life) }}>{life == null ? '—' : N(life).toFixed(2)}</span>
    </span>
  );
}
function GateBar({ spend }) {
  const pct = Math.min(100, (N(spend) / GATE_INR) * 100);
  const tone = pct >= 100 ? 'var(--red)' : pct >= 70 ? '#E8A33D' : 'var(--accent)';
  return (
    <div title={`${inr(spend)} / ${inr(GATE_INR)} decision gate`} style={{ display: 'inline-block', width: 88, textAlign: 'right', verticalAlign: 'middle' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{inr(spend)}</div>
      <div style={{ height: 4, borderRadius: 3, background: 'var(--t3)33', marginTop: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: tone }} />
      </div>
    </div>
  );
}
// Actual-spend split (experiment vs scaling × today · lifetime). The active bucket is emphasised.
function SpendSplit({ spend, kind }) {
  const Row = ({ label, v, on }) => (
    <div style={{ opacity: on ? 1 : 0.6 }}>
      <span style={{ color: on ? 'var(--accent)' : 'var(--t3)', fontWeight: on ? 700 : 400 }}>{label}</span>
      {' '}{inr(N(v?.today))} <span style={{ color: 'var(--t3)' }}>· {inr(N(v?.life))}</span>
    </div>
  );
  return (
    <div style={{ minWidth: 220 }}>
      <div style={{ fontSize: 11, color: 'var(--t2)' }}>Spend — today · lifetime</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, display: 'grid', gap: 1, marginTop: 2 }}>
        <Row label="Experiment" v={spend?.experiment} on={kind === 'experiment'} />
        <Row label="Scaling" v={spend?.scale} on={kind === 'scale'} />
      </div>
    </div>
  );
}

export function DynoBoard({ kind = 'experiment' }) {
  const isScale = kind === 'scale';
  const { session, perms } = useAuth();
  const P = perms || {};
  const canWrite = !!P.sales_ads_write || !!P.salesops_admin;
  const canApprove = !!P.sales_ads_approve || !!P.salesops_admin;

  const [filter, setFilter] = useState('active');
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
      const b = await salesGet('getDynoBoard', { filter, recent_days: RECENT_DAYS, kind }, session);
      setBoard(b || { rows: [] });
    } catch (e) { setErr(String(e?.message || e)); }
    salesGet('getDynoSpend', {}, session).then(setSpend).catch(() => {});   // header split (both buckets, non-fatal)
  }, [session, filter, kind]);

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
    const s = { groups: new Set(), winning: 0, killing: 0, live: 0 };
    for (const r of rows) {
      s.groups.add(r.plan_id);
      if (r.ad_status === 'active') s.live += 1;
      if (r.computed_status === 'winning') s.winning += 1;
      if (r.computed_status === 'killing' || r.computed_status === 'killed') s.killing += 1;
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
    const target = isScale ? 'experiment' : 'scale';
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

  if (!board && !err) return <div style={{ padding: 40 }}><Spinner /></div>;

  const committed = N(board?.committed_daily_inr), ceiling = N(board?.ceiling_inr);
  const ceilPct = ceiling > 0 ? Math.min(100, (committed / ceiling) * 100) : 0;

  return (
    <div style={{ padding: '20px 28px 60px', maxWidth: 1400 }}>
      {/* Header strip */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.03em', margin: 0 }}>Dyno{isScale ? ' · Scaling' : ''}</h1>
          <div style={{ color: 'var(--t2)', fontSize: 12.5, marginTop: 2 }}>
            {isScale
              ? <>Scaling — graduated winners running for volume. Separate from experiments so spend stays clear.</>
              : <>Creative testing grounds — ROAS shown <b>recent {RECENT_DAYS}d</b> | <b>lifetime</b>. Decision gate {inr(GATE_INR)}.</>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
          <SpendSplit spend={spend} kind={kind} />
          <div style={{ minWidth: 180 }}>
            <div style={{ fontSize: 11, color: 'var(--t2)' }}>Committed budget / day (ceiling)</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 13.5 }}>{inr(committed)} <span style={{ color: 'var(--t3)' }}>/ {inr(ceiling)}</span></div>
            <div style={{ height: 5, borderRadius: 3, background: 'var(--t3)33', marginTop: 4, overflow: 'hidden' }}>
              <div style={{ width: `${ceilPct}%`, height: '100%', background: ceilPct >= 95 ? 'var(--red)' : 'var(--accent)' }} />
            </div>
          </div>
          <Stat lbl={isScale ? 'Campaigns' : 'Experiments'} val={stats.groups.size} />
          <Stat lbl="Live ads" val={stats.live} />
          <Stat lbl="Winning" val={stats.winning} tone="var(--green)" />
          <Stat lbl="Killing" val={stats.killing} tone="var(--red)" />
          <button className="so-btn ghost" onClick={() => load()} title="Refresh">↻</button>
        </div>
      </div>

      <DynoTabs />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <SegmentedToggle value={filter} onChange={setFilter} options={[
          { key: 'active', label: 'Active' }, { key: 'all', label: 'All' }, { key: 'staged', label: 'Staged' }]} />
        {!isScale && <button className="so-btn ghost" onClick={() => setShowAngles(s => !s)}>{showAngles ? 'Hide' : 'Angle library'}</button>}
        {board?.write_enabled === false && <span style={{ fontSize: 11.5, color: 'var(--red)' }}>⚠ Ad writes are OFF (settings.ads_write_enabled=false)</span>}
        {selIds.length > 0 && canWrite && (
          <button className="so-btn" onClick={bulkPause} style={{ marginLeft: 'auto' }}>Pause selected ({selIds.length})</button>
        )}
      </div>

      {err && <div style={{ background: 'var(--red)15', border: '1px solid var(--red)55', color: 'var(--red)', padding: '9px 13px', borderRadius: 8, fontSize: 12.5, marginBottom: 14 }}>{err}</div>}

      {!isScale && showAngles && <AngleLibrary angles={angles} canWrite={canWrite} session={session} onSaved={loadAngles} />}

      {groups.length === 0 && <div style={{ color: 'var(--t2)', padding: 30, textAlign: 'center' }}>No {isScale ? 'scaling campaigns' : (filter === 'staged' ? 'staged experiments' : 'variants')} in this view.</div>}

      {groups.map(({ plan, variants }) => {
        const staged = plan.plan_status === 'staged';
        return (
          <div key={plan.plan_id} className="so-card" style={{ marginBottom: 18, padding: 0, overflow: 'hidden' }}>
            {/* Experiment / campaign header */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--t3)0c' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 15 }}>{plan.product} · {plan.batch}</span>
                <Tag>{plan.plan_status}</Tag>
                {plan.plan_verdict && <span style={{ fontSize: 11.5, color: 'var(--t2)' }}>verdict: <b style={{ color: 'var(--t1)' }}>{plan.plan_verdict}</b></span>}
                {staged && canApprove && (
                  <button className="so-btn" style={{ marginLeft: 'auto' }}
                    onClick={() => run(`plan-${plan.plan_id}`, 'Approve', () => salesPost('adsApprovePlan', { plan_id: plan.plan_id }, session))}>
                    Approve &amp; Launch
                  </button>
                )}
                {canWrite && !staged && (
                  <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                    <BtnMini onClick={() => movePlan(plan)} disabled={busy === `kind-${plan.plan_id}`}
                      title={isScale ? 'Move back to the Experiments bucket' : 'Move to the Scaling bucket'}>
                      {isScale ? '→ Experiments' : '→ Scaling'}
                    </BtnMini>
                    <button className="so-btn ghost" onClick={() => openConclude(plan)}>Conclude</button>
                  </div>
                )}
              </div>
              {plan.hypothesis && <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 5, maxWidth: 900 }}><b style={{ color: 'var(--t1)' }}>Hypothesis:</b> {plan.hypothesis}</div>}
              {plan.plan_verdict_reason && <div style={{ fontSize: 11.5, color: 'var(--t2)', marginTop: 3, maxWidth: 900 }}><b style={{ color: 'var(--t1)' }}>Verdict:</b> {plan.plan_verdict_reason}</div>}
              <DecisionStrip planId={plan.plan_id} rows={decisions[plan.plan_id]} onOpen={() => loadDecisions(plan.plan_id)} />
            </div>

            {/* Variants table */}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: TABLE_MIN, borderCollapse: 'collapse', fontSize: 12.5, tableLayout: 'fixed' }}>
                <colgroup>{COLS.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
                <thead>
                  <tr style={{ color: 'var(--t2)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    <th style={{ padding: '7px 8px', textAlign: 'left', width: 26 }}></th>
                    <th style={{ padding: '7px 8px', textAlign: 'left' }}>Status</th>
                    <th style={{ padding: '7px 8px', textAlign: 'left' }}>Variant</th>
                    <th style={{ padding: '7px 8px', textAlign: 'left' }}>Angle · Segment</th>
                    <th style={{ padding: '7px 8px', textAlign: 'right' }}>Spend (gate)</th>
                    <th style={{ padding: '7px 8px', textAlign: 'right' }}>Buys</th>
                    <th style={{ padding: '7px 8px', textAlign: 'right' }}>ROAS r|life</th>
                    <th style={{ padding: '7px 8px', textAlign: 'right' }}>CPA</th>
                    <th style={{ padding: '7px 8px', textAlign: 'right' }}>CTR</th>
                    <th style={{ padding: '7px 8px', textAlign: 'left' }}>Verdict</th>
                    <th style={{ padding: '7px 8px', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {variants.map(r => {
                    const isBusy = busy === r.meta_id;
                    const paused = r.ad_status !== 'active';
                    return (
                      <tr key={r.meta_id} style={{ borderTop: '1px solid var(--border)', opacity: isBusy ? 0.5 : 1 }}>
                        <td style={{ padding: '8px' }}>
                          <input type="checkbox" checked={!!sel[r.meta_id]} onChange={e => setSel(s => ({ ...s, [r.meta_id]: e.target.checked }))} />
                        </td>
                        <td style={{ padding: '8px' }}><StatusChip s={r.computed_status} /></td>
                        <td style={{ padding: '8px', maxWidth: 260 }}>
                          <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                            <Thumb url={r.asset_url} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 600 }}>{r.headline || r.ad_name}</div>
                              <div style={{ color: 'var(--t3)', fontSize: 10.5, fontFamily: 'var(--mono)' }}>{r.ad_name}{r.parent_meta_id ? ' · ↳ iterated' : ''}</div>
                              {r.primary_text && (
                                <button onClick={() => setExpanded(x => ({ ...x, [r.meta_id]: !x[r.meta_id] }))}
                                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 10.5, padding: '2px 0' }}>
                                  {expanded[r.meta_id] ? 'hide copy' : 'copy'}
                                </button>
                              )}
                              {expanded[r.meta_id] && <div style={{ fontSize: 11, color: 'var(--t2)', marginTop: 3, whiteSpace: 'pre-wrap' }}>{r.primary_text}</div>}
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '8px' }}><Tag>{r.angle}</Tag> <Tag tone="var(--t3)">{r.audience_segment}</Tag></td>
                        <td style={{ padding: '8px', textAlign: 'right', minWidth: 96 }}><GateBar spend={r.spend_life} /></td>
                        <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtInt(r.purchases_life)}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}><Roas recent={r.roas_recent} life={r.roas_life} /></td>
                        <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{r.cpa_life == null ? '—' : inr(r.cpa_life)}</td>
                        <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{r.ctr_life == null ? '—' : N(r.ctr_life).toFixed(2) + '%'}</td>
                        <td style={{ padding: '8px' }}>{r.verdict ? <Tag tone="var(--t1)">{r.verdict}</Tag> : <span style={{ color: 'var(--t3)' }}>—</span>}</td>
                        <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {canWrite ? (
                            <div style={{ display: 'inline-flex', gap: 4 }}>
                              {paused
                                ? <BtnMini onClick={() => resume(r)} disabled={isBusy}>Resume</BtnMini>
                                : <BtnMini onClick={() => pause(r)} disabled={isBusy}>Pause</BtnMini>}
                              <BtnMini onClick={() => kill(r)} disabled={isBusy} tone="var(--red)">Kill</BtnMini>
                              <BtnMini onClick={() => scale(r)} disabled={isBusy || !canApprove} title={canApprove ? 'Scale ad-set budget' : 'Scaling needs approver role'}>Scale</BtnMini>
                              <BtnMini onClick={() => rename(r)} disabled={isBusy}>Rename</BtnMini>
                              <BtnMini onClick={() => openVerdict(r)} disabled={isBusy}>Verdict</BtnMini>
                            </div>
                          ) : <span style={{ color: 'var(--t3)', fontSize: 11 }}>monitor</span>}
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

function Stat({ lbl, val, tone = 'var(--t1)' }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 700, color: tone, lineHeight: 1 }}>{val}</div>
      <div style={{ fontSize: 10.5, color: 'var(--t2)', marginTop: 2 }}>{lbl}</div>
    </div>
  );
}
function Thumb({ url }) {
  if (!url) return <div style={{ width: 40, height: 40, borderRadius: 6, background: 'var(--t3)22', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t3)', fontSize: 9 }}>—</div>;
  return <img src={url} alt="" style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', flexShrink: 0, border: '1px solid var(--border)' }} />;
}
function BtnMini({ children, onClick, disabled, tone, title }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border)',
        background: 'var(--surface)', color: tone || 'var(--t1)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1 }}>
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
  const inputStyle = { width: '100%', marginTop: 4, padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' };
  return (
    <Modal open onClose={onClose} title={title}>
      <div style={{ display: 'grid', gap: 12, minWidth: 340 }}>
        <label style={{ fontSize: 12, color: 'var(--t2)' }}>Verdict
          <select value={verdict} onChange={ev => setVerdict(ev.target.value)} style={inputStyle}>
            <option value="">— choose —</option>{VERDICTS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: 'var(--t2)' }}>Reason / why
          <textarea value={reason} onChange={ev => setReason(ev.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
        </label>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 6 }}>Optionally log a decision (feeds the decision tree)</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={decType} onChange={ev => setDecType(ev.target.value)} style={{ flex: '0 0 150px', padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }}>
              <option value="">— no decision —</option>{DECISION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input value={decWhy} onChange={ev => setDecWhy(ev.target.value)} placeholder="rationale" disabled={!decType} style={{ flex: 1, padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }} />
          </div>
        </div>
        {e && <div style={{ color: 'var(--red)', fontSize: 12 }}>{e}</div>}
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
      <button onClick={toggle} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, padding: 0 }}>
        {open ? 'hide decisions' : 'decisions'}
      </button>
      {open && (
        <div style={{ marginTop: 5, display: 'grid', gap: 3 }}>
          {!rows && <div style={{ fontSize: 11, color: 'var(--t3)' }}>loading…</div>}
          {rows && rows.length === 0 && <div style={{ fontSize: 11, color: 'var(--t3)' }}>No decisions logged.</div>}
          {rows && rows.map(dc => (
            <div key={dc.id} style={{ fontSize: 11, color: 'var(--t2)' }}>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--t1)' }}>{dc.type}</span>
              {dc.rationale ? ` — ${dc.rationale}` : ''} <span style={{ color: 'var(--t3)' }}>· {new Date(dc.decided_at).toLocaleDateString('en-IN')}</span>
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
    <div className="so-card" style={{ padding: 14, marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <b style={{ fontFamily: 'var(--cond)', fontSize: 14 }}>Angle library</b>
        {canWrite && !draft && <button className="so-btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setDraft(blank)}>+ New angle</button>}
      </div>
      {angles == null && <Spinner />}
      {angles && (
        <div style={{ display: 'grid', gap: 4 }}>
          {angles.map(a => (
            <div key={a.slug} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12 }}>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--t1)', minWidth: 190 }}>{a.slug}</span>
              <span style={{ color: 'var(--t2)', flex: 1 }}>{a.name}</span>
              <Tag tone="var(--t3)">{a.status}</Tag>
              {canWrite && <button onClick={() => setDraft({ slug: a.slug, name: a.name, psychology_pillar: a.psychology_pillar || '', status: a.status, hypothesis: a.hypothesis || '', evidence: a.evidence || '' })} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}>edit</button>}
            </div>
          ))}
        </div>
      )}
      {draft && (
        <div style={{ marginTop: 12, display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={draft.slug} onChange={ev => setDraft({ ...draft, slug: ev.target.value })} placeholder="slug (e.g. working-machine)" style={{ flex: 1, padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }} />
            <input value={draft.name} onChange={ev => setDraft({ ...draft, name: ev.target.value })} placeholder="name" style={{ flex: 1, padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }} />
            <select value={draft.status} onChange={ev => setDraft({ ...draft, status: ev.target.value })} style={{ flex: '0 0 130px', padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }}>{ANGLE_STATUS.map(s => <option key={s} value={s}>{s}</option>)}</select>
          </div>
          <input value={draft.psychology_pillar} onChange={ev => setDraft({ ...draft, psychology_pillar: ev.target.value })} placeholder="psychology_pillar (optional)" style={{ padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)' }} />
          <textarea value={draft.hypothesis} onChange={ev => setDraft({ ...draft, hypothesis: ev.target.value })} rows={2} placeholder="hypothesis (optional)" style={{ padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--t1)', resize: 'vertical' }} />
          {e && <div style={{ color: 'var(--red)', fontSize: 12 }}>{e}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="so-btn ghost" onClick={() => setDraft(null)} disabled={busy}>Cancel</button>
            <button className="so-btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save angle'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
