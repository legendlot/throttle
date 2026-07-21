'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Pencil, Send, Trash2, Upload, RefreshCw } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDate } from '@/components/format.js';
import { insertMergeTag, findUndeclaredTokens } from '@/components/email-editor/mergeTags.js';
import WaEditor from '@/components/wa-editor/WaEditor.js';
import { validateWaTemplate } from '@/components/wa-editor/waTemplate.js';

const EmailEditor = dynamic(() => import('@/components/email-editor/EmailEditor.js'),
  { ssr: false, loading: () => <div style={{ padding: 24 }}><Spinner /></div> });

const CHANNELS = ['email', 'whatsapp']; // sms lands in Phase 2
const PURPOSES = ['marketing', 'transactional', 'utility'];
const STATUSES = ['draft', 'active', 'archived'];
const VAR_SOURCES = ['profile', 'event', 'constant', 'recipient', 'system'];

const STATUS_TONE = { active: 'green', draft: 'gray', archived: 'red' };
const APPROVAL_TONE = { APPROVED: 'green', PENDING: 'yellow', REJECTED: 'red', PAUSED: 'yellow', DISABLED: 'red' };

function emptyTemplate() {
  return {
    id: null, channel: 'email', name: '', purpose: 'marketing', language: 'en',
    status: 'draft', subject: '', html_body: '', text_body: '', design_json: null, variables: [],
    wa: { meta_name: '', category: 'MARKETING', header: '', body: '', footer: '', buttons: [], mapping: [] },
    approval_status: null, provider_template_id: null,
  };
}

