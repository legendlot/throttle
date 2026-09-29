// Plain-English Funnel (Pruthvi, #bugs 1790600384, 2026-09-28: "display the actual reasons
// behind each funnel dropout and rejection instead of showing them in code language").
//
// The Funnel panel read like engine output: "Condition msllqe271", "SKIPPED: 4004", and a
// "−4,217 (78%) did not reach this step" that was an artefact of sorting steps by count (the
// shared Exit step, which every path lands on, sorted third and made the next Wait look like a
// 78% cliff). Pure functions only — no React — so they run under plain `node` (funnel.test.js).
//
//  · describeStep  — names a step from its CONFIG ("Wait 30 minutes", "Still no order placed
//                    since they entered?", "Send WhatsApp: <template name>"), not its random id.
//  · orderSteps    — the journey's own path order (walk from `entry`), Exit steps last.
//  · dropInto      — the "−N did not get past X" line, ONLY where it is true: the step has one
//                    parent and that parent leads nowhere else. Breadth-first order puts sibling
//                    branches next to each other (C2P: Cancel under No-response), and comparing a
//                    row with the row above it invented drops there (hostile review S403).
//  · humanReason   — why a send did not go out, from `journey_funnel.reasons` (migration 0079).
//  · stopLabel     — where people stopped and why, from `journey_funnel.stopped`, naming the
//                    events behind each exit rule ("Moved on — add to cart, checkout started").

import { humanStepId, humanEnrolmentStatus } from './labels.js';

// `order_placed` → `order placed`. Event names are snake_case registry keys; this is the
// readable form, never a translation.
export function humanEvent(name) {
  return String(name || '').trim().replace(/[_\-.]+/g, ' ') || 'an event';
}

const CHANNEL = { whatsapp: 'WhatsApp', email: 'email', sms: 'SMS', rcs: 'RCS', voice: 'call' };
const OP = { eq: 'is', neq: 'is not', gt: 'is more than', lt: 'is less than', contains: 'contains', in: 'is one of' };
const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// Every definition this journey has had, oldest first, so the chosen version's config wins
// and a step that only exists in another version still gets named ("All versions" mixes them).
// `activeVersion` is the version the Funnel is showing; its entry + steps drive the path order.
export function stepConfigMap(versions, activeVersion) {
  const list = (Array.isArray(versions) ? versions : [])
    .filter((v) => v && v.definition && v.definition.steps)
    .slice()
    .sort((a, b) => (a.version === activeVersion) - (b.version === activeVersion) || (a.version || 0) - (b.version || 0));
  const map = {};
  for (const v of list) Object.assign(map, v.definition.steps);
  const active = list.length ? list[list.length - 1].definition : null;
  return { steps: map, entry: active?.entry || null, activeSteps: active?.steps || {} };
}

