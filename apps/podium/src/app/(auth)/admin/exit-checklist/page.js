'use client';
// X1 — the no-dues checklist template + the "other tools" list (admin data, L4/L8). HR / admin edit them
// here; no code change needed. A started exit keeps its own snapshot, so edits apply to the NEXT exit.
// Live-checked lines (auto_source) keep their behaviour — only wording, owner and flags are editable.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ListChecks, Wrench, Plus, Save } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { EMPLOYMENT_TYPES } from '../../../../lib/format.js';
import { CHECKLIST_OWNERS, AUTO_SOURCE_LABELS, exitError } from '../../../../lib/exits.js';
import { Card, inp, primaryBtn, ghostBtn, muted } from '../../../../components/HiringBits.js';

const th = { textAlign: 'left', padding: '6px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', fontWeight: 700 };
const td = { padding: '6px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', fontSize: 13 };
const smallBtn = { ...ghostBtn, padding: '4px 10px', fontSize: 11 };
const EMPTY_LINE = { key: '', title: '', owner: 'hr', required: true, allow_na: false, applies_to: [], sort: 200, active: true, _new: true };

export default function ExitChecklistPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [d, setD] = useState(null);
  const [lines, setLines] = useState([]);
  const [tools, setTools] = useState([]);
  const [days, setDays] = useState('');
  const load = useCallback(() => {
    if (!session) return;
    podiumopsGet('getExitChecklist', {}, session).then(r => {
      setD(r); setLines(r.lines.map(l => ({ ...l }))); setTools(r.tools.map(t => ({ ...t }))); setDays(String(r.notice_days));
    }).catch(() => setD(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  if (perms && !perms.podium_hr) return <div style={{ color: 'var(--t3)' }}>Requires podium_hr.</div>;
  if (d === false) return <div style={{ color: 'var(--t3)' }}>Could not load the checklist.</div>;
  if (!d) return <Spinner />;

  const setLine = (i, patch) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch, _dirty: true } : l)));
  const setTool = (i, patch) => setTools(ts => ts.map((t, j) => (j === i ? { ...t, ...patch, _dirty: true } : t)));
  async function saveLine(l) {
    try {
      await podiumopsPost('saveExitChecklistLine', { key: l.key.trim(), title: l.title, owner: l.owner, required: l.required,
        allow_na: l.allow_na, applies_to: l.applies_to || [], sort: Number(l.sort), active: l.active }, session);
      showToast('Saved', 'success'); load();
    } catch (e) { showToast(exitError(e), 'error'); }
  }
  async function saveTool(t) {
    try { await podiumopsPost('saveExitTool', { id: t.id || null, name: t.name, active: t.active, sort: Number(t.sort) }, session); showToast('Saved', 'success'); load(); }
    catch (e) { showToast(exitError(e), 'error'); }
  }
  async function saveDays() {
    try { await podiumopsPost('updateSettings', { exit_notice_days: Number(days) }, session); showToast('Saved', 'success'); load(); }
    catch (e) { showToast(exitError(e), 'error'); }
  }

  return (
    <div style={{ maxWidth: 1100, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card title="Notice period">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          Default last working day = notice date +
          <input type="number" min={0} max={365} style={{ ...inp, width: 80 }} value={days} disabled={!d.can_edit_notice_days} onChange={e => setDays(e.target.value)} />
          days.
          {d.can_edit_notice_days ? <button style={smallBtn} onClick={saveDays}><Save size={12} /> Save</button>
            : <span style={muted}>(podium_admin changes this)</span>}
        </div>
        <div style={{ ...muted, marginTop: 6 }}>HR can set a different last working day on an exit, with a reason.</div>
      </Card>

      <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ListChecks size={13} /> Checklist lines</span>}
        right={<button style={smallBtn} onClick={() => setLines(ls => [...ls, { ...EMPTY_LINE }])}><Plus size={12} /> Add line</button>}>
        <div style={{ ...muted, marginBottom: 8 }}>Changes apply to exits started from now on; an exit already in progress keeps its own copy.</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Order</th><th style={th}>Line</th><th style={th}>Owner</th><th style={th}>Required</th><th style={th}>N/A allowed</th><th style={th}>Applies to</th><th style={th}>Active</th><th style={th}></th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key || `new-${i}`} style={{ opacity: l.active ? 1 : 0.55 }}>
                <td style={td}><input type="number" style={{ ...inp, width: 64 }} value={l.sort} onChange={e => setLine(i, { sort: e.target.value })} /></td>
                <td style={td}>
                  <input style={{ ...inp, fontFamily: 'var(--font-ui)' }} value={l.title} onChange={e => setLine(i, { title: e.target.value })} />
                  {l._new
                    ? <input style={{ ...inp, marginTop: 4, width: 220 }} placeholder="key (lowercase_with_underscores)" value={l.key} onChange={e => setLine(i, { key: e.target.value })} />
                    : <div style={muted}>{l.key}{l.auto_source ? ` · ${AUTO_SOURCE_LABELS[l.auto_source]}` : ''}</div>}
                </td>
                <td style={td}>
                  <select style={{ ...inp, width: 110 }} value={l.owner} onChange={e => setLine(i, { owner: e.target.value })}>
                    {CHECKLIST_OWNERS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </td>
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

      <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Wrench size={13} /> Other tools</span>}
        right={<button style={smallBtn} onClick={() => setTools(ts => [...ts, { name: '', active: true, sort: 200, _dirty: true }])}><Plus size={12} /> Add tool</button>}>
        <div style={{ ...muted, marginBottom: 8 }}>Each active tool becomes an IT line on every new exit ("Access removed: …"); HR marks N/A for tools the person never had.</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Order</th><th style={th}>Tool</th><th style={th}>Active</th><th style={th}></th></tr></thead>
          <tbody>
            {tools.map((t, i) => (
              <tr key={t.id || `new-${i}`} style={{ opacity: t.active ? 1 : 0.55 }}>
                <td style={td}><input type="number" style={{ ...inp, width: 64 }} value={t.sort} onChange={e => setTool(i, { sort: e.target.value })} /></td>
                <td style={td}><input style={{ ...inp, fontFamily: 'var(--font-ui)' }} value={t.name} onChange={e => setTool(i, { name: e.target.value })} /></td>
                <td style={td}><input type="checkbox" checked={!!t.active} onChange={e => setTool(i, { active: e.target.checked })} /></td>
                <td style={td}>{t._dirty && <button style={{ ...primaryBtn, padding: '4px 10px' }} onClick={() => saveTool(t)}><Save size={12} /> Save</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
