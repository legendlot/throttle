// Gate Pass — shared constants/helpers (Garage). Mirrors the worker's GP_PURPOSES
import { todayStr } from '@throttle/domain';
// (01_worker/worker.js). Keep the purpose keys in lockstep with the worker validator.

export const GP_PURPOSES = {
  inbound: [
    { key: 'material_receipt', label: 'Material Receipt' },
    { key: 'returnable_in',    label: 'Returnable In' },
    { key: 'sample_in',        label: 'Sample In' },
    { key: 'other',            label: 'Other' },
  ],
  outbound: [
    { key: 'vendor_return',       label: 'Vendor Return' },
    { key: 'jobwork_out',         label: 'Job-work / Repair Out' },
    { key: 'sample_out',          label: 'Sample Out' },
    { key: 'scrap',               label: 'Scrap' },
    { key: 'inter_unit_transfer', label: 'Inter-unit Transfer' },
    { key: 'other',               label: 'Other' },
  ],
};

export const DIRECTION_LABEL = { inbound: 'Inbound', outbound: 'Outbound' };

export function purposeLabel(direction, key) {
  const all = [...GP_PURPOSES.inbound, ...GP_PURPOSES.outbound];
  const found = (GP_PURPOSES[direction] || []).find((p) => p.key === key) || all.find((p) => p.key === key);
  return found ? found.label : (key || '—');
}

// Returnable state: 'returned' | 'overdue' | 'pending' | null (not returnable)
export function returnState(gp) {
  if (!gp || !gp.is_returnable) return null;
  if (gp.returned_at) return 'returned';
  const today = todayStr();
  if (gp.expected_return_date && gp.expected_return_date < today) return 'overdue';
  return 'pending';
}

/* ── document picking ────────────────────────────────────────────────
   A <input type="file"> reports ONLY the files chosen in the last dialog,
   so `setFiles(Array.from(e.target.files))` silently discards everything
   picked before it. A gate pass normally wants a vehicle photo, a material
   photo and an invoice PDF — three different files, usually in three
   different folders, so they get picked in three separate dialogs and only
   the last one survives. On the New form, where the upload runs once on
   create, that means exactly one document is ever saved (Siddhant,
   2026-08-22). Multi-select inside a SINGLE dialog always worked, which is
   why the failure looked intermittent.

   mergeFiles appends instead of replacing, de-duping on name+size+mtime. */
export function mergeFiles(prev, picked) {
  const key = (f) => `${f.name}|${f.size}|${f.lastModified}`;
  const seen = new Set((prev || []).map(key));
  return [...(prev || []), ...Array.from(picked || []).filter((f) => !seen.has(key(f)))];
}

export function fmtFileSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
