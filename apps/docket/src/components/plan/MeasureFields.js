'use client';
// F9 R3 — "Done when · measured from" (spec §4.4): system → metric (filtered by system) → target. The
// metric list is the worker's registry (getPlan `metrics`); the worker re-validates and sets source_ok.
import { AlertTriangle, Activity, CheckCircle2 } from 'lucide-react';
import { metricSystems, metricsFor } from '../../lib/plan.js';
import { readingChip } from '../../lib/measure.js';

const SYSTEM_LABEL = { redline: 'Redline', garage: 'Garage', odo: 'Odo', podium: 'Podium', docket: 'Docket', manual: 'Manual' };

// value = { system, metric, target } (lib/plan measureDraft); '' system = not measured.
export function MeasureFields({ value, onChange, metrics = [], disabled = false }) {
  const v = value || { system: '', metric: '', target: '' };
  const set = (p) => onChange({ ...v, ...p });
  const opts = metricsFor(metrics, v.system);
  return (
    <div className="pl-measure">
      <select className="pl-input" aria-label="Measured from — system" value={v.system} disabled={disabled}
        onChange={e => set({ system: e.target.value, metric: e.target.value === 'manual' ? 'manual' : '' })}>
        <option value="">Not measured</option>
        {metricSystems(metrics).map(s => <option key={s} value={s}>{SYSTEM_LABEL[s] || s}</option>)}
      </select>
      {v.system && v.system !== 'manual' && (
        <select className="pl-input" aria-label="Measured from — metric" value={v.metric} disabled={disabled}
          onChange={e => set({ metric: e.target.value })}>
          <option value="">Pick a metric…</option>
          {opts.map(m => <option key={m.key} value={m.key}>{m.label}{m.source_ok ? '' : ' (not recorded yet)'}</option>)}
        </select>
      )}
      {v.system && (
        <input className="pl-input" aria-label="Measured from — target" placeholder="Target, e.g. ≥ 97% for 4 weeks" value={v.target}
          maxLength={300} disabled={disabled} onChange={e => set({ target: e.target.value })} />
      )}
    </div>
  );
}

// R9b: the daily check's latest reading (measure.reading — sent at F / R / O only) + "✓ target reached".
export function ReadingChip({ measure, metrics = [] }) {
  const c = readingChip(measure, metrics);
  if (!c) return null;
  return <>
    <span className="pl-reading" title={c.title}><Activity size={11} aria-hidden /> {c.text}</span>
    {c.reached && <span className="pl-reached"><CheckCircle2 size={11} aria-hidden /> target reached</span>}
  </>;
}

export function NoSourceChip() {
  return (
    <span className="pl-nosrc" title="No system records this today — it will be checked by hand">
      <AlertTriangle size={11} aria-hidden /> No data source
    </span>
  );
}
