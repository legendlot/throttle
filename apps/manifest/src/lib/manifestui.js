// Shared style tokens + tiny presentational helpers for Snorkel pages.
// Mirrors the inline-style vocabulary the procurement pages already use
// (CSS vars from globals.css: --surface, --border, --t1/t2/t3, --yellow, --mono, --cond).

export const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.2)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.25)' },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.3)' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)' },
};

export const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
export const panelHeaderStyle  = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
export const panelBodyStyle    = { padding: '14px 16px' };
export const tableThStyle      = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
export const tableTdStyle      = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
export const inputStyle        = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
export const selectStyle       = { ...inputStyle, cursor: 'pointer' };
export const labelStyle        = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
export const btnPrimary        = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
export const btnSecondary      = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
export const btnDanger         = { background: 'transparent', border: '1px solid #ff7070', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: '#ff7070', cursor: 'pointer', fontFamily: 'var(--cond)' };

export const pageH1 = { fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 };
export const pageSub = { color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' };

export const tabBtn = (active) => ({
  background: active ? 'var(--yellow)' : 'var(--surface2)',
  color: active ? '#000' : 'var(--t3)',
  border: active ? '1px solid var(--yellow)' : '1px solid var(--border)',
  borderRadius: 4, padding: '5px 12px', fontFamily: 'var(--mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: active ? 700 : 500,
});

export function fmtDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function urgencyColor(u) {
  const v = (u || '').toLowerCase();
  if (v === 'urgent') return '#ff7070';
  if (v === 'high') return '#f2cd1a';
  return 'var(--t3)';
}

export const REQUEST_TONES = { pending: 'yellow', approved: 'green', rejected: 'red', cancelled: 'gray' };

export function StatusBadge({ label, tone = 'gray' }) {
  const s = TONE_STYLES[tone] || TONE_STYLES.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{label}</span>
  );
}

// ── Manifest-specific ──────────────────────────────────────────
export const ORDER_STATUS_TONE = {
  intent: 'gray', quoted: 'gray', placed: 'blue', pi_received: 'blue', in_production: 'yellow',
  ready: 'yellow', picked: 'yellow', shipped: 'blue', in_transit: 'blue', arrived_port: 'blue',
  customs: 'yellow', cleared: 'green', local_transit: 'blue', delivered: 'green', closed: 'green', cancelled: 'red',
};
export const SHIPMENT_STATUS_TONE = {
  planned: 'gray', booked: 'gray', loaded: 'yellow', in_transit: 'blue', arrived: 'blue',
  customs: 'yellow', cleared: 'green', local_transit: 'blue', delivered: 'green', closed: 'green', cancelled: 'red',
};
export const ORDER_STATUSES = ['intent','quoted','placed','pi_received','in_production','ready','picked','shipped','in_transit','arrived_port','customs','cleared','local_transit','delivered','closed','cancelled'];
export const SHIPMENT_STATUSES = ['planned','booked','loaded','in_transit','arrived','customs','cleared','local_transit','delivered','closed','cancelled'];
export const ORDER_CATEGORIES = ['product','part','sub_part','mould','equipment','sample','other'];
export const CHARGE_CATEGORIES = ['goods','sf_commission','intl_freight','customs_duty','clearing','insurance','local_freight','other'];
export const DRAWDOWN_PHASES = ['goods_advance','shipping_customs','local','settlement','other'];

export function titleCase(s) { return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
export function fmtINR(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
export function fmtRMB(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return '¥' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
