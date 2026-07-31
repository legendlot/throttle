'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Pencil, Send, Trash2, Upload, RefreshCw, Mail, MessageCircle, Copy, Images, Archive, ArchiveRestore } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { UtmFields, UtmMarketingNote } from '@/components/utm.js';
import { fmtDateTime } from '@/components/format.js';
import { insertMergeTag, findUndeclaredTokens } from '@/components/email-editor/mergeTags.js';
import WaEditor, { waPreviewProps } from '@/components/wa-editor/WaEditor.js';
import WaPreview from '@/components/wa-editor/WaPreview.js';
import { validateWaTemplate, WA_WABAS, normalizeMetaName } from '@/components/wa-editor/waTemplate.js';
import { useNewParam } from '@/lib/useNewParam.js';
import ImageLibrary from '@/components/ImageLibrary.js';

const EmailEditor = dynamic(() => import('@/components/email-editor/EmailEditor.js'),
  { ssr: false, loading: () => <div style={{ padding: 24 }}><Spinner /></div> });

const CHANNELS = ['email', 'whatsapp']; // sms lands in Phase 2
// List channel filter — SMS chip is present ahead of Phase 2 so the mental model is stable.
const CHAN_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'SMS' },
];
const PURPOSES = ['marketing', 'transactional', 'utility'];
const STATUSES = ['draft', 'active', 'archived'];
const VAR_SOURCES = ['profile', 'event', 'constant', 'recipient', 'system'];

const STATUS_TONE = { active: 'green', draft: 'gray', archived: 'red' };

// ── Duplicate helpers ────────────────────────────────────────────────────────
// A copy must not collide with the original on either name, so both get a suffix that
// is bumped until it is genuinely free in the CURRENT library. Meta template names are
// the load-bearing one: they are unique per WhatsApp Business Account, and a submit that
// reuses one fails at Meta with a name-taken error long after the author has moved on.
function uniqueName(base, taken) {
  const stripped = String(base || 'Untitled').replace(/\s*\(copy(?: \d+)?\)\s*$/i, '');
  let candidate = `${stripped} (copy)`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stripped} (copy ${n})`;
  return candidate;
}
function uniqueMetaName(base, taken) {
  const stripped = normalizeMetaName(String(base || '').replace(/_copy(?:_\d+)?$/i, ''));
  if (!stripped) return '';           // nothing to derive from — let the author name it
  let candidate = `${stripped}_copy`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${stripped}_copy_${n}`;
  return candidate;
}
const APPROVAL_TONE = { APPROVED: 'green', PENDING: 'yellow', REJECTED: 'red', PAUSED: 'yellow', DISABLED: 'red' };

// Canonical snapshot of the editable state, for "has anything actually changed?".
//
// WHATSAPP ONLY — deliberately. An email template's real content lives inside the GrapesJS
// canvas and is only materialised by export() at save time, so it is NOT in React state:
// diffing `t` for email would report "no changes" while the author was actively editing and
// would DISABLE THEIR SAVE. Email instead relies on the worker-side no-change guard, which is
// authoritative for both channels. Key order is normalised because the form rebuilds these
// objects on every render.
function stableJson(v) {
  const norm = (x) => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      return Object.keys(x).sort().reduce((o, k) => { o[k] = norm(x[k]); return o; }, {});
    }
    return x;
  };
  return JSON.stringify(norm(v ?? null));
}
function waSnapshot(t) {
  if (!t || t.channel !== 'whatsapp') return null;
  return stableJson({
    channel: t.channel, name: t.name, purpose: t.purpose,
    language: t.language, status: t.status,
    variables: t.variables || [], wa: t.wa || {},
  });
}

function emptyTemplate() {
  return {
    id: null, channel: 'email', name: '', purpose: 'marketing', language: 'en',
    status: 'draft', subject: '', html_body: '', text_body: '', design_json: null, variables: [],
    wa: { meta_name: '', category: 'MARKETING', waba_id: '', header: '', header_format: '', header_media_url: '', body: '', footer: '', buttons: [], mapping: [] },
    approval_status: null, provider_template_id: null, utm: null,
  };
}

