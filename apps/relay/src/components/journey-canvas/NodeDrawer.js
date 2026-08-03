'use client';
// Config form for the selected canvas node. Pure controlled component:
// receives the node's config + templates list, calls onChange(partial) / onDelete().
import { useState, useEffect } from 'react';
import { Trash2 } from 'lucide-react';
import { Combobox } from '@throttle/ui';
import { eventComboOptions, normalizeEventDefs } from '@/lib/eventDefs.js';

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
  { id: 'event_property', label: 'Trigger event property' },
];
// event_property field suggestions — the enriched/most-branched-on trigger properties.
const EVENT_PROP_SUGGEST = ['primary_category', 'total', 'is_cod', 'financial_status',
  'line_item_count', 'product_title', 'product_names'];
const EVENT_PROP_OPS = [
  { id: 'eq', label: 'is' }, { id: 'neq', label: 'is not' },
  { id: 'contains', label: 'contains' }, { id: 'in', label: 'is any of (comma-sep)' },
];
const CHANNELS = [
  { id: 'email', label: 'Email', live: true },
  { id: 'whatsapp', label: 'WhatsApp', live: true },
  { id: 'sms', label: 'SMS', live: true },
];
// Event names arrive as the `eventDefs` prop, loaded once by the journeys page from the
// live comms.event_definitions registry (@/lib/eventDefs.js). The hardcoded list that used
// to sit here was a THIRD divergent copy — it offered payment/whatsapp events the segment
// builder lacked, and omitted order_delivered/checkout_abandoned which it had.

function Field({ label, children }) {
  return <div className="ff" style={{ marginBottom: 10 }}><div className="kv-k">{label}</div>{children}</div>;
}

// SEND-FROM PIN. Data-only until S243, and load-bearing for any FREE-TEXT step: a free-text send
// carries no template, so there is no WABA to scope senders by, and routing falls through to
// "first active sender whose purpose matches". For a `utility` step that is the SUPPORT number —
// not the number the customer just replied to. The 24h session window is keyed per
// phone_number_id, so the send then finds no open window and is silently skipped as
// `window_closed`: the customer taps a button and gets nothing back. Rendered for both the plain
// and interactive send blocks, because a mid-flow confirm is interactive AND free-text.
function SenderPicker({ config, senders, set, disabled }) {
  if (config.channel !== 'whatsapp') return null;
  const isFreeText = config.text !== undefined;
  return (
    <Field label="Send from">
      <select className="f-inp" value={config.senderId || ''} disabled={disabled}
        onChange={(e) => set({ senderId: e.target.value || undefined })}>
        <option value="">Auto — pick by purpose (fine for template sends)</option>
        {(senders || []).filter((s) => s.channel === 'whatsapp').map((s) => (
          <option key={s.id} value={s.id}>{s.address} · {s.purpose}</option>
        ))}
      </select>
      {isFreeText && !config.senderId && (
        <div className="tw-note" style={{ marginTop: 6, borderColor: 'var(--danger, #DE2A2A)' }}>
          ⚠️ <b>Free-text message with no number pinned.</b> It will be routed by purpose, which
          usually resolves to the <b>support</b> number — not the number the customer replied to.
          The 24-hour reply window belongs to that other number, so this message would be{' '}
          <b>silently skipped</b> and the customer would get nothing. Pin the same number the
          flow&apos;s opening template goes out from.
        </div>
      )}
    </Field>
  );
}

// Number + unit selector composing the engine's "N unit" duration string (journey-graph.js
// durationToMs: second|minute|hour|day|week, plural optional). Free-text durations depended
// on people typing "min/hr/days" correctly — a typo saved fine and only failed at runtime.
const DUR_UNITS = ['minutes', 'hours', 'days'];
function parseDur(str) {
  const m = String(str || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week)s?$/);
  return m ? { n: m[1], unit: m[2] + 's' } : { n: '', unit: 'hours' };
}
function DurationInput({ value, onChange, disabled }) {
  const { n, unit } = parseDur(value);
  const units = DUR_UNITS.includes(unit) ? DUR_UNITS : [unit, ...DUR_UNITS]; // legacy seconds/weeks round-trip
  const emit = (nn, uu) => onChange(!nn || Number(nn) <= 0 ? '' : `${nn} ${uu}`);
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input className="f-inp mono" type="number" min="1" step="any" value={n} disabled={disabled}
        onChange={(e) => emit(e.target.value, unit)} placeholder="24" style={{ width: 110, flex: '0 0 auto' }} />
      <select className="f-inp" value={unit} disabled={disabled}
        onChange={(e) => emit(n || '1', e.target.value)} style={{ flex: 1 }}>
        {units.map((u) => <option key={u} value={u}>{u}</option>)}
      </select>
    </div>
  );
}

