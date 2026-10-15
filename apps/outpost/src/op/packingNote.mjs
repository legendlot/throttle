// The packing note that travels with a consignment, next to the vendor's own GST delivery challan (Outpost records
// that challan's number, it does not issue it). Data = /v/consignment. Pure: returns one HTML document for printWindow.

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = d => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const when = t => (t ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

export function buildPackingNote(c) {
  const draft = c.status === 'draft';
  const v = c.consignor || {};
  const lines = (c.lines || []).map(l => `<tr>
      <td><b>${esc(l.sku)}</b><div class="sub">${esc([l.product, l.model, l.color].filter(Boolean).join(' · '))}</div></td>
      <td>${esc(l.channel)}</td><td class="m">${esc(l.ean || '—')}</td><td class="m">${esc(l.hsn_code || '—')}</td>
      <td class="n">${esc(l.cartons)}</td><td class="n">${esc(l.units)}</td></tr>`).join('');
  const cartons = (c.cartons || []).map((ct, i) => `<tr class="ctn">
      <td class="n">${i + 1}</td><td class="m">${esc(ct.ctn_no)} · v${esc(ct.manifest_version)}</td><td>${esc(ct.sku)}</td>
      <td>${esc(ct.channel)}</td><td class="n">${esc(ct.unit_count)}</td><td class="tick"></td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(c.csg_no)} packing note</title><style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; } body { font: 11px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 18px; margin: 0; } .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 8px; }
  .csg { font: 700 22px/1 ui-monospace, Menlo, monospace; } .draft { color: #b00; font-weight: 700; letter-spacing: .1em; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; margin: 12px 0; }
  .k { color: #555; font-size: 9px; text-transform: uppercase; letter-spacing: .06em; } .v { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; } th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #eee; font-size: 9px; text-transform: uppercase; letter-spacing: .05em; } .n { text-align: right; } .m { font-family: ui-monospace, Menlo, monospace; }
  .sub { color: #555; font-size: 10px; } .tick { width: 40px; } tfoot td { font-weight: 700; }
  h2 { font-size: 12px; margin: 16px 0 0; } .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 36px; }
  .sign div { border-top: 1px solid #111; padding-top: 4px; color: #555; } .foot { margin-top: 18px; color: #777; font-size: 9px; }
  </style></head><body>
  <div class="top"><div><h1>Packing note</h1><div class="sub">Outpost · goods packed for Legend of Toys</div>
    ${draft ? '<div class="draft">DRAFT — NOT DISPATCHED</div>' : ''}</div><div class="csg">${esc(c.csg_no)}</div></div>
  <div class="grid">
    <div><div class="k">Consignor</div><div class="v">${esc(v.vendor_name)}</div><div>${esc(v.address)}</div><div>GSTIN ${esc(v.gstin || '—')}</div></div>
    <div><div class="k">Consignee</div><div class="v">Legend of Toys</div></div>
    <div><div class="k">Delivery challan</div><div class="v">${esc(c.challan_no || '—')} · ${day(c.challan_date)}</div></div>
    <div><div class="k">Vehicle / transporter</div><div class="v">${esc(c.vehicle_no || '—')}${c.transporter ? ` · ${esc(c.transporter)}` : ''}</div></div>
    <div><div class="k">E-way bill</div><div class="v">${esc(c.eway_bill_no || '—')}</div></div>
    <div><div class="k">Dispatched</div><div class="v">${draft ? '—' : when(c.dispatched_at)}</div></div>
  </div>
  ${c.notes ? `<div><span class="k">Notes</span> ${esc(c.notes)}</div>` : ''}
  <h2>Contents</h2>
  <table><thead><tr><th>SKU</th><th>Channel</th><th>EAN</th><th>HSN</th><th class="n">Cartons</th><th class="n">Units</th></tr></thead>
  <tbody>${lines}</tbody><tfoot><tr><td colspan="4">Total</td><td class="n">${esc(c.total_cartons)}</td><td class="n">${esc(c.total_units)}</td></tr></tfoot></table>
  <h2>Cartons</h2>
  <table><thead><tr><th class="n">#</th><th>Carton · label version</th><th>SKU</th><th>Channel</th><th class="n">Units</th><th>Recd</th></tr></thead>
  <tbody>${cartons}</tbody></table>
  <div class="sign"><div>Packed and dispatched by (vendor)</div><div>Received by (LOT)</div></div>
  <div class="foot">Each carton carries its CTN label; the label version must match this note. Units are scanned one by one at LOT receipt.</div>
  </body></html>`;
}