export default function TemplatesPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [chanFilter, setChanFilter] = useState('all');
  // Combo filter (S241). The library outgrew a channel-only chip row the moment the
  // transactional set landed — 36 templates across 5 WhatsApp Business Accounts, where the
  // load-bearing question is usually "which account is this pinned to?" (a template on the
  // wrong WABA fails every send with a misleading Meta permissions error). Every facet is
  // ANDed and derived from data already on the row — no extra fetch.
  const [q, setQ] = useState('');
  const [purposeFilter, setPurposeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [approvalFilter, setApprovalFilter] = useState('all');
  const [wabaFilter, setWabaFilter] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
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
  // WhatsApp test sends: the country code is a SELECTOR (default +91), not something typed
  // into the number field — every miskeyed "+91" prefix was a failed test. A pasted full
  // international number (leading +) is respected as-is; otherwise cc + digits compose.
  const [testCc, setTestCc] = useState('+91');
  const composeTestTo = () => {
    const raw = testTo.trim();
    if (!raw) return '';
    if (t.channel !== 'whatsapp') return raw;
    if (raw.startsWith('+')) return raw.replace(/[^\d+]/g, '');
    return testCc + raw.replace(/\D/g, '').replace(/^0+/, '');
  };
  const [testVals, setTestVals] = useState('{}');
  const [testing, setTesting] = useState(false);
  // Version history (S241). Loaded on demand — the archive only matters when someone is
  // actually asking "what changed?", and it is one row per save, not per page view.
  // Pre-send shape check (S241) — local vs what Meta actually holds. Auto-runs when a
  // submitted WA template is opened, because all three of the 2026-07-28 incidents were only
  // discoverable by pressing Send on live traffic.
  const [shape, setShape] = useState(null);
  const [shapeLoading, setShapeLoading] = useState(false);
  const [versions, setVersions] = useState(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [needsAllow, setNeedsAllow] = useState(false);   // recipient not on the test allowlist → offer add-and-resend
  const [submitting, setSubmitting] = useState(false);
  // WS review follow-up: submitToMeta must never submit content the saved row doesn't have
  // yet (an uploaded-but-unsaved image lints clean in memory but ships headerless from the
  // DB row Meta actually reads). Set on any WA editor change, cleared on load/save.
  const [waDirty, setWaDirty] = useState(false);
  // Baseline of the last loaded/saved state, for the unchanged-template guards below.
  const [baseline, setBaseline] = useState(null);
  // Email-side image library (the WhatsApp side owns its own, inside WaEditor).
  const [libOpen, setLibOpen] = useState(false);

  const canEdit = !perms || perms.template_manage;
  const canTest = !perms || perms.campaign_build;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await garageFetch('getTemplates', { with_usage: 'true' }, session);
      setRows(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load templates', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  // WABA picker options come from LIVE sender_identities, not a hardcoded list — a migrated
  // number changes WABA and a stale hardcoded id had every UI-authored template pinning to a
  // WABA with no sender (S232). Static WA_WABAS remains only as the fetch-failure fallback.
  const [wabas, setWabas] = useState([]);
  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const s = await garageFetch('getSenderIdentities', {}, session);
        const list = (Array.isArray(s) ? s : [])
          .filter((x) => x.channel === 'whatsapp' && x.status === 'active' && x.metadata?.waba_id)
          .map((x) => ({ id: x.metadata.waba_id, label: x.metadata.label || x.address, hint: x.address }));
        if (list.length) setWabas(list);
      } catch { /* static fallback list stays in effect */ }
    })();
  }, [session]);

  // Accounts present in the library, labelled from the live sender list (falls back to the
  // raw id so a template pinned to a WABA with no sender is still selectable — that state is
  // itself a bug worth being able to filter for).
  const wabaLabel = (id) => (wabas.find((w) => w.id === id)?.hint)
    || (WA_WABAS.find((w) => w.id === id)?.label) || id;
  const wabaOptions = [...new Set(rows.map((r) => r.content?.waba_id).filter(Boolean))]
    .map((id) => ({ id, label: wabaLabel(id) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  function startNew() { const n = emptyTemplate(); setT(n); setBaseline(waSnapshot(n)); setHtmlOnly(false); setWaDirty(false); resetTest(); resetVersions(); resetShape(); setEditorKey('new-' + Date.now()); setView('form'); }
  // ⌘K "New template" — cross-screen ?new=1 + same-screen relay:new event.
  useNewParam(canEdit, startNew);
  function startEdit(r) {
    const c = r.content || {};
    const loaded = {
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
      // Stored in its OWN column, not inside content — content is rebuilt from form state on
      // every save, which is the stale-tab overwrite hazard the worker's merge guards against.
      utm: (r.utm && typeof r.utm === 'object') ? r.utm : null,
    };
    setT(loaded);
    // M13 — flag templates authored outside the visual editor (html_body present, no
    // design_json) so save() can warn before the canvas's blank scaffold overwrites it.
    setHtmlOnly((r.channel || 'email') === 'email' && !!(c.html_body || c.html) && !c.design_json);
    setWaDirty(false);
    setBaseline(waSnapshot(loaded));
    resetTest();
    resetVersions();
    resetShape();
    setEditorKey('t-' + r.id);
    setView('form');
    // Auto-run for anything already submitted to Meta. Deliberately not gated on canEdit —
    // a viewer looking at a broken live template should see WHY it is broken.
    if ((r.channel || 'email') === 'whatsapp' && r.provider_template_id) runShapeCheck(r.id);
  }

  // DUPLICATE — open an UNSAVED copy of an existing template, so a new one starts from a
  // working base instead of a blank form. Nothing is written until the author presses Save;
  // the original is never touched.
  //
  // What is deliberately NOT carried over, and why each one would be a real defect:
  //  · `id`                   — else Save would PATCH the original out from under itself.
  //  · `provider_template_id` — this is Meta's id for the ORIGINAL. Carrying it would make
  //                             the copy look already-submitted: the shape check would run
  //                             against the original's approved copy, the test-send panel
  //                             would offer to send it, and Submit would edit the original.
  //  · `approval_status`      — a brand-new template has never been reviewed; showing
  //                             "APPROVED" on unsubmitted content is the most dangerous
  //                             possible lie on this screen.
  //  · `wa.header_handle`     — Meta's handle for the original's uploaded asset. The image
  //                             URL is reusable, that handle is not; it is re-minted at
  //                             submit (same reasoning as WaEditor's replace-image path).
  //  · `status`               — forced to draft. A copy is by definition not live yet.
  // The WABA pin IS carried: a copy almost always belongs on the same account, and it stays
  // editable here because the copy has no provider_template_id to lock it.
  function startDuplicate(r) {
    const c = r.content || {};
    const isWa = (r.channel || 'email') === 'whatsapp';
    const takenNames = new Set(rows.map((x) => String(x.name || '').toLowerCase()));
    const takenMeta = new Set(rows.map((x) => x.content?.meta_name).filter(Boolean));
    const copy = {
      id: null,
      channel: r.channel || 'email',
      name: uniqueName(r.name, takenNames),
      purpose: r.purpose || 'marketing',
      language: r.language || 'en',
      status: 'draft',
      subject: c.subject || '', html_body: c.html_body || c.html || '', text_body: c.text_body || c.text || '',
      design_json: c.design_json || null,
      variables: Array.isArray(r.variables) ? JSON.parse(JSON.stringify(r.variables)) : [],
      wa: {
        meta_name: isWa ? uniqueMetaName(c.meta_name, takenMeta) : '',
        category: c.category || 'MARKETING',
        waba_id: c.waba_id || '',
        header: c.header || '', header_format: c.header_format || '',
        header_media_url: c.header_media_url || '',
        body: c.body || '', footer: c.footer || '',
        buttons: Array.isArray(c.buttons) ? JSON.parse(JSON.stringify(c.buttons)) : [],
        mapping: Array.isArray(c.mapping) ? JSON.parse(JSON.stringify(c.mapping)) : [],
      },
      approval_status: null,
      provider_template_id: null,
      utm: (r.utm && typeof r.utm === 'object') ? JSON.parse(JSON.stringify(r.utm)) : null,
    };
    setT(copy);
    setHtmlOnly(!isWa && !!(c.html_body || c.html) && !c.design_json);
    setWaDirty(false);
    // baseline null → the Save button starts ENABLED. A duplicate is unsaved by definition,
    // and waSnapshot(copy) would have matched it exactly and greyed Save out on arrival.
    setBaseline(null);
    resetTest();
    resetVersions();
    resetShape();
    setEditorKey('dup-' + r.id + '-' + Date.now());
    setView('form');
    showToast(`Copy of “${r.name}” — nothing is saved until you press Save`, 'success');
  }

  function resetTest() { setTestTo(''); setTestVals('{}'); setTestResult(null); setNeedsAllow(false); }
  function resetVersions() { setVersions(null); setVersionsOpen(false); setVersionsLoading(false); }
  function resetShape() { setShape(null); setShapeLoading(false); }
  const runShapeCheck = useCallback(async (templateId) => {
    if (!templateId || !session) return;
    setShapeLoading(true);
    try {
      const r = await garageFetch('checkTemplateShape', { template_id: templateId }, session);
      setShape(r || null);
    } catch { setShape(null); }      // never block authoring on a Graph hiccup
    finally { setShapeLoading(false); }
  }, [session]);
  async function loadVersions(templateId) {
    setVersionsOpen((o) => !o);
    if (versions || !templateId) return;
    setVersionsLoading(true);
    try {
      const v = await garageFetch('getTemplateVersions', { template_id: templateId }, session);
      setVersions(Array.isArray(v) ? v : []);
    } catch (e) {
      showToast(e.message || 'Could not load version history', 'error');
      setVersions([]);
    } finally { setVersionsLoading(false); }
  }
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
      utm: t.utm || null,
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
      // Re-baseline so the Save button greys out again until something actually changes.
      setBaseline(waSnapshot(t));
      // The worker no-ops a save that changes nothing (it used to publish a version anyway),
      // so don't claim "new version" when none was published.
      showToast(!t.id ? 'Template created'
        : saved?.noop ? 'No changes to save'
        : 'Template saved (new version)', 'success');
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
        channel: t.channel, to: composeTestTo(),
        // purpose drives sender ROUTING (purpose-match within the template's WABA) — without
        // it a marketing template can't route out the marketing number. Gates stay bypassed
        // via isTest server-side.
        purpose: t.purpose,
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
      await workerFetch('addTestAllowlist', { entry: composeTestTo() }, session);
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
      + `review queue. Review typically takes minutes to hours and can't be undone from here.\n\n`
      + `WARNING: while the review runs, EVERY send of this template fails (#132001). Measured, `
      + `not theoretical — it took Order Placed down for 18 minutes on 2026-07-28. If a LIVE `
      + `journey uses this template, pause it or cover it elsewhere first.`)) return;
    setSubmitting(true);
    try {
      const r = await workerFetch('waSubmitTemplate', { templateId: t.id }, session);
      const d = r?.data || {};
      set('approval_status', d.status || 'PENDING');
      set('provider_template_id', d.provider_template_id || null);
      showToast(`Submitted — Meta says ${d.status || 'PENDING'}`, 'success');
      load();
      runShapeCheck(t.id);   // refresh the banner — it now reports the mid-review send block
    } catch (e) { showToast(e.message || 'Submit failed', 'error'); }
    finally { setSubmitting(false); }
  }

  // ── Retire a template ──────────────────────────────────────────────────────
  // Archive is the primary action and is LOCAL ONLY — Meta keeps its approved copy, so an
  // archived template can be brought back with no re-approval. Hard delete is reserved for
  // templates that never reached Meta at all; see the worker for why we never issue a Meta
  // DELETE (it removes every language version, name-reuse is undocumented, and it produces
  // the #132001 "template name does not exist" failure already present in this account).
  async function toggleArchive(r) {
    const u = r.usage || {};
    const archiving = r.status !== 'archived';
    if (archiving && u.journeys_live > 0) {
      const names = Array.isArray(u.live_names) ? u.live_names.join(', ') : '';
      if (!window.confirm(
        `"${r.name}" is used by ${u.journeys_live} LIVE journey${u.journeys_live === 1 ? '' : 's'}`
        + (names ? ` (${names})` : '') + `.\n\n`
        + `Archiving hides it from this library and from the journey and campaign pickers, `
        + `so nobody can newly select it. It does NOT stop those live journeys sending it, `
        + `and it does NOT touch Meta — blocking the send would break a customer-facing flow `
        + `silently, which is worse.\n\nArchive anyway?`)) return;
    }
    try {
      await workerFetch('setTemplateArchived', { id: r.id, archived: archiving }, session);
      showToast(archiving ? 'Archived' : 'Restored to draft', 'success');
      load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  async function destroy(r) {
    const u = r.usage || {};
    if (r.provider_template_id || r.approval_status) {
      showToast('Meta has seen this template — archive it instead of deleting', 'error');
      return;
    }
    const blockers = [
      u.journeys_other ? `${u.journeys_other} journey(s)` : null,
      u.campaigns ? `${u.campaigns} campaign(s)` : null,
      u.sent ? `${u.sent} sent message(s)` : null,
    ].filter(Boolean);
    if (blockers.length) { showToast(`Still referenced by ${blockers.join(', ')} — archive instead`, 'error'); return; }
    if (!window.confirm(
      `Permanently delete "${r.name}"?\n\n`
      + `It was never submitted to Meta and nothing references it, so this removes it and its `
      + `version history from Relay only. There is no Meta copy to remove.\n\nThis cannot be undone.`)) return;
    try {
      await workerFetch('deleteTemplate', { id: r.id }, session);
      showToast('Template deleted', 'success');
      load();
    } catch (e) {
      const m = String(e.message || '');
      showToast(m === 'on_meta_archive_instead' ? 'Exists on Meta — archive it instead'
        : m.startsWith('in_use:') ? `Still referenced by ${m.slice(7)}`
        : (m || 'Delete failed'), 'error');
    }
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
    const isWa = t.channel === 'whatsapp';
    // Unsaved-change tracking. WhatsApp only — see waSnapshot: an email's content lives in the
    // GrapesJS canvas, not in `t`, so a diff of `t` would report "clean" mid-edit and disable
    // the author's Save. Email keeps Save always enabled and leans on the worker's no-op guard.
    const snap = isWa ? waSnapshot(t) : null;
    const dirty = !isWa || baseline === null || snap !== baseline;
    // Submit reads the SAVED row from the DB, never the editor — so submitting while dirty
    // ships the OLD content to Meta and burns the once-per-24h edit doing it (waDirty already
    // encoded this for the WA editor; this generalises it to any unsaved field).
    const submitBlocked = dirty || waDirty;
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
            {/* Fork the template you are looking at. Gated on t.id — a duplicate of an
                unsaved draft would just be the same unsaved form again. Warns first when
                there are unsaved edits, because the copy is built from the SAVED row
                (`rows`), so anything on screen but not saved would silently not come with it. */}
            {canEdit && t.id && (
              <Btn onClick={() => {
                const src = rows.find((r) => r.id === t.id);
                if (!src) { showToast('Reload the list first', 'error'); return; }
                if ((dirty || waDirty) && !window.confirm(
                  'You have unsaved changes. The copy is made from the last SAVED version, '
                  + 'so those changes will not be carried over. Duplicate anyway?')) return;
                startDuplicate(src);
              }} title="Open an unsaved copy of this template">
                <Copy size={14} /> Duplicate
              </Btn>
            )}
            {t.channel === 'whatsapp' && canEdit && t.id && (
              <>
                <Btn onClick={syncStatus} disabled={submitting}><RefreshCw size={14} /> Sync status</Btn>
                <Btn onClick={submitToMeta} disabled={submitting || submitBlocked}
                  title={submitBlocked
                    ? 'Save your changes first — Submit sends the saved template, not what is on screen.'
                    : 'Send this template to Meta for review'}>
                  <Upload size={14} /> {submitting ? 'Working…' : 'Submit to Meta'}
                </Btn>
              </>
            )}
            {canEdit && (
              <Btn kind="primary" onClick={save} disabled={saving || !dirty}
                title={dirty ? 'Save this template' : 'No changes to save'}>
                <Check size={14} /> {saving ? 'Saving…' : dirty ? 'Save template' : 'Saved'}
              </Btn>
            )}
          </div>
        </div>

        {/* WhatsApp authoring is a split view: form left, preview PINNED right. Editing copy
            while watching the bubble is the whole job of this screen, and the old stacked
            layout meant scrolling away from the preview to reach the field you were editing.
            Email keeps the single column — its GrapesJS editor has its own canvas + preview. */}
        <div className={isWa ? 'tpl-split' : undefined}>
        <div className={isWa ? 'tpl-main' : undefined}>
        {/* PRE-SEND SHAPE CHECK (S241). Three incidents on 2026-07-28 — a stale WABA pin and
            twice an IMAGE header Meta had not approved — were each discoverable only by
            pressing Send on live traffic, and each surfaced as an opaque Meta code that named
            the wrong thing. This says plainly whether the template will send, before anyone
            tries. Refuses to be reassuring: silence only when it genuinely matched. */}
        {t.channel === 'whatsapp' && t.id && t.provider_template_id && (
          shapeLoading ? (
            <div className="tw-note" style={{ marginBottom: 12 }}>Checking against Meta…</div>
          ) : shape && shape.checked && !shape.match ? (
            <div className="tw-note" style={{ marginBottom: 12, borderLeft: '3px solid var(--danger, #dc2626)' }}>
              <b>This template will not send as it stands.</b>
              <span className="dim"> — local differs from the copy Meta holds
                {shape.meta_status ? ` (Meta: ${shape.meta_status})` : ''}.</span>
              <ul style={{ margin: '8px 0 0 16px', padding: 0 }}>
                {(shape.issues || []).map((iss, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>
                    <code style={{ fontSize: 11 }}>{iss.code}</code> — {iss.detail}
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 8 }}>
                <Btn onClick={() => runShapeCheck(t.id)}><RefreshCw size={14} /> Re-check</Btn>
              </div>
            </div>
          ) : shape && shape.checked && shape.match ? (
            <div className="tw-note" style={{ marginBottom: 12, borderLeft: '3px solid var(--ok, #16a34a)' }}>
              <b>Matches Meta.</b>
              <span className="dim"> — approved on the pinned account and the shapes agree, so a
                send will not be rejected for structure.</span>
              <Btn kind="ghost" style={{ marginLeft: 8 }} onClick={() => runShapeCheck(t.id)}>Re-check</Btn>
            </div>
          ) : null
        )}

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

          {t.purpose === 'marketing' && (
            <div style={{ marginTop: 14 }}>
              <UtmFields
                scope="template"
                value={t.utm}
                onChange={(next) => set('utm', next)}
                disabled={saving || !canEdit}
                auto={{ utm_source: 'relay', utm_medium: t.channel, utm_campaign: 'the journey / campaign name', utm_content: t.name || 'the template name' }}
              />
              <UtmMarketingNote />
            </div>
          )}
        </Panel>

        {t.channel === 'whatsapp' ? (
          <WaEditor wa={t.wa} setWa={(w) => { set('wa', w); setWaDirty(true); }} variables={t.variables} disabled={saving || !canEdit}
          locked={!!t.provider_template_id} session={session} wabas={wabas} />
        ) : (
        <Panel title="Content" pad
          action={t.channel === 'email' && canEdit ? (
            <span style={{ display: 'flex', gap: 6 }}>
              {/* Bulk-upload ahead of authoring. GrapesJS's own asset panel can only be
                  reached by double-clicking an image already on the canvas, which means
                  you cannot load a batch of images BEFORE you start laying the email out —
                  the "one by one during template creation" complaint. Anything picked here
                  is pushed into the same asset manager, so both routes stay in sync. */}
              <Btn onClick={() => setLibOpen(true)}><Images size={14} /> Image library</Btn>
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
          {libOpen && (
            <ImageLibrary session={session} multi onClose={() => setLibOpen(false)}
              onPick={() => {}}
              onPickMany={(urls) => {
                // Push into GrapesJS's asset manager rather than dropping images onto the
                // canvas: where an image belongs is a layout decision, and silently
                // appending blocks to someone's email would be the wrong kind of helpful.
                const ed = edRef.current && edRef.current.getEditor();
                if (!ed) { showToast('Editor still loading — try again in a moment', 'error'); return; }
                ed.AssetManager.add(urls.map((u) => ({ type: 'image', src: u })));
                showToast(`${urls.length} image${urls.length === 1 ? '' : 's'} ready — double-click an image block to place them`, 'success');
              }} />
          )}
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

        {/* Version history (S241). Saves used to bump a counter and overwrite the row, while
            every sent message recorded the version it used — so "what exactly did this
            customer receive?" had no answer and a bad edit could not be read back. One
            immutable row per save now, newest first. Versions predating 2026-07-28 were
            overwritten in place and are genuinely gone; they are not reconstructed here. */}
        {t.id && (
          <Panel title="Version history"
            action={<Btn onClick={() => loadVersions(t.id)}>{versionsOpen ? 'Hide' : 'Show'}</Btn>}>
            {!versionsOpen ? null : versionsLoading ? (
              <div style={{ padding: 18, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : !versions || versions.length === 0 ? (
              <div style={{ padding: 18, color: 'var(--text-4)', fontSize: 12.5 }}>
                No archived versions yet. The next save records one.
              </div>
            ) : (
              <table className="dt">
                <thead><tr><th>Ver</th><th>Status</th><th>Meta</th><th>Account</th><th>Saved</th><th>By</th></tr></thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.id}>
                      <td className="mono">v{v.version}</td>
                      <td><Badge label={v.status} tone={STATUS_TONE[v.status] || 'gray'} /></td>
                      <td>{v.approval_status
                        ? <Badge label={v.approval_status} tone={APPROVAL_TONE[v.approval_status] || 'gray'} />
                        : <span className="dim">—</span>}</td>
                      <td className="mono dim" style={{ fontSize: 11.5 }}>
                        {v.content?.waba_id ? wabaLabel(v.content.waba_id) : '—'}</td>
                      <td className="mono dim">{fmtDateTime(v.created_at)}</td>
                      <td className="dim" style={{ fontSize: 12 }}>{v.created_by || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        )}

        {/* The blocker for WhatsApp is APPROVAL, not the channel. An un-approved template
            genuinely cannot be sent (Meta only ships templates it has reviewed) — but an
            APPROVED one can, and forcing that through a throwaway campaign just to see it on a
            handset is exactly the friction that stops anyone checking 18 templates. */}
        {/* The two panels must stay mutually exclusive, so this one now excludes anything Meta has
            ever approved — otherwise a template with an edit in review would show BOTH the
            "you cannot test yet" note and the working test-send panel. */}
        {canTest && t.channel === 'whatsapp' && !t.provider_template_id && (
          <Panel title="Send a test" pad>
            <div className="tw-note" style={{ marginTop: 0 }}>
              WhatsApp templates can only be sent once Meta has <b>approved</b> them, so there is no
              draft test-send here. Save → Submit to Meta → Sync status until <code>APPROVED</code> —
              the test send appears here automatically once it is.
            </div>
          </Panel>
        )}

        {/* Gate on "Meta has EVER approved this" (`provider_template_id` is set), not on the
            CURRENT approval_status. Submitting an edit flips that status to PENDING, so gating on
            APPROVED meant our own submit disarmed our own diagnostic — and a previously-approved
            template with an edit in review is the single most important state to be able to test.
            Meta keeps serving the last approved version meanwhile, so the send is valid. */}
        {canTest && (t.channel !== 'whatsapp' || !!t.provider_template_id) && (
          <Panel title="Send a test" pad>
            <div className="tw-note" style={{ marginTop: 0, marginBottom: 12 }}>
              {t.channel === 'whatsapp'
                ? <>Sends the <b>approved</b> template as Meta holds it — if an edit is in review,
                  that means the previously approved version, not your unsaved draft.
                  The recipient must be on the
                  test-mode allow list, and the sending number must sit on the <b>same WABA</b> this
                  template was approved on — templates are WABA-scoped, so a sender on another WABA
                  will be rejected by Meta as unknown.</>
                : <>Sends the current (unsaved) draft as a transactional message.</>}
              {' '}Test values fill any <code>{' {token} '}</code> — they are applied as constants,
              recipient <b>and the event context</b>, so <b>event-sourced tokens DO resolve here</b>:
              give each one a value, e.g. <code>{'{"cart_link_suffix":"47394784149556:1"}'}</code>.
              A token with no fallback and no test value fails the send with
              <code> unresolved_variables:&lt;token&gt;</code> — that is the gap, not a limitation.
              Profile tokens still come from the profile (or their fallback).
            </div>
            <div className="form-grid">
              <div className="ff"><div className="kv-k">Test recipient</div>
                {t.channel === 'whatsapp' ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <select className="f-inp mono" value={testCc} onChange={(e) => setTestCc(e.target.value)}
                      disabled={testing} style={{ width: 96, flex: '0 0 auto' }} aria-label="Country code">
                      {['+91', '+1', '+44', '+971', '+65'].map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <input className="f-inp mono" value={testTo} onChange={(e) => setTestTo(e.target.value)}
                      placeholder="7019103926" disabled={testing} style={{ flex: 1 }} />
                  </div>
                ) : (
                  <input className="f-inp mono" value={testTo} onChange={(e) => setTestTo(e.target.value)}
                    placeholder="you@legendoftoys.com" disabled={testing} />
                )}
              </div>
              <div className="ff"><div className="kv-k">Test values (JSON)</div>
                <input className="f-inp mono" value={testVals} onChange={(e) => setTestVals(e.target.value)} placeholder='{"first":"Afshaan"}' disabled={testing} />
              </div>
            </div>
            {needsAllow && (
              <div style={{ margin: '8px 0', fontSize: 13, padding: '10px 12px', border: '1px solid var(--line, #ddd)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <b>{composeTestTo()}</b> isn’t on the test allowlist — test sends only reach approved test
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
        {isWa && (
          <aside className="tpl-side">
            <Panel title="Preview" pad>
              <WaPreview {...waPreviewProps(t.wa, t.variables)} senderLabel="Legend of Toys" />
            </Panel>
          </aside>
        )}
        </div>
      </div>
    );
  }

  const needle = q.trim().toLowerCase();
  const archivedCount = rows.filter((r) => r.status === 'archived').length;
  const filteredRows = rows.filter((r) => {
    // Archived templates are retired: hidden unless you ask for them, or explicitly filter
    // to Archived via the status dropdown. Before S252 `archived` was in the enum but no
    // reader honoured it, so archiving did nothing at all.
    if (r.status === 'archived' && !showArchived && statusFilter !== 'archived') return false;
    if (chanFilter !== 'all' && (r.channel || 'email') !== chanFilter) return false;
    if (purposeFilter !== 'all' && (r.purpose || '') !== purposeFilter) return false;
    if (statusFilter !== 'all' && (r.status || '') !== statusFilter) return false;
    if (wabaFilter !== 'all' && (r.content?.waba_id || '') !== wabaFilter) return false;
    // Approval is a WhatsApp-only concept (email has no Meta review), so "Not approved"
    // scopes to WhatsApp rather than sweeping every email template in as a false positive.
    if (approvalFilter === 'approved' && r.approval_status !== 'APPROVED') return false;
    if (approvalFilter === 'not_approved'
      && !(r.channel === 'whatsapp' && r.approval_status !== 'APPROVED')) return false;
    // Name search also covers the Meta template name — that is the identifier that appears
    // in logs, in comms.messages and on Meta's side, so it is often what you actually have.
    if (needle && !`${r.name || ''} ${r.content?.meta_name || ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  const filtersOn = chanFilter !== 'all' || purposeFilter !== 'all' || statusFilter !== 'all'
    || approvalFilter !== 'all' || wabaFilter !== 'all' || !!needle || showArchived;
  const clearFilters = () => {
    setQ(''); setChanFilter('all'); setPurposeFilter('all');
    setStatusFilter('all'); setApprovalFilter('all'); setWabaFilter('all');
    setShowArchived(false);
  };

  return (
    <div className="pg">
      <PageHead title="Templates" sub="Channel-shaped message templates with merge variables. Editing an active template publishes a new version."
        actions={canEdit ? <Btn kind="primary" onClick={startNew}><Plus size={14} /> New template</Btn> : null} />
      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : rows.length === 0
          ? <Panel><EmptyState icon="file-text" title="No templates yet" hint="Create your first email template to start building campaigns." /></Panel>
          : (
            <Panel title="Templates" count={filteredRows.length}
              action={
                <span style={{ display: 'flex', gap: 4 }}>
                  {CHAN_FILTERS.map((f) => (
                    <Btn key={f.key} kind={chanFilter === f.key ? 'primary' : 'ghost'}
                      onClick={() => setChanFilter(f.key)}>{f.label}</Btn>
                  ))}
                </span>
              }>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
                padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
                <input className="f-inp" value={q} onChange={(e) => setQ(e.target.value)}
                  placeholder="Search name or Meta name…"
                  style={{ flex: '1 1 220px', minWidth: 180, maxWidth: 340 }} />
                <select className="f-inp" value={purposeFilter} onChange={(e) => setPurposeFilter(e.target.value)}
                  style={{ width: 'auto', minWidth: 130 }}>
                  <option value="all">Any purpose</option>
                  {PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <select className="f-inp" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
                  style={{ width: 'auto', minWidth: 120 }}>
                  <option value="all">Any status</option>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <select className="f-inp" value={approvalFilter} onChange={(e) => setApprovalFilter(e.target.value)}
                  style={{ width: 'auto', minWidth: 150 }}>
                  <option value="all">Any Meta state</option>
                  <option value="approved">Approved</option>
                  <option value="not_approved">Not approved (WA)</option>
                </select>
                {wabaOptions.length > 0 && (
                  <select className="f-inp" value={wabaFilter} onChange={(e) => setWabaFilter(e.target.value)}
                    style={{ width: 'auto', minWidth: 170 }}>
                    <option value="all">Any account</option>
                    {wabaOptions.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                  </select>
                )}
                {archivedCount > 0 && (
                  <Btn kind={showArchived ? 'primary' : 'ghost'} onClick={() => setShowArchived((v) => !v)}
                    title="Archived templates are hidden from this list and from the journey and campaign pickers">
                    {showArchived ? 'Showing archived' : `Archived · ${archivedCount}`}
                  </Btn>
                )}
                {filtersOn && (
                  <Btn kind="ghost" onClick={clearFilters}>
                    Clear · {filteredRows.length}/{rows.length}
                  </Btn>
                )}
              </div>
              {filteredRows.length === 0 ? (
                <EmptyState icon="file-text" title="No templates match"
                  hint="Nothing in the library fits every filter. Clear one to widen the search." />
              ) : (
              <table className="dt">
                <thead><tr><th>Name</th><th>Channel</th><th>Purpose</th><th>Account</th><th>Status</th><th>Meta</th><th>Ver</th><th>Updated</th><th></th></tr></thead>
                <tbody>
                  {filteredRows.map((r) => (
                    <tr key={r.id} className="row-click" onClick={() => startEdit(r)}>
                      <td style={{ fontWeight: 600 }}>{r.name}</td>
                      {/* Channel glyph + label (§7.6) — WA green, email neutral. */}
                      <td>
                        <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5,
                          color: r.channel === 'whatsapp' ? 'var(--wa, #25D366)'
                            : r.channel === 'email' ? 'var(--em, #a78bfa)' : 'var(--t2)' }}>
                          {r.channel === 'whatsapp' ? <MessageCircle size={14} /> : <Mail size={14} />}
                          {r.channel === 'whatsapp' ? 'WhatsApp' : (r.channel === 'email' ? 'Email' : r.channel)}
                        </span>
                      </td>
                      <td className="dim" style={{ fontSize: 12.5 }}>{r.purpose}</td>
                      {/* Which WhatsApp Business Account this template is pinned to. Sends are
                          WABA-scoped, so a template on the wrong account fails every time with
                          an opaque Meta permissions error — worth seeing at a glance (S241). */}
                      <td className="mono dim" style={{ fontSize: 11.5 }}>
                        {r.channel === 'whatsapp'
                          ? (r.content?.waba_id ? wabaLabel(r.content.waba_id)
                            : <span style={{ color: 'var(--warn, #f59e0b)' }}>unpinned</span>)
                          : '—'}
                      </td>
                      <td><Badge label={r.status} tone={STATUS_TONE[r.status] || 'gray'} /></td>
                      <td>{r.channel === 'whatsapp'
                        ? (r.approval_status
                          ? <Badge label={r.approval_status} tone={APPROVAL_TONE[r.approval_status] || 'gray'} />
                          : <span className="dim" style={{ fontSize: 12 }}>not submitted</span>)
                        : <span className="dim">—</span>}</td>
                      <td className="mono dim">v{r.version}</td>
                      <td className="mono dim">{fmtDateTime(r.updated_at)}</td>
                      <td>
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <Btn onClick={(e) => { e.stopPropagation(); startEdit(r); }}><Pencil size={14} /> {canEdit ? 'Edit' : 'View'}</Btn>
                          {canEdit && (
                            <Btn onClick={(e) => { e.stopPropagation(); startDuplicate(r); }}
                              title="Open an unsaved copy of this template as the starting point for a new one">
                              <Copy size={14} /> Duplicate
                            </Btn>
                          )}
                          {canEdit && (
                            <Btn onClick={(e) => { e.stopPropagation(); toggleArchive(r); }}
                              title={r.status === 'archived'
                                ? 'Restore to draft — it returns to the library and the pickers'
                                : 'Archive — hides it here and in the journey/campaign pickers. Meta keeps its approved copy, so this is reversible.'}>
                              {r.status === 'archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                            </Btn>
                          )}
                          {/* Hard delete exists only for templates that never reached Meta.
                              Anything with a provider_template_id is archive-only — see the
                              worker for why Relay never issues a Meta DELETE. */}
                          {/* Either signal of Meta contact means archive-only, not just
                              provider_template_id: one live template carries
                              approval_status=APPROVED with a NULL id (Meta has seen it, we
                              lost the id), and deleting that would orphan it on Meta. */}
                          {canEdit && !r.provider_template_id && !r.approval_status && (
                            <Btn onClick={(e) => { e.stopPropagation(); destroy(r); }}
                              disabled={!!(r.usage && (r.usage.journeys_other || r.usage.campaigns || r.usage.sent))}
                              title={r.usage && (r.usage.journeys_other || r.usage.campaigns || r.usage.sent)
                                ? 'Referenced by a journey, campaign or sent message — archive it instead'
                                : 'Delete permanently (never submitted to Meta, nothing references it)'}>
                              <Trash2 size={14} />
                            </Btn>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              )}
            </Panel>
          )}
    </div>
  );
}
