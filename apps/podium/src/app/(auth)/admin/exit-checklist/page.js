'use client';
// X1 — the no-dues checklist template + the "other tools" list (admin data, L4/L8). HR / admin edit them
// here; no code change needed. A started exit keeps its own snapshot, so edits apply to the NEXT exit.
// Live-checked lines (auto_source) keep their behaviour — only wording, owner and flags are editable.
// X1b: the relieving + experience letter templates (versioned like the offer templates: saving = a new version,
// issued letters keep the version they used).
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ListChecks, Wrench, Plus, Save, Eye, FileText } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { EMPLOYMENT_TYPES } from '../../../../lib/format.js';
import { CHECKLIST_OWNERS, AUTO_SOURCE_LABELS, EXIT_LETTER_KINDS, exitError } from '../../../../lib/exits.js';
import { fmtDateTime } from '../../../../lib/hiring.js';
import { Card, F, Note, inp, primaryBtn, ghostBtn, muted } from '../../../../components/HiringBits.js';
import { LetterPreview } from '../../../../components/OfferBits.js';

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

      <LetterTemplates session={session} />
    </div>
  );
}

// ── X1b — Letter templates ───────────────────────────────────────────────────
function LetterTemplates({ session }) {
  const [data, setData] = useState(null);
  const [key, setKey] = useState('relieving');
  const load = useCallback(() => {
    if (!session) return;
    podiumopsGet('getExitLetterTemplates', {}, session).then(setData).catch(() => setData(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);
  const title = <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FileText size={13} /> Letter templates</span>;
  if (data === false) return <Card title={title}><div style={muted}>Could not load the letter templates.</div></Card>;
  if (!data) return <Card title={title}><Spinner /></Card>;
  const versions = (data.templates || []).filter(t => t.template_key === key);
  const current = versions.find(t => t.is_current) || versions[0] || null;
  return (
    <Card title={title}>
      <div style={{ ...muted, marginBottom: 8 }}>The relieving and experience letters HR issues from an exit. Saving makes a new version; letters already issued keep theirs.</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {EXIT_LETTER_KINDS.map(t => (
          <button key={t.id} onClick={() => setKey(t.id)} style={{ ...ghostBtn, ...(key === t.id ? { color: 'var(--text-1)', borderColor: 'var(--podium-accent)' } : {}) }}>{t.label}</button>
        ))}
      </div>
      <LetterTemplateEditor key={current?.id || key} templateKey={key} current={current} versions={versions} fields={data.fields || []} session={session} onSaved={load} />
    </Card>
  );
}

function LetterTemplateEditor({ templateKey, current, versions, fields, session, onSaved }) {
  const { showToast } = useToast();
  const [f, setF] = useState(() => ({
    title: current?.title || '', body: current?.body || '', entity_name: current?.entity_name || '',
    entity_address: (current?.entity_address || []).join('\n'), notes: '',
  }));
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const body = () => ({ template_key: templateKey, ...f, entity_address: f.entity_address.split('\n').map(s => s.trim()).filter(Boolean) });
  async function doPreview() {
    try { const r = await podiumopsPost('previewExitLetterTemplate', body(), session); setPreview(r.view); }
    catch (e) { setPreview(null); showToast(exitError(e), 'error'); }
  }
  async function save() {
    if (!window.confirm('Save as a new version? Letters issued from now on use it; letters already issued keep theirs.')) return;
    setBusy(true);
    try { const t = await podiumopsPost('saveExitLetterTemplate', body(), session); showToast(`Saved as v${t?.version}`, 'success'); onSaved(); }
    catch (e) { showToast(exitError(e), 'error'); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(340px, 1fr) minmax(340px, 1fr)', gap: 14, alignItems: 'start' }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{current ? `Current: v${current.version}` : 'No version yet'}</div>
        {current?.notes && <Note>{current.notes}</Note>}
        <F label="Title"><input style={inp} value={f.title} onChange={e => set('title', e.target.value)} /></F>
        <F label="Body — {{field}} merges; {{#field}}…{{/field}} shows only when the field is set; blank line = new paragraph">
          <textarea rows={14} style={{ ...inp, resize: 'vertical', fontSize: 12 }} value={f.body} onChange={e => set('body', e.target.value)} />
        </F>
        <F label="Entity *"><input style={inp} value={f.entity_name} onChange={e => set('entity_name', e.target.value)} /></F>
        <F label="Letterhead address (one line each)"><textarea rows={3} style={{ ...inp, resize: 'vertical' }} value={f.entity_address} onChange={e => set('entity_address', e.target.value)} /></F>
        <F label="Version note (what changed)"><input style={inp} value={f.notes} onChange={e => set('notes', e.target.value)} /></F>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button style={ghostBtn} onClick={doPreview}><Eye size={13} /> Preview</button>
          <button style={primaryBtn} disabled={busy} onClick={save}><Save size={13} /> Save new version</button>
        </div>
        <div style={{ marginTop: 12 }}>
          <div style={{ ...muted, marginBottom: 4 }}>Merge fields</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {fields.map(k => <code key={k} style={{ fontSize: 11, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px' }}>{`{{${k}}}`}</code>)}
          </div>
          <div style={{ ...muted, marginTop: 6 }}>has_department and has_signatory_title are for sections. The letter closes with “For &lt;entity&gt;”, the signatory and their title.</div>
        </div>
        {versions.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ ...muted, marginBottom: 4 }}>Versions</div>
            {versions.map(v => <div key={v.id} style={{ fontSize: 12 }}>v{v.version}{v.is_current ? ' (current)' : ''} · {fmtDateTime(v.created_at)}{v.notes ? ` · ${v.notes}` : ''}</div>)}
          </div>
        )}
      </div>
      <div>
        {preview ? <LetterPreview view={preview} /> : <div style={muted}>Preview renders the template with sample data (no real person).</div>}
      </div>
    </div>
  );
}
