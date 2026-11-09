'use client';
// Recurrence picker for checklist (recurring) tasks. Controlled: emits the
// { freq, days_of_week?, day_of_month?, time } jsonb. RULE-DOCKET-008.
import { useState } from 'react';
import { WEEKDAYS } from '../lib/recurrence.js';

const FREQS = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];

export function RecurrenceEditor({ value, onChange, hideTime = false }) {
  const rec = value || (hideTime ? { freq: 'daily' } : { freq: 'daily', time: '09:00' });
  const [domDraft, setDomDraft] = useState(null);   // monthly day while typing (string), else null

  function setFreq(freq) {
    if (freq === rec.freq) return;
    const base = hideTime ? {} : { time: rec.time || '09:00' };
    if (freq === 'daily') onChange({ freq, ...base });
    else if (freq === 'weekly') onChange({ freq, ...base, days_of_week: rec.days_of_week?.length ? rec.days_of_week : [1] });
    else onChange({ freq, ...base, day_of_month: rec.day_of_month || 1 });
  }
  function toggleDay(d) {
    const set = new Set((rec.days_of_week || []).map(Number));
    if (set.has(d)) set.delete(d); else set.add(d);
    onChange({ ...rec, days_of_week: [...set].sort((a, b) => a - b) });
  }

  return (
    <div className="rec-editor">
      <div className="rec-seg">
        {FREQS.map(f => (
          <button key={f.key} type="button" className={'rec-seg-btn' + (rec.freq === f.key ? ' on' : '')}
            onClick={() => setFreq(f.key)}>{f.label}</button>
        ))}
      </div>

      {rec.freq === 'weekly' && (
        <div className="rec-days">
          {WEEKDAYS.map(w => (
            <button key={w.v} type="button" title={w.full}
              className={'rec-day' + ((rec.days_of_week || []).includes(w.v) ? ' on' : '')}
              onClick={() => toggleDay(w.v)}>{w.label}</button>
          ))}
        </div>
      )}

      {rec.freq === 'monthly' && (
        <div className="rec-row">
          <label className="rec-lbl">On day</label>
          {/* A local draft so the field can be cleared while typing; clamps to 1–31 on blur. */}
          <input type="number" min={1} max={31} className="rec-num"
            value={domDraft ?? (rec.day_of_month || 1)}
            onChange={e => {
              const v = e.target.value;
              setDomDraft(v);
              const n = Number(v);
              if (v !== '' && Number.isInteger(n) && n >= 1 && n <= 31) onChange({ ...rec, day_of_month: n });
            }}
            onBlur={() => {
              if (domDraft == null) return;
              const n = Math.max(1, Math.min(31, Math.round(Number(domDraft)) || 1));
              setDomDraft(null);
              if (n !== Number(rec.day_of_month)) onChange({ ...rec, day_of_month: n });
            }} />
          <span className="rec-hint">of the month (clamps to the last day in shorter months)</span>
        </div>
      )}

      {!hideTime && (
        <div className="rec-row">
          <label className="rec-lbl">At</label>
          <input type="time" className="rec-time" value={rec.time || '09:00'}
            onChange={e => onChange({ ...rec, time: e.target.value })} />
        </div>
      )}

      <div className="rec-row">
        <label className="rec-lbl">Ends</label>
        <input type="date" className="rec-date" value={rec.until || ''}
          onChange={e => onChange({ ...rec, until: e.target.value || undefined })} />
        {rec.until
          ? <button type="button" className="rec-clear" onClick={() => { const { until, ...rest } = rec; onChange(rest); }}>Clear · no end date</button>
          : <span className="rec-hint">optional — the task disappears from the checklist after this date</span>}
      </div>
    </div>
  );
}

export default RecurrenceEditor;
