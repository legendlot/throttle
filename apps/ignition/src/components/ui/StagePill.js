'use client';
import { STAGE_LABELS, STAGE_PALETTE } from '../../lib/stages.js';
import { UGC_STAGE_LABELS, UGC_STAGE_PALETTE } from '../../lib/ugcStages.js';

const FALLBACK = { fg: 'var(--text-2)', bg: 'var(--chip-neutral)' };

// Stage status pill (radius 99, 12/600; size 'lg' = 13/700). `ugc` picks the UGC vocabulary.
// `dot` adds the 6px stage-colour dot used by filter chips. Labels come from lib/*Stages.js.
export function StagePill({ stage, ugc = false, size = 'sm', dot = false, label, style }) {
  if (!stage) return null;
  const labels = ugc ? UGC_STAGE_LABELS : STAGE_LABELS;
  const pal = (ugc ? UGC_STAGE_PALETTE : STAGE_PALETTE)[stage] || FALLBACK;
  const lg = size === 'lg';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
      padding: lg ? '5px 12px' : '3px 10px', borderRadius: 99,
      fontFamily: 'var(--font-ui)', fontSize: lg ? 13 : 12, fontWeight: lg ? 700 : 600,
      color: pal.fg, background: pal.bg, ...style,
    }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: pal.fg, flexShrink: 0 }} />}
      {label || labels[stage] || stage}
    </span>
  );
}

export default StagePill;
