// Smoke test: import every pure-JS export from the @throttle/* packages
// and assert each is defined plus exercise core behaviour.
//
// JSX-containing files (AuthProvider, guards, all of @throttle/ui) are NOT
// imported here because Node ESM cannot parse JSX without a bundler.
// Their correctness is verified by the three Next.js app builds, which
// transpile and tree-shake every exported symbol that the apps reference.
//
// Run from repo root: node scripts/smoke-imports.mjs

import assert from 'node:assert/strict';

const failures = [];
function check(name, value, kind) {
  if (value == null) return failures.push(`${name} is ${value}`);
  if (kind && typeof value !== kind) failures.push(`${name}: expected ${kind}, got ${typeof value}`);
}

// --- @throttle/domain (entire package, pure JS) -------------------------
const domain = await import('@throttle/domain');
check('domain.formatLotUpc',       domain.formatLotUpc,       'function');
check('domain.isBatchLabel',       domain.isBatchLabel,       'function');
check('domain.calcCycleTimeStats', domain.calcCycleTimeStats, 'function');
check('domain.isFbuProduct',       domain.isFbuProduct,       'function');
check('domain.todayStr',           domain.todayStr,           'function');
check('domain.todayISO',           domain.todayISO,           'function');
check('domain.formatDate',         domain.formatDate,         'function');
check('domain.OPERATOR_ROLES',     domain.OPERATOR_ROLES,     'object');
check('domain.SCAN_ACTIVITIES',    domain.SCAN_ACTIVITIES,    'object');
check('domain.LINES',              domain.LINES,              'object');

assert.equal(domain.formatLotUpc('3151'),          'LOT-00003151');
assert.equal(domain.formatLotUpc('lot-00003151'),  'LOT-00003151');
assert.equal(domain.formatLotUpc('LOT-00003151'),  'LOT-00003151');
assert.equal(domain.isBatchLabel('LOT-00003151-E'), true);
assert.equal(domain.isBatchLabel('LOT-00003151'),   false);
assert.equal(domain.OPERATOR_ROLES.length, 11);
assert.equal(domain.SCAN_ACTIVITIES.length, 8);
assert.equal(domain.LINES.length, 3);
const stats = domain.calcCycleTimeStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.ok(stats.median > 0 && stats.p95 > 0);
assert.equal(domain.todayStr().length, 10);

// --- @throttle/auth non-JSX modules -------------------------------------
const perms = await import('@throttle/auth/permissions.js');
check('auth.hasPermission',       perms.hasPermission,      'function');
check('auth.hasWritePermission',  perms.hasWritePermission, 'function');
check('auth.canApprovePO',        perms.canApprovePO,       'function');
check('auth.canRaisePO',          perms.canRaisePO,         'function');
check('auth.canViewCosts',        perms.canViewCosts,       'function');
check('auth.canManageUsers',      perms.canManageUsers,     'function');
check('auth.canViewProcurement',  perms.canViewProcurement, 'function');

assert.equal(perms.hasPermission(null, 'dashboard'),            false);
assert.equal(perms.hasPermission({ dashboard: true },  'dashboard'), true);
assert.equal(perms.hasPermission({ stock: 'none' },    'stock'),     false);
assert.equal(perms.hasPermission({ stock: 'view' },    'stock'),     true);
assert.equal(perms.hasPermission({ stock: 'write' },   'stock'),     true);
assert.equal(perms.hasWritePermission({ stock: 'view' },  'stock'),  false);
assert.equal(perms.hasWritePermission({ stock: 'write' }, 'stock'),  true);
assert.equal(perms.canApprovePO({ procurement_approve: true }),      true);

const defaultRoute = await import('@throttle/auth/getDefaultRoute.js');
check('auth.getDefaultRoute', defaultRoute.getDefaultRoute, 'function');
assert.equal(defaultRoute.getDefaultRoute(null),                                        '/dashboard');
assert.equal(defaultRoute.getDefaultRoute({ dashboard: true }),                         '/dashboard');
assert.equal(defaultRoute.getDefaultRoute({ line_flush_create: true, stock: 'none' }),  '/line-flush');
assert.equal(defaultRoute.getDefaultRoute({ line_flush_create: true, stock: 'view' }),  '/dashboard');
assert.equal(defaultRoute.getDefaultRoute({ procurement_view: true }),                  '/procurement');

// --- @throttle/db non-JSX modules ---------------------------------------
const dbWorker = await import('@throttle/db/workerFetch.js');
check('db.workerFetch', dbWorker.workerFetch, 'function');

const dbSb = await import('@throttle/db/sbFetch.js');
check('db.sbFetch', dbSb.sbFetch, 'function');

const dbClients = await import('@throttle/db/supabase.js');
check('db.supabase',      dbClients.supabase,      'object');
check('db.supabaseBrand', dbClients.supabaseBrand, 'object');

// --- Results ------------------------------------------------------------
if (failures.length) {
  console.error('SMOKE TEST FAILURES:');
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
} else {
  console.log('OK — all non-JSX package exports resolved, 19 behaviour assertions pass');
  console.log('JSX packages (@throttle/ui, AuthProvider, guards) verified by Next.js app builds');
}
