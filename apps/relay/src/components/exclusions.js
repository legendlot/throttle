'use client';

// Shared audience-exclusion controls. Used by the campaign form (S276) and the journey settings
// panel (S338b) so the picker, the presets and the wording cannot drift between the two surfaces —
// the rules are the same three rules, evaluated by the same SQL predicate (comms.campaign_excluded).

// Presets for "don't contact anyone messaged in the last N hours". Free entry is still allowed;
// these just cover what people actually ask for ("not again today", "not this week").
export const CONTACTED_WINDOWS = [
  { v: '', label: 'Off — no time-based exclusion' },
  { v: '6', label: '6 hours' },
  { v: '24', label: '24 hours (a day)' },
  { v: '48', label: '48 hours' },
  { v: '72', label: '72 hours (3 days)' },
  { v: '168', label: '7 days' },
  { v: '336', label: '14 days' },
  { v: '720', label: '30 days' },
];

// Compact multi-select: a scrollable checkbox list. Deliberately not a <select multiple> —
// ctrl-clicking to keep a selection is the single most misused control on the web, and losing
// an exclusion by mis-clicking means a customer gets a message they were meant to be spared.
export function ExcludePicker({ options, selected, onToggle, disabled, empty, renderLabel }) {
  if (!options.length) return <div className="dim" style={{ fontSize: 12 }}>{empty}</div>;
  return (
    <div style={{ maxHeight: 132, overflowY: 'auto', border: '1px solid var(--border)',
      borderRadius: 6, padding: '4px 6px', background: 'var(--surface-2, transparent)' }}>
      {options.map((o) => (
        <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 2px',
          fontSize: 12.5, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
          <input type="checkbox" checked={selected.includes(o.id)} disabled={disabled}
            onChange={() => onToggle(o.id)} style={{ cursor: disabled ? 'default' : 'pointer' }} />
          <span>{renderLabel(o)}</span>
        </label>
      ))}
    </div>
  );
}
