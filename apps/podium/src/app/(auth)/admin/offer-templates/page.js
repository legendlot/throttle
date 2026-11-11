'use client';
// Hiring C3 — offer letter templates (versioned: saving = a new version, offers keep the one they used),
// authorised signatories, and the statutory rule sets (read-only; new ones ship as migrations).
// Server gate: salary allow-list or podium_admin (canAdminOfferTemplates); the nav flag mirrors it.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Save, Eye, Plus } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { Card, F, Row, Note, inp, comboInp, primaryBtn, ghostBtn, muted } from '../../../../components/HiringBits.js';
import { LetterPreview, AnnexureTable } from '../../../../components/OfferBits.js';
import { OFFER_TEMPLATE_KEYS, hiringError, fmtDateTime } from '../../../../lib/hiring.js';

export default function OfferTemplatesPage() {
  const { session } = useAuth();
  const [data, setData] = useState(null);
  const [key, setKey] = useState('employment');
  const load = useCallback(() => {
    if (!session) return;
    podiumopsGet('getOfferTemplates', {}, session).then(setData).catch(() => setData(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  if (data === false) return <div style={{ color: 'var(--text-3)' }}>Offer templates are managed by the salary allow-list and Podium admins.</div>;
  if (!data) return <Spinner />;
  const versions = (data.templates || []).filter(t => t.template_key === key);
  const current = versions.find(t => t.is_current) || versions[0] || null;

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {OFFER_TEMPLATE_KEYS.map(t => (
          <button key={t.id} onClick={() => setKey(t.id)} style={{ ...ghostBtn, ...(key === t.id ? { color: 'var(--text-1)', borderColor: 'var(--podium-accent)' } : {}) }}>{t.label}</button>
        ))}
      </div>
      <TemplateEditor key={current?.id || key} templateKey={key} current={current} versions={versions} fields={data.fields || []} session={session} onSaved={load} />
      <div style={{ marginTop: 14 }}><Signatories list={data.signatories || []} employees={data.employees || []} session={session} onSaved={load} /></div>
      <div style={{ marginTop: 14 }}>
        <Card title="Statutory rule sets">
          <div style={{ ...muted, marginBottom: 8 }}>An offer uses the set in force on its start date. New sets ship as migrations.</div>
          {(data.rule_sets || []).map(r => (
            <div key={r.code} style={{ borderTop: '1px solid var(--border)', padding: '8px 0', fontSize: 13 }}>
              <b>{r.code}</b> <span style={muted}>{r.effective_from} → {r.effective_to || 'open'}</span>
              {r.notes && <div style={muted}>{r.notes}</div>}
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

function TemplateEditor({ templateKey, current, versions, fields, session, onSaved }) {
  const { showToast } = useToast();
  const [f, setF] = useState(() => ({
    title: current?.title || '', body: current?.body || '', entity_name: current?.entity_name || '',
    entity_address: (current?.entity_address || []).join('\n'), footer_note: current?.footer_note || '', notes: '',
  }));
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const body = () => ({ template_key: templateKey, ...f, entity_address: f.entity_address.split('\n').map(s => s.trim()).filter(Boolean) });

  async function doPreview() {
    try { const r = await podiumopsPost('previewOfferTemplate', body(), session); setPreview(r.text); }
    catch (e) { setPreview(null); showToast(hiringError(e), 'error'); }
  }
  async function save() {
    if (!window.confirm('Save as a new version? New offers will use it; existing offers keep theirs.')) return;
    setBusy(true);
    try { const t = await podiumopsPost('saveOfferTemplate', body(), session); showToast(`Saved as v${t?.version}`, 'success'); onSaved(); }
    catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 1fr) minmax(360px, 1fr)', gap: 14, alignItems: 'start' }}>
      <Card title={current ? `Current: v${current.version}` : 'No version yet'}>
        {current?.notes && <Note>{current.notes}</Note>}
        <F label="Title"><input style={inp} value={f.title} onChange={e => set('title', e.target.value)} /></F>
        <F label="Body — {{field}} merges; {{#field}}…{{/field}} shows only when the field is set; blank line = new paragraph">
          <textarea rows={22} style={{ ...inp, resize: 'vertical', fontSize: 12 }} value={f.body} onChange={e => set('body', e.target.value)} />
        </F>
        <Row>
          <F label="Entity"><input style={inp} value={f.entity_name} onChange={e => set('entity_name', e.target.value)} /></F>
        </Row>
        <F label="Letterhead address (one line each)"><textarea rows={3} style={{ ...inp, resize: 'vertical' }} value={f.entity_address} onChange={e => set('entity_address', e.target.value)} /></F>
        <F label="Annexure footer note"><input style={inp} value={f.footer_note} onChange={e => set('footer_note', e.target.value)} /></F>
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
          <div style={{ ...muted, marginTop: 6 }}>has_variable, has_department, has_probation, has_joining_bonus, has_retention_bonus are for sections.</div>
        </div>
        {versions.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ ...muted, marginBottom: 4 }}>Versions</div>
            {versions.map(v => <div key={v.id} style={{ fontSize: 12 }}>v{v.version}{v.is_current ? ' (current)' : ''} · {fmtDateTime(v.created_at)}{v.notes ? ` · ${v.notes}` : ''}</div>)}
          </div>
        )}
      </Card>
      <div style={{ display: 'grid', gap: 14 }}>
        {preview ? <><LetterPreview view={preview} />{preview.annexure && <AnnexureTable annexure={preview.annexure} />}</>
          : <div style={muted}>Preview renders the template with sample data (no real person or salary).</div>}
      </div>
    </div>
  );
}

function Signatories({ list, employees, session, onSaved }) {
  const { showToast } = useToast();
  const [rows, setRows] = useState(list);
  const [add, setAdd] = useState(null);
  useEffect(() => { setRows(list); }, [list]);
  const upd = (id, k, v) => setRows(rs => rs.map(r => (r.id === id ? { ...r, [k]: v } : r)));

  async function save(r) {
    try { await podiumopsPost('saveSignatory', { id: r.id, display_name: r.display_name, phone: r.phone, title: r.title, active: r.active }, session); showToast('Saved', 'success'); onSaved(); }
    catch (e) { showToast(hiringError(e), 'error'); }
  }
  async function create() {
    try { await podiumopsPost('saveSignatory', { ...add, active: true }, session); showToast('Signatory added', 'success'); setAdd(null); onSaved(); }
    catch (e) { showToast(hiringError(e), 'error'); }
  }
  return (
    <Card title="Authorised signatories" right={!add && <button style={ghostBtn} onClick={() => setAdd({ employee_id: '', display_name: '', phone: '', title: '' })}><Plus size={13} /> Add</button>}>
      <div style={{ ...muted, marginBottom: 8 }}>The signatory's phone prints on the letterhead; leave it blank to omit it.</div>
      {rows.map(r => (
        <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', borderTop: '1px solid var(--border)', padding: '6px 0', flexWrap: 'wrap' }}>
          <input style={{ ...inp, flex: '1 1 180px' }} value={r.display_name || ''} onChange={e => upd(r.id, 'display_name', e.target.value)} />
          <input style={{ ...inp, flex: '1 1 150px' }} placeholder="Phone" value={r.phone || ''} onChange={e => upd(r.id, 'phone', e.target.value)} />
          <input style={{ ...inp, flex: '1 1 150px' }} placeholder="Title" value={r.title || ''} onChange={e => upd(r.id, 'title', e.target.value)} />
          <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={!!r.active} onChange={e => upd(r.id, 'active', e.target.checked)} /> Active</label>
          <button style={ghostBtn} onClick={() => save(r)}><Save size={13} /></button>
        </div>
      ))}
      {add && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 6 }}>
          <Row>
            <F label="Employee">
              <Combobox value={add.employee_id} inputStyle={comboInp} placeholder="Search…"
                onChange={v => { const e = employees.find(x => x.id === v); setAdd(s => ({ ...s, employee_id: v, display_name: s.display_name || e?.full_name || '', title: s.title || e?.job_title || '' })); }}
                options={employees.map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code }))} />
            </F>
            <F label="Name on the letter *"><input style={inp} value={add.display_name} onChange={e => setAdd(s => ({ ...s, display_name: e.target.value }))} /></F>
          </Row>
          <Row>
            <F label="Phone"><input style={inp} value={add.phone} onChange={e => setAdd(s => ({ ...s, phone: e.target.value }))} /></F>
            <F label="Title"><input style={inp} value={add.title} onChange={e => setAdd(s => ({ ...s, title: e.target.value }))} /></F>
          </Row>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button style={ghostBtn} onClick={() => setAdd(null)}>Cancel</button>
            <button style={primaryBtn} onClick={create}>Add signatory</button>
          </div>
        </div>
      )}
    </Card>
  );
}
