'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, salesPost, inr, fmtInt } from '../../../lib/api.js';
import { SegmentedToggle } from '../../../components/kit.js';

// Dyno — LOT creative testing grounds. Live board (one row per variant) + controls, all against
// the same gated Worker actions the Brand engine uses. Monitor-only is fully supported (buttons
// simply don't render without the ads-write / ads-approve perms).

const GATE_INR = 6500;   // the kill-decision spend gate (mirror of settings.ads_kill_after_inr)
const RECENT_DAYS = 3;

// Shared fixed column widths so every experiment table lines up (auto-layout sized each table to
// its own content, so columns drifted between experiments). Order = the 11 columns below.
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

export default function DynoPage() {
  const { session, perms } = useAuth();
  const P = perms || {};
  const canWrite = !!P.sales_ads_write || !!P.salesops_admin;
  const canApprove = !!P.sales_ads_approve || !!P.salesops_admin;

  const [filter, setFilter] = useState('active');
  const [board, setBoard] = useState(null);       // { rows, committed_daily_inr, ceiling_inr, write_enabled }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');           // meta_id currently mutating
  const [sel, setSel] = useState({});             // bulk selection: meta_id → true
  const [expanded, setExpanded] = useState({});   // meta_id → show copy
  const timer = useRef(null);

  const load = useCallback(async (quiet) => {
    if (!session) return;
    if (!quiet) { setBoard(null); setErr(''); }
    try {
      const b = await salesGet('getDynoBoard', { filter, recent_days: RECENT_DAYS }, session);
      setBoard(b || { rows: [] });
    } catch (e) { setErr(String(e?.message || e)); }
  }, [session, filter]);

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
    const s = { experiments: new Set(), winning: 0, killing: 0, live: 0 };
    for (const r of rows) {
      s.experiments.add(r.plan_id);
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
  const kill = async (r) => {
    if (!confirm(`Kill "${r.ad_name}"? Pauses the ad and records a "killed" verdict.`)) return;
    const reason = prompt('Why killed? (optional)', r.verdict_reason || '') ?? '';
    await run(r.meta_id, 'Kill', async () => {
      await salesPost('metaSetStatus', { entity_type: 'ad', meta_id: r.meta_id, status: 'PAUSED', plan_id: r.plan_id }, session);
      await salesPost('adsSetVerdict', { meta_id: r.meta_id, verdict: 'killed', reason }, session);
    });
  };
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
  const setVerdict = (r) => {
    const v = prompt(`Verdict (${VERDICTS.join(' / ')}):`, r.verdict || '');
    if (!v) return;
    if (!VERDICTS.includes(v.trim())) { setErr(`Verdict must be one of: ${VERDICTS.join(', ')}`); return; }
    const reason = prompt('Reason / why:', r.verdict_reason || '') ?? '';
    run(r.meta_id, 'Set verdict', () => salesPost('adsSetVerdict', { meta_id: r.meta_id, verdict: v.trim(), reason }, session));
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
          <h1 style={{ fontFamily: 'var(--cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.03em', margin: 0 }}>Dyno</h1>
          <div style={{ color: 'var(--t2)', fontSize: 12.5, marginTop: 2 }}>Creative testing grounds — ROAS shown <b>recent {RECENT_DAYS}d</b> | <b>lifetime</b>. Decision gate {inr(GATE_INR)}.</div>
        </div>
        <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 190 }}>
            <div style={{ fontSize: 11, color: 'var(--t2)' }}>Committed daily / ceiling</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 13.5 }}>{inr(committed)} <span style={{ color: 'var(--t3)' }}>/ {inr(ceiling)}</span></div>
            <div style={{ height: 5, borderRadius: 3, background: 'var(--t3)33', marginTop: 4, overflow: 'hidden' }}>
              <div style={{ width: `${ceilPct}%`, height: '100%', background: ceilPct >= 95 ? 'var(--red)' : 'var(--accent)' }} />
            </div>
          </div>
          <Stat lbl="Experiments" val={stats.experiments.size} />
          <Stat lbl="Live ads" val={stats.live} />
          <Stat lbl="Winning" val={stats.winning} tone="var(--green)" />
          <Stat lbl="Killing" val={stats.killing} tone="var(--red)" />
          <button className="so-btn ghost" onClick={() => load()} title="Refresh">↻</button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <SegmentedToggle value={filter} onChange={setFilter} options={[
          { key: 'active', label: 'Active' }, { key: 'all', label: 'All' }, { key: 'staged', label: 'Staged' }]} />
        {board?.write_enabled === false && <span style={{ fontSize: 11.5, color: 'var(--red)' }}>⚠ Ad writes are OFF (settings.ads_write_enabled=false)</span>}
        {selIds.length > 0 && canWrite && (
          <button className="so-btn" onClick={bulkPause} style={{ marginLeft: 'auto' }}>Pause selected ({selIds.length})</button>
        )}
      </div>

      {err && <div style={{ background: 'var(--red)15', border: '1px solid var(--red)55', color: 'var(--red)', padding: '9px 13px', borderRadius: 8, fontSize: 12.5, marginBottom: 14 }}>{err}</div>}

      {groups.length === 0 && <div style={{ color: 'var(--t2)', padding: 30, textAlign: 'center' }}>No {filter === 'staged' ? 'staged experiments' : 'variants'} in this view.</div>}

      {groups.map(({ plan, variants }) => {
        const staged = plan.plan_status === 'staged';
        return (
          <div key={plan.plan_id} className="so-card" style={{ marginBottom: 18, padding: 0, overflow: 'hidden' }}>
            {/* Experiment header */}
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
              </div>
              {plan.hypothesis && <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 5, maxWidth: 900 }}><b style={{ color: 'var(--t1)' }}>Hypothesis:</b> {plan.hypothesis}</div>}
              {plan.plan_verdict_reason && <div style={{ fontSize: 11.5, color: 'var(--t2)', marginTop: 3, maxWidth: 900 }}><b style={{ color: 'var(--t1)' }}>Verdict:</b> {plan.plan_verdict_reason}</div>}
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
                              <BtnMini onClick={() => setVerdict(r)} disabled={isBusy}>Verdict</BtnMini>
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
