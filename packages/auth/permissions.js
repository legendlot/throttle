const LEVEL_KEYS = new Set([
  'stock', 'grn', 'receiving', 'work_order', 'stock_issue', 'returns',
]);

export function hasPermission(perms, key) {
  if (!perms) return false;
  const value = perms[key];
  if (LEVEL_KEYS.has(key)) return value && value !== 'none';
  return value === true;
}

export function hasWritePermission(perms, key) {
  if (!perms) return false;
  return perms[key] === 'write';
}

export function canApprovePO(perms) {
  return !!(perms && perms.procurement_approve);
}

export function canRaisePO(perms) {
  return !!(perms && perms.procurement_raise);
}

export function canViewCosts(perms) {
  return !!(perms && perms.reports_finance);
}

export function canManageUsers(perms) {
  return !!(perms && perms.users_manage);
}

export function canViewProcurement(perms) {
  return !!(perms && perms.procurement_view);
}
