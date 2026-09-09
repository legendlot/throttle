// ── S362 (2026-09-09) — ONE CUSTOMER, ONE NUMBERLESS THREAD ──────────────────
//
// `cs_wa_threads_phone_null_waba_idx` is UNIQUE (customer_phone) WHERE
// waba_phone_number_id IS NULL. Inserting a numberless row for a phone that ALREADY owns
// one therefore raises 23505, which PostgREST returns as HTTP 409.
//
// Three sites in index.js insert such a row. Two of them look the incumbent up by phone
// first, so for those a 23505 is only ever a race. The third — the web bot's
// `handleRelayWebForward` — looks up by `relay_web_session_id`, which is NEW EVERY SESSION,
// so the lookup can never find the phone's existing thread. Every returning customer hit
// the conflict, csops answered 500, and commsops dropped the entire transcript on the floor
// (found by the S359 hostile review; 10,253 such threads were live landmines).
//
// Adopting the incumbent is the only correct outcome: a second numberless row for the same
// phone cannot exist by construction, so there is nothing else to create. Afshaan chose this,
// option (a), over scoping the index to WhatsApp.
// ⚠️ THE REASON FIRST RECORDED FOR REJECTING (b) WAS WRONG, corrected by the S362 hostile review.
// It said the index is "the only uniqueness guard for the Chatwoot webhook's
// instagram/messenger/email inserts". It is not: those rows carry `customer_phone = NULL`
// (measured 2026-09-09 — instagram 4 with a phone vs 4,483 without, email 0 vs 2,650, messenger
// 0 vs 23) and a UNIQUE index never constrains NULLs. Their real guard is
// `cs_wa_threads_provider_ref_uniq`. Option (a) is still right, on the "one customer, one thread"
// argument alone — but do not defend it with the duplicate-channels claim.
//
// ⚠️ MEASURED 2026-09-09 BEFORE WRITING THIS, and it is the whole reason for the guard below:
// of the 10,253 threads that have a phone AND no waba id, 8,977 are legacy `whatsapp`, 1,272 are `web` (only 3 of
// them relay_web) and 4 are instagram. So the thread we adopt is USUALLY NOT the same channel
// as the row we were trying to insert. That is what "one customer, one thread" costs here, and
// it is accepted — but it is why adoption must NEVER relabel the thread it adopts.
//
// `relay_web=true` is the POSITIVE MARKER that separates Relay web-bot threads from the legacy
// Chatwoot web widget (reference/decisions.md — "DO NOT let exclude channel='web' swallow the
// NEW web channel"). Stamping it, or `channel`, onto an adopted WhatsApp thread would silently
// corrupt every query that reads either. Channel provenance survives where it belongs: on the
// MESSAGE rows, which carry their own `channel`.

/** Keys adoption may never write onto a thread it did not create. See the header. */
export const ADOPT_PROTECTED_KEYS = Object.freeze(['channel', 'relay_web']);

/**
 * PostgREST surfaces a unique violation as HTTP 409 carrying SQLSTATE 23505.
 * ⚠️ THE SQLSTATE IS THE TEST, NOT THE STATUS (S362 hostile review). PostgREST also maps
 * foreign-key (23503) and exclusion violations to 409, and adopting on one of those would convert
 * a diagnosable error into a silent behaviour change. The status stays only as a fallback for a
 * 409 whose body did not parse.
 */
export function isUniqueViolation(res) {
  const code = res?.data?.code;
  if (code) return code === '23505';
  return res?.status === 409;
}

/**
 * Strip the protected keys from a caller's adopt patch. Returns a NEW object; never mutates.
 * Silent by design at the call sites (they pass literals), but it returns the dropped keys so
 * a test — and a future caller — can see that the guard actually fired.
 */
export function adoptPatch(patch) {
  const clean = {};
  const dropped = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (ADOPT_PROTECTED_KEYS.includes(k)) dropped.push(k);
    else clean[k] = v;
  }
  return { patch: clean, dropped };
}

/**
 * Find the phone's existing numberless thread and (optionally) stamp `patch` onto it.
 * Returns the thread, or null when there is nothing to adopt or the patch failed — callers
 * treat null as "fall through to the original error path", never as success.
 *
 * `deps.sb` is injected so this is testable without a network: index.js passes its own sb().
 */
export async function adoptNumberlessThread(phone, env, patch, deps) {
  const { sb, log = console } = deps || {};
  if (!phone || typeof sb !== 'function') return null;

  const r = await sb(
    `/rest/v1/cs_wa_threads?customer_phone=eq.${encodeURIComponent(phone)}&waba_phone_number_id=is.null`
    + '&select=*&order=last_message_at.desc.nullslast&limit=1', env);
  const t = r?.data?.[0] || null;
  // Lost the race and the incumbent is gone: let the caller report its original failure
  // rather than inventing a thread.
  if (!t) return null;

  const { patch: safe, dropped } = adoptPatch(patch);
  if (dropped.length) log.error?.(`[adopt] refused to rewrite ${dropped.join(',')} on adopted thread ${t.id}`);

  if (Object.keys(safe).length) {
    const up = await sb(`/rest/v1/cs_wa_threads?id=eq.${t.id}`, env,
      { method: 'PATCH', body: JSON.stringify(safe) });
    if (!up?.ok) {
      log.error?.('[adopt] patch failed', up?.status, JSON.stringify(up?.data).slice(0, 200));
      return null;
    }
    Object.assign(t, safe);
  }
  log.log?.(`[adopt] reused numberless thread ${t.id} channel=${t.channel} for ${phone}`);
  return t;
}
