const STATUS_STYLES = {
  pending:    { label: 'Pending',    cls: 'bg-yellow-900/40 text-yellow-400 border-yellow-800' },
  approved:   { label: 'Approved',   cls: 'bg-green-900/40 text-green-400 border-green-800' },
  rejected:   { label: 'Rejected',   cls: 'bg-red-900/40 text-red-400 border-red-800' },
  info_needed:{ label: 'Info Needed',cls: 'bg-blue-900/40 text-blue-400 border-blue-800' },
};

export default function RequestStatusBadge({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.pending;
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded border ${s.cls}`}>
      {s.label}
    </span>
  );
}
