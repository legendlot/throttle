'use client';
/* ════════════════════════════════════════════════════════════
   RETURNS — Inbox stream (Pit Wall v2). Return piles by
   disposition with the two production-owned request flows
   (RULE-RET-002) preserved exactly:
   · Request UDR Issue   → workerFetch createUdrRequest
   · Request Repair Run  → workerFetch createRepairRun
   Data: garageFetch getReturnPilesV2, 60s auto-refresh.
   ════════════════════════════════════════════════════════════ */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, EmptyState, useToast, useEscapeClose } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import {
  Icon, KpiTile, Panel, InboxTabs, fmt, btnPrimary, btnGhost, inputStyle,
} from '../../../components/kit/index.js';

function formatAge(ts) {
  if (!ts) return '—';
  const ms = Date.now() - new Date(ts).getTime();
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days}d`;
  return `${Math.floor(ms / 3600000)}h`;
}

// ── shared table cell styles (Pit Wall v2) ────────────────────
const thStyle = { padding: '0 14px 9px', textAlign: 'left', whiteSpace: 'nowrap' };
const tdBase = { padding: '10px 14px', borderTop: '1px solid var(--border)', whiteSpace: 'nowrap', verticalAlign: 'middle' };

const PILE_META = {
  UDR:  { color: 'var(--ok-fg)',   label: 'UDR · re-dispatch', icon: 'truck' },
  CXR:  { color: 'var(--yellow)',  label: 'CXR · repair',      icon: 'wrench' },
  BRV:  { color: 'var(--info-fg)', label: 'BRV · repair',      icon: 'wrench' },
  Loss: { color: 'var(--bad-fg)',  label: 'Loss · write-off',  icon: 'flag' },
  scrap:{ color: 'var(--t3)',      label: 'Scrap',             icon: 'box' },
};
const LINES = ['L1', 'L2', 'L3', 'L4', 'L5'];

const selectStyle = { ...inputStyle, width: 'auto', padding: '6px 10px', fontSize: 12.5, cursor: 'pointer' };

function PileTable({ rows, color, showOldest }) {
  if (!rows.length) return (
    <div style={{ padding: 28, textAlign: 'center', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)' }}>Empty</div>
  );
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={thStyle}><span className="eyebrow">Product</span></th>
          <th style={thStyle}><span className="eyebrow">Model</span></th>
          <th style={thStyle}><span className="eyebrow">Colour</span></th>
          <th style={{ ...thStyle, textAlign: 'right' }}><span className="eyebrow">Count</span></th>
          {showOldest && <th style={{ ...thStyle, textAlign: 'right' }}><span className="eyebrow">Oldest</span></th>}
        </tr></thead>
        <tbody>
          {rows.map((b, i) => (
            <tr key={`${b.product}-${b.model}-${b.color}-${i}`}>
              <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{b.product || '—'}</td>
              <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>{b.model || '—'}</td>
              <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>{b.color || '—'}</td>
              <td style={{ ...tdBase, textAlign: 'right' }}><span className="num" style={{ fontSize: 13, fontWeight: 700, color }}>{fmt(b.count)}</span></td>
              {showOldest && <td style={{ ...tdBase, textAlign: 'right' }}><span className="num" style={{ fontSize: 12, color: 'var(--t3)' }}>{formatAge(b.oldest_at)}</span></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ReturnsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [piles, setPiles] = useState({ UDR: [], CXR: [], BRV: [], Loss: [], scrap: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reqOpen, setReqOpen] = useState(false);
  const [reqLine, setReqLine] = useState('L1');
  const [reqSel, setReqSel] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [udrOpen, setUdrOpen] = useState(false);
  const [udrSel, setUdrSel] = useState({});
  const [udrSubmitting, setUdrSubmitting] = useState(false);

  useEscapeClose(reqOpen, () => { if (!submitting) setReqOpen(false); });
  useEscapeClose(udrOpen, () => { if (!udrSubmitting) setUdrOpen(false); });

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true); setRefreshing(true); setError(null);
    try {
      const d = await garageFetch('getReturnPilesV2', {}, session);
      setPiles({
        UDR:  Array.isArray(d?.UDR) ? d.UDR : [],
        CXR:  Array.isArray(d?.CXR) ? d.CXR : [],
        BRV:  Array.isArray(d?.BRV) ? d.BRV : [],
        Loss: Array.isArray(d?.Loss) ? d.Loss : [],
        scrap:Array.isArray(d?.scrap) ? d.scrap : [],
      });
      setLastRefreshed(new Date());
    } catch (e) {
      setError(e.message || 'Failed to load return piles');
    } finally { setLoading(false); setRefreshing(false); }
  }, [session, setRefreshing, setLastRefreshed]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!session) return;
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load, session]);

  const tot = (k) => piles[k].reduce((s, b) => s + (b.count || 0), 0);
  const repairBuckets = useMemo(() => [...piles.CXR, ...piles.BRV], [piles]);
  const totalUnits = ['UDR', 'CXR', 'BRV', 'Loss', 'scrap'].reduce((s, k) => s + tot(k), 0);

  function toggleSel(b) {
    const key = `${b.product}|${b.model}|${b.color}`;
    setReqSel((prev) => {
      const n = { ...prev };
      if (n[key]) delete n[key]; else n[key] = { product: b.product, model: b.model, color: b.color, target_car_qty: b.count || 0 };
      return n;
    });
  }

  async function submitRequest() {
    const lines = Object.values(reqSel);
    setSubmitting(true);
    try {
      const res = await workerFetch('createRepairRun', { data: { line: reqLine, notes: 'Requested from Redline returns piles', lines } }, session);
      const r = res.data || res;
      showToast(`Repair run ${r.run_no} requested — Store issues units against it`, 'success');
      setReqOpen(false); setReqSel({});
    } catch (e) {
      showToast(e.message || 'Failed to request run', 'error');
    } finally { setSubmitting(false); }
  }

  // ── UDR issue request (notional; production-owned, RULE-RET-002) ──
  // A variant is only requestable for what is left AFTER outstanding requests. `available`
  // and `requested` come from getReturnPilesV2; falling back to `count` keeps the modal
  // working against an older worker response rather than disabling every row.
  const udrAvail = (b) => (b.available != null ? b.available : (b.count || 0));
  function toggleUdr(b) {
    if (udrAvail(b) <= 0) return;   // nothing left to request — the worker would 422 anyway
    const key = `${b.product}|${b.model}|${b.color}`;
    setUdrSel((prev) => {
      const n = { ...prev };
      if (n[key]) delete n[key]; else n[key] = { product: b.product, model: b.model, color: b.color, qty: udrAvail(b) };
      return n;
    });
  }
  function toggleAllUdr() {
    const selectable = piles.UDR.filter((b) => udrAvail(b) > 0);
    setUdrSel((prev) => {
      const allSel = selectable.length > 0 && selectable.every((b) => prev[`${b.product}|${b.model}|${b.color}`]);
      if (allSel) return {};
      const n = {};
      for (const b of selectable) n[`${b.product}|${b.model}|${b.color}`] = { product: b.product, model: b.model, color: b.color, qty: udrAvail(b) };
      return n;
    });
  }
  // Only over SELECTABLE rows — otherwise the header box can never read checked whenever a
  // single variant is fully consumed, which is currently 10 of 14.
  const udrSelectable = piles.UDR.filter((b) => udrAvail(b) > 0);
  const allUdrSelected = udrSelectable.length > 0 && udrSelectable.every((b) => udrSel[`${b.product}|${b.model}|${b.color}`]);
  function setUdrQty(key, qty) {
    // Clamp to what is actually free. Without this the point of the change is lost: someone
    // can still type past availability and hit the exact 422 this is meant to pre-empt. The
    // worker still validates — this only stops a submit that is guaranteed to fail.
    const b = piles.UDR.find((x) => `${x.product}|${x.model}|${x.color}` === key);
    const cap = b ? udrAvail(b) : Infinity;
    setUdrSel((prev) => (prev[key]
      ? { ...prev, [key]: { ...prev[key], qty: Math.min(cap, Math.max(0, parseInt(qty, 10) || 0)) } }
      : prev));
  }
  async function submitUdr() {
    const lines = Object.values(udrSel).filter((l) => l.qty > 0);
    if (!lines.length) { showToast('Select at least one UDR bucket with a qty', 'error'); return; }
    setUdrSubmitting(true);
    try {
      const res = await workerFetch('createUdrRequest', { data: { lines, notes: 'UDR issue request from Redline returns' } }, session);
      const r = res.data || res;
      const nLines = r.lines != null ? r.lines : lines.length;
      showToast(`UDR request ${r.wo_no || ''} raised (${nLines} line${nLines === 1 ? '' : 's'}) — one item in the Store Issue Queue`, 'success');
      setUdrOpen(false); setUdrSel({});
    } catch (e) {
      showToast(e.message || 'Failed to request UDR issue', 'error');
    } finally { setUdrSubmitting(false); }
  }

  if (error) return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <InboxTabs />
      <EmptyState message={`Failed to load: ${error}`} />
    </div>
  );

  const modalShell = { background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-md)',
    boxShadow: 'var(--shadow-pop)', padding: 20, color: 'var(--t1)', minWidth: 520, maxWidth: 620, width: '100%' };

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <InboxTabs counts={{ returns: totalUnits }} />

      <section style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
          <h2 className="label" style={{ margin: 0, fontSize: 12, color: 'var(--t2)' }}>Return Piles</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...btnGhost, opacity: loading ? 0.6 : 1 }} onClick={load} disabled={loading}>
              <Icon name="undo" size={14} /> Refresh
            </button>
            <button
              style={{ ...btnPrimary, background: 'var(--green)', color: '#0a0a0a', opacity: !piles.UDR.length ? 0.5 : 1 }}
              onClick={() => setUdrOpen(true)} disabled={!piles.UDR.length}>
              Request UDR Issue <Icon name="chevR" size={14} />
            </button>
            <button
              style={{ ...btnPrimary, opacity: !repairBuckets.length ? 0.5 : 1 }}
              onClick={() => setReqOpen(true)} disabled={!repairBuckets.length}>
              Request Repair Run <Icon name="chevR" size={14} />
            </button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
          <KpiTile label="UDR"   value={fmt(tot('UDR'))}   tone={tot('UDR')  > 0 ? 'ok'    : undefined} />
          <KpiTile label="CXR"   value={fmt(tot('CXR'))}   tone={tot('CXR')  > 0 ? 'brand' : undefined} />
          <KpiTile label="BRV"   value={fmt(tot('BRV'))}   tone={tot('BRV')  > 0 ? 'blue'  : undefined} />
          <KpiTile label="Loss"  value={fmt(tot('Loss'))}  tone={tot('Loss') > 0 ? 'bad'   : undefined} />
          <KpiTile label="Scrap" value={fmt(tot('scrap'))} />
        </div>
      </section>

      {loading ? (
        <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {['UDR', 'CXR', 'BRV', 'Loss', 'scrap'].map((k) => (
            <Panel key={k} pad={8} icon={PILE_META[k].icon}
              title={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: PILE_META[k].color }} />
                  {PILE_META[k].label}
                </span>
              }
              action={<span className="num" style={{ fontSize: 12, color: 'var(--t3)' }}>{fmt(tot(k))} units</span>}>
              <PileTable rows={piles[k]} color={PILE_META[k].color} showOldest={k !== 'scrap' && k !== 'Loss'} />
            </Panel>
          ))}
        </div>
      )}

      <div style={{ marginTop: 20, fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)', textAlign: 'center' }}>
        Auto-refreshes every 60s. Store issues units (Garage → Returns). Repaired units re-pair at QC PASS.
      </div>

      {reqOpen && (
        <div onClick={() => !submitting && setReqOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9000, padding: 24, overflowY: 'auto' }}>
          <div onClick={(e) => e.stopPropagation()} style={modalShell}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 className="label" style={{ margin: 0, fontSize: 13, color: 'var(--yellow)' }}>Request Repair Run</h3>
              <button style={{ ...btnGhost, padding: '5px 8px' }} onClick={() => setReqOpen(false)} disabled={submitting}><Icon name="x" size={14} /></button>
            </div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)', marginBottom: 12, lineHeight: 1.5 }}>
              Creates an empty repair run with these target lines. Store then physically issues (scans out) the units against it on the Garage → Issue Repair tab.
            </div>
            <div style={{ marginBottom: 12 }}>
              <span className="eyebrow" style={{ display: 'block', marginBottom: 5 }}>Line</span>
              <select value={reqLine} onChange={(e) => setReqLine(e.target.value)} style={selectStyle} disabled={submitting}>
                {LINES.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 0 0' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={thStyle}></th>
                  <th style={thStyle}><span className="eyebrow">Disp</span></th>
                  <th style={thStyle}><span className="eyebrow">Product</span></th>
                  <th style={thStyle}><span className="eyebrow">Colour</span></th>
                  <th style={{ ...thStyle, textAlign: 'right' }}><span className="eyebrow">Count</span></th>
                </tr></thead>
                <tbody>
                  {repairBuckets.map((b, i) => {
                    const key = `${b.product}|${b.model}|${b.color}`;
                    const disp = piles.CXR.includes(b) ? 'CXR' : 'BRV';
                    return (
                      <tr key={`${key}-${i}`} onClick={() => toggleSel(b)} style={{ cursor: 'pointer', background: reqSel[key] ? 'var(--brand-bg)' : 'transparent' }}>
                        <td style={tdBase}><input type="checkbox" readOnly checked={!!reqSel[key]} /></td>
                        <td style={tdBase}><span className="num" style={{ fontSize: 12, fontWeight: 600, color: disp === 'CXR' ? 'var(--yellow)' : 'var(--info-fg)' }}>{disp}</span></td>
                        <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{[b.product, b.model].filter(Boolean).join(' ')}</td>
                        <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>{b.color || '—'}</td>
                        <td style={{ ...tdBase, textAlign: 'right' }}><span className="num" style={{ fontSize: 13, fontWeight: 700, color: 'var(--yellow)' }}>{fmt(b.count)}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button style={{ ...btnGhost, opacity: submitting ? 0.6 : 1 }} onClick={() => setReqOpen(false)} disabled={submitting}>Cancel</button>
              <button style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1 }} onClick={submitRequest} disabled={submitting}>{submitting ? 'Requesting…' : 'Create Run'}</button>
            </div>
          </div>
        </div>
      )}

      {udrOpen && (
        <div onClick={() => !udrSubmitting && setUdrOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9000, padding: 24, overflowY: 'auto' }}>
          <div onClick={(e) => e.stopPropagation()} style={modalShell}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 className="label" style={{ margin: 0, fontSize: 13, color: 'var(--ok-fg)' }}>Request UDR Issue</h3>
              <button style={{ ...btnGhost, padding: '5px 8px' }} onClick={() => setUdrOpen(false)} disabled={udrSubmitting}><Icon name="x" size={14} /></button>
            </div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)', marginBottom: 12, lineHeight: 1.5 }}>
              Raises a notional UDR issue request (one work order per line). It appears in the <strong style={{ color: 'var(--t2)' }}>Store Issue Queue</strong>; the Store then scans each unit out at the <strong style={{ color: 'var(--t2)' }}>Issue UDR</strong> station — no desk issuing. <strong style={{ color: 'var(--t2)' }}>Requested</strong> is what open requests have already claimed, so only the free remainder can be asked for.
            </div>
            <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 0 0' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={thStyle}><input type="checkbox" readOnly checked={allUdrSelected} onClick={toggleAllUdr} title="Select all" style={{ cursor: 'pointer' }} /></th>
                  <th style={thStyle}><span className="eyebrow">Product</span></th>
                  <th style={thStyle}><span className="eyebrow">Colour</span></th>
                  <th style={{ ...thStyle, textAlign: 'right' }}><span className="eyebrow">In pool</span></th>
                  <th style={{ ...thStyle, textAlign: 'right' }}><span className="eyebrow">Requested</span></th>
                  <th style={{ ...thStyle, textAlign: 'right' }}><span className="eyebrow">Request qty</span></th>
                </tr></thead>
                <tbody>
                  {piles.UDR.map((b, i) => {
                    const key = `${b.product}|${b.model}|${b.color}`;
                    const sel = udrSel[key];
                    const requested = b.requested || 0;
                    const avail = udrAvail(b);
                    // Fully consumed: the pile shows units, but every one is already promised
                    // to an open request, so requesting again 422s. Dim + block rather than
                    // hide — production still needs to see the units exist and why they are
                    // not requestable. The worker remains the authority.
                    const spent = avail <= 0;
                    const click = spent ? undefined : () => toggleUdr(b);
                    const nameStyle = { ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: spent ? 'var(--t3)' : 'var(--t1)', cursor: spent ? 'not-allowed' : 'pointer' };
                    return (
                      <tr key={`${key}-${i}`} title={spent ? `All ${fmt(b.count)} in the pile are already promised to open requests — nothing left to request` : undefined}
                          style={{ background: sel ? 'var(--ok-bg)' : 'transparent', opacity: spent ? 0.55 : 1 }}>
                        <td style={tdBase}><input type="checkbox" readOnly disabled={spent} checked={!!sel} onClick={click} style={{ cursor: spent ? 'not-allowed' : 'pointer' }} /></td>
                        <td style={nameStyle} onClick={click}>{[b.product, b.model].filter(Boolean).join(' ')}</td>
                        <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', cursor: spent ? 'not-allowed' : 'pointer' }} onClick={click}>{b.color || '—'}</td>
                        <td style={{ ...tdBase, textAlign: 'right' }}><span className="num" style={{ fontSize: 12.5, color: 'var(--t3)' }}>{fmt(b.count)}</span></td>
                        <td style={{ ...tdBase, textAlign: 'right' }}>
                          <span className="num" style={{ fontSize: 12.5, color: requested > 0 ? 'var(--warn-fg, #fbbf24)' : 'var(--t4)' }}>{requested > 0 ? fmt(requested) : '—'}</span>
                        </td>
                        <td style={{ ...tdBase, textAlign: 'right' }}>
                          {spent
                            ? <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t3)' }}>all requested</span>
                            : sel
                              ? <input type="number" min="0" max={avail} value={sel.qty} onChange={(e) => setUdrQty(key, e.target.value)}
                                  className="num" style={{ ...inputStyle, width: 70, padding: '5px 8px', fontSize: 12.5, textAlign: 'right' }} />
                              : <span style={{ color: 'var(--t3)' }}>{fmt(avail)} free</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button style={{ ...btnGhost, opacity: udrSubmitting ? 0.6 : 1 }} onClick={() => setUdrOpen(false)} disabled={udrSubmitting}>Cancel</button>
              <button style={{ ...btnPrimary, background: 'var(--green)', color: '#0a0a0a', opacity: udrSubmitting ? 0.6 : 1 }} onClick={submitUdr} disabled={udrSubmitting}>{udrSubmitting ? 'Requesting…' : 'Raise Request'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