export default function NodeDrawer({ nodeId, config, templates, senders, onChange, onDelete, disabled, eventDefs }) {
  if (!nodeId || !config) return null;
  // Defaulted through normalizeEventDefs so the drawer still renders a usable list if it is
  // ever mounted without the prop (fallback set), never an empty picker.
  const evDefs = (eventDefs && eventDefs.length) ? eventDefs : normalizeEventDefs(null);
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
        {/* WhatsApp can send either an approved template (valid any time) or a free-text
            SESSION reply (valid only inside the 24h window the customer's own reply opens).
            Mid-flow confirmations — "we've cancelled your order" — are session replies, and
            forcing them through Meta review would put a 4-message flow behind 4 approvals
            for no benefit. Email has no such split, so the choice is WA-only. */}
        {config.channel === 'whatsapp' && (
          <Field label="Message">
            <select className="f-inp" value={config.text ? 'text' : 'template'} disabled={disabled}
              onChange={(e) => set(e.target.value === 'text'
                ? { text: config.text || ' ', templateId: '' }
                : { text: undefined })}>
              <option value="template">Approved template — sendable any time</option>
              <option value="text">Free text — reply inside the 24h window only</option>
            </select>
          </Field>
        )}
        {config.channel === 'whatsapp' && config.text !== undefined ? (
          <Field label="Message text">
            <textarea className="f-inp" rows={3} value={config.text || ''} disabled={disabled}
              onChange={(e) => set({ text: e.target.value })}
              placeholder="Great! We have your order confirmed." />
            <div className="tw-note" style={{ marginTop: 6 }}>
              Only delivers if this customer messaged us in the last 24 hours — true straight
              after they tap a button, <b>not</b> as a journey&apos;s first step (it would skip
              with <span className="mono">window_closed</span>). No Meta approval needed.
            </div>
          </Field>
        ) : (
          <Field label="Template (must be active)">
            <select className="f-inp" value={config.templateId || ''} disabled={disabled}
              onChange={(e) => set({ templateId: e.target.value })}>
              <option value="">— pick a template —</option>
              {channelTemplates.map((x) => <option key={x.id} value={x.id}>{x.name} · v{x.version} ({x.status})</option>)}
            </select>
          </Field>
        )}
        <SenderPicker config={config} senders={senders} set={set} disabled={disabled} />

        {/* No variable reference existed until S243. A token the run context can't supply throws
            `unresolved_variables`, which FAILS the send and raises a defect alert — so "which
            tokens may I use, and when?" is a correctness question, not a convenience one. The
            ordering rule is the part that isn't guessable: context is accumulated by the graph
            walk, so a token only resolves if an EARLIER step produced it. */}
        <details style={{ marginBottom: 10 }}>
          <summary className="kv-k" style={{ cursor: 'pointer' }}>Variables I can use in this message</summary>
          <div className="tw-note" style={{ marginTop: 8 }}>
            <b>Always:</b> whatever the trigger event carries — e.g.{' '}
            <span className="mono">{'{order_number}'}</span> <span className="mono">{'{total}'}</span>{' '}
            <span className="mono">{'{product_title}'}</span>.
            <br /><br />
            <b>Only if an earlier step produced it</b> — context builds up as the journey runs, so a
            token from a step <i>below</i> this one will not resolve:
            <br />
            after a <b>Payment link</b> step → <span className="mono">{'{payment_link_url}'}</span>, and with
            prepaid pricing also <span className="mono">{'{prepaid_amount_display}'}</span>{' '}
            <span className="mono">{'{cod_amount_display}'}</span> <span className="mono">{'{saving_display}'}</span>
            <br />
            after a <b>Recreate as prepaid</b> step → <span className="mono">{'{new_order_number}'}</span>
            <br /><br />
            ⚠️ A token nothing supplies <b>fails the whole send</b> (<span className="mono">unresolved_variables</span>) —
            it does not fall back to blank. Send yourself a test before activating.
          </div>
        </details>

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
        <Field label="Duration">
          <DurationInput value={config.duration || ''} disabled={disabled}
            onChange={(v) => set({ duration: v })} />
        </Field>
      )}

      {t === 'wait_response' && (<>
        <Field label="Awaited events (comma-separated)">
          <AwaitedEventsInput nodeId={nodeId} value={config.awaited} disabled={disabled}
            onChange={(arr) => set({ awaited: arr })} />
          {/* Multi-value field, so a datalist (not a Combobox) — but fed from the live
              registry rather than a hardcoded list. */}
          <datalist id="jc-event-suggest">{evDefs.map((d) => <option key={d.name} value={d.name} />)}</datalist>
        </Field>
        <Field label="Within">
          <DurationInput value={config.within || ''} disabled={disabled}
            onChange={(v) => set({ within: v })} />
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
        {config.check?.kind === 'event_property' ? (<>
          {/* Branch on the TRIGGER event's own properties — e.g. primary_category is
              "L.O.T Build" → Build-voice template; anything else → Cars voice. */}
          <Field label="Event property">
            <input className="f-inp mono" list="jc-eventprop-suggest" value={config.check?.field || ''} disabled={disabled}
              onChange={(e) => set({ check: { ...config.check, field: e.target.value } })} placeholder="primary_category" />
            <datalist id="jc-eventprop-suggest">{EVENT_PROP_SUGGEST.map((a) => <option key={a} value={a} />)}</datalist>
          </Field>
          <Field label="Operator">
            <select className="f-inp" value={config.check?.op || 'eq'} disabled={disabled}
              onChange={(e) => set({ check: { ...config.check, op: e.target.value } })}>
              {EVENT_PROP_OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="Value">
            <input className="f-inp mono" value={config.check?.value ?? ''} disabled={disabled}
              onChange={(e) => set({ check: { ...config.check, value: e.target.value } })} placeholder="L.O.T Build" />
          </Field>
          <div className="tw-note" style={{ margin: '0 0 8px' }}>Matching is case-insensitive. A missing property compares as empty text.</div>
        </>) : config.check?.kind !== 'attribute' ? (
          <Field label="Event">
            <Combobox
              value={config.check?.event || ''}
              options={eventComboOptions(evDefs)}
              onChange={(v) => set({ check: { ...config.check, event: v || '' } })}
              placeholder="Search events…"
              disabled={disabled}
              allowClear={false}
              emptyLabel="No matching event — check it is registered in comms.event_definitions"
            />
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
        <div className="tw-note" style={{ margin: '0 0 10px' }}>WhatsApp quick-reply buttons. Each button becomes an outcome handle; the reply routes there, and a customer who never taps takes <span className="mono">no_reply</span> when the wait expires.</div>
        <Field label="Purpose">
          <select className="f-inp" value={config.purpose || 'utility'} disabled={disabled}
            onChange={(e) => set({ purpose: e.target.value })}>
            <option value="utility">utility</option>
            <option value="marketing">marketing</option>
          </select>
        </Field>
        <SenderPicker config={config} senders={senders} set={set} disabled={disabled} />
        {/* Two shapes of interactive send, and the difference is load-bearing:
            · TEMPLATE — the buttons are the ones Meta approved on it. Sendable any time, so
              this is what OPENS a flow (the C2P first touch).
            · FREE TEXT — buttons defined here, sent as a session message. Only valid inside
              the 24h window, i.e. as a MID-flow confirm ("Are you sure?") after the customer
              has already tapped something. */}
        <Field label="Message">
          <select className="f-inp" value={config.text !== undefined ? 'text' : 'template'} disabled={disabled}
            onChange={(e) => set(e.target.value === 'text'
              ? { text: config.text || ' ', templateId: '' }
              : { text: undefined })}>
            <option value="template">Approved template with buttons — opens a flow</option>
            <option value="text">Free text + buttons — mid-flow confirm, 24h window only</option>
          </select>
        </Field>
        {config.text !== undefined ? (
          <Field label="Message text">
            <textarea className="f-inp" rows={3} value={config.text || ''} disabled={disabled}
              onChange={(e) => set({ text: e.target.value })}
              placeholder="Are you sure that you want to cancel your order?" />
            <div className="tw-note" style={{ marginTop: 6 }}>
              Session message — delivers only if the customer messaged us in the last 24h,
              which tapping a button on the previous step guarantees. No Meta approval needed.
              Button labels are capped at 20 characters by WhatsApp.
            </div>
          </Field>
        ) : (
          <Field label="Template (WA, with buttons — must be active)">
            <select className="f-inp" value={config.templateId || ''} disabled={disabled}
              onChange={(e) => set({ templateId: e.target.value })}>
              <option value="">— pick a WhatsApp template —</option>
              {(templates || []).filter((x) => x.channel === 'whatsapp').map((x) => <option key={x.id} value={x.id}>{x.name} · v{x.version} ({x.status})</option>)}
            </select>
          </Field>
        )}
        <Field label="Wait for reply within">
          <DurationInput value={config.within || ''} disabled={disabled}
            onChange={(v) => set({ within: v })} />
        </Field>
        {/* For a TEMPLATE send, Meta echoes the button's TEXT as the payload when the template
            carries no payload parameter — so the id here must equal the button label exactly
            (verified against live whatsapp_reply events). For a free-text send the id is ours
            to choose and is returned verbatim. */}
        <Field label={config.text !== undefined
          ? 'Buttons (id is yours; label is what the customer sees · max 3)'
          : "Buttons (id must equal the template's button TEXT exactly · max 3)"}>
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
            <option value="recreate_as_prepaid">Recreate as prepaid (cancel COD + new paid order)</option>
            <option value="convert_to_prepaid">Convert to prepaid (mark Shopify order paid)</option>
            <option value="cancel">Cancel order (on Shopify)</option>
            <option value="add_tag">Add tag only</option>
          </select>
        </Field>
        {config.op === 'recreate_as_prepaid' && (
          <div className="tw-note" style={{ margin: '0 0 10px' }}>
            Builds a <strong>new paid order at the prepaid price</strong>, then cancels the COD original
            (without restocking — the replacement holds the same units). Use this, not Convert, for
            COD→prepaid: <span className="mono">Convert</span> can only settle the COD total, so it bills
            the customer the ₹50 fee plus the 3% they were promised. Requires an upstream{' '}
            <span className="mono">payment_link</span> step with <span className="mono">c2p_prepaid</span>{' '}
            pricing — it charges exactly what that link collected and refuses to run without it.
            Exposes <span className="mono">{'{new_order_number}'}</span> to later sends.
          </div>
        )}
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
          Shopify order op (mirrors BiteSpeed's Modify Order). Convert/recreate/cancel are <strong>guarded to UNFULFILLED orders</strong> (once shipped, COD is locked to the courier) and <strong>gated by the go-live switch</strong> + need <span className="mono">write_orders</span> (recreate also needs <span className="mono">write_draft_orders</span>). Outcomes: <span className="mono">done</span> · <span className="mono">not_done</span>.
        </div>
      </>)}

      {t === 'action' && config.kind === 'payment_link' && (<>
        <Field label="Purpose (shown to the customer on the payment page)">
          <input className="f-inp" value={config.purpose || ''} disabled={disabled}
            onChange={(e) => set({ purpose: e.target.value })} placeholder="Complete your order payment" />
        </Field>
        {/* `pricing` was data-only until S243, so the canvas could ONLY mint a link for the raw
            COD total — which for a COD→prepaid flow overcharges by the ₹50 fee plus the 3% the
            customer was just promised. A UI that can only produce the wrong number is worse than
            a missing field, so the choice is explicit and the C2P option is the default hint. */}
        <Field label="How much to charge">
          <select className="f-inp" value={config.pricing || ''} disabled={disabled}
            onChange={(e) => set({ pricing: e.target.value || undefined })}>
            <option value="">The order total as-is</option>
            <option value="c2p_prepaid">Prepaid price — COD→prepaid conversion (recommended for C2P)</option>
          </select>
        </Field>
        <Field label="Fixed amount (₹) — overrides the above; blank = use the order">
          <input className="f-inp mono" type="number" min="1" value={config.amount ?? ''} disabled={disabled}
            onChange={(e) => set({ amount: e.target.value === '' ? undefined : Number(e.target.value) })}
            placeholder="(from the order)" />
        </Field>
        {config.pricing === 'c2p_prepaid' ? (
          <div className="tw-note" style={{ margin: '0 0 10px' }}>
            Charges <span className="mono">(order total − COD fee) × (1 − prepaid discount)</span>, both
            read live from <strong>Settings</strong> — so a pricing change never needs a deploy or a
            journey edit. The COD fee is per <b>order</b> and comes off <b>before</b> the percentage,
            so a customer&apos;s own coupon carries through automatically. Pair this with the{' '}
            <span className="mono">Recreate as prepaid</span> order op, which charges exactly what this
            link collected and refuses to run without it.
          </div>
        ) : (
          <div className="tw-note" style={{ margin: '0 0 10px' }}>
            ⚠️ For a <strong>COD→prepaid</strong> flow this is the wrong choice — it bills the COD
            total, i.e. the COD fee plus the discount the customer was promised for paying up front.
            Pick the prepaid option above.
          </div>
        )}
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
