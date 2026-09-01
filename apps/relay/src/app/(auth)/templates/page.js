'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Pencil, Send, Trash2, Upload, RefreshCw, Mail, MessageCircle, MessageSquare, Smartphone, Copy, Images, Archive, ArchiveRestore } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState, Stamp } from '@/components/ui.js';
import { UtmFields, UtmMarketingNote } from '@/components/utm.js';
import { insertMergeTag, findUndeclaredTokens } from '@/components/email-editor/mergeTags.js';
import WaEditor, { waPreviewProps } from '@/components/wa-editor/WaEditor.js';
import WaPreview from '@/components/wa-editor/WaPreview.js';
import { validateWaTemplate, WA_WABAS, normalizeMetaName } from '@/components/wa-editor/waTemplate.js';
import { useNewParam } from '@/lib/useNewParam.js';
import { PURPOSES, purposeLabel } from '@/lib/purposes.js';
import ImageLibrary from '@/components/ImageLibrary.js';
import MsgPreview from '@/components/MsgPreview.js';
import { useConfirm, useChoose } from '@/components/confirm.js';

const EmailEditor = dynamic(() => import('@/components/email-editor/EmailEditor.js'),
  { ssr: false, loading: () => <div style={{ padding: 24 }}><Spinner /></div> });

const CHANNELS = ['email', 'sms', 'rcs', 'whatsapp'];
// List channel filter — SMS chip is present ahead of Phase 2 so the mental model is stable.
const CHAN_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'SMS' },
  { key: 'rcs', label: 'RCS' },
];
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

// One approval concept per channel, normalised for the list. WhatsApp is Meta's review
// (UPPERCASE statuses), SMS is the DLT registration mirrored from the vendor catalogue
// (lowercase `approved`, and only real with BOTH ids — a row typed straight into Relay with
// neither can never send, which is exactly what the red chip is for), RCS is the carrier
// hub's verdict on the bound vendor template, synced into content.provider_status. Email has
// no approval concept and returns null.
// "Is this template actually doing anything?" — the question the library could not answer.
// FOUR states, because collapsing to in-use/not-in-use loses the two that matter most:
//   in use    — a LIVE journey or a campaign points at it. Editing it changes what customers get.
//   past use  — nothing live points at it, but it has sent messages or sits in an older
//               journey version. Safe to leave alone; NOT safe to delete, and its history
//               is why. Calling this "not in use" would invite exactly that deletion.
//   unused    — referenced by nothing, ever. The genuinely dormant pile (53 of 101).
//   unknown   — the usage lookup FAILED. Never render this as "unused": absence of evidence
//               arrives looking identical to evidence of absence, and the difference here is
//               whether deleting is safe.
function templateUsage(r) {
  const u = r.usage;
  if (u && u.unavailable) {
    return { label: 'unknown', tone: 'gray',
      detail: 'Could not check where this template is used — treat it as in use until this loads.' };
  }
  const live = Number(u?.journeys_live || 0);
  const camps = Number(u?.campaigns || 0);
  const otherJ = Number(u?.journeys_other || 0);
  const sent = Number(u?.sent || 0);
  const liveNames = Array.isArray(u?.live_names) ? u.live_names.filter(Boolean) : [];
  const campNames = Array.isArray(u?.campaign_names) ? u.campaign_names.filter(Boolean) : [];

  if (live > 0 || camps > 0) {
    const bits = [];
    if (liveNames.length) bits.push(`Live journeys: ${liveNames.join(', ')}`);
    else if (live > 0) bits.push(`${live} live journey${live === 1 ? '' : 's'}`);
    if (campNames.length) {
      bits.push(`Campaigns: ${campNames.map((c) => (c && c.name ? `${c.name}${c.status ? ` (${c.status})` : ''}` : String(c))).join(', ')}`);
    } else if (camps > 0) bits.push(`${camps} campaign${camps === 1 ? '' : 's'}`);
    return { label: 'in use', tone: 'green', detail: bits.join(' · ') };
  }
  if (otherJ > 0 || sent > 0) {
    const bits = [];
    if (sent > 0) bits.push(`${sent.toLocaleString('en-IN')} message${sent === 1 ? '' : 's'} sent`);
    if (otherJ > 0) bits.push(`in ${otherJ} older journey version${otherJ === 1 ? '' : 's'}`);
    // `yellow`, NOT `amber` — TONES has no amber and an unknown key silently falls back to
    // gray, which would render "past use" identically to "unused" and lose the distinction.
    return { label: 'past use', tone: 'yellow',
      detail: `Nothing live uses it now — ${bits.join(', ')}. Keep it: the history is attached.` };
  }
  return { label: 'unused', tone: 'gray',
    detail: 'No live journey, no campaign, nothing ever sent. Safe to archive.' };
}

function templateApproval(r) {
  if (r.channel === 'whatsapp') {
    return r.approval_status
      ? { label: r.approval_status, tone: APPROVAL_TONE[r.approval_status] || 'gray' }
      : { label: 'not submitted', dim: true };
  }
  if (r.channel === 'sms') {
    const hasIds = !!r.provider_template_id && !!String(r.content?.dlt_template_id || '').trim();
    if (!hasIds) return { label: 'not registered', tone: 'red',
      title: 'No DLT/vendor id — this template cannot send. Register the body on the DLT portal, then mirror it to the vendor from the editor.' };
    const s = (r.approval_status || '').toLowerCase();
    if (s === 'approved') return { label: 'DLT: approved', tone: 'green' };
    return { label: s ? `DLT: ${s}` : 'DLT: unknown', tone: 'yellow' };
  }
  if (r.channel === 'rcs') {
    if (!r.provider_template_id) return { label: 'not submitted', dim: true };
    const s = (r.content?.provider_status || '').toLowerCase();
    return { label: `Vendor: ${s || 'unknown'}`,
      tone: s === 'approved' ? 'green' : r.content?.provider_error ? 'red' : 'yellow',
      title: r.content?.provider_error || undefined };
  }
  return null;
}
const isApprovedForSend = (r) => {
  const a = templateApproval(r);
  return !!a && a.tone === 'green';
};

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
    status: 'draft', subject: '', html_body: '', text_body: '', design_json: null, mjml: '', variables: [],
    wa: { meta_name: '', category: 'MARKETING', waba_id: '', header: '', header_format: '', header_media_url: '', body: '', footer: '', buttons: [], mapping: [] },
    sms: { body: '', var_order: [], template_type: '', dlt_template_id: '', dlt_var_count: null, header: '' },
    rcs: { rcs_type: 'text_message', var_params: [], sms_fallback_template_id: '', link_param: '', link_target_base: '', ttl: null, provider_status: '' },
    approval_status: null, provider_template_id: null, utm: null,
  };
}

