export function formatLotUpc(raw) {
  if (raw == null) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  const stripped = trimmed.replace(/^lot-?/i, '');
  const digits = stripped.replace(/[^0-9a-zA-Z]/g, '');
  if (!digits) return '';
  const padded = digits.padStart(8, '0');
  return `LOT-${padded}`;
}

export function isBatchLabel(upc) {
  if (!upc) return false;
  return /-(E|R)$/.test(String(upc));
}
