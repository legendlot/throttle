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
    wa: { meta_name: '', category: 'MARKETING', waba_id: '', header: '', header_format: '', header_media_url: '', body: '', footer: '', buttons: [], mapping: [] },
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
  // M13 — a template with html_body but no design_json opens the visual editor onto a
  // BLANK scaffold (EmailEditor.js only loads initialDesign when it's non-empty; otherwise
  // it sets BLANK_MJML). Saving from there calls edRef.export() on that blank canvas,
  // silently replacing the real hand-authored HTML with the empty scaffold. There was no
  // existing guard against this — startEdit/save never checked for design_json presence.
  const [htmlOnly, setHtmlOnly] = useState(false);

  // test-send state
  const [testTo, setTestTo] = useState('');
  const [testVals, setTestVals] = useState('{}');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [needsAllow, setNeedsAllow] = useState(false);   // recipient not on the test allowlist → offer add-and-resend
  const [submitting, setSubmitting] = useState(false);
  // WS review follow-up: submitToMeta must never submit content the saved row doesn't have
  // yet (an uploaded-but-unsaved image lints clean in memory but ships headerless from the
  // DB row Meta actually reads). Set on any WA editor change, cleared on load/save.
  const [waDirty, setWaDirty] = useState(false);

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

  function startNew() { setT(emptyTemplate()); setHtmlOnly(false); setWaDirty(false); resetTest(); setEditorKey('new-' + Date.now()); setView('form'); }
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
        waba_id: c.waba_id || '',
        header: c.header || '', header_format: c.header_format || '', header_media_url: c.header_media_url || '',
        body: c.body || '', footer: c.footer || '',
        buttons: Array.isArray(c.buttons) ? c.buttons : [],
        mapping: Array.isArray(c.mapping) ? c.mapping : [],
      },
      approval_status: r.approval_status || null,
      provider_template_id: r.provider_template_id || null,
    });
    // M13 — flag templates authored outside the visual editor (html_body present, no
    // design_json) so save() can warn before the canvas's blank scaffold overwrites it.
    setHtmlOnly((r.channel || 'email') === 'email' && !!(c.html_body || c.html) && !c.design_json);
    setWaDirty(false);
    resetTest();
    setEditorKey('t-' + r.id);
    setView('form');
  }
  function resetTest() { setTestTo(''); setTestVals('{}'); setTestResult(null); setNeedsAllow(false); }
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
        // ALWAYS sent (never conditionally omitted): the worker's saveTemplate merge only
        // preserves these on a null/undefined omission (review C4/M8's protection against the
        // UI silently dropping a value it doesn't know about). Now that the editor owns them,
        // an explicit clear — switching Image back to None/Text — must reach the server as a
        // real non-null value ('TEXT' / '') or the merge would quietly restore the old image.
        header_format: w.header_format || 'TEXT',
        header_media_url: w.header_media_url || '',
        mapping: (w.mapping || []).filter((m) => m.token),
      };
      if (w.header) content.header = w.header;
      if (w.footer) content.footer = w.footer;
      if ((w.buttons || []).length) content.buttons = w.buttons;
      if (w.waba_id) content.waba_id = w.waba_id;
      // `header_handle` is otherwise worker-owned (minted only by waUploadHeaderMedia /
      // waSubmitTemplate) and never authored here — but WaEditor blanks it locally whenever the
      // header image is replaced or removed, because the OLD handle points at Meta's copy of the
      // asset that no longer matches `header_media_url`. That blank has to reach the server (an
      // omitted key would be merge-preserved back to the stale handle), so forward it ONLY when
      // WaEditor actually touched it this session — never a fabricated non-empty value.
      if ('header_handle' in w) content.header_handle = w.header_handle || '';
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
    // M13 — this template's real content is html_body with no design_json; the mounted
    // visual editor is sitting on the BLANK scaffold (EmailEditor.js never loaded the real
    // HTML into it), so buildPayload()'s export() below would silently replace the
    // hand-authored HTML with that empty canvas. Confirm before it's irreversible.
    if (t.channel === 'email' && htmlOnly && edRef.current) {
      if (!window.confirm(
        'This template was authored outside the visual editor. Saving will REPLACE its HTML with the canvas content. Continue?'
      )) return;
    }
    const payload = buildPayload();
    // WS review follow-up: without this, a live/APPROVED template could be saved with
    // header_format:'IMAGE' + an empty header_media_url (e.g. Image -> Text -> Image, which
    // clears the url but keeps the format) — every subsequent SEND of that row then hard-fails
    // render.js's media_header_missing_url guard. Targeted rule only (not the full
    // validateWaTemplate lint, which also demands meta_name/body/waba_id/mapping — those stay
    // save-time-optional so an in-progress draft can still be saved; Submit still runs the
    // full lint). Mirrors the email branch's M14 unsubscribe-guard pattern: a single narrow
    // check blocked with a toast, not a full pre-submit validation gate.
    if (t.channel === 'whatsapp') {
      const hc = payload.content;
      if (String(hc.header_format || '').toUpperCase() === 'IMAGE' && !hc.header_media_url) {
        showToast('Upload the header image before saving (or switch the header type away from Image).', 'error');
        return;
      }
    }
    if (t.channel === 'email') {
      if (t.purpose === 'marketing' && !(payload.content.html_body || '').includes('{unsubscribe_url}')) {
        showToast('Marketing emails must include {unsubscribe_url} — add the merge tag before saving.', 'error');
        return;
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
      // Whatever happened (user confirmed the overwrite, or this was never html-only), the
      // saved content now carries the editor's real design_json — no longer html-only.
      if (t.channel === 'email') setHtmlOnly(false);
      setWaDirty(false);
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
    setTesting(true); setTestResult(null); setNeedsAllow(false);
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
    } catch (e) {
      // Not on the test allowlist → offer the one-click fix instead of a dead end.
      if (e.message === 'test_sends_are_internal_only') setNeedsAllow(true);
      else showToast(e.message || 'Test send failed', 'error');
    }
    finally { setTesting(false); }
  }

  // Add the entered recipient to the builder-managed TEST allowlist, then resend.
  // Exact address only — the worker rejects @domain patterns (super-admin territory).
  async function allowAndResend() {
    setTesting(true);
    try {
      await workerFetch('addTestAllowlist', { entry: testTo.trim() }, session);
      setNeedsAllow(false);
      showToast('Added to test allowlist', 'success');
    } catch (e) { showToast(e.message || 'Could not add to allowlist', 'error'); setTesting(false); return; }
    setTesting(false);
    await sendTest();
  }

  // Submitting sends the template into Meta's review queue under LOT's WhatsApp Business
  // Account — an outward-facing, non-instant action, so it always confirms first.
  async function submitToMeta() {
    if (!t.id) { showToast('Save the template first', 'error'); return; }
    // WS review follow-up: waSubmitTemplate reads the SAVED row, not the in-memory editor
    // state this lint below inspects — an uploaded-but-unsaved image (or any other unsaved
    // edit) would lint clean here yet submit whatever is actually in the DB (e.g. headerless,
    // or the previous version). Block on any unsaved change instead of letting the two diverge.
    if (waDirty) { showToast('Save the template before submitting to Meta', 'error'); return; }
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
          <WaEditor wa={t.wa} setWa={(w) => { set('wa', w); setWaDirty(true); }} variables={t.variables} disabled={saving || !canEdit}
          locked={!!t.provider_template_id} session={session} />
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
            {needsAllow && (
              <div style={{ margin: '8px 0', fontSize: 13, padding: '10px 12px', border: '1px solid var(--line, #ddd)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <b>{testTo.trim()}</b> isn’t on the test allowlist — test sends only reach approved test
                addresses. Add it (exact address, test sends only) and resend?
                <Btn kind="primary" onClick={allowAndResend} disabled={testing} style={{ marginLeft: 12 }}>
                  {testing ? 'Working…' : 'Add & resend'}
                </Btn>
              </div>
            )}
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