// ── SMS editor ───────────────────────────────────────────────────────────────
// SMS is neither email nor WhatsApp. TrustSignal sends a DLT template id plus POSITIONAL
// pr1..pr5 params, and the carrier matches the delivered text against the DLT registration —
// so the two things that actually break an SMS are (a) editing the registered copy and (b)
// getting var_order's ORDER wrong, which produces a grammatical message carrying the wrong
// words with nothing erroring anywhere. This editor is built around making both visible.
// RcsEditor (S290) — deliberately a BINDING editor, not a content editor. RCS templates are
// authored + approved on Sigmo (RCS Settings › Templates); what Relay owns is which vendor
// template this row sends, the param slots (csparams index order — positional at the vendor,
// NEVER alphabetical), the mandatory SMS fallback leg, and the optional tracked-link variable.
function RcsEditor({ rcs, setRcs, variables, disabled, providerTemplateId, setProviderTemplateId, smsTemplates,
                     session, templateRowId, onBound }) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const choose = useChoose();
  const [submitting, setSubmitting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const r = rcs || {};
  const up = (k, v) => setRcs({ ...r, [k]: v });
  const d = r.draft || {};
  const upd = (k, v) => setRcs({ ...r, draft: { ...d, [k]: v } });

  // Authoring → vendor submit (S290 part 3). The vendor derives the param slots from the
  // [bracketed] names in order of first appearance; approval is the vi hub's call and lands
  // via Sync. Submit needs the row SAVED first — the vendor id is stamped onto it.
  async function submitToVendor() {
    if (!templateRowId) { showToast('Save the template first — the vendor id is stamped onto the saved row.', 'error'); return; }
    const type = d.type || 'text_message';
    const spec = { name: d.vendor_name || '', type };
    if (type === 'text_message') {
      spec.textMessageContent = d.body || '';
      spec.suggestions = (d.btn_text || '').trim()
        ? [{ suggestionType: 'url_action', displayText: d.btn_text.trim(),
             postback: (d.btn_postback || '').trim(), url: (d.btn_url || '').trim(), application: 'Browser' }]
        : [];
    } else {
      spec.orientation = d.orientation || 'HORIZONTAL';
      spec.standAlone = {
        cardTitle: d.card_title || '', cardDescription: d.body || '', mediaUrl: d.media_url || '',
        suggestions: (d.btn_text || '').trim()
          ? [{ suggestionType: 'url_action', displayText: d.btn_text.trim(),
               postback: (d.btn_postback || '').trim(), url: (d.btn_url || '').trim(), application: 'Browser' }]
          : [],
      };
    }
    setSubmitting(true);
    try {
      const res = await workerFetch('rcsSubmitTemplate', { id: templateRowId, spec }, session);
      const out = res?.data || {};
      showToast(`Submitted — vendor id ${out.provider_template_id}, status ${out.status}`, 'success');
      onBound?.(out.provider_template_id, out.status, out.var_params || []);
    } catch (e) { showToast(e.message || 'Vendor submit failed', 'error'); }
    finally { setSubmitting(false); }
  }
  async function syncStatus() {
    setSyncing(true);
    try {
      const res = await workerFetch('rcsSyncTemplateStatus', {}, session);
      const upd2 = (res?.data?.updated || []).find((x) => x.id === templateRowId);
      const reg = (res?.data?.registry || []).find((x) => x.id === providerTemplateId);
      if (reg) up('provider_status', reg.status);
      showToast(reg ? `Vendor status: ${reg.status}${reg.error ? ' — ' + reg.error : ''}` : 'Synced', upd2?.error || reg?.error ? 'error' : 'success');
    } catch (e) { showToast(e.message || 'Sync failed', 'error'); }
    finally { setSyncing(false); }
  }
  const params = Array.isArray(r.var_params) ? r.var_params : [];
  const declared = (variables || []).map((v) => (v.token || '').trim()).filter(Boolean);
  const undeclared = params.filter((p) => !declared.includes(p));
  const linkParamUnknown = r.link_param && !params.includes(r.link_param);
  const linkVarWithValue = r.link_param
    && (variables || []).some((v) => v.token === r.link_param && v.source === 'constant' && v.value);

  const problems = [];
  if (!String(providerTemplateId || '').trim()) problems.push('No vendor template id — paste the id from Sigmo once the template is approved (RCS Settings › Templates).');
  if (!r.sms_fallback_template_id) problems.push('No SMS fallback template — every RCS send requires one; the send is rejected without it.');
  if (undeclared.length) problems.push(`Params not declared in Variables below: ${undeclared.join(', ')}`);
  if (linkParamUnknown) problems.push(`Tracked link param "${r.link_param}" is not in the param list.`);
  if (linkVarWithValue) problems.push(`The "${r.link_param}" variable carries a stored value — that value wins over the minted link. Use a fallback instead.`);

  return (
    <Panel title="Content · RCS (binding)" pad>
      {!providerTemplateId && (
        <div style={{ marginBottom: 16, padding: '12px 14px', borderRadius: 8, border: '1px solid var(--line, #333)' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Compose &amp; submit</div>
          <div className="dim" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
            Write the message here and submit — it is created at TrustSignal and goes for carrier
            approval (text usually clears in about a minute; rich cards take longer). Use
            <code> [square_brackets] </code> for variables; the slots are read from them in order.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 10 }}>
            <div className="ff"><div className="kv-k">Vendor name (≤20, a-z 0-9 _)</div>
              <input className="f-inp mono" value={d.vendor_name || ''} disabled={disabled || submitting}
                onChange={(e) => upd('vendor_name', e.target.value)} placeholder="LOT_Winback_Text" /></div>
            <div className="ff"><div className="kv-k">Kind</div>
              <select className="f-inp" value={d.type || 'text_message'} disabled={disabled || submitting}
                onChange={(e) => upd('type', e.target.value)}>
                <option value="text_message">Text message</option>
                <option value="rich_card">Rich card (image + button)</option>
              </select></div>
            {(d.type === 'rich_card') && (
              <div className="ff"><div className="kv-k">Card title</div>
                <input className="f-inp" value={d.card_title || ''} disabled={disabled || submitting}
                  onChange={(e) => upd('card_title', e.target.value)} /></div>
            )}
          </div>
          {(d.type === 'rich_card') && (
            <div className="ff" style={{ marginBottom: 10 }}><div className="kv-k">Image URL (2:1 horizontal, ≤2MB — upload via Library first)</div>
              <input className="f-inp mono" value={d.media_url || ''} disabled={disabled || submitting}
                onChange={(e) => upd('media_url', e.target.value)} placeholder="https://…/sale.png" /></div>
          )}
          <div className="ff" style={{ marginBottom: 10 }}>
            <div className="kv-k">{d.type === 'rich_card' ? 'Card description' : 'Message text'}</div>
            <textarea className="f-inp" rows={3} value={d.body || ''} disabled={disabled || submitting}
              onChange={(e) => upd('body', e.target.value)}
              placeholder="Hey [name]! The [sale_name] is live. Use code [code]: [link]" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 10 }}>
            <div className="ff"><div className="kv-k">Button text (optional)</div>
              <input className="f-inp" value={d.btn_text || ''} disabled={disabled || submitting}
                onChange={(e) => upd('btn_text', e.target.value)} placeholder="Shop Now" /></div>
            <div className="ff"><div className="kv-k">Button URL</div>
              <input className="f-inp mono" value={d.btn_url || ''} disabled={disabled || submitting}
                onChange={(e) => upd('btn_url', e.target.value)} placeholder="https://lottoys.in/r/sale-rcs" /></div>
            <div className="ff"><div className="kv-k">Button id (postback)</div>
              <input className="f-inp mono" value={d.btn_postback || ''} disabled={disabled || submitting}
                onChange={(e) => upd('btn_postback', e.target.value)} placeholder="SHOP_NOW" /></div>
          </div>
          <div className="dim" style={{ fontSize: 11, marginBottom: 10 }}>
            A button needs all three fields — the vendor rejects a suggestion without an id.
            Unsaved work here is kept with the draft when you Save.
          </div>
          <Btn kind="primary" onClick={submitToVendor} disabled={disabled || submitting}>
            <Send size={14} /> {submitting ? 'Submitting…' : 'Submit to TrustSignal'}
          </Btn>
        </div>
      )}
      {providerTemplateId && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Badge label={`Vendor: ${r.provider_status || 'unknown'}`}
                   tone={(r.provider_status || '') === 'approved' ? 'green'
                     : r.provider_error ? 'red' : 'yellow'} />
            <span className="dim" style={{ fontSize: 12 }}>Approval is the carrier hub&apos;s call — Sync pulls the latest.</span>
            <Btn onClick={syncStatus} disabled={syncing} style={{ marginLeft: 'auto' }}>{syncing ? 'Syncing…' : 'Sync status'}</Btn>
          </div>
          {r.provider_error && (
            <div style={{ fontSize: 12, marginTop: 8, padding: '8px 12px', borderRadius: 8,
                          border: '1px solid rgba(220,80,60,.45)', background: 'rgba(220,80,60,.08)' }}>
              Vendor rejection: {r.provider_error}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: 14 }}>
        <div className="ff">
          <div className="kv-k">Vendor template id</div>
          {/* Read-only once bound — a stray keystroke here would silently rebind the row to a
              template that doesn't exist. Rebinding is deliberate: duplicate the row instead. */}
          <input className="f-inp mono" value={providerTemplateId || ''}
            disabled={disabled || !!providerTemplateId}
            onChange={(e) => setProviderTemplateId(e.target.value.trim())} placeholder="73he0n5x33x" />
        </div>
        <div className="ff">
          <div className="kv-k">Type</div>
          <select className="f-inp" value={r.rcs_type || 'text_message'} disabled={disabled}
            onChange={(e) => up('rcs_type', e.target.value)}>
            <option value="text_message">Text message</option>
            <option value="text_message_with_media">Text with media</option>
            <option value="rich_card">Rich card</option>
            <option value="carousel">Carousel</option>
          </select>
        </div>
        <div className="ff">
          <div className="kv-k">SMS fallback template</div>
          <select className="f-inp" value={r.sms_fallback_template_id || ''} disabled={disabled}
            onChange={(e) => up('sms_fallback_template_id', e.target.value)}>
            <option value="">— required —</option>
            {(smsTemplates || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
            Only DLT-explicit (promotional) SMS templates are listed — the fallback rides the
            promotional route, and the carrier enforces the category match.
          </div>
        </div>
      </div>

      <div className="ff" style={{ marginBottom: 14 }}>
        <div className="kv-k">Variable slots (registered order)</div>
        <input className="f-inp mono" value={params.join(', ')} disabled={disabled}
          onChange={(e) => up('var_params', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))}
          placeholder="name, sale_name, discount, code, link" />
        <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
          Comma-separated, in the order the [bracketed] params appear in the registered template
          — this is positional at the vendor. Declare a Variable below for each, token = param name.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: 12 }}>
        <div className="ff">
          <div className="kv-k">Tracked link param (optional)</div>
          <input className="f-inp mono" value={r.link_param || ''} disabled={disabled}
            onChange={(e) => up('link_param', e.target.value.trim())} placeholder="link" />
        </div>
        <div className="ff">
          <div className="kv-k">Link destination</div>
          <input className="f-inp mono" value={r.link_target_base || ''} disabled={disabled}
            onChange={(e) => up('link_target_base', e.target.value.trim())} placeholder="https://www.legendoftoys.com/sale" />
          <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
            With both set, every send mints its own short link into that variable — clicks
            resolve to the person, and the same link rides the SMS fallback leg.
          </div>
        </div>
      </div>

      {problems.length > 0 && (
        <div style={{ fontSize: 12, lineHeight: 1.6, padding: '10px 12px', borderRadius: 8,
                      border: '1px solid rgba(220,140,40,.45)', background: 'rgba(220,140,40,.08)' }}>
          <strong>Not ready to send</strong>
          <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
            {problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function SmsEditor({ sms, setSms, variables, disabled, providerTemplateId, session, templateRowId, onMirrored }) {
  const { showToast } = useToast();
  const [mirroring, setMirroring] = useState(false);
  const [finding, setFinding] = useState(false);
  const [bindables, setBindables] = useState(null);   // null = not looked up yet, [] = none
  const [binding, setBinding] = useState(null);
  const s = sms || {};
  const up = (k, v) => setSms({ ...s, [k]: v });
  // S290 part 3 — push the vendor mirror for a DLT-registered body straight from here, so
  // nobody retypes it into Sigmo. The DLT-portal registration stays FIRST: this button only
  // arms once the 19-digit id from the portal is in the field.
  const canMirror = !providerTemplateId && /^\d{19}$/.test(String(s.dlt_template_id || ''))
    && !!s.template_type && !!String(s.body || '').trim();
  async function createMirror() {
    if (!templateRowId) { showToast('Save the template first — the vendor id is stamped onto the saved row.', 'error'); return; }
    setMirroring(true);
    try {
      const res = await workerFetch('smsCreateVendorTemplate', { id: templateRowId }, session);
      showToast(`Vendor mirror created — id ${res?.data?.provider_template_id}`, 'success');
      onMirrored?.(res?.data?.provider_template_id);
    } catch (e) { showToast(e.message || 'Mirror create failed', 'error'); }
    finally { setMirroring(false); }
  }
  // S326 — adopt a template authored VENDOR-FIRST in Sigmo. Before this there was no path at all:
  // saveTemplate persists provider_template_id for channel 'rcs' only, so a Sigmo-authored SMS
  // template was invisible here and unadoptable, and the one live case had to be bound by hand.
  // `bindable` (not `unbound`) is listed on purpose — the worker filters to the consent types the
  // send path can actually accept, so we never offer a template that dies at the first send.
  async function findUnbound() {
    setFinding(true);
    try {
      const res = await workerFetch('smsSyncTemplateStatus', {}, session);
      const d = res?.data || {};
      setBindables(d.bindable || []);
      const skipped = (d.unbound || []).length - (d.bindable || []).length;
      showToast(
        `${(d.bindable || []).length} adoptable at TrustSignal`
        + (skipped > 0 ? ` · ${skipped} unbound but not sendable (consent type is not explicit/implicit)` : ''),
        'success');
    } catch (e) { showToast(e.message || 'Lookup failed', 'error'); }
    finally { setFinding(false); }
  }
  async function adopt(vendorId) {
    if (!templateRowId) { showToast('Save the template first — the binding is stamped onto the saved row.', 'error'); return; }
    setBinding(vendorId);
    try {
      const res = await workerFetch('smsBindVendorTemplate',
        { id: templateRowId, provider_template_id: vendorId }, session);
      const d = res?.data || {};
      showToast(d.needs_variable_authoring
        ? `Adopted ${vendorId} — now name its ${d.slots} placeholder${d.slots === 1 ? '' : 's'} in Variable order.`
        : `Adopted ${vendorId}.`, 'success');
      // The bind REWRITES content server-side (registered body, dlt id, consent type, slot count).
      // This form still holds the pre-bind values, and a Save from here would push them straight
      // back over the adoption. Reload rather than patch field-by-field — the same stale-tab
      // hazard saveTemplate's carry-over guards exist for, and a reload cannot get it half-right.
      setTimeout(() => window.location.reload(), 900);
    } catch (e) { showToast(e.message || 'Adopt failed', 'error'); }
    finally { setBinding(null); }
  }
  const order = Array.isArray(s.var_order) ? s.var_order : [];
  const body = s.body || '';

  const declared = (variables || []).map((v) => (v.token || '').trim()).filter(Boolean);
  // ⚠️ ANY {#word#}, not just {#var#} — DLT also issues {#urg#} for a URL slot and one live
  // template uses it (`harry potter`). Matching only {#var#} let a raw URL marker through this
  // check silently. Same fix as render.js dltVarRe / countDltVars (S326).
  const stillRaw = /\{#\w+#\}/.test(body);
  const bodyTokens = [...new Set((body.match(/\{([a-zA-Z0-9_]+)\}/g) || []).map((x) => x.slice(1, -1)))];
  const arityKnown = typeof s.dlt_var_count === 'number';
  const arityBad = arityKnown && order.length !== s.dlt_var_count;
  const tooMany = order.length > 5;
  const undeclared = order.filter((tok) => !declared.includes(tok));
  const notInBody = order.filter((tok) => !bodyTokens.includes(tok));

  // An SMS template that exists ONLY in Relay can never send, and nothing used to say so:
  // adapters/sms.js passes provider_template_id straight to TrustSignal as `template_id`, so a
  // null one is rejected by the vendor, and an unregistered body is rejected by the carrier even
  // if the vendor accepts it. Both were previously invisible until a send failed. (2026-08-16)
  const missingDlt = !String(s.dlt_template_id || '').trim();
  const missingVendor = !String(providerTemplateId || '').trim();
  // Mirrors render.js F6 at authoring time, but WIDER: render.js uses /https?:\/\//i, so a
  // scheme-less "legendoftoys.com/sale" slips past it. A bare domain is still a URL to the
  // carrier's verbatim match. Warn-only here — the send-time rule is deliberately untouched.
  // ⚠️ MIRRORS `URL_RE` in commsops-worker/src/render.js, which is THE AUTHORITY — change both.
  // Until 2026-09-01 (S327) this editor warning was WIDER than the send-time guard, which only
  // matched `https?://`. That divergence was the actual defect: an author saw the warning, left
  // the bare domain in, and the send "passed" anyway — then the carrier rejected it because
  // `isdesturl` had rewritten content that no longer matched the DLT registration. Both now use
  // the same pattern, so a warning here means a refusal there.
  const hasUrl = /https?:\/\/|[a-z0-9-]+\.(com|in|co|net|io|shop)(\/|\s|$)/i.test(body);

  const problems = [];
  if (stillRaw) problems.push('Body still contains {#var#} — replace each with a named {token}, left to right.');
  if (tooMany) problems.push(`${order.length} variables — pr1..pr5 is a hard vendor ceiling.`);
  if (arityBad) problems.push(`Variable order has ${order.length} entries but the DLT template registers ${s.dlt_var_count} placeholder${s.dlt_var_count === 1 ? '' : 's'}.`);
  if (undeclared.length) problems.push(`Not declared in Variables below: ${undeclared.join(', ')}`);
  if (notInBody.length) problems.push(`In the order but not used in the body: ${notInBody.join(', ')}`);
  if (missingDlt) problems.push('No DLT template id — this body is not registered with the carrier, so every send is rejected. Register it on the DLT portal first.');
  if (missingVendor) problems.push('No vendor template — this template does not exist at TrustSignal, so the send is rejected before it reaches the carrier. It arrives via the DLT catalogue pull, not from here.');
  if (hasUrl) problems.push('The body contains a link written directly into the text. A URL must sit inside a {token}, or the delivered text stops matching the DLT registration.');

  return (
    <Panel title="Content · SMS" pad>
      <div className="dim" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
        The body must stay word-for-word what is registered on DLT — the carrier matches delivered
        text against the registration, so rewording it gets the message rejected. Only the
        placeholders change: replace each <code>{'{#var#}'}</code> with a named <code>{'{token}'}</code>.
      </div>
      {/* The three questions this editor kept getting asked, answered where they get asked
          (2026-08-16). SMS is not WhatsApp: nothing is submitted from here, and there is no
          media. Without this the editor looks like a template builder that is missing buttons. */}
      <div className="dim" style={{ fontSize: 12, marginBottom: 14, lineHeight: 1.5,
             padding: '10px 12px', borderRadius: 8, border: '1px solid var(--line, #333)' }}>
        <strong>SMS templates are not authored here.</strong> Each one is registered on the DLT
        portal first, then pulled into Relay by the catalogue sync — what you edit on this page is
        the variable naming, not the message. So there is deliberately{' '}
        <strong>no Submit&nbsp;for&nbsp;approval button</strong> (there is nothing to submit to —
        DLT approval happens on the portal and is not instant) and{' '}
        <strong>no image upload</strong> (SMS is plain text; images need WhatsApp or RCS).
        A template typed straight into this page will have no DLT id and no vendor template, and
        every send on it fails.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 14 }}>
        <div className="ff">
          <div className="kv-k">DLT template id</div>
          <input className="f-inp" value={s.dlt_template_id || ''} disabled={disabled}
            onChange={(e) => up('dlt_template_id', e.target.value)} placeholder="1707176130196189451" />
        </div>
        <div className="ff">
          <div className="kv-k">Consent type</div>
          <select className="f-inp" value={s.template_type || ''} disabled={disabled}
            onChange={(e) => up('template_type', e.target.value)}>
            <option value="">— not set —</option>
            <option value="implicit">implicit (service · utility/transactional)</option>
            <option value="explicit">explicit (promotional · marketing)</option>
          </select>
        </div>
        <div className="ff">
          <div className="kv-k">Sender header</div>
          <input className="f-inp" value={s.header || ''} disabled={disabled}
            onChange={(e) => up('header', e.target.value)} placeholder="LGNDRC" />
        </div>
        <div className="ff">
          <div className="kv-k">DLT placeholders</div>
          <input className="f-inp" value={arityKnown ? String(s.dlt_var_count) : '—'} disabled readOnly />
        </div>
      </div>
      <div className="dim" style={{ fontSize: 11, marginTop: -6, marginBottom: 14 }}>
        Consent type mirrors the DLT registration — it is <strong>not</strong> verified against it.
        The carrier enforces on DLT, so a wrong value here looks correct and still skips
        DND-registered customers.
        {providerTemplateId ? <> Vendor template <code>{providerTemplateId}</code>.</> : null}
      </div>

      <div className="ff" style={{ marginBottom: 14 }}>
        <div className="kv-k">Message body</div>
        <textarea className="f-inp" rows={4} value={body} disabled={disabled}
          onChange={(e) => up('body', e.target.value)}
          placeholder="Hi {first_name}! Your order {order_number} is confirmed." />
        <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>{body.length} characters</div>
      </div>

      <div className="ff" style={{ marginBottom: 10 }}>
        <div className="kv-k">Variable order (positional)</div>
        <input className="f-inp" value={order.join(', ')} disabled={disabled}
          onChange={(e) => up('var_order', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))}
          placeholder="first_name, order_number" />
        <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
          Comma-separated, in the order the placeholders appear in the registered text. This is the
          mapping onto pr1..prN and it is not alphabetical.
        </div>
      </div>

      {order.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {order.map((tok, i) => (
            <span key={`${tok}-${i}`} className="chip" style={{ opacity: declared.includes(tok) ? 1 : 0.55 }}>
              pr{i + 1} → {`{${tok}}`}
            </span>
          ))}
        </div>
      )}

      {!providerTemplateId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Btn kind="primary" onClick={createMirror} disabled={disabled || mirroring || !canMirror}>
            <Send size={14} /> {mirroring ? 'Creating…' : 'Create at TrustSignal'}
          </Btn>
          <span className="dim" style={{ fontSize: 12 }}>
            {canMirror
              ? 'Pushes this body + consent type + DLT id to the vendor — no Sigmo step.'
              : 'Arms once the body, consent type and the 19-digit DLT id (from the portal) are set — register on the DLT portal first.'}
          </span>
        </div>
      )}
      {!providerTemplateId && (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--line, #333)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Btn onClick={findUnbound} disabled={disabled || finding}>
              {finding ? 'Looking…' : 'Find templates in Sigmo'}
            </Btn>
            <span className="dim" style={{ fontSize: 12 }}>
              Already registered on DLT <em>and</em> created in Sigmo? Adopt it here instead of
              retyping — the registered body, consent type, DLT id and placeholder count are
              copied from the vendor.
            </span>
          </div>
          {bindables && bindables.length === 0 && (
            <div className="dim" style={{ fontSize: 12, marginTop: 10 }}>
              Nothing adoptable — every Sigmo template is either already bound here or carries a
              consent type the send path cannot use (only <code>explicit</code> and{' '}
              <code>implicit</code> can send; a <code>promotional</code> one is refused at bind).
            </div>
          )}
          {bindables && bindables.length > 0 && (
            <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
              {bindables.map((b) => (
                <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                       padding: '6px 8px', borderRadius: 6, border: '1px solid var(--line, #333)' }}>
                  <code style={{ fontSize: 12 }}>{b.id}</code>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{b.name}</span>
                  <span className="chip" style={{ fontSize: 11 }}>{b.template_type}</span>
                  <span className="chip" style={{ fontSize: 11 }}>{b.var_count} slot{b.var_count === 1 ? '' : 's'}</span>
                  <span className="dim" style={{ fontSize: 11 }}>{b.status}</span>
                  <Btn kind="primary" onClick={() => adopt(b.id)} disabled={disabled || !!binding}>
                    {binding === b.id ? 'Adopting…' : 'Adopt'}
                  </Btn>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {problems.length > 0 ? (
        <div style={{ fontSize: 12, lineHeight: 1.6, padding: '10px 12px', borderRadius: 8,
                      border: '1px solid rgba(220,140,40,.45)', background: 'rgba(220,140,40,.08)' }}>
          <strong>Not ready to send</strong>
          <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
            {problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      ) : (
        <div className="dim" style={{ fontSize: 12 }}>
          Binding looks consistent. This checks our own wiring only — it is not DLT compliance.
        </div>
      )}
    </Panel>
  );
}

export default function TemplatesPage() {
  // `choose` here is this page's own — the identifier it used to reference belonged to
  // RcsEditor, so the hardened delete path below threw ReferenceError (S322).
  const choose = useChoose();
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
  // MJML warnings from the most recent export, surfaced under the editor (S327). A ref because
  // it is written inside buildPayload (called during save) and must not re-render mid-save; it is
  // copied into state right after, which is what actually paints it.
  const mjmlWarnRef = useRef([]);
  const [mjmlWarnings, setMjmlWarnings] = useState([]);
  const [editorKey, setEditorKey] = useState('new');
  // M13 — a template with html_body but no design_json opens the visual editor onto a
  // BLANK scaffold (EmailEditor.js only loads initialDesign when it's non-empty; otherwise
  // it sets BLANK_MJML). Saving from there calls edRef.export() on that blank canvas,
  // silently replacing the real hand-authored HTML with the empty scaffold. There was no
  // existing guard against this — startEdit/save never checked for design_json presence.
  const [htmlOnly, setHtmlOnly] = useState(false);
  // Set by save() for the duration of one save, read by buildPayload(). A ref, not state,
  // because buildPayload runs synchronously inside the same save() call — a setState would
  // not have flushed yet and the body would be replaced anyway.
  const preserveBodyRef = useRef(false);

  // test-send state
  const [testTo, setTestTo] = useState('');
  // WhatsApp test sends: the country code is a SELECTOR (default +91), not something typed
  // into the number field — every miskeyed "+91" prefix was a failed test. A pasted full
  // international number (leading +) is respected as-is; otherwise cc + digits compose.
  const [testCc, setTestCc] = useState('+91');
  // SMS is phone-based too, and treating it as "not whatsapp ⇒ email" meant a bare 10-digit
  // number was passed through unprefixed. trustsignal-client renderPhoneForSms demands a
  // 13-char +91 E.164 and returns invalid_phone otherwise, so every SMS test send failed on a
  // number typed the obvious way. (2026-08-16)
  const composeTestTo = () => {
    const raw = testTo.trim();
    if (!raw) return '';
    if (t.channel !== 'whatsapp' && t.channel !== 'sms' && t.channel !== 'rcs') return raw;
    if (raw.startsWith('+')) return raw.replace(/[^\d+]/g, '');
    // SMS pins +91 rather than reading testCc: the selector is disabled on SMS, but the state
    // survives switching templates, so a testCc left at +44 by a WhatsApp template would
    // otherwise compose a number the vendor rejects as unsupported_country.
    const cc = t.channel === 'sms' ? '+91' : testCc;
    return cc + raw.replace(/\D/g, '').replace(/^0+/, '');
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
      design_json: c.design_json || null, mjml: c.mjml || '',
      variables: Array.isArray(r.variables) ? r.variables : [],
      wa: {
        meta_name: c.meta_name || '', category: c.category || 'MARKETING',
        waba_id: c.waba_id || '',
        header: c.header || '', header_format: c.header_format || '', header_media_url: c.header_media_url || '',
        body: c.body || '', footer: c.footer || '',
        buttons: Array.isArray(c.buttons) ? c.buttons : [],
        mapping: Array.isArray(c.mapping) ? c.mapping : [],
      },
      // SMS. `body` holds the DLT-registered copy with each positional {#var#} replaced by a
      // named {token}; `var_order` is what maps those names onto pr1..prN and its ORDER is
      // load-bearing. `dlt_var_count` is the placeholder count recorded from the registration
      // by the catalog pull, and is what makes an arity mistake checkable rather than a matter
      // of care. Kept in its own sub-object so buildPayload can rebuild content without the
      // email branch clobbering it.
      sms: {
        body: c.body || '',
        var_order: Array.isArray(c.var_order) ? c.var_order : [],
        template_type: c.template_type || '',
        dlt_template_id: c.dlt_template_id || '',
        dlt_var_count: typeof c.dlt_var_count === 'number' ? c.dlt_var_count : null,
        header: c.header || '',
      },
      // RCS (S290). The row is a BINDING onto a vendor-registered template — var_params in
      // csparams index order, the mandatory SMS fallback reference, and the optional tracked
      // link variable. Own sub-object for the same reason as sms: buildPayload must rebuild
      // content without the email branch clobbering it (PATTERN-252).
      rcs: {
        rcs_type: c.rcs_type || 'text_message',
        var_params: Array.isArray(c.var_params) ? c.var_params : [],
        sms_fallback_template_id: c.sms_fallback_template_id || '',
        link_param: c.link_param || '',
        link_target_base: c.link_target_base || '',
        ttl: typeof c.ttl === 'number' ? c.ttl : null,
        provider_status: c.provider_status || '',
        provider_error: c.provider_error || '',
        draft: (c.draft && typeof c.draft === 'object') ? c.draft : {},
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
    setHtmlOnly((r.channel || 'email') === 'email' && !!(c.html_body || c.html) && !c.design_json && !c.mjml);
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
      design_json: c.design_json || null, mjml: c.mjml || '',
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
      // SMS + RCS sub-objects (S290 hostile review — both were missing, so duplicating either
      // channel silently produced an empty copy while WA carried everything).
      sms: {
        body: c.body || '',
        var_order: Array.isArray(c.var_order) ? [...c.var_order] : [],
        template_type: c.template_type || '',
        // Deliberately NOT carried: dlt_template_id / dlt_var_count. A duplicate is a NEW
        // registration-to-be — carrying the original's DLT id would let it activate while
        // actually sending on the original's registration with different-looking intent.
        dlt_template_id: '', dlt_var_count: null,
        header: c.header || '',
      },
      rcs: {
        rcs_type: c.rcs_type || 'text_message',
        var_params: Array.isArray(c.var_params) ? [...c.var_params] : [],
        sms_fallback_template_id: c.sms_fallback_template_id || '',
        link_param: c.link_param || '',
        link_target_base: c.link_target_base || '',
        ttl: typeof c.ttl === 'number' ? c.ttl : null,
        // Never carried: provider_status/provider_error (this copy was never submitted).
        provider_status: '',
        draft: (c.draft && typeof c.draft === 'object') ? JSON.parse(JSON.stringify(c.draft)) : {},
      },
      approval_status: null,
      provider_template_id: null,
      utm: (r.utm && typeof r.utm === 'object') ? JSON.parse(JSON.stringify(r.utm)) : null,
    };
    setT(copy);
    setHtmlOnly(!isWa && !!(c.html_body || c.html) && !c.design_json && !c.mjml);
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
    } else if (t.channel === 'sms') {
      // Shape consumed by render.js renderSms + adapters/sms.js. Explicit rather than relying
      // on the worker's carry-over merge: that guard exists to survive an editor that does NOT
      // know these keys, and this branch is the editor learning them. Sending them explicitly
      // also means a real clear (emptying var_order) reaches the server instead of being
      // merge-restored to the old value.
      const s = t.sms || {};
      content = {
        body: s.body || '',
        var_order: (s.var_order || []).map((x) => String(x).trim()).filter(Boolean),
        template_type: s.template_type || '',
        dlt_template_id: s.dlt_template_id || '',
        header: s.header || '',
      };
      if (typeof s.dlt_var_count === 'number') content.dlt_var_count = s.dlt_var_count;
      // Once a body has real {token}s and an order, it is no longer the raw catalogue mirror.
      content.needs_variable_authoring = /\{#var#\}/.test(content.body) || content.var_order.length === 0;
    } else if (t.channel === 'rcs') {
      // The rcs branch that stops save() from destroying a binding row (the same PATTERN-252
      // failure the sms branch fixed for SMS: before this, an rcs row fell into the email
      // shape and a save wiped var_params + the fallback reference).
      const r = t.rcs || {};
      content = {
        rcs_type: r.rcs_type || 'text_message',
        var_params: (r.var_params || []).map((x) => String(x).trim()).filter(Boolean),
        sms_fallback_template_id: r.sms_fallback_template_id || '',
        link_param: (r.link_param || '').trim(),
        link_target_base: (r.link_target_base || '').trim(),
        provider_status: r.provider_status || '',
        ...(r.provider_error ? { provider_error: r.provider_error } : {}),
        // Unsubmitted compose work rides with the draft so half-written copy survives a Save.
        ...(r.draft && Object.keys(r.draft).length ? { draft: r.draft } : {}),
      };
      if (typeof r.ttl === 'number' && r.ttl > 0) content.ttl = r.ttl;
    } else if (edRef.current && !preserveBodyRef.current) {
      const ex = edRef.current.export();
      // MJML compiles at validationLevel 'soft', so a broken template saves cleanly and only
      // warns. Capture the warnings here — this is the one moment the compiler has an opinion
      // about what the author just built. Surfaced below the editor; see exportEmail.js.
      mjmlWarnRef.current = Array.isArray(ex.warnings) ? ex.warnings : [];
      content = { subject: t.subject, html_body: ex.html, text_body: ex.text, design_json: ex.design, mjml: ex.mjml || '' };
    } else if (preserveBodyRef.current) {
      // HTML-ONLY TEMPLATE, BODY PRESERVED. The canvas is sitting on the blank scaffold because
      // there is no design_json to load, so exporting it would replace hand-authored HTML with an
      // empty email. Keep the loaded body and let the metadata edit (subject/name/status) through
      // — that is the whole reason someone opens this screen on such a template.
      content = { subject: t.subject, html_body: t.html_body, text_body: t.text_body, design_json: t.design_json || null, mjml: t.mjml || '' };
    } else {
      content = { subject: t.subject, html_body: t.html_body, text_body: t.text_body, design_json: t.design_json || null, mjml: t.mjml || '' };
    }
    return {
      channel: t.channel, name: t.name.trim(), purpose: t.purpose, language: t.language || 'en',
      status: t.status, content, variables,
      utm: t.utm || null,
      // RCS ONLY: the typed vendor-binding id must ride with the save — it lived solely in
      // React state, so binding a row to an existing Sigmo template looked bound (the sync
      // showed VENDOR: APPROVED) and was dropped on Save; the list truthfully read the row
      // as "not submitted" (Pruthvi, #bugs 2026-08-17). The worker writes it for rcs rows
      // only and never clears a stored binding on a blank.
      ...(t.channel === 'rcs' ? { provider_template_id: (t.provider_template_id || '').trim() || null } : {}),
    };
  }

  async function save() {
    if (!t.name.trim()) { showToast('Name required', 'error'); return; }
    // Cleared per attempt so a fixed template stops showing yesterday's warnings.
    mjmlWarnRef.current = [];
    // htmlOnly deliberately does NOT mount the canvas (it shows the real email read-only), so a
    // null edRef is the expected state there, not a still-loading editor — without this exemption
    // an html-only template could never have its subject or status saved at all.
    if (t.channel === 'email' && !htmlOnly && !edRef.current) { showToast('Editor still loading — try again in a moment', 'error'); return; }
    // M13 — this template's real content is html_body with no design_json; the mounted
    // visual editor is sitting on the BLANK scaffold (EmailEditor.js never loaded the real
    // HTML into it), so buildPayload()'s export() below would silently replace the
    // hand-authored HTML with that empty canvas. Confirm before it's irreversible.
    // M13, HARDENED 2026-08-10 after this destroyed a live template. The old guard was a confirm
    // whose OK path was DESTRUCTIVE, so the reflex action — dismiss the dialog and carry on —
    // replaced 22,930 bytes of hand-authored email with a blank canvas. A dialog you have to read
    // correctly to avoid data loss is a speed bump, not a guard.
    // Now the SAFE outcome is the default: the body is preserved and the metadata edit still goes
    // through, so changing a subject line no longer risks the email. Replacing the body is still
    // possible, but it is now the deliberate, explicitly-confirmed branch.
    preserveBodyRef.current = false;
    if (t.channel === 'email' && htmlOnly && edRef.current) {
      // Was OK/Cancel standing in for two real answers, where Cancel silently meant
      // "keep the HTML" — an outcome nobody reads a Cancel button as choosing.
      const pick = await choose({
        tone: 'danger',
        title: 'Replace this email\u2019s HTML?',
        lede: 'This template was authored outside the editor, so the visual canvas is empty.',
        actions: [
          { value: 'keep', label: 'Keep the HTML',
            hint: 'Saves only name, subject and status. The email body is untouched.' },
          { value: 'replace', label: 'Replace it with the canvas', tone: 'danger',
            hint: 'The hand-authored email is lost. Recoverable only from version history.' },
        ],
      });
      if (pick === null) { setSaving(false); return; }
      preserveBodyRef.current = pick === 'keep';
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
    // SMS: same narrow, save-time-only shape as the WA header guard above — block the states
    // that would reach a customer broken, and only once the author has marked the template
    // ACTIVE. A draft stays freely savable mid-authoring, which is the whole point of drafts.
    // renderSms enforces these again at send time; this exists so the failure surfaces here
    // rather than in a send log.
    if (t.channel === 'sms' && t.status === 'active') {
      const c = payload.content;
      const n = (c.var_order || []).length;
      if (/\{#var#\}/.test(c.body || '')) {
        showToast('Body still contains {#var#} — replace each with a named {token} before activating.', 'error'); return;
      }
      if (!c.template_type) { showToast('Set the consent type before activating.', 'error'); return; }
      if (n > 5) { showToast(`${n} variables — pr1..pr5 is a hard vendor ceiling.`, 'error'); return; }
      // An SMS template with no DLT registration and no vendor template can NEVER send — the
      // vendor rejects a null template_id and the carrier rejects unregistered text. Activating
      // one produced a green, sendable-looking template that failed on every send, which is
      // exactly how "Freedom to Play Sale_17Aug" reached active. (2026-08-16)
      if (!String(c.dlt_template_id || '').trim()) {
        showToast('No DLT template id — register the body on the DLT portal before activating, or every send is rejected.', 'error'); return;
      }
      if (!String(t.provider_template_id || '').trim()) {
        showToast('No vendor template — this template does not exist at TrustSignal yet. It arrives via the DLT catalogue pull; it cannot be activated before then.', 'error'); return;
      }
      if (typeof c.dlt_var_count === 'number' && n !== c.dlt_var_count) {
        showToast(`Variable order has ${n} entries but the DLT template registers ${c.dlt_var_count}.`, 'error'); return;
      }
    }
    // Same discipline for RCS (S290): an active binding must reference a real vendor template
    // AND a real SMS fallback — with_fallback is the only send path, so either gap fails every
    // send at the vendor.
    if (t.channel === 'rcs' && t.status === 'active') {
      if (!String(t.provider_template_id || '').trim()) {
        showToast('No vendor template id — RCS templates are authored on Sigmo (RCS Settings › Templates); paste the approved template\u2019s id before activating.', 'error'); return;
      }
      if (!String(payload.content.sms_fallback_template_id || '').trim()) {
        showToast('No SMS fallback template — every RCS send requires one (pick an active, DLT-explicit SMS template).', 'error'); return;
      }
    }
    if (t.channel === 'email') {
      if (t.purpose === 'marketing' && !(payload.content.html_body || '').includes('{unsubscribe_url}')) {
        showToast('Marketing emails must include {unsubscribe_url} — add the merge tag before saving.', 'error');
        return;
      }
      // A literal ${…} (a JS-template placeholder pasted in with handoff content) inside an
      // inline style makes Gmail drop the WHOLE style attribute, and MJML's font-size:0px
      // outer-cell pattern then renders the element at zero size — buttons, captions and the
      // unsubscribe footer silently vanish for Gmail readers while the canvas looks perfect.
      // Cost a live debugging round 2026-08-16 (Freedom to Play Emailer: one ${FONT} in
      // mj-all propagated into 20 compiled styles). {token} single-brace merge tags are fine;
      // "${" specifically is never legitimate authored content.
      if ((payload.content.html_body || '').includes('${') || (payload.content.mjml || '').includes('${')) {
        showToast('The email contains a literal "${…}" placeholder — Gmail hides every element styled with it. Remove it (usually pasted-in ${FONT}) before saving.', 'error');
        return;
      }
      // A CTA still pointing at the BARE HOMEPAGE is almost always the starter scaffold nobody
      // changed — that was the default until 2026-08-16 (Mishica, #bugs 1786189428.760609), and
      // an unchanged "Shop now" drops the reader on the front page with nothing to act on.
      //
      // CONFIRM, not block: a homepage link is legitimate in a brand or newsletter email, so
      // refusing it outright would be wrong. Same soft idiom as the stray-merge-tag check below;
      // the two hard blocks above (missing {unsubscribe_url}, a literal ${…}) are reserved for
      // things that are never correct.
      const bareHome = /href\s*=\s*(["'])https?:\/\/(?:www\.)?legendoftoys\.com\/?\1/i;
      if ((bareHome.test(payload.content.html_body || '') || bareHome.test(payload.content.mjml || ''))
        && !(await confirm({
          tone: 'warn',
          title: 'A link still points at the bare homepage',
          lede: <>Something still targets <span className="mono">legendoftoys.com</span>, which is the starter link.</>,
          note: 'Readers who click a CTA expect the thing it names, not the front page. Point it at the product or collection instead.',
          confirmLabel: 'Save anyway',
          cancelLabel: 'Go back and fix it',
        }))) return;
      const stray = findUndeclaredTokens(
        [payload.content.subject, payload.content.html_body, payload.content.text_body],
        payload.variables.map((v) => v.token));
      if (stray.length && !(await confirm({
        tone: 'warn',
        title: 'Undeclared merge tags',
        lede: 'These look like merge tags but are not declared as variables:',
        points: stray.map((tok) => <span className="mono">{`{${tok}}`}</span>),
        warning: 'They will be sent as literal text, not filled in.',
        confirmLabel: 'Save anyway',
        cancelLabel: 'Go back and declare them',
      }))) return;
    }
    setSaving(true);
    try {
      if (t.id) payload.id = t.id;
      const r = await workerFetch('saveTemplate', payload, session);
      const saved = r?.data;
      set('design_json', payload.content.design_json || null);
      // Only clear html-only when the body ACTUALLY came from the canvas. On the preserve path
      // the template is still hand-authored HTML with no design_json, so the guard must stay
      // armed for the next save — clearing it unconditionally (the pre-2026-08-10 behaviour)
      // disarmed it after one metadata edit and made the SECOND save the silent, unguarded one.
      if (t.channel === 'email' && !preserveBodyRef.current) setHtmlOnly(false);
      if (preserveBodyRef.current) {
        showToast('Saved. The hand-authored HTML was kept — only name/subject/status changed.', 'success');
      }
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
    finally {
      setSaving(false);
      // Publish whatever the compiler said about THIS save. Deliberately in `finally`: a template
      // that fails to save for an unrelated reason still deserves its warnings shown, and a
      // successful save is exactly when an author is looking. ⚠️ Warn, never block — MJML's soft
      // level means these are cosmetic-to-serious and we cannot tell which, so refusing the save
      // would be worse than the silence this replaces.
      const w = mjmlWarnRef.current || [];
      setMjmlWarnings(w);
      if (w.length) {
        showToast(`Saved — but MJML reported ${w.length} warning${w.length === 1 ? '' : 's'}. See below the editor.`, 'error');
      }
    }
  }

  async function sendTest() {
    if (!testTo.trim()) {
      showToast((t.channel === 'whatsapp' || t.channel === 'sms' || t.channel === 'rcs')
        ? 'Test recipient phone number required' : 'Test recipient email required', 'error');
      return;
    }
    let vals = {};
    try { vals = testVals.trim() ? JSON.parse(testVals) : {}; }
    catch { showToast('Test values must be valid JSON', 'error'); return; }
    setTesting(true); setTestResult(null); setNeedsAllow(false);
    try {
      // Send the in-memory template so it works before/without saving. Test values are
      // passed as BOTH constants and recipient overrides so any matching var resolves.
      const payload = buildPayload();
      // Same guard as save(): a literal ${…} in the HTML makes Gmail drop whole style
      // attributes and zero-size the affected elements — a test of that template "loses"
      // buttons/footer in the inbox and burns a debugging round on a healthy pipeline.
      if (t.channel === 'email' &&
          ((payload.content.html_body || '').includes('${') || (payload.content.mjml || '').includes('${'))) {
        showToast('The email contains a literal "${…}" placeholder — Gmail hides every element styled with it. Remove it before testing.', 'error');
        setTesting(false); return;
      }
      const r = await workerFetch('sendTest', {
        channel: t.channel, to: composeTestTo(),
        // purpose drives sender ROUTING (purpose-match within the template's WABA) — without
        // it a marketing template can't route out the marketing number. Gates stay bypassed
        // via isTest server-side.
        purpose: t.purpose,
        // provider_template_id rides along because send.js resolves `opts.template ||
        // getTemplate(opts.templateId)` — the inline draft WINS, so a templateId here would be
        // ignored. SMS needs it: adapters/sms.js sends it as TrustSignal's `template_id`, and
        // without it the vendor gets `undefined` and the send is rejected. Harmless on the
        // other channels, which never read it.
        // `id` rides along so finalize() can stamp comms.messages.template_id. Without it EVERY
        // test send logged template_id NULL (69% of all WA test sends), which makes "has this
        // template ever sent successfully?" unanswerable by join — it cost a diagnostic step
        // during the S261 link test. finalize() is the ONLY reader of template.id, so this is
        // inert everywhere else.
        //
        // ⚠️ Deliberately NOT sending `version`. This object is the ON-SCREEN draft, which may
        // differ from the saved version's content; stamping template_version would assert the
        // send used that archived version and quietly make comms.template_versions lie.
        template: { id: t.id || null, content: payload.content, variables: payload.variables, provider_template_id: t.provider_template_id || null },
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
    // Full rows, not tokens — the source checks need to know where each token resolves.
    const errs = validateWaTemplate(buildPayload().content, t.variables);
    if (errs.length) { showToast(`Fix ${errs.length} issue${errs.length === 1 ? '' : 's'} before submitting`, 'error'); return; }
    if (!(await confirm({
      tone: 'danger',
      title: `Submit "${t.wa.meta_name}" to Meta?`,
      lede: 'This creates a real template on LOT\u2019s WhatsApp Business Account and enters Meta\u2019s review queue.',
      points: [
        'Review typically takes minutes to hours',
        'It cannot be undone from here',
      ],
      warning: <>While the review runs, <b>every send of this template fails</b> (#132001).
               Measured, not theoretical: it took Order Placed down for 18 minutes on 2026-07-28.</>,
      note: 'If a live journey uses this template, pause it or cover it elsewhere first.',
      confirmLabel: 'Submit to Meta',
    }))) return;
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
      if (!(await confirm({
        tone: 'warn',
        title: `Archive "${r.name}"?`,
        lede: <>It is used by <b>{u.journeys_live}</b> live journey{u.journeys_live === 1 ? '' : 's'}{names ? ` (${names})` : ''}.</>,
        points: [
          'Hides it from this library and from the journey and campaign pickers',
          'Nobody can newly select it',
          <>It does <b>not</b> stop those live journeys sending it, and does not touch Meta</>,
        ],
        note: 'Blocking the send would break a customer-facing flow silently, which is worse.',
        confirmLabel: 'Archive anyway',
      }))) return;
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
    if (!(await confirm({
      tone: 'danger',
      title: `Permanently delete "${r.name}"?`,
      lede: 'It was never submitted to Meta and nothing references it.',
      points: [
        'Removes the template and its version history from Relay',
        'There is no Meta copy to remove',
      ],
      warning: 'This cannot be undone.',
      confirmLabel: 'Delete permanently',
    }))) return;
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
    const isPhone = isWa || t.channel === 'sms' || t.channel === 'rcs';
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
            {t.channel === 'sms' && t.id
              && (() => {
                const a = templateApproval({ channel: 'sms', approval_status: t.approval_status,
                  provider_template_id: t.provider_template_id, content: { dlt_template_id: t.sms?.dlt_template_id } });
                return a && !a.dim ? <span title={a.title}><Badge label={a.label} tone={a.tone || 'gray'} /></span> : null;
              })()}
            {t.channel === 'rcs' && t.provider_template_id
              && <Badge label={`Vendor: ${(t.rcs?.provider_status || 'unknown').toLowerCase()}`}
                   tone={(t.rcs?.provider_status || '').toLowerCase() === 'approved' ? 'green' : 'yellow'} />}
          </div>
          <div className="po-head-r">
            {/* Fork the template you are looking at. Gated on t.id — a duplicate of an
                unsaved draft would just be the same unsaved form again. Warns first when
                there are unsaved edits, because the copy is built from the SAVED row
                (`rows`), so anything on screen but not saved would silently not come with it. */}
            {canEdit && t.id && (
              <Btn onClick={async () => {
                const src = rows.find((r) => r.id === t.id);
                if (!src) { showToast('Reload the list first', 'error'); return; }
                if ((dirty || waDirty) && !(await confirm({
                  tone: 'warn',
                  title: 'You have unsaved changes',
                  lede: 'The copy is made from the last saved version, so those changes will not be carried over.',
                  confirmLabel: 'Duplicate anyway',
                  cancelLabel: 'Go back and save first',
                }))) return;
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
        <div className={isPhone ? 'tpl-split' : undefined}>
        <div className={isPhone ? 'tpl-main' : undefined}>
        {/* PRE-SEND SHAPE CHECK (S241). Three incidents on 2026-07-28 — a stale WABA pin and
            twice an IMAGE header Meta had not approved — were each discoverable only by
            pressing Send on live traffic, and each surfaced as an opaque Meta code that named
            the wrong thing. This says plainly whether the template will send, before anyone
            tries. Refuses to be reassuring: silence only when it genuinely matched. */}
        {t.channel === 'whatsapp' && t.id && t.provider_template_id && (
          shapeLoading ? (
            <div className="tw-note" style={{ marginBottom: 12 }}>Checking against Meta…</div>
          ) : shape && shape.checked && !shape.match ? (
            <div className="note-box is-bad" style={{ marginBottom: 12 }}>
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
            <div className="note-box is-good" style={{ marginBottom: 12 }}>
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
                {PURPOSES.map((p) => <option key={p} value={p}>{purposeLabel(p)}</option>)}
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
        ) : t.channel === 'sms' ? (
          <SmsEditor sms={t.sms} setSms={(s) => set('sms', s)} variables={t.variables}
            disabled={saving || !canEdit} providerTemplateId={t.provider_template_id}
            session={session} templateRowId={t.id}
            onMirrored={(pid) => set('provider_template_id', pid)} />
        ) : t.channel === 'rcs' ? (
          <RcsEditor rcs={t.rcs} setRcs={(r) => set('rcs', r)} variables={t.variables}
            disabled={saving || !canEdit}
            providerTemplateId={t.provider_template_id}
            setProviderTemplateId={(v) => set('provider_template_id', v)}
            session={session} templateRowId={t.id}
            onBound={(pid, status, varParams) => setT((prev) => ({ ...prev,
              provider_template_id: pid,
              rcs: { ...prev.rcs, provider_status: status, rcs_type: prev.rcs?.draft?.type || prev.rcs?.rcs_type || 'text_message',
                     var_params: varParams } }))}
            smsTemplates={rows.filter((x) => x.channel === 'sms' && x.provider_template_id
              && (x.content?.template_type === 'explicit'))} />
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
            /* HTML-ONLY TEMPLATE — show the REAL email, not an empty canvas (2026-08-10).
               The canvas is grapesjs-mjml: it renders MJML, and it loads either a stored
               design_json or the BLANK scaffold. A template authored outside Relay (the
               ad-engine build pipeline emits hand-authored table HTML, byte-identical by
               construction) has neither, so mounting the editor showed a blank email and
               made the real one look lost. Worse, saving from it exported the blank canvas
               over the real HTML — which is exactly what happened to the Roxie emailer.
               So: render the actual HTML read-only. Not mounting the canvas also means
               edRef stays null and buildPayload structurally cannot replace the body —
               a stronger guarantee than any dialog. Subject/name/status stay editable. */
            (canEdit && htmlOnly) ? (
              <>
                <div className="tw-note" style={{ marginTop: 0, marginBottom: 12 }}>
                  <strong>Authored outside the visual editor</strong> — showing the real email,
                  read-only. This HTML is generated by its source project and is byte-exact, so the
                  MJML canvas cannot represent it without rewriting it. To change the design, edit
                  the source and re-import. Subject, name and status above are still editable and
                  save normally.
                  <div style={{ marginTop: 8 }}>
                    <Btn onClick={async () => {
                      if (await confirm({
                        tone: 'warn',
                        title: 'Switch to the visual editor?',
                        lede: 'The canvas starts empty. This email\u2019s HTML is not MJML and cannot be loaded into it.',
                        points: [
                          'Saving after switching replaces the email with whatever you build',
                          'The current HTML stays recoverable in the version history',
                        ],
                        confirmLabel: 'Switch to visual',
                        cancelLabel: 'Stay on HTML',
                      })) setHtmlOnly(false);
                    }}>Switch to visual editor (replaces this HTML)</Btn>
                  </div>
                </div>
                <iframe title="Email preview" sandbox=""
                  srcDoc={t.html_body || '<p style="font-family:sans-serif;color:#888;padding:24px">No content</p>'}
                  style={{ width: '100%', height: 640, border: '1px solid var(--border,#e5e5e5)', borderRadius: 8, background: '#fff' }} />
              </>
            ) : canEdit ? (
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
                <EmailEditor key={editorKey} onReady={(api) => { edRef.current = api; }} initialDesign={t.design_json} initialMjml={t.mjml} session={session} />
                {/* MJML compiles at validationLevel 'soft', so a broken template saves cleanly and
                    only console.warns. That is how a nested <mj-attributes> head — which makes MJML
                    apply NONE of the template's global defaults — survived across all 7 saved
                    templates and shipped to a live customer send at the wrong font size. The
                    compiler DID notice; nobody was listening. This is the listening. */}
                {mjmlWarnings.length > 0 && (
                  <div style={{
                    marginTop: 12, padding: '12px 14px', borderRadius: 8,
                    border: '1px solid var(--yellow, #eab308)',
                    background: 'color-mix(in srgb, var(--yellow, #eab308) 8%, transparent)',
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>
                      MJML reported {mjmlWarnings.length} warning{mjmlWarnings.length === 1 ? '' : 's'} on the last save
                    </div>
                    <div className="dim" style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.5 }}>
                      The template still saved — these do not block anything. But MJML only warns,
                      so an ignored warning here is what reaches the recipient&apos;s inbox.
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
                      {mjmlWarnings.slice(0, 12).map((w, i) => (
                        <li key={i}>
                          {w.tag ? <code>{w.tag}</code> : null}
                          {w.line ? <span className="dim mono"> line {w.line}</span> : null}
                          {(w.tag || w.line) ? ' — ' : null}{w.message}
                        </li>
                      ))}
                    </ul>
                    {mjmlWarnings.length > 12 && (
                      <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
                        …and {mjmlWarnings.length - 12} more — the full list is in the browser console.
                      </div>
                    )}
                  </div>
                )}
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
              <div className="table-scroll">
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
                      <td className="dim"><Stamp value={v.created_at} /></td>
                      <td className="dim" style={{ fontSize: 12 }}>{v.created_by || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
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
                {(t.channel === 'whatsapp' || t.channel === 'sms' || t.channel === 'rcs') ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    {/* SMS is +91-only: renderPhoneForSms rejects every other country with
                        unsupported_country, so offering them would only produce failed tests. */}
                    <select className="f-inp mono" value={t.channel === 'sms' ? '+91' : testCc}
                      onChange={(e) => setTestCc(e.target.value)}
                      disabled={testing || t.channel === 'sms'} style={{ width: 96, flex: '0 0 auto' }} aria-label="Country code">
                      {(t.channel === 'sms' ? ['+91'] : ['+91', '+1', '+44', '+971', '+65'])
                        .map((c) => <option key={c} value={c}>{c}</option>)}
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
        {/* SMS + RCS get the same pinned handset preview WhatsApp has — Google Messages
            look, because that is where both channels actually render. Fed straight from the
            editor state, so the bubble tracks every keystroke like the WA one does. */}
        {t.channel === 'sms' && (
          <aside className="tpl-side">
            <Panel title="Preview" pad>
              <MsgPreview channel="sms" sender={t.sms?.header || 'LGNDRC'}
                body={t.sms?.body} variables={t.variables}
                meta={`SMS · DLT ${t.sms?.dlt_template_id || 'unregistered'}`} />
            </Panel>
          </aside>
        )}
        {t.channel === 'rcs' && (
          <aside className="tpl-side">
            <Panel title="Preview" pad>
              <MsgPreview channel="rcs" sender="L.O.T"
                body={t.rcs?.draft?.body} variables={t.variables}
                image={(t.rcs?.draft?.type === 'rich_card' || t.rcs?.rcs_type === 'rich_card')
                  ? (t.rcs?.draft?.media_url || '') : null}
                cardTitle={t.rcs?.draft?.card_title}
                chips={t.rcs?.draft?.btn_text ? [{ label: t.rcs.draft.btn_text }] : []}
                emptyNote={t.provider_template_id
                  ? `Bound to vendor template ${t.provider_template_id} — the creative lives at TrustSignal; Relay fills: ${
                      (t.rcs?.var_params || []).join(', ') || 'no variables'}.`
                  : 'Write the message in Compose & submit to see it here.'}
                meta={`RCS · ${t.rcs?.rcs_type || 'text_message'} · falls back to SMS if the handset has no RCS`} />
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
    // Approval spans every reviewed channel now (Meta for WA, DLT for SMS, the carrier hub
    // for RCS) — email alone has no approval concept, so "Not approved" still excludes it
    // rather than sweeping every email template in as a false positive.
    if (approvalFilter === 'approved' && !isApprovedForSend(r)) return false;
    if (approvalFilter === 'not_approved'
      && !(r.channel !== 'email' && !isApprovedForSend(r))) return false;
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
                  {PURPOSES.map((p) => <option key={p} value={p}>{purposeLabel(p)}</option>)}
                </select>
                <select className="f-inp" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
                  style={{ width: 'auto', minWidth: 120 }}>
                  <option value="all">Any status</option>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <select className="f-inp" value={approvalFilter} onChange={(e) => setApprovalFilter(e.target.value)}
                  style={{ width: 'auto', minWidth: 150 }}>
                  <option value="all">Any approval state</option>
                  <option value="approved">Approved</option>
                  <option value="not_approved">Not approved</option>
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
              <div className="table-scroll">
              <table className="dt">
                <thead><tr><th>Name</th><th>Channel</th><th>Purpose</th><th>Account</th><th>Used by</th><th>Status</th><th>Approval</th><th>Ver</th><th>Updated</th><th></th></tr></thead>
                <tbody>
                  {filteredRows.map((r) => (
                    <tr key={r.id} className="row-click" onClick={() => startEdit(r)}>
                      <td style={{ fontWeight: 600 }}>{r.name}</td>
                      {/* Channel glyph + label (§7.6) — WA green, email neutral. */}
                      <td>
                        <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5,
                          color: r.channel === 'whatsapp' ? 'var(--wa, #25D366)'
                            : r.channel === 'email' ? 'var(--em, #a78bfa)' : 'var(--t2)' }}>
                          {r.channel === 'whatsapp' ? <MessageCircle size={14} />
                            : r.channel === 'sms' ? <MessageSquare size={14} />
                            : r.channel === 'rcs' ? <Smartphone size={14} /> : <Mail size={14} />}
                          {r.channel === 'whatsapp' ? 'WhatsApp' : r.channel === 'email' ? 'Email'
                            : r.channel === 'rcs' ? 'RCS' : r.channel === 'sms' ? 'SMS' : r.channel}
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
                      {/* Used-by pill (Pruthvi 2026-08-18/20): with 101 templates and 53 of
                          them never referenced by anything, there was no way to tell a live
                          template from a dead one without opening each. Hover names where. */}
                      <td>{(() => {
                        const usage = templateUsage(r);
                        // Badge's own `title` — it also switches the cursor to `help`, so the
                        // pill advertises that hovering it says more.
                        return <Badge label={usage.label} tone={usage.tone} title={usage.detail} />;
                      })()}</td>
                      <td><Badge label={r.status} tone={STATUS_TONE[r.status] || 'gray'} /></td>
                      <td>{(() => {
                        const a = templateApproval(r);
                        if (!a) return <span className="dim">—</span>;
                        if (a.dim) return <span className="dim" style={{ fontSize: 12 }}>{a.label}</span>;
                        return <span title={a.title}><Badge label={a.label} tone={a.tone || 'gray'} /></span>;
                      })()}</td>
                      <td className="mono dim">v{r.version}</td>
                      <td className="dim"><Stamp value={r.updated_at} /></td>
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
                          {/* ⚠️ The disabled test blocks on `unavailable` TOO. It used to read a
                              FAILED usage lookup as "nothing references it" and go clickable —
                              fail-open on the one control that permanently destroys a template
                              a live journey may depend on. Unknown must mean no, not yes. */}
                          {canEdit && !r.provider_template_id && !r.approval_status && (
                            <Btn onClick={(e) => { e.stopPropagation(); destroy(r); }}
                              disabled={!!(r.usage && (r.usage.unavailable || r.usage.journeys_other || r.usage.campaigns || r.usage.sent))}
                              title={r.usage && r.usage.unavailable
                                ? 'Cannot check what uses this template right now — reload before deleting'
                                : r.usage && (r.usage.journeys_other || r.usage.campaigns || r.usage.sent)
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
              </div>
              )}
            </Panel>
          )}
    </div>
  );
}
