// Blind cycle-count sheet — printable PDF for the physical counter.
// Shows part_code + part_name + category + BLANK count field + initial line.
// Never shows erp_qty (audit-critical: blind counting prevents anchoring).
//
// header: { count_no, count_date, area, counter_name, created_by_name, total_lines }
// lines:  cycle_count_lines rows with part_code, part_name, product, category, abc_class
export function buildCycleCountSheetHtml(header, lines) {
  const h = header || {};
  const dateStr = h.count_date
    ? new Date(h.count_date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '';
  const rows = (lines || []).map((l, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td class="mono">${l.part_code || ''}</td>
      <td>${l.part_name || ''}</td>
      <td class="small">${l.product || '—'}</td>
      <td class="small">${l.category || '—'}</td>
      <td class="small abc abc-${(l.abc_class || '').toLowerCase()}">${l.abc_class || '—'}</td>
      <td class="qty">&nbsp;</td>
      <td class="initial">&nbsp;</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><head><title>Cycle Count Sheet — ${h.count_no || ''}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; padding: 14mm; color: #000; font-size: 10pt; }
  .ttl { text-align: center; font-size: 14pt; font-weight: 900; letter-spacing: 0.15em; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 12px; }
  .hdr { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px 24px; margin-bottom: 12px; font-size: 10pt; }
  .hdr .k { color: #555; font-size: 8.5pt; letter-spacing: 0.05em; text-transform: uppercase; }
  .hdr .v { font-weight: 700; margin-bottom: 4px; }
  .alert { background: #fff8e1; border: 1.5px solid #f59e0b; padding: 8px 10px; margin-bottom: 12px; font-size: 9pt; }
  .alert b { color: #b45309; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  th { background: #eee; padding: 5px 6px; text-align: left; border-bottom: 1.5px solid #000; font-size: 8pt; letter-spacing: 0.04em; text-transform: uppercase; }
  td { padding: 5px 6px; border-bottom: 1px solid #ccc; vertical-align: top; }
  td.num { text-align: right; color: #777; font-size: 8pt; }
  td.mono { font-family: 'Courier New', monospace; font-weight: 700; }
  td.small { font-size: 8.5pt; color: #444; }
  td.qty { width: 70px; border: 1px solid #000; height: 22px; background: #fafafa; }
  td.initial { width: 50px; border: 1px solid #000; height: 22px; background: #fafafa; }
  td.abc { text-align: center; font-weight: 700; }
  td.abc-a { color: #b91c1c; }
  td.abc-b { color: #b45309; }
  td.abc-c { color: #1d4ed8; }
  .sig { margin-top: 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .sigbox { border-top: 1px solid #000; padding-top: 4px; text-align: center; font-size: 9pt; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
  .footer { margin-top: 14px; font-size: 8pt; color: #666; text-align: center; }
  @media print { body { padding: 10mm; } }
</style></head>
<body>
  <div class="ttl">CYCLE COUNT SHEET — BLIND</div>

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
      <div class="k">Assigned Counter</div>
      <div class="v">${h.counter_name || '__________________________'}</div>
    </div>
    <div>
      <div class="k">Created By</div>
      <div class="v">${h.created_by_name || '—'}</div>
    </div>
    <div>
      <div class="k">Total Lines</div>
      <div class="v">${lines.length}</div>
    </div>
  </div>

  <div class="alert">
    <b>Instructions:</b> Count each part physically. Write the count in the QTY box.
    Initial each row. <b>Do NOT</b> reconcile against system qty — that's intentional.
    Recount any line that feels off; flag uncertain counts in the notes column at submit time.
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:24px">#</th>
        <th>Part Code</th>
        <th>Part Name</th>
        <th>Product</th>
        <th>Category</th>
        <th style="text-align:center;width:32px">ABC</th>
        <th style="width:70px">Qty</th>
        <th style="width:50px">Initial</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="sig">
    <div class="sigbox">Counted By<br/><span style="opacity:0">.</span></div>
    <div class="sigbox">Verified / Witnessed<br/><span style="opacity:0">.</span></div>
  </div>

  <div class="footer">${lines.length} part${lines.length === 1 ? '' : 's'} · Blind count · Legend of Toys Garage</div>
</body></html>`;
}
