'use client';
// Config form for the selected canvas node. Pure controlled component:
// receives the node's config + templates list, calls onChange(partial) / onDelete().
import { useState, useEffect } from 'react';
import { Trash2 } from 'lucide-react';

// Multi-value comma-separated input with a local text buffer. Committing the parsed
// array on every keystroke (filter(Boolean) drops the trailing empty token) makes a
// second value un-typeable by hand — so we buffer the raw text and commit on blur.
function AwaitedEventsInput({ nodeId, value, onChange, disabled }) {
  const [text, setText] = useState((value || []).join(', '));
  // Reset the buffer when a different node is selected (nodeId changes).
  useEffect(() => { setText((value || []).join(', ')); }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => onChange(text.split(',').map((x) => x.trim()).filter(Boolean));
  return (
    <input className="f-inp mono" list="jc-event-suggest" value={text} disabled={disabled}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      placeholder="order_placed, whatsapp_inbound" />
  );
}

const COND_KINDS = [
  { id: 'no_event_since_enrol', label: "Hasn't done event since enrol" },
  { id: 'event_since_enrol', label: 'Has done event since enrol' },
  { id: 'attribute', label: 'Profile attribute compare' },
];
const CHANNELS = [
  { id: 'email', label: 'Email', live: true },
  { id: 'whatsapp', label: 'WhatsApp', live: true },
  { id: 'sms', label: 'SMS (not live yet)', live: false },
];
const EVENT_SUGGEST = ['checkout_started', 'order_placed', 'order_fulfilled', 'order_cancelled',
  'add_to_cart', 'link_clicked', 'whatsapp_inbound'];

function Field({ label, children }) {
  return <div className="ff" style={{ marginBottom: 10 }}><div className="kv-k">{label}</div>{children}</div>;
}

export default function NodeDrawer({ nodeId, config, templates, onChange, onDelete, disabled }) {
  if (!nodeId || !config) return null;
  const set = (patch) => onChange({ ...config, ...patch });
  const t = config.type;
  const channelTemplates = (templates || []).filter((x) => x.channel === (config.channel || 'email'));

  return (
    <div style={{ border: '1px solid var(--bd, #ddd)', borderRadius: 10, padding: 14, marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <strong style={{ textTransform: 'capitalize' }}>{t} · <span className="mono dim" style={{ fontSize: 11 }}>{nodeId}</span></strong>
        {!disabled && (
          <button className="btn" type="button" onClick={onDelete} style={{ color: '#DE2A2A' }}>
            <Trash2 size={13} /> Delete node
          </button>
        )}
      </div>

      {t === 'send' && (<>
        <Field label="Channel">
          <select className="f-inp" value={config.channel || 'email'} disabled={disabled}
            onChange={(e) => set({ channel: e.target.value, templateId: '' })}>
            {CHANNELS.map((c) => <option key={c.id} value={c.id} disabled={!c.live}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Purpose">
          <select className="f-inp" value={config.purpose || 'marketing'} disabled={disabled}
            onChange={(e) => set({ purpose: e.target.value })}>
            <option value="marketing">marketing</option>
            <option value="transactional">transactional</option>
            <option value="utility">utility</option>
          </select>
        </Field>
        <Field label="Template (must be active)">
          <select className="f-inp" value={config.templateId || ''} disabled={disabled}
            onChange={(e) => set({ templateId: e.target.value })}>
            <option value="">— pick a template —</option>
            {channelTemplates.map((x) => <option key={x.id} value={x.id}>{x.name} · v{x.version} ({x.status})</option>)}
          </select>
        </Field>
        <Field label="If skipped (not sent — e.g. suppressed/unsubscribed)">
          <select className="f-inp" value={config.on_skip || 'continue'} disabled={disabled}
            onChange={(e) => set({ on_skip: e.target.value })}>
            <option value="continue">Continue — proceed as if sent</option>
            <option value="advance">Advance — skip the next wait, go straight to its timeout</option>
            <option value="exit">Exit — leave the journey</option>
          </select>
        </Field>
        {config.on_skip === 'exit' && (
          <Field label="Skip outcome label">
            <input className="f-inp mono" value={config.on_skip_outcome || 'skipped'} disabled={disabled}
              onChange={(e) => set({ on_skip_outcome: e.target.value })} placeholder="skipped" />
          </Field>
        )}
      </>)}

      {t === 'wait' && (
        <Field label='Duration (e.g. "24 hours", "30 minutes")'>
          <input className="f-inp mono" value={config.duration || ''} disabled={disabled}
            onChange={(e) => set({ duration: e.target.value })} placeholder="24 hours" />
        </Field>
      )}

      {t === 'wait_response' && (<>
        <Field label="Awaited events (comma-separated)">
          <AwaitedEventsInput nodeId={nodeId} value={config.awaited} disabled={disabled}
            onChange={(arr) => set({ awaited: arr })} />
          <datalist id="jc-event-suggest">{EVENT_SUGGEST.map((a) => <option key={a} value={a} />)}</datalist>
        </Field>
        <Field label='Within (e.g. "6 hours", "30 minutes")'>
          <input className="f-inp mono" value={config.within || ''} disabled={disabled}
            onChange={(e) => set({ within: e.target.value })} placeholder="6 hours" />
        </Field>
        <div className="tw-note" style={{ margin: 0 }}>Responded path = <span className="mono">responded</span> handle, timeout = <span className="mono">timeout</span>.</div>
      </>)}

      {t === 'condition' && (<>
        <Field label="Check">
          <select className="f-inp" value={config.check?.kind || 'no_event_since_enrol'} disabled={disabled}
            onChange={(e) => set({ check: { ...config.check, kind: e.target.value } })}>
            {COND_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </Field>
        {config.check?.kind !== 'attribute' ? (
          <Field label="Event">
            <input className="f-inp mono" list="jc-event-suggest" value={config.check?.event || ''} disabled={disabled}
              onChange={(e) => set({ check: { ...config.check, event: e.target.value } })} placeholder="order_placed" />
            <datalist id="jc-event-suggest">{EVENT_SUGGEST.map((a) => <option key={a} value={a} />)}</datalist>
          </Field>
        ) : (<>
          <Field label="Attribute">
            <input className="f-inp mono" value={config.check?.attr || ''} disabled={disabled}
              onChange={(e) => set({ check: { ...config.check, attr: e.target.value } })} placeholder="lifetime_orders" />
          </Field>
          <Field label="Operator">
            <select className="f-inp" value={config.check?.op || 'eq'} disabled={disabled}
              onChange={(e) => set({ check: { ...config.check, op: e.target.value } })}>
              <option value="eq">=</option><option value="gt">&gt;</option><option value="lt">&lt;</option>
            </select>
          </Field>
          <Field label="Value">
            <input className="f-inp mono" value={config.check?.value ?? ''} disabled={disabled}
              onChange={(e) => set({ check: { ...config.check, value: e.target.value } })} />
          </Field>
        </>)}
        <div className="tw-note" style={{ margin: 0 }}>True path = <span className="mono">if_true</span> handle, false = <span className="mono">if_false</span>.</div>
      </>)}

      {t === 'exit' && (
        <Field label="Outcome label">
          <select className="f-inp" value={config.outcome || 'completed'} disabled={disabled}
            onChange={(e) => set({ outcome: e.target.value })}>
            <option value="completed">completed</option>
            <option value="exited">exited</option>
          </select>
        </Field>
      )}
    </div>
  );
}
