// Shared constants + helpers for the Asset Register (list / new / detail / settings).
import { printWindow } from '@throttle/ui';

export const ASSET_STATUSES = [
  { value: 'in_use',     label: 'In Use',     tone: 'green' },
  { value: 'in_storage', label: 'In Storage', tone: 'blue'  },
  { value: 'damaged',    label: 'Damaged',    tone: 'red'   },
  { value: 'in_repair',  label: 'In Repair',  tone: 'yellow'},
  { value: 'retired',    label: 'Retired',    tone: 'gray'  },
];

export const ACQ_TYPES = [
  { value: 'purchased', label: 'Purchased' },
  { value: 'rented',    label: 'On Rental' },
];

export const RENTAL_PERIODS = ['monthly', 'quarterly', 'annual'];

export const DOC_TYPES = [
  { value: 'photo',    label: 'Photo' },
  { value: 'invoice',  label: 'Invoice' },
  { value: 'warranty', label: 'Warranty' },
  { value: 'other',    label: 'Other' },
];

export function statusLabel(v) {
  return ASSET_STATUSES.find(s => s.value === v)?.label || v || '—';
}
export function statusTone(v) {
  return ASSET_STATUSES.find(s => s.value === v)?.tone || 'gray';
}
export function acqLabel(v) {
  return ACQ_TYPES.find(a => a.value === v)?.label || v || '—';
}
export function docTypeLabel(v) {
  return DOC_TYPES.find(d => d.value === v)?.label || v || 'Other';
}

// ── Warranty / AMC expiry ──────────────────────────────────────────────
export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr); if (isNaN(d)) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0); d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}
// Most-urgent of warranty/AMC. Returns null if neither is set or both are healthy.
export function assetExpiry(a, withinDays = 60) {
  const cands = [];
  const w = daysUntil(a.warranty_expiry); if (w !== null) cands.push({ what: 'Warranty', days: w });
  const m = daysUntil(a.amc_renewal);     if (m !== null) cands.push({ what: 'AMC', days: m });
  if (!cands.length) return null;
  cands.sort((x, y) => x.days - y.days);
  const top = cands[0];
  if (top.days < 0)            return { level: 'expired', tone: 'red',    what: top.what, days: top.days };
  if (top.days <= withinDays)  return { level: 'soon',    tone: 'yellow', what: top.what, days: top.days };
  return null;
}
export function isExpiring(a, withinDays = 60) { return !!assetExpiry(a, withinDays); }

// ── Printable asset label (AST code QR + details) ──────────────────────
// Reuses the redline sticker pattern: CDN qrcodejs in a print window. No npm dep.
export function printAssetLabel(a) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = [
    ['Name', a.name],
    ['Serial', a.serial_no],
    ['Custodian', a.custodian_name],
    ['Location', a.location_name],
  ].filter(([, v]) => v);
  const detail = rows.map(([k, v]) => `<div class="ln"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Asset Label — ${esc(a.asset_code)}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
<style>
  @page { size: 70mm 40mm; margin: 3mm; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'JetBrains Mono',monospace; color:#000; background:#fff; }
  .card { display:flex; gap:4mm; align-items:center; padding:2mm; }
  #qr { width:26mm; height:26mm; flex:0 0 auto; }
  #qr img, #qr canvas { width:26mm !important; height:26mm !important; }
  .body { flex:1; min-width:0; }
  .code { font-size:13pt; font-weight:700; letter-spacing:.02em; }
  .org { font-size:6pt; text-transform:uppercase; letter-spacing:.12em; color:#444; margin-bottom:1mm; }
  .ln { font-size:6.5pt; display:flex; gap:2mm; line-height:1.35; }
  .ln .k { color:#666; min-width:13mm; text-transform:uppercase; letter-spacing:.05em; }
  .ln .v { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
</style></head><body>
<div class="card">
  <div id="qr"></div>
  <div class="body">
    <div class="org">Legend of Toys · Asset</div>
    <div class="code">${esc(a.asset_code)}</div>
    ${detail}
  </div>
</div>
<script>
  function render(){ try { new QRCode(document.getElementById('qr'), { text:${JSON.stringify(a.asset_code || '')}, width:120, height:120, correctLevel: QRCode.CorrectLevel.M }); } catch(e){ document.getElementById('qr').textContent=${JSON.stringify(a.asset_code || '')}; } }
  if (typeof QRCode === 'undefined') { setTimeout(function(){ render(); setTimeout(function(){ window.print(); }, 400); }, 600); }
  else { render(); window.onload = function(){ setTimeout(function(){ window.print(); }, 400); }; }
<\/script>
</body></html>`;
  printWindow(html);
}

// History event_type → human label.
export const HISTORY_LABELS = {
  created:          'Created',
  status_change:    'Status changed',
  custody_transfer: 'Custody transfer',
  location_change:  'Location changed',
  updated:          'Edited',
  retired:          'Retired',
  document_added:   'Document added',
  document_removed: 'Document removed',
};
