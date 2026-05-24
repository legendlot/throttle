// UPC checklist sheet for dispatch unit cycle counts.
// Header info + list of LOT-UPCs with ✓ Present / ✗ Missing checkboxes.
// Counter walks staging, marks each row, signs.
export function buildUnitCountSheetHtml(header, lines) {
  const h = header || {};
  const dateStr = h.count_date
    ? new Date(h.count_date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '';
  const rows = (lines || []).map((l, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td class="mono">${l.unit_upc || ''}</td>
      <td>${[l.product, l.model, l.color].filter(Boolean).join(' · ') || '—'}</td>
      <td class="box">&nbsp;</td>
      <td class="box">&nbsp;</td>
      <td class="initial">&nbsp;</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><head><title>Unit Count Sheet — ${h.count_no || ''}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; padding: 14mm; color: #000; font-size: 10pt; }
  .ttl { text-align: center; font-size: 14pt; font-weight: 900; letter-spacing: 0.15em; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 12px; }
  .hdr { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px 24px; margin-bottom: 12px; font-size: 10pt; }
  .hdr .k { color: #555; font-size: 8.5pt; letter-spacing: 0.05em; text-transform: uppercase; }
  .hdr .v { font-weight: 700; margin-bottom: 4px; }
  .alert { background: #fff8e1; border: 1.5px solid #f59e0b; padding: 8px 10px; margin-bottom: 12px; font-size: 9pt; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  th { background: #eee; padding: 5px 6px; text-align: left; border-bottom: 1.5px solid #000; font-size: 8pt; letter-spacing: 0.04em; text-transform: uppercase; }
  td { padding: 5px 6px; border-bottom: 1px solid #ccc; vertical-align: top; }
  td.num { text-align: right; color: #777; font-size: 8pt; }
  td.mono { font-family: 'Courier New', monospace; font-weight: 700; }
  td.box { width: 30px; border: 1px solid #000; height: 22px; background: #fafafa; text-align: center; }
  td.initial { width: 50px; border: 1px solid #000; height: 22px; background: #fafafa; }
  th.box-h { text-align: center; font-size: 7.5pt; }
  .sig { margin-top: 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .sigbox { border-top: 1px solid #000; padding-top: 4px; text-align: center; font-size: 9pt; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
  .footer { margin-top: 14px; font-size: 8pt; color: #666; text-align: center; }
  @media print { body { padding: 10mm; } }
</style></head>
<body>
  <div class="ttl">UNIT COUNT SHEET — ${h.scope_status ? h.scope_status.toUpperCase() : 'STAGING'}</div>

  <div class="hdr">
    <div>
      <div class="k">Count No</div>
      <div class="v" style="font-family:'Courier New',monospace;font-size:13pt">${h.count_no || '—'}</div>
    </div>
    <div>
      <div class="k">Date</div>
      <div class="v">${dateStr || '—'}</div>
    </div>
    <div>
      <div class="k">Area / Zone</div>
      <div class="v">${h.area || '—'}</div>
    </div>
    <div>
      <div class="k">Scope Status</div>
      <div class="v">${h.scope_status || '—'}</div>
    </div>
    <div>
      <div class="k">Assigned Counter</div>
      <div class="v">${h.counter_name || '__________________________'}</div>
    </div>
    <div>
      <div class="k">Expected Units</div>
      <div class="v">${lines.length}</div>
    </div>
  </div>

  <div class="alert">
    <b>Instructions:</b> Walk the staging area, verify each LOT-UPC physically.
    Tick <b>✓</b> in the "Present" box if found. Tick <b>✗</b> in "Missing" if not.
    Write extra UPCs found (not on this sheet) in the notes section below. Initial each row.
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:24px">#</th>
        <th>LOT UPC</th>
        <th>Product · Model · Colour</th>
        <th class="box-h" style="width:32px">✓ Present</th>
        <th class="box-h" style="width:32px">✗ Missing</th>
        <th style="width:50px">Initial</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div style="margin-top: 14px; padding: 10px; border: 1px solid #000; min-height: 60px;">
    <div style="font-size: 8.5pt; color: #555; letter-spacing: 0.05em; text-transform: uppercase; margin-bottom: 6px;">Extra UPCs Found (not on sheet)</div>
  </div>

  <div class="sig">
    <div class="sigbox">Counted By<br/><span style="opacity:0">.</span></div>
    <div class="sigbox">Verified / Witnessed<br/><span style="opacity:0">.</span></div>
  </div>

  <div class="footer">${lines.length} expected unit${lines.length === 1 ? '' : 's'} · Legend of Toys Dispatch</div>
</body></html>`;
}
