// Pure helpers for a bot-handled WhatsApp turn forwarded by commsops (S355, spec §5.3/§5.5).
// Kept out of index.js so the two load-bearing invariants are testable: the relay_bot marker
// (the awaiting-reply trigger reads it) and the bot_active rail (assignment + filters read it).
export function flattenReply(r) {
  const opts = Array.isArray(r?.buttons) && r.buttons.length ? '\n' + r.buttons.map((b, i) => `${i + 1}. ${b.label}`).join('\n') : '';
  return String(r?.text ?? '') + opts;
}
export function botOutboundRows({ threadId, wabaPhoneNumberId, replies, now }) {
  return (replies || []).map((r, i) => {
    // The inbox orders by created_at, and a bulk insert gives every row the same now() —
    // so both timestamps are explicit and strictly increasing, after the inbound's.
    const at = new Date(new Date(now).getTime() + (i + 1) * 5).toISOString();
    return {
      thread_id: threadId, direction: 'outbound', kind: 'text', body: flattenReply(r),
      template_name: 'relay_bot',              // THE marker: NOT-NULL template + NULL user = automated
      sent_by_user_id: null, sent_by_name: 'Relay (bot)', is_internal: false, status: 'sent',
      waba_phone_number_id: wabaPhoneNumberId || null,
      sent_at: at, created_at: at,
    };
  });
}
export function botThreadPatch({ session_status, handoff, thread, now }) {
  if (handoff || session_status === 'handed_off') {
    const p = { bot_active: false };
    if (thread?.thread_state && thread.thread_state !== 'open') Object.assign(p, { thread_state: 'open', closed_at: null, closed_by_user_id: null, snoozed_until: null, closed_reason: null, closed_note: null });
    return p;
  }
  if (session_status === 'ended') return { bot_active: false, thread_state: 'closed', closed_at: now, closed_reason: 'bot_resolved', closed_by_user_id: null };
  return { bot_active: true };
}
