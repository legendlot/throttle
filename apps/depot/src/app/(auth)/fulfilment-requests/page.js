'use client';
/* ════════════════════════════════════════════════════════════
   Depot — Fulfilment Requests.
   Sales orders confirmed in Snorkel land here as fulfilment
   requests. The dispatch team ACCEPTS (Full = one shipment, or
   Split = N shipments with their own dates) or REJECTS (which
   cancels the Snorkel sales order). Accepted requests spawn child
   shipments that show on the Shipments screen.
   Reads: getFulfilmentRequests (list) · getFulfilmentRequest (detail).
   Writes: acceptFulfilmentFull · acceptFulfilmentSplit · rejectFulfilment.
   ════════════════════════════════════════════════════════════ */
import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Panel, EmptyState, Spinner, Modal } from '@throttle/ui';
import { btnPrimary, btnGhost, inputStyle, fmt, istToday } from '../../../components/kit';

const STATUS_COLOR = {
  pending: 'var(--amber)', accepted: 'var(--green)', rejected: 'var(--red)', cancelled: 'var(--t3)',
};
function StatusPill({ status }) {
  const c = STATUS_COLOR[status] || 'var(--t3)';
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase',
      color: c, border: `1px solid ${c}`, borderRadius: 4, padding: '2px 8px' }}>{status}</span>
  );
}
const th = { padding: '9px 12px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', textAlign: 'left', whiteSpace: 'nowrap', fontWeight: 600 };
const td = { padding: '9px 12px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', color: 'var(--t1)', whiteSpace: 'nowrap' };
const lineKey = (l) => `${l.product || ''}|${l.model || ''}|${l.color || ''}`;
const lineLabel = (l) => [l.product, l.model, l.color].filter(Boolean).join(' ');

