// Calendar presets, computed in IST (the business clock). Each resolves to a concrete
// [from, to) range. Shared by Analytics + Activity — keep the two pages' pickers identical.
const IST_MS = 5.5 * 3600 * 1000;

export function istPresetRange(key) {
  const now = new Date();
  const ist = new Date(now.getTime() + IST_MS);            // shifted clock; read via getUTC*
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate();
  const istMidnightUtc = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd) - IST_MS);
  switch (key) {
    case 'today':  return [istMidnightUtc(y, m, d), now];
    case '7d':     return [new Date(now.getTime() - 7 * 86400000), now];
    case '30d':    return [new Date(now.getTime() - 30 * 86400000), now];
    case '90d':    return [new Date(now.getTime() - 90 * 86400000), now];
    case 'mtd':    return [istMidnightUtc(y, m, 1), now];
    case 'lastmo': return [istMidnightUtc(y, m - 1, 1), istMidnightUtc(y, m, 1)];
    case 'fy':     return [istMidnightUtc(m >= 3 ? y : y - 1, 3, 1), now];   // FY = Apr 1 IST
    default:       return [new Date(now.getTime() - 30 * 86400000), now];
  }
}

export const PRESETS = [
  { key: 'today', label: 'Today' }, { key: '7d', label: '7D' }, { key: '30d', label: '30D' },
  { key: '90d', label: '90D' }, { key: 'mtd', label: 'MTD' }, { key: 'lastmo', label: 'Last mo' },
  { key: 'fy', label: 'FY' },
];