export function describeStep(stepId, cfg, templateNames = {}) {
  const c = cfg || null;
  if (!c || !c.type) return humanStepId(stepId);
  switch (c.type) {
    case 'wait':
      return c.duration ? `Wait ${c.duration}` : 'Wait';
    case 'wait_response': {
      // `awaited` names what it waits FOR — C2P pay_wait awaits payment_link_paid, not a reply.
      const aw = (Array.isArray(c.awaited) ? c.awaited : []).filter(Boolean);
      const what = aw.length ? aw.map(humanEvent).join(' or ') : 'a reply';
      return c.within ? `Wait up to ${c.within} for ${what}` : `Wait for ${what}`;
    }
    case 'condition': {
      const k = c.check || {};
      if (k.kind === 'no_event_since_enrol') return `Still no ${humanEvent(k.event)} since they entered?`;
      if (k.kind === 'event_since_enrol') return `Did ${humanEvent(k.event)} since they entered?`;
      if (k.kind === 'attribute') return `Check: ${humanEvent(k.attr)} ${own(OP, k.op) ? OP[k.op] : OP.eq} ${k.value ?? ''}`;
      if (k.kind === 'event_property') return `Check: ${humanEvent(k.field)} ${own(OP, k.op) ? OP[k.op] : OP.eq} "${k.value ?? ''}"`;
      return 'Check';
    }
    case 'send': {
      const ch = CHANNEL[c.channel] || c.channel || 'message';
      const tpl = own(templateNames, c.templateId) ? templateNames[c.templateId] : null;
      const what = c.interactive ? `${ch} with buttons` : ch;
      return tpl ? `Send ${what}: ${tpl}` : `Send ${what}`;
    }
    case 'action':
      if (c.kind === 'payment_link') return 'Create a payment link';
      if (c.kind === 'order_modify') {
        // Three C2P steps are all op:add_tag — the tag is what tells them apart.
        const tags = (Array.isArray(c.tags) ? c.tags : []).filter(Boolean);
        if (c.op === 'add_tag') return tags.length ? `Tag the order "${tags.join(', ')}"` : 'Tag the order';
        return `Change the order (${humanEvent(c.op || 'convert to prepaid')})`;
      }
      if (c.kind === 'order_status') return 'Look up the order';
      if (c.kind === 'set_attr') return `Set ${humanEvent(c.attr)} to ${c.value ?? ''}`;
      return 'Action';
    case 'exit':
      return !c.outcome || c.outcome === 'completed' ? 'End of journey' : `End of journey (${humanEvent(c.outcome)})`;
    default:
      return humanStepId(stepId);
  }
}

// Walk the graph from `entry` in outcome order (breadth-first), so the list reads top to
// bottom the way the journey runs. Exit steps go last — several paths merge into one, and in
// the middle of the list a merge point reads as a step people "reached" from the step above.
// Steps the graph no longer has (old versions) follow, by volume, as before.
export function orderSteps(steps, entry, stepDefs) {
  const rank = {};
  if (entry && stepDefs && stepDefs[entry]) {
    const queue = [entry];
    let n = 0;
    while (queue.length) {
      const id = queue.shift();
      if (id in rank || !stepDefs[id]) continue;
      rank[id] = n++;
      for (const next of Object.values(stepDefs[id].outcomes || {})) {
        if (typeof next === 'string' && !(next in rank)) queue.push(next);
      }
    }
  }
  const isExit = (s) => s.step_type === 'exit';
  return (steps || []).slice().sort((a, b) => {
    const ea = isExit(a), eb = isExit(b);
    if (ea !== eb) return ea ? 1 : -1;
    const ra = rank[a.step_id], rb = rank[b.step_id];
    if (ra != null && rb != null) return ra - rb;
    if (ra != null) return -1;
    if (rb != null) return 1;
    return Number(b.entered || 0) - Number(a.entered || 0);
  });
}

// Why a message was not sent (or an action not done). Keys are `result.reason` cut at the
// first ':' (0079).
const REASON = {
  no_consent: 'No marketing consent on this channel',
  no_phone_identifier: 'No phone number on the profile',
  no_phone: 'No phone number on the profile',
  no_identity: 'No phone or email on the profile',
  freq_cap: 'Already messaged recently (frequency cap)',
  budget_exhausted: "Today's send budget was used up",
  gate_error: 'The send check itself errored',
  suppressed: 'On the do-not-contact list',
  excluded: "Excluded by this journey's exclusion rules",
  quiet_hours: 'Quiet hours — not sent at night',
  window_closed: 'WhatsApp 24-hour reply window had closed',
  opted_out: 'Customer opted out',
  invalid_phone: 'Phone number is not valid',
  unresolved_variables: 'Missing details to fill the message (e.g. cart link)',
  insufficient_stock: 'Product was out of stock',
  payment_links_disabled: 'Payment links are switched off',
  template_not_found: 'Message template not found',
  wa_132001: 'WhatsApp rejected it — template name not found / not approved',
  wa_130429: 'WhatsApp rate limit hit',
  wa_131000: 'WhatsApp error (temporary)',
  wa_2: 'WhatsApp service temporarily unavailable',
  wa_http_522: 'WhatsApp could not be reached',
  cod_flow_disabled: 'COD flow is switched off',
  already_cancelled: 'Order was already cancelled',
  shopify_auth: 'Shopify refused the request',
  shopify_graphql: 'Shopify refused the request',
  unknown: 'No reason recorded',
};

