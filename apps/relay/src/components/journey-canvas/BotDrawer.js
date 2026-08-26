'use client';
// Config form for the selected BOT canvas node (S312). Mirrors NodeDrawer's contract:
// pure controlled component — receives the node's config, calls onChange(partial) /
// onDelete(). Kept separate from NodeDrawer on purpose: the journey forms are dense
// (templates, senders, purposes) and none of it applies to a bot step.
import { Trash2 } from 'lucide-react';

function Field({ label, children }) {
  return <div className="ff" style={{ marginBottom: 10 }}><div className="kv-k">{label}</div>{children}</div>;
}

// Mint a stable-ish button id from its label — lowercase slug, b_ prefix, deduped by index.
function buttonId(label, i) {
  const slug = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return `b_${slug || 'opt'}_${i}`;
}

export default function BotDrawer({ nodeId, config, onChange, onDelete, readOnly }) {
  if (!config) return null;
  const c = config;
  // Same contract as NodeDrawer:113 — onChange receives the FULL next config (the page
  // REPLACES the node's config with what it gets), so every set merges onto the current.
  const set = (patch) => onChange({ ...config, ...patch });

  const setButton = (i, label) => {
    const buttons = (c.buttons || []).map((b, j) => (j === i ? { ...b, label } : b));
    set({ buttons });
  };
  // ⚠️ Re-minting an id on RENAME would orphan the button's edge (edges key on handle id),
  // so ids are minted once at ADD and never changed by typing.
  const addButton = () => set({ buttons: [...(c.buttons || []), { id: buttonId('opt', (c.buttons || []).length + 1) + Date.now().toString(36).slice(-3), label: '' }] });
  const rmButton = (i) => set({ buttons: (c.buttons || []).filter((_, j) => j !== i) });

  return (
    <div>
      {c.type === 'message' && (
        <Field label="Message text">
          <textarea className="f-inp" rows={4} value={c.text || ''} disabled={readOnly}
            onChange={(e) => set({ text: e.target.value })} placeholder="Hi! I'm the LOT assistant." />
        </Field>
      )}

      {c.type === 'menu' && (
        <>
          <Field label="Menu text">
            <textarea className="f-inp" rows={3} value={c.text || ''} disabled={readOnly}
              onChange={(e) => set({ text: e.target.value })} placeholder="How can I help you today?" />
          </Field>
          <Field label="Options (each becomes a button + a branch)">
            {(c.buttons || []).map((b, i) => (
              <div key={b.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <input className="f-inp" value={b.label} disabled={readOnly} placeholder={`Option ${i + 1}`}
                  onChange={(e) => setButton(i, e.target.value)} />
                {!readOnly && (
                  <button className="btn" type="button" onClick={() => rmButton(i)} title="Remove option"><Trash2 size={13} /></button>
                )}
              </div>
            ))}
            {!readOnly && <button className="btn" type="button" onClick={addButton}>+ Add option</button>}
          </Field>
          <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
            Free text that matches no option re-shows the menu; after 2 misses the customer
            follows the <b>Not understood</b> branch — wire it (usually to Hand to agent).
          </div>
        </>
      )}

      {c.type === 'collect' && (
        <>
          <Field label="What to ask for">
            <select className="f-inp" value={c.field || 'phone_or_email'} disabled={readOnly}
              onChange={(e) => set({ field: e.target.value })}>
              <option value="phone_or_email">Phone or email (identity)</option>
              <option value="order_number">Order number</option>
            </select>
          </Field>
          <Field label="Prompt">
            <textarea className="f-inp" rows={2} value={c.prompt || ''} disabled={readOnly}
              onChange={(e) => set({ prompt: e.target.value })}
              placeholder={c.field === 'order_number' ? 'Your order number? (e.g. #12345)' : 'Your phone or email, so we can help?'} />
          </Field>
          <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
            Answers are validated — an invalid value re-asks without moving on.
          </div>
        </>
      )}

      {c.type === 'action' && c.kind === 'order_status' && (
        <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
          Looks the order up and replies with its live status. <b>Verified:</b> the order's own
          phone/email must match what the customer gave earlier — a mismatch follows the
          <b> Not found</b> branch and never reveals whether the order exists. Needs a
          <b> Phone or email</b> ask and an <b>Order number</b> ask earlier in the flow.
        </div>
      )}

      {c.type === 'handoff' && (
        <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
          Ends the bot's part and places the conversation in the Pitstop inbox. Inside business
          hours the customer is told an agent is coming; outside, that the team will reply when
          back. The bot never speaks again in this conversation.
        </div>
      )}

      {c.type === 'end' && (
        <Field label="Goodbye text (optional)">
          <textarea className="f-inp" rows={2} value={c.text || ''} disabled={readOnly}
            onChange={(e) => set({ text: e.target.value })} placeholder="Anything else, just say hi!" />
        </Field>
      )}

      {!readOnly && (
        <button className="btn" type="button" onClick={onDelete}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--red, #DE2A2A)' }}>
          <Trash2 size={13} /> Delete step
        </button>
      )}
    </div>
  );
}