export default function TemplatesPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [t, setT] = useState(emptyTemplate());
  const [saving, setSaving] = useState(false);
  const edRef = useRef(null);
  const [editorKey, setEditorKey] = useState('new');

  // test-send state
  const [testTo, setTestTo] = useState('');
  const [testVals, setTestVals] = useState('{}');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const canEdit = !perms || perms.template_manage;
  const canTest = !perms || perms.campaign_build;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await garageFetch('getTemplates', {}, session);
      setRows(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load templates', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  function startNew() { setT(emptyTemplate()); resetTest(); setEditorKey('new-' + Date.now()); setView('form'); }
  function startEdit(r) {
    const c = r.content || {};
    setT({
      id: r.id, channel: r.channel || 'email', name: r.name || '', purpose: r.purpose || 'marketing',
      language: r.language || 'en', status: r.status || 'draft',
      subject: c.subject || '', html_body: c.html_body || c.html || '', text_body: c.text_body || c.text || '',
      design_json: c.design_json || null,
      variables: Array.isArray(r.variables) ? r.variables : [],
      wa: {
        meta_name: c.meta_name || '', category: c.category || 'MARKETING',
        header: c.header || '', body: c.body || '', footer: c.footer || '',
        buttons: Array.isArray(c.buttons) ? c.buttons : [],
        mapping: Array.isArray(c.mapping) ? c.mapping : [],
      },
      approval_status: r.approval_status || null,
      provider_template_id: r.provider_template_id || null,
    });
    resetTest();
    setEditorKey('t-' + r.id);
    setView('form');
  }
  function resetTest() { setTestTo(''); setTestVals('{}'); setTestResult(null); }
  function set(k, v) { setT((p) => ({ ...p, [k]: v })); }

  function addVar() { setT((p) => ({ ...p, variables: [...p.variables, { token: '', source: 'profile', field: '', fallback: '' }] })); }
  function setVar(i, k, v) { setT((p) => ({ ...p, variables: p.variables.map((row, j) => j === i ? { ...row, [k]: v } : row) })); }
  function removeVar(i) { setT((p) => ({ ...p, variables: p.variables.filter((_, j) => j !== i) })); }

  function buildPayload() {
    const variables = t.variables
      .filter((v) => v.token && v.token.trim())
      .map((v) => {
        const out = { token: v.token.trim(), source: v.source };
        if (v.field && v.field.trim()) out.field = v.field.trim();
        if (v.fallback !== '' && v.fallback != null) out.fallback = v.fallback;
        if (v.source === 'constant' && v.value != null && v.value !== '') out.value = v.value;
        return out;
      });
    let content;
    if (t.channel === 'whatsapp') {
      const w = t.wa || {};
      // Shape consumed by render.js renderWhatsapp + wa-templates.js buildComponents.
      content = {
        meta_name: w.meta_name || '', language: t.language || 'en', category: w.category || 'MARKETING',
        body: w.body || '',
        mapping: (w.mapping || []).filter((m) => m.token),
      };
      if (w.header) content.header = w.header;
      if (w.footer) content.footer = w.footer;
      if ((w.buttons || []).length) content.buttons = w.buttons;
    } else if (edRef.current) {
      const ex = edRef.current.export();
      content = { subject: t.subject, html_body: ex.html, text_body: ex.text, design_json: ex.design };
    } else {
      content = { subject: t.subject, html_body: t.html_body, text_body: t.text_body, design_json: t.design_json || null };
    }
    return {
      channel: t.channel, name: t.name.trim(), purpose: t.purpose, language: t.language || 'en',
      status: t.status, content, variables,
    };
  }

  async function save() {
    if (!t.name.trim()) { showToast('Name required', 'error'); return; }
    if (t.channel === 'email' && !edRef.current) { showToast('Editor still loading — try again in a moment', 'error'); return; }
    const payload = buildPayload();
    if (t.channel === 'email') {
      if (t.purpose === 'marketing' && !(payload.content.html_body || '').includes('{unsubscribe_url}')) {
        showToast('Marketing emails should include {unsubscribe_url} in the footer', 'error');
      }
      const stray = findUndeclaredTokens(
        [payload.content.subject, payload.content.html_body, payload.content.text_body],
        payload.variables.map((v) => v.token));
      if (stray.length && !window.confirm(
        `These look like merge tags but aren't declared as variables:\n\n`
        + stray.map((s) => `  {${s}}`).join('\n')
        + `\n\nThey will be sent as literal text, not filled in. Save anyway?`)) return;
    }
    setSaving(true);
    try {
      if (t.id) payload.id = t.id;
      const r = await workerFetch('saveTemplate', payload, session);
      const saved = r?.data;
      set('design_json', payload.content.design_json || null);
      showToast(t.id ? 'Template saved (new version)' : 'Template created', 'success');
      if (saved?.id && !t.id) set('id', saved.id);
      load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  }

  async function sendTest() {
    if (!testTo.trim()) { showToast('Test recipient email required', 'error'); return; }
    let vals = {};
    try { vals = testVals.trim() ? JSON.parse(testVals) : {}; }
    catch { showToast('Test values must be valid JSON', 'error'); return; }
    setTesting(true); setTestResult(null);
    try {
      // Send the in-memory template so it works before/without saving. Test values are
      // passed as BOTH constants and recipient overrides so any matching var resolves.
      const payload = buildPayload();
      const r = await workerFetch('sendTest', {
        channel: t.channel, to: testTo.trim(),
        template: { content: payload.content, variables: payload.variables },
        constants: vals, recipient: vals,
      }, session);
      const res = r?.data || {};
      setTestResult(res);
      if (res.status === 'sent') showToast('Test sent', 'success');
      else showToast(`Test ${res.status}: ${res.reason || ''}`, res.status === 'sent' ? 'success' : 'error');
    } catch (e) { showToast(e.message || 'Test send failed', 'error'); }
    finally { setTesting(false); }
  }

  // Submitting sends the template into Meta's review queue under LOT's WhatsApp Business
  // Account — an outward-facing, non-instant action, so it always confirms first.
  async function submitToMeta() {
    if (!t.id) { showToast('Save the template first', 'error'); return; }
    const errs = validateWaTemplate(buildPayload().content, t.variables.map((v) => v.token));
    if (errs.length) { showToast(`Fix ${errs.length} issue${errs.length === 1 ? '' : 's'} before submitting`, 'error'); return; }
    if (!window.confirm(
      `Submit "${t.wa.meta_name}" to Meta for approval?\n\n`
      + `This creates a real template on LOT's WhatsApp Business Account and enters Meta's `
      + `review queue. Review typically takes minutes to hours and can't be undone from here.`)) return;
    setSubmitting(true);
    try {
      const r = await workerFetch('waSubmitTemplate', { templateId: t.id }, session);
      const d = r?.data || {};
      set('approval_status', d.status || 'PENDING');
      set('provider_template_id', d.provider_template_id || null);
      showToast(`Submitted — Meta says ${d.status || 'PENDING'}`, 'success');
      load();
    } catch (e) { showToast(e.message || 'Submit failed', 'error'); }
    finally { setSubmitting(false); }
  }

  async function syncStatus() {
    if (!t.id) return;
    setSubmitting(true);
    try {
      const r = await workerFetch('waSyncTemplateStatus', { templateId: t.id }, session);
      const s = r?.data?.synced?.[0];
      if (s?.status) { set('approval_status', s.status); showToast(`Meta status: ${s.status}`, 'success'); }
      else showToast('No status from Meta yet', 'error');
      load();
    } catch (e) { showToast(e.message || 'Sync failed', 'error'); }
    finally { setSubmitting(false); }
  }

  if (perms && !perms.relay_view) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Relay access required.</div>;

  if (view === 'form') {
    return (
      <div className="pg">
        <div className="po-head">
          <div className="po-head-l">
            <Btn onClick={() => setView('list')}><ArrowLeft size={14} /> Back to templates</Btn>
            <span className="po-head-no" style={{ fontSize: 18 }}>{t.id ? (t.name || 'Template') : 'New Template'}</span>
            {t.id && <Badge label={`v${rows.find((r) => r.id === t.id)?.version || 1}`} tone="gray" />}
            {t.channel === 'whatsapp' && t.approval_status
              && <Badge label={`Meta: ${t.approval_status}`} tone={APPROVAL_TONE[t.approval_status] || 'gray'} />}
          </div>
          <div className="po-head-r">
            {t.channel === 'whatsapp' && canEdit && t.id && (
              <>
                <Btn onClick={syncStatus} disabled={submitting}><RefreshCw size={14} /> Sync status</Btn>
                <Btn onClick={submitToMeta} disabled={submitting}><Upload size={14} /> {submitting ? 'Working…' : 'Submit to Meta'}</Btn>
              </>
            )}
            {canEdit && <Btn kind="primary" onClick={save} disabled={saving}><Check size={14} /> {saving ? 'Saving…' : 'Save template'}</Btn>}
          </div>
        </div>

        <Panel title="Details" pad>
          <div className="form-grid">
            <div className="ff"><div className="kv-k">Name</div>
              <input className="f-inp" value={t.name} onChange={(e) => set('name', e.target.value)} placeholder="Win-back · 30 days" disabled={saving || !canEdit} />
            </div>
            <div className="ff"><div className="kv-k">Channel</div>
              <select className="f-inp" value={t.channel} onChange={(e) => set('channel', e.target.value)} disabled={saving || !canEdit}>
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="ff"><div className="kv-k">Purpose</div>
              <select className="f-inp" value={t.purpose} onChange={(e) => set('purpose', e.target.value)} disabled={saving || !canEdit}>
                {PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="ff"><div className="kv-k">Language</div>
              <input className="f-inp" value={t.language} onChange={(e) => set('language', e.target.value)} placeholder="en" disabled={saving || !canEdit} />
            </div>
            <div className="ff"><div className="kv-k">Status</div>
              <select className="f-inp" value={t.status} onChange={(e) => set('status', e.target.value)} disabled={saving || !canEdit}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
        </Panel>

        {t.channel === 'whatsapp' ? (
          <WaEditor wa={t.wa} setWa={(w) => set('wa', w)} variables={t.variables} disabled={saving || !canEdit} />
        ) : (
        <Panel title="Content" pad
          action={t.channel === 'email' && canEdit ? (
            <span style={{ display: 'flex', gap: 6 }}>
              <Btn onClick={() => edRef.current && edRef.current.setDevice('Desktop')}>Desktop</Btn>
              <Btn onClick={() => edRef.current && edRef.current.setDevice('Mobile portrait')}>Mobile</Btn>
            </span>
          ) : null}>
          <div className="ff" style={{ marginBottom: 14 }}>
            <div className="kv-k">Subject</div>
            <input className="f-inp" value={t.subject} onChange={(e) => set('subject', e.target.value)}
              placeholder="We miss you, {first} — 10% inside" disabled={saving || !canEdit} />
          </div>
          {t.channel === 'email' ? (
            canEdit ? (
              <>
                {t.variables.some((v) => v.token) && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                    <span className="dim" style={{ fontSize: 12, alignSelf: 'center' }}>Merge tags:</span>
                    {t.variables.filter((v) => v.token).map((v) => (
                      <button key={v.token} type="button" className="chip"
                        onClick={async () => {
                          const res = await insertMergeTag(edRef.current && edRef.current.getEditor(), v.token);
                          showToast(res === 'inserted' ? `Inserted {${v.token}}` : res === 'copied' ? `Copied {${v.token}} — paste into a text block` : 'Select a text block first', res === 'noop' ? 'error' : 'success');
                        }}>{`{${v.token}}`}</button>
                    ))}
                  </div>
                )}
                <EmailEditor key={editorKey} onReady={(api) => { edRef.current = api; }} initialDesign={t.design_json} session={session} />
              </>
            ) : (
              <iframe title="Email preview" sandbox="" srcDoc={t.html_body || '<p style="font-family:sans-serif;color:#888;padding:24px">No content</p>'}
                style={{ width: '100%', height: 640, border: '1px solid var(--border,#e5e5e5)', borderRadius: 8, background: '#fff' }} />
            )
          ) : (
            <>
              <div className="ff" style={{ marginBottom: 14 }}><div className="kv-k">HTML body</div>
                <textarea className="f-inp mono" rows={12} value={t.html_body} onChange={(e) => set('html_body', e.target.value)} disabled={saving || !canEdit} />
              </div>
              <div className="ff"><div className="kv-k">Plain-text body</div>
                <textarea className="f-inp mono" rows={5} value={t.text_body} onChange={(e) => set('text_body', e.target.value)} disabled={saving || !canEdit} />
              </div>
            </>
          )}
          <div className="tw-note" style={{ marginTop: 10 }}>
            Insert <code>{'{token}'}</code> merge tags from the chips above (or type them). Marketing sends auto-expose <code>{'{unsubscribe_url}'}</code>.
          </div>
        </Panel>
        )}

        <Panel title="Variables" count={t.variables.length}
          action={canEdit ? <Btn onClick={addVar}><Plus size={14} /> Add variable</Btn> : null}>
          {t.variables.length === 0
            ? <div style={{ padding: 18, color: 'var(--text-4)', fontSize: 12.5 }}>No variables. Add one per <code>{'{token}'}</code> you used above.</div>
            : (
              <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {t.variables.map((v, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.2fr 1.2fr 32px', gap: 8, alignItems: 'center' }}>
                    <input className="f-inp mono" value={v.token} onChange={(e) => setVar(i, 'token', e.target.value)} placeholder="first" disabled={saving || !canEdit} />
                    <select className="f-inp" value={v.source} onChange={(e) => setVar(i, 'source', e.target.value)} disabled={saving || !canEdit}>
                      {VAR_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    {v.source === 'constant'
                      ? <input className="f-inp" value={v.value || ''} onChange={(e) => setVar(i, 'value', e.target.value)} placeholder="constant value" disabled={saving || !canEdit} />
                      : <input className="f-inp mono" value={v.field || ''} onChange={(e) => setVar(i, 'field', e.target.value)} placeholder={`field (default: ${v.token || 'token'})`} disabled={saving || !canEdit} />}
                    <input className="f-inp" value={v.fallback || ''} onChange={(e) => setVar(i, 'fallback', e.target.value)} placeholder="fallback (optional)" disabled={saving || !canEdit} />
                    {canEdit
                      ? <button className="dr-close" onClick={() => removeVar(i)} disabled={saving} title="Remove"><Trash2 size={14} /></button>
                      : <span />}
                  </div>
                ))}
              </div>
            )}
        </Panel>

        {/* The blocker for WhatsApp is APPROVAL, not the channel. An un-approved template
            genuinely cannot be sent (Meta only ships templates it has reviewed) — but an
            APPROVED one can, and forcing that through a throwaway campaign just to see it on a
            handset is exactly the friction that stops anyone checking 18 templates. */}
        {canTest && t.channel === 'whatsapp' && t.approval_status !== 'APPROVED' && (
          <Panel title="Send a test" pad>
            <div className="tw-note" style={{ marginTop: 0 }}>
              WhatsApp templates can only be sent once Meta has <b>approved</b> them, so there is no
              draft test-send here. Save → Submit to Meta → Sync status until <code>APPROVED</code> —
              the test send appears here automatically once it is.
            </div>
          </Panel>
        )}

        {canTest && (t.channel !== 'whatsapp' || t.approval_status === 'APPROVED') && (
          <Panel title="Send a test" pad>
            <div className="tw-note" style={{ marginTop: 0, marginBottom: 12 }}>
              {t.channel === 'whatsapp'
                ? <>Sends the <b>approved</b> template as Meta holds it. The recipient must be on the
                  test-mode allow list, and the sending number must sit on the <b>same WABA</b> this
                  template was approved on — templates are WABA-scoped, so a sender on another WABA
                  will be rejected by Meta as unknown.</>
                : <>Sends the current (unsaved) draft as a transactional message.</>}
              {' '}Test values fill any <code>{' {token} '}</code> (applied as constants + recipient).
              Profile/event tokens won’t resolve in a test.
            </div>
            <div className="form-grid">
              <div className="ff"><div className="kv-k">Test recipient</div>
                <input className="f-inp mono" value={testTo} onChange={(e) => setTestTo(e.target.value)}
                  placeholder={t.channel === 'whatsapp' ? '+917019103926' : 'you@legendoftoys.com'} disabled={testing} />
              </div>
              <div className="ff"><div className="kv-k">Test values (JSON)</div>
                <input className="f-inp mono" value={testVals} onChange={(e) => setTestVals(e.target.value)} placeholder='{"first":"Afshaan"}' disabled={testing} />
              </div>
            </div>
            <div className="form-foot">
              {testResult && (
                <span style={{ marginRight: 'auto', alignSelf: 'center' }}>
                  <Badge label={testResult.status} tone={testResult.status === 'sent' ? 'green' : testResult.status === 'suppressed' ? 'red' : 'yellow'} />
                  {testResult.reason && <span className="dim" style={{ marginLeft: 8, fontSize: 12 }}>{testResult.reason}</span>}
                </span>
              )}
              <Btn kind="primary" onClick={sendTest} disabled={testing}><Send size={14} /> {testing ? 'Sending…' : 'Send test'}</Btn>
            </div>
          </Panel>
        )}
      </div>
    );
  }

  return (
    <div className="pg">
      <PageHead title="Templates" sub="Channel-shaped message templates with merge variables. Editing an active template publishes a new version."
        actions={canEdit ? <Btn kind="primary" onClick={startNew}><Plus size={14} /> New template</Btn> : null} />
      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : rows.length === 0
          ? <Panel><EmptyState icon="file-text" title="No templates yet" hint="Create your first email template to start building campaigns." /></Panel>
          : (
            <Panel title="Templates" count={rows.length}>
              <table className="dt">
                <thead><tr><th>Name</th><th>Channel</th><th>Purpose</th><th>Status</th><th>Meta</th><th>Ver</th><th>Updated</th><th></th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="row-click" onClick={() => startEdit(r)}>
                      <td>{r.name}</td>
                      <td><Badge label={r.channel} tone="blue" /></td>
                      <td className="dim">{r.purpose}</td>
                      <td><Badge label={r.status} tone={STATUS_TONE[r.status] || 'gray'} /></td>
                      <td>{r.channel === 'whatsapp'
                        ? (r.approval_status
                          ? <Badge label={r.approval_status} tone={APPROVAL_TONE[r.approval_status] || 'gray'} />
                          : <span className="dim" style={{ fontSize: 12 }}>not submitted</span>)
                        : <span className="dim">—</span>}</td>
                      <td className="mono dim">v{r.version}</td>
                      <td className="mono dim">{fmtDate(r.updated_at)}</td>
                      <td><Btn onClick={(e) => { e.stopPropagation(); startEdit(r); }}><Pencil size={14} /> {canEdit ? 'Edit' : 'View'}</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
    </div>
  );
}