export function humanReason(key) {
  const raw = String(key || '').trim();
  if (!raw) return REASON.unknown;
  if (own(REASON, raw)) return REASON[raw];
  const wa = raw.match(/^wa_(?:http_)?(\d+)$/);
  if (wa) return `WhatsApp error (code ${wa[1]})`;
  return raw.charAt(0).toUpperCase() + raw.slice(1).replace(/[_\-]+/g, ' ');
}

// `journey_funnel.reasons[step]` → [{ status, reason, label, n }], biggest first.
export function reasonRows(byStatus) {
  const out = [];
  for (const [status, reasons] of Object.entries(byStatus || {})) {
    for (const [reason, n] of Object.entries(reasons || {})) {
      out.push({ status, reason, label: humanReason(reason), n: Number(n) || 0 });
    }
  }
  return out.sort((a, b) => b.n - a.n);
}

// Exit-rule outcome → the events that trigger it, from the journey's own exit_rules, so a
// "progressed" chip can say it means "added to cart / started checkout" for THIS journey.
export function exitRuleEvents(exitRules) {
  const map = {};
  for (const r of Array.isArray(exitRules) ? exitRules : []) {
    const o = String(r?.outcome || '').trim();
    if (!o || !r.event) continue;
    (map[o] = map[o] || []).push(humanEvent(r.event));
  }
  return map;
}

const STOP = {
  active: 'still waiting here',
  completed: 'finished the journey',
  expired: 'ran out of time (journey time limit)',
  failed: 'stopped by an error',
  send_failed: 'stopped — a message failed to send',
};

// One enrolment status, as the reason someone stopped. Exit-rule outcomes name their events.
export function stopLabel(status, ruleEvents = {}) {
  const evs = own(ruleEvents, status) ? ruleEvents[status] : null;
  if (Array.isArray(evs) && evs.length) return `left — ${evs.join(' / ')}`;
  return own(STOP, status) ? STOP[status] : humanEnrolmentStatus(status).toLowerCase();
}

// Summary chip: the status plus, for an exit-rule outcome, what it means here.
export function statusChipLabel(status, ruleEvents = {}) {
  const base = humanEnrolmentStatus(status);
  const evs = own(ruleEvents, status) ? ruleEvents[status] : null;
  return Array.isArray(evs) && evs.length ? `${base} (${evs.join(' / ')})` : base;
}

// The drop INTO a step, or null when a drop would not be true.
// Only when: the step has exactly ONE parent in the shown version's graph, and every outcome of
// that parent leads to this step (a wait / plain send). Then parent.entered − step.entered is
// exactly the people who stopped at the parent — its "Stopped here" list says why. A branching
// parent (condition, buttons) splits people on purpose; its own chips already say how.
export function dropInto(stepId, stepDefs, enteredById) {
  if (!stepDefs || !own(stepDefs, stepId)) return null;
  const parents = Object.keys(stepDefs).filter((id) =>
    Object.values(stepDefs[id]?.outcomes || {}).includes(stepId));
  if (parents.length !== 1) return null;
  const p = parents[0];
  const targets = Object.values(stepDefs[p]?.outcomes || {});
  if (!targets.length || targets.some((t) => t !== stepId)) return null;
  const from = Number(enteredById[p] || 0);
  const to = Number(enteredById[stepId] || 0);
  if (!from || to > from) return null;
  return { parent: p, lost: from - to, pct: Math.round(((from - to) / from) * 100) };
}
