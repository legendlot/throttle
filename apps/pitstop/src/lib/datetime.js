// Pitstop date/time formatting — always render in IST (Asia/Kolkata), since the
// CS team is in India and cs_tickets timestamps are full timestamptz.
const IST = 'Asia/Kolkata';

export function fmtIstDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: IST, day: '2-digit', month: 'short', year: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch { return String(iso); }
}

export function fmtIstDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      timeZone: IST, day: '2-digit', month: 'short', year: '2-digit',
    });
  } catch { return String(iso); }
}
