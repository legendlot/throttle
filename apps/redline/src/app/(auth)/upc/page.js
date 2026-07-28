'use client';
/* ════════════════════════════════════════════════════════════
   UPC GENERATOR — Setup › UPC Generator (Pit Wall v2 reskin of
   redesign-reference/app/upc.jsx). Batch-print unique unit codes
   (car AND remote are separate products — SHTK / SHTKR). Manages
   the Generated → Sent → Received round-trip. All data actions
   (generateUpcBatch, markUpcBatchSent, receiveUpcBatch, print
   HTML builder) kept exactly as before — visual layer only.
   ════════════════════════════════════════════════════════════ */
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, printWindow, Combobox } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import {
  Icon, Panel, FilterChip, fmt, btnPrimary, btnGhost, inputStyle,
} from '../../../components/kit/index.js';

// ── Helpers ───────────────────────────────────────────────────
function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-');
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  return `${date} ${time}`;
}

// Full round-trip lifecycle — keep all four DB statuses.
const BATCH_STATUS = {
  generated:     { label: 'Generated',     fg: 'var(--warn-fg)', bg: 'var(--warn-bg)',            bd: 'var(--warn-bd)' },
  sent_to_print: { label: 'Sent to Print', fg: 'var(--orange)',  bg: 'rgba(249,115,22,0.14)',     bd: 'rgba(249,115,22,0.3)' },
  printed:       { label: 'Printed',       fg: 'var(--info-fg)', bg: 'var(--info-bg)',            bd: 'var(--info-bd)' },
  received:      { label: 'Received',      fg: 'var(--ok-fg)',   bg: 'var(--ok-bg)',              bd: 'var(--ok-bd)' },
};

function BatchStatus({ status }) {
  const st = BATCH_STATUS[status] || { label: status || '—', fg: 'var(--t2)', bg: 'var(--surface-2)', bd: 'var(--border-2)' };
  return (
    <span className="num" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
      color: st.fg, background: st.bg, border: `1px solid ${st.bd}`, borderRadius: 3, padding: '2px 7px', whiteSpace: 'nowrap' }}>
      {st.label}
    </span>
  );
}

const actionBtn = (color) => ({
  display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent',
  border: `1px solid ${color}`, color, borderRadius: 'var(--r-xs)', padding: '4px 9px',
  fontFamily: 'var(--font-ui)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
});

const COLS = '76px 88px minmax(120px,1fr) minmax(110px,1fr) 56px 230px 110px 122px 196px';

