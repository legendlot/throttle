// Gate Pass — shared constants/helpers (Garage). Mirrors the worker's GP_PURPOSES
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
  const today = new Date().toISOString().slice(0, 10);
  if (gp.expected_return_date && gp.expected_return_date < today) return 'overdue';
  return 'pending';
}
