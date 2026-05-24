// Bag-label HTML generator for receiving + direct-GRN flows.
// Pure: takes an array of bag rows and a header string, returns a full HTML
// document for printing via printWindow.
//
// bags[i] consumed fields: bag_id, part_code, part_name (or name), product,
// qty, bag_seq, total_bags, mark_code, bin_code.
// headerRef is shown in the small top-right slot — pass the shipment_id for
// receiving-flow prints, or the grn_no for direct-GRN prints.
export function buildBagLabelsHtml(bags, headerRef) {
  const shipRef = headerRef || '—';
  const labelItems = bags.map(b => {
    const qrData = encodeURIComponent(b.bag_id || '');
    const qrUrl  = `https://api.qrserver.com/v1/create-qr-code/?size=90x90&margin=2&data=${qrData}`;
    return `
      <div class="label">
        <div class="lh">
          <span class="lp">LOT</span>
          <span class="lc">${b.part_code || ''}</span>
          <span class="ls">${shipRef}</span>
        </div>
        <div class="lb">
          <div class="ll">
            ${b.product ? `<div class="lpn">${b.product}</div>` : ''}
            <div class="ln">${b.part_name || b.name || ''}</div>
            <div class="lqr"><span class="lqn">${b.qty || 0}</span><span class="lqu"> pcs</span></div>
            <div class="lm">
              <div>Bag ${b.bag_seq || ''}${b.total_bags ? ' of ' + b.total_bags : ''}</div>
              ${b.mark_code && b.mark_code !== '—' ? `<div class="lsub">${b.mark_code}</div>` : ''}
              ${b.bin_code  && b.bin_code  !== '—' ? `<div class="lsub">Bin: ${b.bin_code}</div>` : ''}
            </div>
          </div>
          <div class="lq"><img src="${qrUrl}" width="60" height="60" alt="QR"></div>
        </div>
        <div class="lf">
          <span class="lid">${b.bag_id || ''}</span>
          <span>${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
        </div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><title>Bag Labels (${bags.length})</title><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,sans-serif;background:#eee}
    .page{display:flex;flex-wrap:wrap;gap:4mm;padding:5mm;background:#eee}
    .label{width:100mm;height:50mm;border:1px solid #000;padding:3mm;display:flex;flex-direction:column;background:#fff}
    .lh{display:flex;align-items:center;gap:6px;border-bottom:1px solid #000;padding-bottom:2mm;margin-bottom:2mm}
    .lp{font-weight:900;font-size:14pt;letter-spacing:2px;margin-right:2px}
    .lc{font-family:monospace;font-size:12pt;font-weight:700;flex:1}
    .ls{font-family:monospace;font-size:8pt;color:#555}
    .lb{display:flex;gap:2mm;flex:1;align-items:flex-start}
    .ll{display:flex;flex-direction:column;flex:1;min-width:0;gap:1mm}
    .lpn{font-size:10pt;font-weight:800;line-height:1.2;color:#000;letter-spacing:0.02em}
    .ln{font-size:9pt;font-weight:600;line-height:1.2}
    .lqr{display:flex;align-items:baseline;gap:2px}
    .lqn{font-size:18pt;font-weight:900;font-family:monospace;line-height:1}
    .lqu{font-size:9pt;color:#555}
    .lm{font-size:7pt;color:#444;line-height:1.4}
    .lsub{color:#666}
    .lq{flex-shrink:0;display:flex;align-items:center}
    .lf{display:flex;justify-content:space-between;align-items:center;border-top:1px solid #000;padding-top:1.5mm;margin-top:auto}
    .lid{font-family:monospace;font-size:6.5pt;color:#333}
    @page{size:100mm 50mm;margin:0}
    @media print{
      body{background:#fff}
      .page{display:block;padding:0;background:#fff}
      .label{width:100mm;height:50mm;border:none;page-break-after:always;break-after:page}
      .label:last-child{page-break-after:avoid;break-after:avoid}
    }
  </style></head><body><div class="page">${labelItems}</div></body></html>`;
}