// ── UPC Generator Page ────────────────────────────────────────
export default function UpcPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [products,     setProducts]     = useState([]);
  const [batches,      setBatches]      = useState([]);
  const [loadingProds, setLoadingProds] = useState(false);
  const [loadingHist,  setLoadingHist]  = useState(false);

  const [selectedCode,       setSelectedCode]      = useState('');
  const [selectedHasRemote,  setSelectedHasRemote] = useState(false);
  const [selectedLabel,      setSelectedLabel]     = useState('');
  const [component,          setComponent]         = useState('car');
  const [qty,                setQty]               = useState(100);
  const [notes,              setNotes]             = useState('');
  const [genStatus,          setGenStatus]         = useState(null);
  const [generating,         setGenerating]        = useState(false);

  // ── Data loaders ──────────────────────────────────────────
  const loadProducts = useCallback(async () => {
    if (!session) return;
    setLoadingProds(true);
    try {
      const data = await garageFetch('getProductCodes', {}, session);
      setProducts(Array.isArray(data) ? data : []);
    } catch (_) { setProducts([]); }
    finally { setLoadingProds(false); }
  }, [session]);

  const loadHistory = useCallback(async () => {
    if (!session) return;
    setLoadingHist(true);
    setRefreshing(true);
    try {
      // Pending batches are fetched separately and pinned to the top: the recent
      // window alone used to drop un-received batches off the page entirely, which
      // left their stickers unscannable with no way to mark them received.
      const [recent, pending] = await Promise.all([
        garageFetch('getUpcBatches', { limit: '50' }, session),
        garageFetch('getUpcBatches', { pending: 'true' }, session),
      ]);
      const recentArr  = Array.isArray(recent)  ? recent  : [];
      const pendingArr = Array.isArray(pending) ? pending : [];
      const seen = new Set(pendingArr.map(b => b.batch_id));
      setBatches([...pendingArr, ...recentArr.filter(b => !seen.has(b.batch_id))]);
    } catch (_) { setBatches([]); }
    finally {
      setLoadingHist(false);
      setRefreshing(false);
      setLastRefreshed(new Date());
    }
  }, [session, setRefreshing, setLastRefreshed]);

  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const pendingCount = batches.filter(b => ['generated', 'sent_to_print', 'printed'].includes(b.status)).length;

  function clearSelection() {
    setSelectedCode('');
    setSelectedHasRemote(false);
    setSelectedLabel('');
    setComponent('car');
  }

  // ── Generate ──────────────────────────────────────────────
  async function generateBatch() {
    if (!selectedCode) { setGenStatus({ type: 'err', text: 'Select a product first' }); return; }
    const numQty = parseInt(qty, 10);
    if (!numQty || numQty < 1 || numQty > 10000) { setGenStatus({ type: 'err', text: 'Quantity must be 1–10,000' }); return; }
    const productCode = component === 'remote' ? selectedCode + 'R' : selectedCode;
    setGenerating(true);
    setGenStatus({ type: 'loading', text: `Generating ${numQty} stickers for ${productCode}...` });
    try {
      const res = await workerFetch('generateUpcBatch', {
        product_code: productCode,
        quantity: numQty,
        notes: notes.trim() || undefined,
      }, session);
      const b = res?.data || res;
      const sheets = Math.ceil((b.quantity || numQty) / 609);
      setGenStatus({
        type: 'ok',
        text: `Batch ${b.batch_id} generated — ${fmt(b.quantity)} stickers · ${productCode}-${b.seq_from} to ${productCode}-${b.seq_to} · ${sheets} A3 sheet${sheets !== 1 ? 's' : ''}`,
      });
      await loadHistory();
      setTimeout(() => printBatch(b.batch_id), 500);
    } catch (e) {
      setGenStatus({ type: 'err', text: 'Error: ' + (e.message || 'Unknown error') });
    } finally {
      setGenerating(false);
    }
  }

  // ── Print batch ───────────────────────────────────────────
  async function printBatch(batchId) {
    try {
      const data = await garageFetch('getUpcBatch', { batch_id: batchId, include_rows: 'true' }, session);
      const { batch, rows } = data || {};
      if (!batch || !rows?.length) { showToast('No rows to print', 'error'); return; }

      const isRemote = (batch.product_code || '').length === 5;
      const productLabel = isRemote
        ? (batch.product || batch.product_code)
        : [batch.product, batch.model, batch.color].filter(Boolean).join(' · ');
      const date = batch.generated_at
        ? new Date(batch.generated_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : '';

      const stickerItems = rows.map(row => {
        const lotNum = (row.upc_id || '').replace('LOT-', '');
        const code = row.product_code ? `${row.product_code}${lotNum}` : row.upc_id;
        return { upcId: row.upc_id, code };
      });

      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>LOT Stickers — ${batch.batch_id}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
<style>
  @page { size: A3 portrait; margin: 5mm; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#fff; font-family:'JetBrains Mono',monospace; }
  .hdr { display:flex; justify-content:space-between; align-items:baseline;
         font-size:8pt; font-weight:700; letter-spacing:.07em; text-transform:uppercase;
         color:#000; margin-bottom:3.5mm; padding-bottom:2.5mm; border-bottom:.3mm solid #000; }
  .grid { display:grid; grid-template-columns:repeat(21,13mm); grid-auto-rows:13mm; gap:.3mm; }
  .s { width:13mm; height:13mm; display:flex; flex-direction:column;
       align-items:center; justify-content:center; overflow:hidden; background:#fff; }
  .s img, .s canvas { width:9mm; height:9mm; display:block; }
  .c { font-size:4pt; font-weight:700; color:#000; margin-top:.4mm;
       text-align:center; letter-spacing:0; line-height:1; white-space:nowrap; }
</style></head><body>
<div class="hdr">
  <span>LOT — Batch ${batch.batch_id}</span>
  <span>${productLabel} · ${rows.length} stickers</span>
  <span>${date}</span>
</div>
<div class="grid" id="grid"></div>
<script>
  const items = ${JSON.stringify(stickerItems)};
  function render() {
    const grid = document.getElementById('grid');
    items.forEach(item => {
      const cell = document.createElement('div'); cell.className = 's';
      const qrDiv = document.createElement('div');
      cell.appendChild(qrDiv);
      const label = document.createElement('div'); label.className = 'c'; label.textContent = item.code;
      cell.appendChild(label);
      grid.appendChild(cell);
      try {
        new QRCode(qrDiv, { text: item.upcId, width:72, height:72, colorDark:'#000', colorLight:'#fff', correctLevel: QRCode.CorrectLevel.M });
      } catch(e) { qrDiv.textContent = item.upcId; }
    });
  }
  if (typeof QRCode === 'undefined') {
    setTimeout(function() { render(); setTimeout(function() { window.print(); }, 400); }, 600);
  } else {
    render();
    window.onload = function() { setTimeout(function() { window.print(); }, 400); };
  }
<\/script>
</body></html>`;
      printWindow(html);
    } catch (e) {
      showToast('Failed to load batch for printing', 'error');
    }
  }

  // ── Mark received ─────────────────────────────────────────
  async function receiveBatch(batchId) {
    try {
      await workerFetch('receiveUpcBatch', { data: { batch_id: batchId } }, session);
      showToast(`Batch ${batchId} received`, 'success');
      await loadHistory();
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    }
  }

  async function markSent(batchId) {
    try {
      await workerFetch('markUpcBatchSent', { data: { batch_id: batchId } }, session);
      showToast(`Batch ${batchId} marked as sent`, 'success');
      await loadHistory();
    } catch (e) {
      showToast(e.message || 'Failed to mark as sent', 'error');
    }
  }

  // ── Render ────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 1320, margin: '0 auto' }}>
      <style>{`.rl-upc-opt:hover, .rl-upc-row:hover { background: var(--surface-2); }`}</style>

      {/* Generate new batch */}
      <Panel title="Generate new batch" icon="box" pad={18} style={{ marginBottom: 18 }}>
        {/* Product picker */}
        <div style={{ marginBottom: 16 }}>
          <div className="eyebrow" style={{ marginBottom: 7 }}>Product</div>
          <Combobox
            value={selectedCode}
            options={products.map(p => ({
              value: p.product_code,
              label: `${p.product_code} · ${[p.product, p.model, p.color].filter(Boolean).join(' · ')}`,
              hint: p.has_remote ? '+ Remote' : '',
              has_remote: !!p.has_remote,
            }))}
            onChange={(v, opt) => {
              if (!opt) { clearSelection(); return; }
              setSelectedCode(v);
              setSelectedHasRemote(!!opt.has_remote);
              setSelectedLabel(opt.label);
              setComponent('car');
            }}
            placeholder="Search product code, name, model, or color…"
            loading={loadingProds}
            portal
          />
        </div>

        {/* Component toggle (only if has_remote) — car and remote are separate products */}
        {selectedHasRemote && (
          <div style={{ marginBottom: 16 }}>
            <div className="eyebrow" style={{ marginBottom: 7 }}>Component</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <FilterChip active={component === 'car'} onClick={() => setComponent('car')}>Car ({selectedCode})</FilterChip>
              <FilterChip active={component === 'remote'} onClick={() => setComponent('remote')}>Remote ({selectedCode}R)</FilterChip>
            </div>
          </div>
        )}

        {/* Qty + notes */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', marginBottom: 16 }}>
          <div style={{ width: 220 }}>
            <div className="eyebrow" style={{ marginBottom: 7 }}>Quantity (1–10,000)</div>
            <input
              type="number" min={1} max={10000}
              value={qty}
              onChange={e => setQty(e.target.value)}
              className="num"
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div className="eyebrow" style={{ marginBottom: 7 }}>Notes (optional)</div>
            <input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Internal note for this batch"
              style={inputStyle}
            />
          </div>
        </div>

        {/* Status */}
        {genStatus && (
          <div style={{
            padding: '10px 13px', borderRadius: 'var(--r-sm)', marginBottom: 14,
            fontFamily: 'var(--font-ui)', fontSize: 13,
            background: genStatus.type === 'err' ? 'var(--bad-bg)' : genStatus.type === 'ok' ? 'var(--ok-bg)' : 'var(--surface-2)',
            color:      genStatus.type === 'err' ? 'var(--bad-fg)' : genStatus.type === 'ok' ? 'var(--ok-fg)' : 'var(--t2)',
            border:     `1px solid ${genStatus.type === 'err' ? 'var(--bad-bd)' : genStatus.type === 'ok' ? 'var(--ok-bd)' : 'var(--border-2)'}`,
          }}>{genStatus.text}</div>
        )}

        <button
          onClick={generateBatch}
          disabled={generating || !selectedCode}
          style={{ ...btnPrimary, padding: '11px 18px', opacity: (generating || !selectedCode) ? 0.5 : 1,
            cursor: (generating || !selectedCode) ? 'default' : 'pointer' }}
        >
          <Icon name="box" size={15} /> {generating ? 'Generating…' : 'Generate & Print'}
        </button>
      </Panel>

      {/* Recent batches — every un-received batch is pinned above the recent window */}
      <Panel
        title="Recent batches" icon="layers" pad={8}
        action={
          <button style={{ ...btnGhost, padding: '6px 11px', fontSize: 12 }} onClick={loadHistory} disabled={loadingHist}>
            <Icon name="activity" size={13} /> Refresh
          </button>
        }
      >
        {loadingHist && batches.length === 0 ? (
          <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : batches.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)' }}>
            No batches yet — generate one above.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            {pendingCount > 0 && (
              <div style={{ margin: '0 12px 10px', padding: '9px 12px', borderRadius: 8,
                background: 'var(--warn-bg)', border: '1px solid var(--warn-bd)',
                fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--warn-fg)' }}>
                {pendingCount} {pendingCount === 1 ? 'batch is' : 'batches are'} still awaiting receipt — listed first below.
                Their stickers can&apos;t be scanned until you mark them Received.
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, padding: '4px 12px 9px',
              borderBottom: '1px solid var(--border)', minWidth: 1140 }}>
              {['Batch', 'Code', 'Product', 'Variant', 'Qty', 'Seq range', 'Status', 'Generated', 'Actions'].map(h => (
                <div key={h} className="eyebrow">{h}</div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {batches.map((b, i) => {
                const canMove = ['generated', 'sent_to_print', 'printed'].includes(b.status);
                const variant = [b.model, b.color].filter(Boolean).join(' ') || '—';
                return (
                  <div key={b.batch_id} className="rl-upc-row" style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12,
                    alignItems: 'center', padding: '11px 12px', borderTop: i ? '1px solid var(--border)' : 'none',
                    minWidth: 1140, transition: 'background var(--fast) var(--ease)' }}>
                    <span className="num" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--yellow)', whiteSpace: 'nowrap' }}>{b.batch_id}</span>
                    <span className="num" style={{ fontSize: 12, color: 'var(--t2)' }}>{b.product_code}</span>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.product || '—'}</span>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{variant}</span>
                    <span className="num" style={{ fontSize: 12.5, color: 'var(--t1)' }}>{fmt(b.quantity)}</span>
                    <span className="num" style={{ fontSize: 11.5, color: 'var(--t3)', whiteSpace: 'nowrap' }}>{b.upc_from} → {b.upc_to}</span>
                    <span><BatchStatus status={b.status} /></span>
                    <span className="num" style={{ fontSize: 11.5, color: 'var(--t3)', whiteSpace: 'nowrap' }}>{formatDateTime(b.generated_at)}</span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => printBatch(b.batch_id)} style={actionBtn('var(--blue-bright)')}>
                        <Icon name="printer" size={12} /> Print
                      </button>
                      {canMove && b.status === 'generated' && (
                        <button onClick={() => markSent(b.batch_id)} style={actionBtn('var(--orange)')}>Sent</button>
                      )}
                      {canMove && (
                        <button onClick={() => receiveBatch(b.batch_id)} style={actionBtn('var(--ok-fg)')}>Received</button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
