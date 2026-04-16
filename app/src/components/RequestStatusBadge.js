const STATUS_STYLES = {
  pending:    { label: 'Pending',    color: '#F2CD1A', bg: 'rgba(242,205,26,0.12)' },
  approved:   { label: 'Approved',   color: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
  rejected:   { label: 'Rejected',   color: '#DE2A2A', bg: 'rgba(222,42,42,0.12)' },
  info_needed:{ label: 'Info Needed', color: '#213CE2', bg: 'rgba(33,60,226,0.12)' },
};

export default function RequestStatusBadge({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.pending;
  return (
    <span style={{
      fontFamily: 'var(--mono)',
      fontSize: 9,
      letterSpacing: '.1em',
      textTransform: 'uppercase',
      padding: '2px 7px',
      borderRadius: 3,
      background: s.bg,
      color: s.color,
    }}>
      {s.label}
    </span>
  );
}
