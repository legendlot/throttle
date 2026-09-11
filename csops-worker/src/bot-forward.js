// Pure helpers for a bot-handled WhatsApp turn forwarded by commsops (S355, spec §5.3/§5.5).
// Kept out of index.js so the two load-bearing invariants are testable: the relay_bot marker
// (the awaiting-reply trigger reads it) and the bot_active rail (assignment + filters read it).
export function flattenReply(r) {
  const opts = Array.isArray(r?.buttons) && r.buttons.length ? '\n' + r.buttons.map((b, i) => `${i + 1}. ${b.label}`).join('\n') : '';
  return String(r?.text ?? '') + opts;
}
export function botOutboundRows({ threadId, wabaPhoneNumberId, replies, now, ticketId }) {
  return (replies || []).map((r, i) => {
    // The inbox orders by created_at, and a bulk insert gives every row the same now() —
    // so both timestamps are explicit and strictly increasing. `now` must be the INSERT
    // time (caller stamps it after the inbound round-trip), strictly AFTER the inbound
    // row's created_at (DB now() at insert, not Meta's `ts`) — else the bot's reply sorts
    // above the customer's message it is replying to.
    const at = new Date(new Date(now).getTime() + (i + 1) * 5).toISOString();
    return {
      thread_id: threadId, direction: 'outbound', kind: 'text', body: flattenReply(r),
      template_name: 'relay_bot',              // THE marker: NOT-NULL template + NULL user = automated
      sent_by_user_id: null, sent_by_name: 'Relay (bot)', is_internal: false, status: 'sent',
      waba_phone_number_id: wabaPhoneNumberId || null,
      ticket_id: ticketId || null,
      sent_at: at, created_at: at,
    };
  });
}
// The rail has NO expiry writer: `bot_active` only flips back on the customer's NEXT inbound
// (bot-wa.js's 6h idle expire, or any turn the bot declines — declinedTurnPatch), on a human
// outbound, or on a manual agent action. An abandoned
// session therefore holds the thread out of Awaiting/unread/auto-assign FOREVER — and a web
// session has no inbound-driven expiry at all. So every READER treats the rail as live only
// while the customer was here inside the same 6h window the session itself uses.
export const BOT_RAIL_TTL_MS = 6 * 3600 * 1000;
export function railLive(thread, nowMs) {
  if (!thread || !thread.bot_active) return false;
  const t = Date.parse(thread.last_inbound_at || '');
  if (!Number.isFinite(t)) return false;   // no inbound ever recorded: nothing to keep alive
  return t > (nowMs ?? Date.now()) - BOT_RAIL_TTL_MS;
}
export function botThreadPatch({ session_status, handoff, thread, now }) {
  if (handoff || session_status === 'handed_off') {
    const p = { bot_active: false };
    if (thread?.thread_state && thread.thread_state !== 'open') Object.assign(p, { thread_state: 'open', closed_at: null, closed_by_user_id: null, snoozed_until: null, closed_reason: null, closed_note: null });
    return p;
  }
  // Self-served -> close as bot_resolved, so ~450 abandoned threads/week do not sit in Awaiting.
  // ⚠️ NOT when an agent owns the thread: the bot must never close somebody's assigned thread out
  // from under them (they may still be mid-reply). Drop the rail and leave it open for its owner.
  if (session_status === 'ended') {
    if (thread?.assigned_agent_id) return { bot_active: false };
    return { bot_active: false, thread_state: 'closed', closed_at: now, closed_reason: 'bot_resolved', closed_by_user_id: null, snoozed_until: null };
  }
  return { bot_active: true };
}
// A WhatsApp inbound the bot did NOT take (no `m.bot.handled`): bot paused/none active, not in
// pilot, opt-out keyword, human active, enrolled, unsupported kind, sticky handoff, or a bot-side
// error — bot-wa.js fails every one of those CLOSED, "forward exactly as today". Nobody automated
// is answering this message, so the rail must drop: left TRUE, every new line refreshes
// last_inbound_at and railLive hides a customer writing to a paused bot from agents indefinitely.
// Event-driven on purpose (§S355d: the column is not swept). Merged into the inbound's own PATCH.
// ⚠️ First delivery only — never the pmid-dedup branch: a redelivery whose bot run hit a transient
// error would otherwise drop the rail the FIRST delivery's handled turn legitimately set.
// ⚠️ Only a message the bot COULD have taken (S372 hostile review). The bot never takes a
// reaction/location/contacts/unsupported message (bot-wa.js condition 7) even mid-session, so a
// customer's 👍 on a bot line is not a decline — clearing on it let auto-assign pull an agent in
// (and the assignment trigger pinned the rail false) while the session was still live.
// Mirrors bot-wa.js's `kindOk` list; keep the two in step.
export const BOT_TAKEABLE_TYPES = ['text', 'interactive', 'button', 'image', 'video', 'audio', 'document', 'sticker'];
export function declinedTurnPatch(bot, thread, type) {
  if (!BOT_TAKEABLE_TYPES.includes(type || 'text')) return {};
  return !bot?.handled && thread?.bot_active ? { bot_active: false } : {};
}
