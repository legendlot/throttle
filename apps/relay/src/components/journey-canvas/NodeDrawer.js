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
  'add_to_cart', 'link_clicked', 'whatsapp_inbound', 'shopflo_order_completed',
  'payment_link_paid', 'payment_link_failed'];

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

      {t === 'send' && !config.interactive && (<>
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

      {t === 'send' && config.interactive && (<>
        <div className="tw-note" style={{ margin: '0 0 10px' }}>WhatsApp quick-reply buttons. Each button becomes an outcome handle; the reply routes there. Inert until WhatsApp is live (send skips → <span className="mono">no_reply</span>).</div>
        <Field label="Purpose">
          <select className="f-inp" value={config.purpose || 'utility'} disabled={disabled}
            onChange={(e) => set({ purpose: e.target.value })}>
            <option value="utility">utility</option>
            <option value="marketing">marketing</option>
          </select>
        </Field>
        <Field label="Template (WA, with buttons — must be active)">
          <select className="f-inp" value={config.templateId || ''} disabled={disabled}
            onChange={(e) => set({ templateId: e.target.value })}>
            <option value="">— pick a WhatsApp template —</option>
            {(templates || []).filter((x) => x.channel === 'whatsapp').map((x) => <option key={x.id} value={x.id}>{x.name} · v{x.version} ({x.status})</option>)}
          </select>
        </Field>
        <Field label='Wait for reply within (e.g. "6 hours")'>
          <input className="f-inp mono" value={config.within || ''} disabled={disabled}
            onChange={(e) => set({ within: e.target.value })} placeholder="6 hours" />
        </Field>
        <Field label="Buttons (id must match the template's button payload · max 3)">
          {(config.buttons || []).map((b, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input className="f-inp mono" style={{ flex: 1 }} value={b.id || ''} disabled={disabled} placeholder="make_payment"
                onChange={(e) => { const bs = [...config.buttons]; bs[i] = { ...bs[i], id: e.target.value }; set({ buttons: bs }); }} />
              <input className="f-inp" style={{ flex: 1 }} value={b.label || ''} disabled={disabled} placeholder="Make Payment"
                onChange={(e) => { const bs = [...config.buttons]; bs[i] = { ...bs[i], label: e.target.value }; set({ buttons: bs }); }} />
              {!disabled && <button className="btn" type="button" onClick={() => set({ buttons: config.buttons.filter((_, j) => j !== i) })} style={{ color: '#DE2A2A' }}><Trash2 size={12} /></button>}
            </div>
          ))}
          {!disabled && (config.buttons || []).length < 3 && (
            <button className="btn" type="button" onClick={() => set({ buttons: [...(config.buttons || []), { id: '', label: '' }] })}>+ Add button</button>
          )}
        </Field>
      </>)}

      {t === 'action' && config.kind === 'order_modify' && (<>
        <Field label="Operation">
          <select className="f-inp" value={config.op || 'convert_to_prepaid'} disabled={disabled}
            onChange={(e) => set({ op: e.target.value })}>
            <option value="convert_to_prepaid">Convert to prepaid (mark Shopify order paid)</option>
            <option value="cancel">Cancel order (on Shopify)</option>
            <option value="add_tag">Add tag only</option>
          </select>
        </Field>
        {config.op === 'add_tag' && (
          <Field label="Tags (comma-separated)">
            <input className="f-inp mono" value={(config.tags || []).join(', ')} disabled={disabled}
              onChange={(e) => set({ tags: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })}
              placeholder="relay-cod-confirmed" />
          </Field>
        )}
        {config.op !== 'add_tag' && (
          <Field label="Only within N hours of order (blank = no time limit)">
            <input className="f-inp mono" type="number" min="1" value={config.within_hours ?? ''} disabled={disabled}
              onChange={(e) => set({ within_hours: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="(no limit)" />
          </Field>
        )}
        <div className="tw-note" style={{ margin: 0 }}>
          Shopify order op (mirrors BiteSpeed's Modify Order). Convert/cancel are <strong>guarded to UNFULFILLED orders</strong> (once shipped, COD is locked to the courier) and <strong>gated by the go-live switch</strong> + need <span className="mono">write_orders</span>. Outcomes: <span className="mono">done</span> · <span className="mono">not_done</span>.
        </div>
      </>)}

      {t === 'action' && config.kind === 'payment_link' && (<>
        <Field label="Purpose (shown to the customer on the payment page)">
          <input className="f-inp" value={config.purpose || ''} disabled={disabled}
            onChange={(e) => set({ purpose: e.target.value })} placeholder="Complete your order payment" />
        </Field>
        <Field label="Amount (₹) — blank = use the trigger order's total">
          <input className="f-inp mono" type="number" min="1" value={config.amount ?? ''} disabled={disabled}
            onChange={(e) => set({ amount: e.target.value === '' ? undefined : Number(e.target.value) })}
            placeholder="(order total)" />
        </Field>
        <div className="tw-note" style={{ margin: 0 }}>
          Mints a Cashfree pay-link (<strong>inert</strong> until <span className="mono">payment_links_enabled</span> is on).
          Follow it with a <strong>Send</strong> node delivering <span className="mono">{'{payment_link_url}'}</span>,
          then a <strong>Wait-for-response</strong> on <span className="mono">payment_link_paid</span>.
          Outcomes: <span className="mono">next</span> (minted) · <span className="mono">failed</span>.
        </div>
      </>)}

      {t === 'action' && config.kind === 'set_attr' && (<>
        <Field label="Attribute">
          <input className="f-inp mono" value={config.attr || ''} disabled={disabled}
            onChange={(e) => set({ attr: e.target.value })} placeholder="cod_converted" />
        </Field>
        <Field label="Value">
          <input className="f-inp mono" value={config.value ?? ''} disabled={disabled}
            onChange={(e) => set({ value: e.target.value })} placeholder="true" />
        </Field>
        <div className="tw-note" style={{ margin: 0 }}>Merges <span className="mono">{'{attr: value}'}</span> into the profile. Outcome: <span className="mono">next</span>.</div>
      </>)}
    </div>
  );
}
