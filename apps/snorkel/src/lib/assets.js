// Shared constants for the Asset Register (list / new / detail / settings).

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
