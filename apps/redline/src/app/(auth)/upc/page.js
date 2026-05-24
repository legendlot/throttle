'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel, Chip, StatusBadge, useToast, printWindow } from '@throttle/ui';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-');
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  return `${date} ${time}`;
}

const BATCH_STATUS_VARIANT = {
  generated:     'brand',
  sent_to_print: 'warning',
  printed:       'info',
  received:      'success',
};

const BATCH_STATUS_LABEL = {
  generated:     'Generated',
  sent_to_print: 'Sent to Print',
  printed:       'Printed',
  received:      'Received',
};

function BatchStatus({ status }) {
  return (
    <StatusBadge variant={BATCH_STATUS_VARIANT[status] || 'neutral'}>
      {BATCH_STATUS_LABEL[status] || status || '—'}
    </StatusBadge>
  );
}

// ── Common styles ────────────────────────────────────────────
const primaryBtn = { padding: '8px 14px', background: 'var(--yellow)', color: '#0a0a0a', border: '1px solid var(--yellow)', borderRadius: 3, fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' };
const secondaryBtn = { padding: '8px 14px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' };
const smallBtn = { padding: '5px 11px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 12, cursor: 'pointer', letterSpacing: '0.04em' };
const inputStyle = { background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '8px 12px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 13, outline: 'none' };
const labelStyle = { fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase', display: 'block', marginBottom: 6, fontFamily: 'var(--mono)' };
const sectionLabel = { fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)', margin: 0 };
const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap', color: 'var(--t1)' };

// ── UPC Generator Page ────────────────────────────────────────
export default function UpcPage() {
  const { session } = useAuth();
  const { showToast } = useToast();

  const [products,     setProducts]     = useState([]);
  const [batches,      setBatches]      = useState([]);
  const [loadingProds, setLoadingProds] = useState(false);
  const [loadingHist,  setLoadingHist]  = useState(false);

  const [search,             setSearch]            = useState('');
  const [dropdownOpen,       setDropdownOpen]      = useState(false);
  const [selectedCode,       setSelectedCode]      = useState('');
  const [selectedHasRemote,  setSelectedHasRemote] = useState(false);
  const [selectedLabel,      setSelectedLabel]     = useState('');
  const [component,          setComponent]         = useState('car');
  const [qty,                setQty]               = useState(100);
  const [notes,              setNotes]             = useState('');
  const [genStatus,          setGenStatus]         = useState(null);
  const [generating,         setGenerating]        = useState(false);

  const dropdownRef = useRef(null);

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
    try {
      const data = await garageFetch('getUpcBatches', { limit: '50' }, session);
      setBatches(Array.isArray(data) ? data : []);
    } catch (_) { setBatches([]); }
    finally { setLoadingHist(false); }
  }, [session]);

  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // ── Click outside dropdown ────────────────────────────────
  useEffect(() => {
    function onClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
        if (selectedCode) setSearch(selectedLabel);
      }
    }
    if (dropdownOpen) {
      window.addEventListener('mousedown', onClick);
      return () => window.removeEventListener('mousedown', onClick);
    }
  }, [dropdownOpen, selectedCode, selectedLabel]);

  // ── Filtered products ─────────────────────────────────────
  const queryUpper = search.trim().toUpperCase();
  const filteredProducts = !queryUpper ? products : products.filter(p => {
    const hay = `${p.product_code || ''} ${p.product || ''} ${p.model || ''} ${p.color || ''}`.toUpperCase();
    return hay.includes(queryUpper);
  });

  function selectProduct(p) {
    const label = `${p.product_code} · ${[p.product, p.model, p.color].filter(Boolean).join(' · ')}`;
    setSelectedCode(p.product_code);
    setSelectedHasRemote(!!p.has_remote);
    setSelectedLabel(label);
    setSearch(label);
    setComponent('car');
    setDropdownOpen(false);
  }

  function clearSelection() {
    setSelectedCode('');
    setSelectedHasRemote(false);
    setSelectedLabel('');
    setSearch('');
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
        text: `✓ Batch ${b.batch_id} generated — ${fmt(b.quantity)} stickers · ${productCode}-${b.seq_from} to ${productCode}-${b.seq_to} · ${sheets} A3 sheet${sheets !== 1 ? 's' : ''}`,
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
    <div>
      {/* Generator section */}
      <Panel style={{ marginBottom: 20 }}>
        <h2 style={{ ...sectionLabel, marginBottom: 12 }}>Generate New Batch</h2>

        {/* Product picker */}
        <div style={{ marginBottom: 12, position: 'relative' }} ref={dropdownRef}>
          <label style={labelStyle}>Product</label>
          <input
            style={{ ...inputStyle, width: '100%' }}
            placeholder={loadingProds ? 'Loading products…' : 'Search product code, name, model, or color…'}
            value={search}
            onChange={e => { setSearch(e.target.value); setDropdownOpen(true); if (!e.target.value) clearSelection(); }}
            onFocus={() => setDropdownOpen(true)}
            disabled={loadingProds}
          />
          {dropdownOpen && filteredProducts.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, zIndex: 10, maxHeight: 280, overflowY: 'auto' }}>
              {filteredProducts.slice(0, 60).map(p => (
                <div
                  key={p.product_code}
                  onClick={() => selectProduct(p)}
                  style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface3)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <span style={{ color: 'var(--yellow)', fontFamily: 'var(--mono)', fontWeight: 700, minWidth: 60 }}>{p.product_code}</span>
                  <span style={{ color: 'var(--t1)', flex: 1 }}>
                    {p.product}{(p.model || p.color) && <span style={{ color: 'var(--t3)' }}> · {[p.model, p.color].filter(Boolean).join(' · ')}</span>}
                  </span>
                  {p.has_remote && (
                    <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 2, background: 'rgba(167,139,250,.15)', color: '#a78bfa', letterSpacing: '0.05em' }}>+ REMOTE</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Component toggle (only if has_remote) */}
        {selectedHasRemote && (
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Component</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <Chip active={component === 'car'} onClick={() => setComponent('car')}>Car ({selectedCode})</Chip>
              <Chip active={component === 'remote'} onClick={() => setComponent('remote')}>Remote ({selectedCode}R)</Chip>
            </div>
          </div>
        )}

        {/* Qty + notes */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>Quantity (1–10,000)</label>
            <input
              type="number" min={1} max={10000}
              value={qty}
              onChange={e => setQty(e.target.value)}
              style={{ ...inputStyle, width: '100%' }}
            />
          </div>
          <div>
            <label style={labelStyle}>Notes (optional)</label>
            <input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Internal note for this batch"
              style={{ ...inputStyle, width: '100%' }}
            />
          </div>
        </div>

        {/* Status */}
        {genStatus && (
          <div style={{
            padding: '10px 12px', borderRadius: 3, marginBottom: 10, fontSize: 12, fontFamily: 'var(--mono)',
            background: genStatus.type === 'err' ? 'rgba(222,42,42,.1)' : genStatus.type === 'ok' ? 'rgba(34,197,94,.1)' : 'rgba(80,80,80,.15)',
            color:      genStatus.type === 'err' ? 'var(--red)' : genStatus.type === 'ok' ? 'var(--green)' : 'var(--t2)',
            border:     `1px solid ${genStatus.type === 'err' ? 'rgba(222,42,42,.3)' : genStatus.type === 'ok' ? 'rgba(34,197,94,.3)' : 'rgba(80,80,80,.3)'}`,
          }}>{genStatus.text}</div>
        )}

        <button
          onClick={generateBatch}
          disabled={generating || !selectedCode}
          style={{ ...primaryBtn, opacity: (generating || !selectedCode) ? 0.5 : 1 }}
        >
          {generating ? 'Generating…' : '⚡ Generate & Print'}
        </button>
      </Panel>

      {/* Batch history */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <h2 style={sectionLabel}>Recent Batches</h2>
          <div style={{ flex: 1 }} />
          <button style={secondaryBtn} onClick={loadHistory} disabled={loadingHist}>↻ Refresh</button>
        </div>
        <Panel padding={0}>
          {loadingHist && batches.length === 0 ? (
            <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : batches.length === 0 ? (
            <EmptyState icon="🏷" message="No batches yet — generate one above" />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Batch','Product Code','Product','Variant','Qty','Seq Range','Status','Generated','Actions'].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {batches.map(b => {
                    const canMove = ['generated','sent_to_print','printed'].includes(b.status);
                    const variant = [b.model, b.color].filter(Boolean).join(' ') || '—';
                    return (
                      <tr key={b.batch_id}>
                        <td style={{ ...tdStyle, color: 'var(--yellow)' }}>{b.batch_id}</td>
                        <td style={tdStyle}>{b.product_code}</td>
                        <td style={tdStyle}>{b.product || '—'}</td>
                        <td style={{ ...tdStyle, color: 'var(--t2)' }}>{variant}</td>
                        <td style={tdStyle}>{fmt(b.quantity)}</td>
                        <td style={{ ...tdStyle, color: 'var(--t3)' }}>{b.upc_from} → {b.upc_to}</td>
                        <td style={tdStyle}><BatchStatus status={b.status} /></td>
                        <td style={{ ...tdStyle, color: 'var(--t3)' }}>{formatDateTime(b.generated_at)}</td>
                        <td style={tdStyle}>
                          <button onClick={() => printBatch(b.batch_id)} style={{ ...smallBtn, color: 'var(--state-info, #7b93ff)', borderColor: 'var(--state-info, #7b93ff)', marginRight: 4 }}>🖨 Print</button>
                          {canMove && b.status === 'generated' && (
                            <button onClick={() => markSent(b.batch_id)} style={{ ...smallBtn, color: 'var(--orange)', borderColor: 'var(--orange)', marginRight: 4 }}>Sent</button>
                          )}
                          {canMove && (
                            <button onClick={() => receiveBatch(b.batch_id)} style={{ ...smallBtn, color: 'var(--green)', borderColor: 'var(--green)' }}>Received</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