export default function FulfilmentRequestsPage() {
  const { session } = useAuth();
  const router = useRouter();

  const [tab, setTab]         = useState('pending');   // pending | all
  const [list, setList]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel]         = useState(null);        // { request, lines, shipments }
  const [busy, setBusy]       = useState(false);
  const [msg, setMsg]         = useState('');

  // reject modal
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // split modal
  const [splitOpen, setSplitOpen] = useState(false);
  const [splits, setSplits] = useState([]);            // [{ scheduled_date, qty:{ [key]: n } }]

  const loadList = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const params = tab === 'pending' ? { status: 'pending' } : {};
      const r = await garageFetch('getFulfilmentRequests', params, session);
      setList(Array.isArray(r) ? r : []);
    } catch { setList([]); }
    finally { setLoading(false); }
  }, [session, tab]);

  useEffect(() => { loadList(); }, [loadList]);

  const openDetail = useCallback(async (id) => {
    setMsg(''); setSel(null);
    const r = await garageFetch('getFulfilmentRequest', { id }, session);
    if (r?.request) setSel(r);
  }, [session]);

  async function acceptFull() {
    if (!sel?.request) return;
    setBusy(true);
    try {
      const r = await workerFetch('acceptFulfilmentFull', { request_id: sel.request.id }, session);
      if (r?.ok === false) throw new Error(r?.data || 'failed');
      setMsg(`Accepted — shipment ${r?.data?.shipment_no || ''} created.`);
      await loadList(); await openDetail(sel.request.id);
    } catch (e) { setMsg('Accept failed: ' + (e.message || e)); }
    finally { setBusy(false); }
  }

  async function submitReject() {
    if (!sel?.request || !rejectReason.trim()) return;
    setBusy(true);
    try {
      const r = await workerFetch('rejectFulfilment', { request_id: sel.request.id, reason: rejectReason.trim() }, session);
      if (r?.ok === false) throw new Error(r?.data || 'failed');
      setRejectOpen(false); setRejectReason('');
      setMsg('Rejected — the Snorkel sales order will be cancelled.');
      await loadList(); await openDetail(sel.request.id);
    } catch (e) { setMsg('Reject failed: ' + (e.message || e)); }
    finally { setBusy(false); }
  }

  // ── Split builder ──────────────────────────────────────────
  function openSplit() {
    if (!sel?.lines?.length) return;
    // start with one shipment carrying the full requested qty
    const full = {}; sel.lines.forEach(l => { full[lineKey(l)] = Math.round(Number(l.qty)) || 0; });
    setSplits([{ scheduled_date: istToday(), qty: full }]);
    setSplitOpen(true);
  }
  function addSplit() {
    const zero = {}; sel.lines.forEach(l => { zero[lineKey(l)] = 0; });
    setSplits(s => [...s, { scheduled_date: istToday(), qty: zero }]);
  }
  function removeSplit(i) { setSplits(s => s.filter((_, idx) => idx !== i)); }
  function setSplitQty(i, key, val) {
    setSplits(s => s.map((sp, idx) => idx === i ? { ...sp, qty: { ...sp.qty, [key]: Math.max(0, Math.round(Number(val) || 0)) } } : sp));
  }
  function setSplitDate(i, d) { setSplits(s => s.map((sp, idx) => idx === i ? { ...sp, scheduled_date: d } : sp)); }

  async function submitSplit() {
    if (!sel?.request) return;
    const payload = splits.map(sp => ({
      scheduled_date: sp.scheduled_date || null,
      lines: sel.lines
        .map(l => ({ product: l.product, model: l.model, color: l.color, qty: sp.qty[lineKey(l)] || 0 }))
        .filter(x => x.qty > 0),
    })).filter(sp => sp.lines.length > 0);
    if (!payload.length) { setMsg('Add at least one unit to a shipment.'); return; }
    setBusy(true);
    try {
      const r = await workerFetch('acceptFulfilmentSplit', { request_id: sel.request.id, splits: payload }, session);
      if (r?.ok === false) throw new Error(r?.data || 'failed');
      setSplitOpen(false);
      setMsg(`Split accepted — ${r?.data?.shipments?.length || payload.length} shipments created.`);
      await loadList(); await openDetail(sel.request.id);
    } catch (e) { setMsg('Split failed: ' + (e.message || e)); }
    finally { setBusy(false); }
  }

  // split totals per line (vs requested)
  const splitTotals = {};
  if (sel?.lines) sel.lines.forEach(l => { splitTotals[lineKey(l)] = splits.reduce((s, sp) => s + (sp.qty[lineKey(l)] || 0), 0); });

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
        <div>
          <h1 className="font-display" style={{ fontSize: 24, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--t1)', margin: 0 }}>Fulfilment Requests</h1>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, color: 'var(--t3)' }}>Accept (full or split) or reject sales-order fulfilment</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {['pending', 'all'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={tab === t ? btnPrimary : btnGhost}>{t === 'pending' ? 'Pending' : 'All'}</button>
          ))}
        </div>
      </div>

      {msg && <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--border)', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)' }}>{msg}</div>}

      <Panel>
        {loading ? <div style={{ padding: 40, textAlign: 'center' }}><Spinner /></div>
          : list.length === 0 ? <EmptyState title="No requests" subtitle={tab === 'pending' ? 'Nothing awaiting action.' : 'No fulfilment requests yet.'} />
          : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Request</th><th style={th}>Sales Order</th><th style={th}>Warehouse</th>
                <th style={th}>Platform PO</th><th style={{ ...th, textAlign: 'right' }}>Units</th>
                <th style={th}>Status</th><th style={th}>Mode</th>
              </tr></thead>
              <tbody>
                {list.map(r => (
                  <tr key={r.id} onClick={() => openDetail(r.id)}
                    style={{ cursor: 'pointer', background: sel?.request?.id === r.id ? 'var(--surface2)' : 'transparent' }}>
                    <td style={{ ...td, color: 'var(--t1)', fontWeight: 700 }}>{r.request_no}</td>
                    <td style={td}>{r.sales_order_no}</td>
                    <td style={td}>{r.destination_warehouse || '—'}</td>
                    <td style={td}>{r.partner_po_ref || '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmt(r.requested_units)}</td>
                    <td style={td}><StatusPill status={r.status} /></td>
                    <td style={td}>{r.fulfilment_mode || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ── Detail ─────────────────────────────────────────── */}
      {sel?.request && (
        <Panel style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 800, color: 'var(--t1)' }}>{sel.request.title}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>
                {sel.request.request_no} · {sel.request.sales_order_no} · <StatusPill status={sel.request.status} />
              </div>
            </div>
            {sel.request.status === 'pending' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button disabled={busy} onClick={acceptFull} style={btnPrimary}>Accept — Full</button>
                <button disabled={busy} onClick={openSplit} style={btnGhost}>Accept — Split</button>
                <button disabled={busy} onClick={() => { setRejectReason(''); setRejectOpen(true); }} style={{ ...btnGhost, color: 'var(--red)', borderColor: 'var(--red)' }}>Reject</button>
              </div>
            )}
          </div>

          {/* requested lines */}
          <div style={{ overflowX: 'auto', marginBottom: 16 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Item</th><th style={th}>SKU</th><th style={{ ...th, textAlign: 'right' }}>Requested</th></tr></thead>
              <tbody>
                {sel.lines.map(l => (
                  <tr key={l.id}><td style={td}>{lineLabel(l)}</td><td style={td}>{l.sku || '—'}</td><td style={{ ...td, textAlign: 'right' }}>{fmt(l.qty)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* child shipments */}
          <div style={{ fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', marginBottom: 8 }}>
            Shipments ({sel.shipments.length})
          </div>
          {sel.shipments.length === 0
            ? <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>No shipments yet.</div>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={th}>Shipment</th><th style={th}>Status</th><th style={th}>Scheduled</th><th style={th}>Courier</th><th style={th}>Tracking</th></tr></thead>
                  <tbody>
                    {sel.shipments.map(s => (
                      <tr key={s.id}>
                        <td style={{ ...td, fontWeight: 700 }}>{s.shipment_no}</td>
                        <td style={td}>{s.status}</td>
                        <td style={td}>{s.scheduled_date || '—'}</td>
                        <td style={td}>{s.courier_partner || '—'}</td>
                        <td style={td}>{s.tracking_number || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginTop: 10 }}>
                  <button onClick={() => router.push('/dispatch-shipments')} style={btnGhost}>Manage in Shipments →</button>
                </div>
              </div>
            )}
        </Panel>
      )}

      {/* ── Reject modal ───────────────────────────────────── */}
      <Modal open={rejectOpen} onClose={() => setRejectOpen(false)} title="Reject fulfilment request"
        confirmLabel="Reject & cancel order" confirmColor="var(--red)" loading={busy} onConfirm={submitReject}>
        <p style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, color: 'var(--t2)', marginTop: 0 }}>
          Rejecting cancels the Snorkel sales order. A reason is required.
        </p>
        <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={3}
          placeholder="Reason for rejection" style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
      </Modal>

      {/* ── Split builder modal ────────────────────────────── */}
      <Modal open={splitOpen} onClose={() => setSplitOpen(false)} title="Split fulfilment" size="lg"
        confirmLabel="Create split shipments" loading={busy} onConfirm={submitSplit}>
        <p style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, color: 'var(--t2)', marginTop: 0 }}>
          Each shipment gets its own dispatch date. Set the quantity per item for each shipment.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {splits.map((sp, i) => (
            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Shipment {i + 1}</span>
                  <label style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>Dispatch&nbsp;date</label>
                  <input type="date" value={sp.scheduled_date} onChange={e => setSplitDate(i, e.target.value)} style={{ ...inputStyle, width: 160 }} />
                </div>
                {splits.length > 1 && <button onClick={() => removeSplit(i)} style={{ ...btnGhost, color: 'var(--red)', borderColor: 'var(--red)' }}>Remove</button>}
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {sel?.lines?.map(l => (
                    <tr key={l.id}>
                      <td style={{ ...td, borderBottom: 'none' }}>{lineLabel(l)}</td>
                      <td style={{ ...td, borderBottom: 'none', textAlign: 'right', width: 120 }}>
                        <input type="number" min={0} value={sp.qty[lineKey(l)] ?? 0}
                          onChange={e => setSplitQty(i, lineKey(l), e.target.value)} style={{ ...inputStyle, width: 90, textAlign: 'right' }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <button onClick={addSplit} style={btnGhost}>+ Add shipment</button>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
            {sel?.lines?.map(l => {
              const tot = splitTotals[lineKey(l)] || 0; const req = Math.round(Number(l.qty)) || 0;
              const over = tot > req;
              return <span key={l.id} style={{ marginLeft: 10, color: over ? 'var(--red)' : tot === req ? 'var(--green)' : 'var(--t3)' }}>{lineLabel(l)}: {tot}/{req}</span>;
            })}
          </div>
        </div>
      </Modal>
    </div>
  );
}
