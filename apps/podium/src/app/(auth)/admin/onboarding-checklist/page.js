'use client';
// J2 — the onboarding checklist template (admin data). HR / admin edit wording, owner, flags and the due offset
// (days from the joining date; negative = before day one). A started onboarding keeps its own snapshot, so edits
// apply to the NEXT one. Live-checked lines (auto_source) keep their behaviour.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ListChecks, Plus, Save } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { EMPLOYMENT_TYPES } from '../../../../lib/format.js';
import { OB_OWNERS, OB_AUTO_LABELS, obError } from '../../../../lib/onboarding.js';
import { Card, inp, primaryBtn, ghostBtn, muted } from '../../../../components/HiringBits.js';

const th = { textAlign: 'left', padding: '6px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', fontWeight: 700 };
const td = { padding: '6px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', fontSize: 13 };
const smallBtn = { ...ghostBtn, padding: '4px 10px', fontSize: 11 };
const EMPTY_LINE = { key: '', title: '', owner: 'hr', required: true, allow_na: false, applies_to: [], due_offset_days: 0, sort: 200, active: true, _new: true };

export default function OnboardingChecklistPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [d, setD] = useState(null);
  const [lines, setLines] = useState([]);
  const load = useCallback(() => {
    if (!session) return;
    podiumopsGet('getOnboardingTemplate', {}, session).then(r => { setD(r); setLines(r.lines.map(l => ({ ...l }))); }).catch(() => setD(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  if (perms && !perms.podium_hr) return <div style={{ color: 'var(--t3)' }}>Requires podium_hr.</div>;
  if (d === false) return <div style={{ color: 'var(--t3)' }}>Could not load the checklist.</div>;
  if (!d) return <Spinner />;

  const setLine = (i, patch) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch, _dirty: true } : l)));
  async function saveLine(l) {
    try {
      await podiumopsPost('saveOnboardingLine', { key: l.key.trim(), title: l.title, owner: l.owner, required: l.required,
        allow_na: l.allow_na, applies_to: l.applies_to || [], due_offset_days: Number(l.due_offset_days), sort: Number(l.sort), active: l.active }, session);
      showToast('Saved', 'success'); load();
    } catch (e) { showToast(obError(e), 'error'); }
  }

  return (
    <div style={{ maxWidth: 1150 }}>
      <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ListChecks size={13} /> Onboarding checklist</span>}
        right={<button style={smallBtn} onClick={() => setLines(ls => [...ls, { ...EMPTY_LINE }])}><Plus size={12} /> Add line</button>}>
        <div style={{ ...muted, marginBottom: 8 }}>Changes apply to onboardings started from now on. “Due” = days from the joining date (negative = before day one).</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Order</th><th style={th}>Line</th><th style={th}>Owner</th><th style={th}>Due (days)</th><th style={th}>Required</th><th style={th}>N/A allowed</th><th style={th}>Applies to</th><th style={th}>Active</th><th style={th}></th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key || `new-${i}`} style={{ opacity: l.active ? 1 : 0.55 }}>
                <td style={td}><input type="number" style={{ ...inp, width: 64 }} value={l.sort} onChange={e => setLine(i, { sort: e.target.value })} /></td>
                <td style={td}>
                  <input style={{ ...inp, fontFamily: 'var(--font-ui)' }} value={l.title} onChange={e => setLine(i, { title: e.target.value })} />
                  {l._new
                    ? <input style={{ ...inp, marginTop: 4, width: 220 }} placeholder="key (lowercase_with_underscores)" value={l.key} onChange={e => setLine(i, { key: e.target.value })} />
                    : <div style={muted}>{l.key}{l.auto_source ? ` · ${OB_AUTO_LABELS[l.auto_source]}` : ''}</div>}
                </td>
                <td style={td}>
                  <select style={{ ...inp, width: 120 }} value={l.owner} onChange={e => setLine(i, { owner: e.target.value })}>
                    {OB_OWNERS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </td>
                <td style={td}><input type="number" min={-60} max={365} style={{ ...inp, width: 70 }} value={l.due_offset_days} onChange={e => setLine(i, { due_offset_days: e.target.value })} /></td>
                <td style={td}><input type="checkbox" checked={!!l.required} onChange={e => setLine(i, { required: e.target.checked })} /></td>
                <td style={td}><input type="checkbox" checked={!!l.allow_na} onChange={e => setLine(i, { allow_na: e.target.checked })} /></td>
                <td style={td}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: 220 }}>
                    {EMPLOYMENT_TYPES.map(t => {
                      const on = (l.applies_to || []).includes(t.id);
                      return (
                        <label key={t.id} style={{ fontSize: 11, display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                          <input type="checkbox" checked={on} onChange={e => setLine(i, { applies_to: e.target.checked ? [...(l.applies_to || []), t.id] : (l.applies_to || []).filter(x => x !== t.id) })} />
                          {t.label}
                        </label>
                      );
                    })}
                  </div>
                  {!(l.applies_to || []).length && <div style={muted}>everyone</div>}
                </td>
                <td style={td}><input type="checkbox" checked={!!l.active} onChange={e => setLine(i, { active: e.target.checked })} /></td>
                <td style={td}>{l._dirty && <button style={{ ...primaryBtn, padding: '4px 10px' }} onClick={() => saveLine(l)}><Save size={12} /> Save</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
