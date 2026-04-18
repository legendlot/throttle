export function getDefaultRoute(perms) {
  if (!perms) return '/dashboard';
  if (perms.dashboard) return '/dashboard';
  if (perms.line_flush_create && (!perms.stock || perms.stock === 'none')) return '/line-flush';
  if (perms.procurement_view && !perms.dashboard) return '/procurement';
  return '/dashboard';
}
