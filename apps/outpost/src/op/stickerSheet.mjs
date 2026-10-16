// The UPC sticker sheet, laid out exactly as the factory prints it (Redline › UPC printBatch, S421): A3 portrait, 21
// columns of 13 mm stickers, a 9 mm QR of the LOT-NNNNNNNN id and the product code + number under it. Redline is left
// untouched (the vendor never gets Redline); keep the two layouts in step by hand. Data = /v/batch_sheet. Pure: returns
// one HTML document; the page renders the QR codes, then opens the print dialog itself (never without QR codes).

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function stickerItems(rows) {
  return (rows || []).map(row => {
    const lotNum = (row.upc_id || '').replace('LOT-', '');
    return { upcId: row.upc_id, code: row.product_code ? `${row.product_code}${lotNum}` : row.upc_id };
  });
}

export function buildStickerSheet({ batch, rows }) {
  const isRemote = (batch.product_code || '').length === 5;
  const productLabel = isRemote
    ? (batch.product || batch.product_code)
    : [batch.product, batch.model, batch.color].filter(Boolean).join(' · ');
  const date = batch.generated_at
    ? new Date(batch.generated_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
    : '';
  // Inside a <script>: no "<" survives, so no value can close the tag.
  const items = JSON.stringify(stickerItems(rows)).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>LOT Stickers — ${esc(batch.batch_id)}</title>
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
  .wait { font:14px system-ui, sans-serif; padding:12px 0; }
  @media print { .wait { display:none; } }
</style></head><body>
<div class="hdr">
  <span>LOT — Batch ${esc(batch.batch_id)}</span>
  <span>${esc(productLabel)} · ${rows.length} stickers</span>
  <span>${esc(date)}</span>
</div>
<div id="wait" class="wait">Loading…</div>
<div class="grid" id="grid"></div>
<script>
  const items = ${items};
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
      } catch(e) { qrDiv.textContent = item.upcId; }   // one bad cell: its id as text, like Redline
    });
  }
  // Unlike Redline: a sheet without QR codes is never printed (a vendor-site network may not reach cdnjs) — it says so.
  function noQr() {
    document.body.innerHTML = '<p style="font:16px system-ui;padding:24px">The QR code library did not load, so this sheet ' +
      'has no QR codes. Do not print it. Check the internet connection, close this window and click Print sheet again.</p>';
  }
  // A full 10,000 takes ~12 s to draw (measured S423), so a notice shows first (never printed); then the dialog opens.
  function go() {
    if (typeof QRCode === 'undefined') { noQr(); return; }
    var wait = document.getElementById('wait');
    wait.textContent = 'Drawing ' + items.length + ' stickers. The print dialog opens by itself when they are ready.';
    setTimeout(function() { render(); wait.remove(); setTimeout(function() { window.print(); }, 400); }, 50);
  }
  // Wait up to 10 s for the library (a slow 4G link), then render or refuse.
  var waited = 0;
  (function wait() {
    if (typeof QRCode !== 'undefined' || waited >= 10000) { go(); return; }
    waited += 250; setTimeout(wait, 250);
  })();
<\/script>
</body></html>`;
}
