// F9 R7 prep — the Docket Slack app's Events endpoint, so the app can be created WITH its event subscriptions
// (Slack verifies this URL at creation, before the signing secret exists). Until R7 it only answers the
// url_verification handshake and acknowledges events; it reads, stores and acts on nothing. Once
// SLACK_DOCKET_SIGNING_SECRET is set, every non-handshake request must carry a valid v0 signature within
// the 5-minute window, else 401.
export async function slackEvents(request, env) {
  const raw = await request.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { return new Response('bad_request', { status: 400 }); }
  if (body && body.type === 'url_verification' && typeof body.challenge === 'string' && body.challenge.length <= 200) {
    return new Response(body.challenge, { headers: { 'Content-Type': 'text/plain' } });
  }
  const secret = env.SLACK_DOCKET_SIGNING_SECRET;
  if (secret && !(await slackSignatureOk(request, raw, secret))) return new Response('bad_signature', { status: 401 });
  return new Response('', { status: 200 });   // acknowledged; handled from R7
}
export async function slackSignatureOk(request, raw, secret, nowSec = Math.floor(Date.now() / 1000)) {
  const ts = request.headers.get('x-slack-request-timestamp') || '';
  const sig = request.headers.get('x-slack-signature') || '';
  if (!/^\d+$/.test(ts) || Math.abs(nowSec - Number(ts)) > 300 || !sig.startsWith('v0=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${ts}:${raw}`)));
  const want = 'v0=' + [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ════════════════════════════════════════════════════════════════════════════
// F9 R7a — /docket, the shortcuts, modals and buttons (spec §9.1, §9.3). Pure helpers + the one Slack Web API
// helper; the routes live in index.js (they call the SAME action handlers the app calls, as the mapped person).
// Nothing here ever shows the person raw Slack or database text.
// ════════════════════════════════════════════════════════════════════════════
// The quick-add parser is the app's own (apps/docket/src/lib/quickAdd.js — pure ESM, no imports), shared, not
// forked: the same tokens mean the same thing in the capture row and in `/docket add`.
export { parseQuickAdd } from '../../apps/docket/src/lib/quickAdd.js';
import { LINKABLE_LEVELS, LINK_STATES } from './plan-core.mjs';

export const DOCKET_URL = 'https://docket.legendoftoys.com';
export const taskLink = (id) => `${DOCKET_URL}/tasks?task=${encodeURIComponent(id)}`;
export const UNLINKED = "Your Slack account isn't linked to a Docket login, so Docket can't act for you. "
  + 'Docket matches you by your work email — ask an admin to check it.';
export const USAGE = [
  '*/docket* — Docket from Slack. Everything runs as you, with your own Docket permissions.',
  '• `/docket add <task>` — add a task. Like Docket\'s quick add: `@name` sets the owner, `!p0`–`!p3` the priority, '
    + 'and a date or time the deadline (`fri 5pm`, `tomorrow`, `12 nov`). Without `@name` it is yours.',
  '• `/docket mine` — your open tasks: overdue, due today, and the next few.',
  '• `/docket propose <title> | <why>` — propose something for the plan (the founders decide).',
  '• `/docket help` — this message.',
  'Also: *Add to Docket* on any message\'s ⋯ menu, and *New Docket task* from the shortcuts menu.',
].join('\n');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLACK_ID = /^[UW][A-Z0-9]{2,30}$/;
export const isSlackUserId = (v) => typeof v === 'string' && SLACK_ID.test(v);

// application/x-www-form-urlencoded → { key: value } (last wins; Slack sends each once).
export function parseForm(raw) {
  const out = {};
  for (const [k, v] of new URLSearchParams(String(raw || ''))) out[k] = v;
  return out;
}

// `/docket <text>` → { sub: 'add'|'mine'|'propose'|'help'|'unknown', text }
export function parseCommand(text) {
  const t = String(text || '').trim();
  if (!t) return { sub: 'help', text: '' };
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(t);
  const w = m[1].toLowerCase(), rest = (m[2] || '').trim();
  if (w === 'help' || w === '?') return { sub: 'help', text: '' };
  if (w === 'mine' || w === 'my') return { sub: 'mine', text: '' };
  if (w === 'add' || w === 'propose') return rest ? { sub: w, text: rest } : { sub: 'help', text: '', missing: w };
  return { sub: 'unknown', text: t };
}

// `propose <title> | <why>` → { title, why } (no `|`: the text is both — the plan needs a why).
export function proposalFrom(text, max = { title: 200, why: 2000 }) {
  const s = String(text || '').trim();
  const i = s.indexOf('|');
  const title = (i >= 0 ? s.slice(0, i) : s).trim();
  const why = (i >= 0 ? s.slice(i + 1) : s).trim();
  if (!title) return { error: 'title_required' };
  if (!why) return { error: 'why_required' };
  if (title.length > max.title || why.length > max.why) return { error: 'text_too_long' };
  return { title, why };
}

// A Slack message → a task title: Slack markup unwrapped (<@U…> → @someone, <url|label> → label, <url> → url,
// <#C…|name> → #name), whitespace collapsed, cut at a word near `max` with an ellipsis.
export function titleFromMessage(text, max = 200) {
  let s = String(text || '')
    .replace(/<@[UW][A-Z0-9]+(?:\|([^>]+))?>/g, (_, n) => '@' + (n || 'someone'))
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!(?:here|channel|everyone)[^>]*>/g, '')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

// A date (YYYY-MM-DD, IST) → the deadline instant Docket's DatePicker writes for a date with no time: 18:00 IST.
export const deadlineIso = (date) => new Date(Date.parse(`${date}T18:00:00+05:30`)).toISOString();
export const istToday = (nowMs = Date.now()) => new Date(nowMs + 330 * 60000).toISOString().slice(0, 10);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

// ── Docket's error codes → plain words (never the raw text) ──
export function friendlyError(code, extra = {}) {
  const c = String(code || '').split(':')[0].trim();
  switch (c) {
    case 'unauthorized': case 'unlinked': return UNLINKED;
    case 'forbidden': case 'forbidden_space': case 'forbidden_docket_admin': return "You don't have permission to do that in Docket.";
    case 'not_found': case 'parent_not_found': return "That task isn't available to you in Docket.";
    case 'waiting_on': {
      const n = (Array.isArray(extra.blockers) ? extra.blockers.length : 0) + (Number(extra.hidden_open) || 0);
      return `It is still waiting on ${n || 'an'} open task${n === 1 || !n ? '' : 's'}. Mark it done in Docket, where you can confirm.`;
    }
    case 'abandoned_read_only': return 'That task is abandoned, so it is read-only. Reopen it in Docket first.';
    case 'not_receiver': return 'Only the receiver of the hand-off (or their team) can accept it.';
    case 'not_a_handoff': return "That task isn't a hand-off.";
    case 'handoff_closed': return 'That hand-off is already closed.';
    case 'reason required': return 'Give a reason for moving the date.';
    case 'reason_too_long': return 'That reason is too long.';
    case 'invalid deadline': return 'Pick a valid date.';
    case 'title required': case 'title_required': return 'Give it a title.';
    case 'why_required': return 'Say why it should be on the plan: `/docket propose <title> | <why>`.';
    case 'text_too_long': return 'That is too long.';
    case 'bad_handoff': case 'handoff_receiver_team': case 'handoff_same_team': return "That hand-off receiver can't be used — pick someone on another team.";
    case 'handoff_receiver_inactive': return 'That person has left — pick someone else to hand it to.';
    case 'restricted_needs_founders_space': case 'plan_link_level': case 'plan_item_closed': return "That plan link can't be used for this task.";
    default: return "Docket couldn't do that. Try it in Docket.";
  }
}

// ── the one Slack Web API helper: `ok:false` is an error; the error text stays here (callers get a code) ──
// Scalars go form-encoded (some read methods — users.info — refuse JSON); anything with an object goes JSON.
// A 429 / `ratelimited` is retried ONCE after Slack's Retry-After (capped at 5 s), then given up as `ratelimited`.
export const SLACK_RETRY_CAP_MS = 5000;
const wait = (ms) => new Promise(res => setTimeout(res, ms));
export async function slackApi(method, body, env, fetchImpl = fetch, { sleep = wait } = {}) {
  const token = env && env.SLACK_DOCKET_BOT_TOKEN;
  if (!token) return { ok: false, error: 'not_configured' };
  const asJson = Object.values(body || {}).some(v => v !== null && typeof v === 'object');
  const init = { method: 'POST', headers: { Authorization: `Bearer ${token}` } };
  if (asJson) { init.headers['Content-Type'] = 'application/json; charset=utf-8'; init.body = JSON.stringify(body || {}); }
  else {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(Object.entries(body || {}).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(`https://slack.com/api/${method}`, init);
      const j = await res.json().catch(() => null);
      if (j && j.ok === true) return j;
      const limited = res.status === 429 || (j && j.error === 'ratelimited');
      if (limited && attempt === 0) {
        const after = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000, SLACK_RETRY_CAP_MS));
        continue;
      }
      return { ok: false, error: limited ? 'ratelimited' : (j && j.error) || `http_${res.status}` };
    } catch { return { ok: false, error: 'network' }; }
  }
}
// A reply to a command / button through its response_url — only ever Slack's own hooks host.
export async function slackRespond(responseUrl, message, fetchImpl = fetch) {
  if (typeof responseUrl !== 'string' || !responseUrl.startsWith('https://hooks.slack.com/')) return { ok: false, error: 'bad_response_url' };
  try {
    const res = await fetchImpl(responseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, ...message }) });
    return { ok: res.ok };
  } catch { return { ok: false, error: 'network' }; }
}

// ── identity: Slack user → Docket person (spec §9.1) ──
export const IDENTITY_TTL_MS = 7 * 86400000;
// A users.info reply → the work email to match on, or null. Refused: a deleted user, a bot, a guest from another
// org (is_stranger), or anyone outside the bot's own workspace (botTeamId from auth.test — unknown = refused).
export function slackUserEmail(info, botTeamId) {
  const u = info && info.ok && info.user;
  if (!u || u.deleted || u.is_bot || u.is_stranger || !botTeamId || u.team_id !== botTeamId) return null;
  return lookupEmail(u.profile && u.profile.email);
}
// Slack user → the ONE active employee with that work email (exact, case-insensitive) → { employeeId, authUserId }.
// This alone is what an owner / hand-off pick needs (any active employee, as in the app and quick add).
// deps: { slackEmail(slackId) → email | null, employeesByEmail(email) → [{ id, auth_user_id, status, work_email }] }
export async function slackEmployee(slackUserId, deps) {
  if (!isSlackUserId(slackUserId)) return { error: 'unlinked' };
  const email = lookupEmail(await deps.slackEmail(slackUserId));
  if (!email) return { error: 'unlinked' };
  const hits = (await deps.employeesByEmail(email) || [])
    .filter(e => e.status === 'active' && String(e.work_email || '').trim().toLowerCase() === email);
  if (hits.length !== 1) return { error: 'unlinked' };
  return { employeeId: hits[0].id, authUserId: hits[0].auth_user_id || null };
}
// The person ACTING: a fresh cached row (< 7 days) first; a stale or refused one is forgotten and the person is
// re-resolved once from Slack (so a re-emailed / re-hired / re-linked account recovers instead of locking out).
// deps: slackEmployee's + { cached(slackId) → { employee_id, auth_user_id, resolved_at } | null, forget(slackId),
//        save(row), authForUser(userId) → auth | null }
// → { auth, employeeId } | { error: 'unlinked' }. No self-provision anywhere: unknown = refused.
export async function resolveSlackPerson(slackUserId, deps, nowMs = Date.now()) {
  if (!isSlackUserId(slackUserId)) return { error: 'unlinked' };
  // The login must still be active (authForUser) AND still be this employee, who must still be active.
  const accept = async (employeeId, authUserId) => {
    if (!authUserId) return null;
    const auth = await deps.authForUser(authUserId);
    if (!auth || auth.employeeId !== employeeId || auth.employeeActive === false) return null;
    auth.source = 'slack';
    return { auth, employeeId };
  };
  const row = await deps.cached(slackUserId);
  if (row) {
    const fresh = Date.parse(row.resolved_at || '') > nowMs - IDENTITY_TTL_MS;
    const hit = fresh ? await accept(row.employee_id, row.auth_user_id) : null;
    if (hit) return hit;
    await deps.forget(slackUserId);
  }
  const emp = await slackEmployee(slackUserId, deps);
  if (emp.error) return emp;
  const hit = await accept(emp.employeeId, emp.authUserId);
  if (!hit) return { error: 'unlinked' };
  await deps.save({ employee_id: emp.employeeId, slack_user_id: slackUserId, auth_user_id: emp.authUserId });
  return hit;
}

// `/docket add` → the reply: the task, who owns it, and any @name the parser couldn't place (it stays in the title).
// people: getEmployees rows; selfId: the person's employee id.
export function addReply(text, q, task, people = [], selfId = null) {
  const owner = q.owner_employee_id && q.owner_employee_id !== selfId ? people.find(p => p.id === q.owner_employee_id) : null;
  const who = owner ? `owner ${owner.full_name}` : 'yours';
  const placed = new Set((q.tokens || []).filter(t => t.kind === 'owner').map(t => t.raw.toLowerCase()));
  const notes = [];
  for (const w of String(text || '').split(/\s+/)) {
    if (!/^@[\p{L}][\p{L}._'-]*$/u.test(w) || placed.has(w.toLowerCase())) continue;
    const query = w.slice(1).toLowerCase().replace(/[._-]/g, '');
    const n = people.filter(p => [(p.preferred_name || ''), (p.full_name || '').trim().split(/\s+/)[0], (p.full_name || '').replace(/\s+/g, '')]
      .some(k => k && k.toLowerCase().startsWith(query))).length;
    const why = n > 1 ? 'matched more than one person' : 'matched no one';
    notes.push(`${esc(w)} ${why} — ${q.owner_employee_id ? 'left in the title' : 'kept as yours'}.`);
  }
  return [`Added <${taskLink(task.id)}|${esc(task.task_no)}> — ${esc(q.title)} — ${esc(who)}.`, ...notes].join('\n');
}

// ── interactive payloads → what to do ──
export function routeInteraction(p) {
  if (!p || typeof p !== 'object') return { kind: 'ignore' };
  const user = p.user && p.user.id;
  if (p.type === 'message_action' && p.callback_id === 'docket_add_from_message') {
    return { kind: 'open_task', user, trigger_id: p.trigger_id, title: titleFromMessage(p.message && p.message.text),
      channel: p.channel && p.channel.id, ts: p.message && p.message.ts, response_url: p.response_url };
  }
  if (p.type === 'shortcut' && p.callback_id === 'docket_new_task') return { kind: 'open_task', user, trigger_id: p.trigger_id, title: '' };
  if (p.type === 'view_submission' && p.view) {
    const kinds = { docket_task: 'submit_task', docket_move: 'submit_move', docket_comment: 'submit_comment' };
    const kind = kinds[p.view.callback_id];
    if (!kind) return { kind: 'ignore' };
    let meta = {};
    try { meta = JSON.parse(p.view.private_metadata || '{}') || {}; } catch { meta = {}; }
    return { kind, user, values: (p.view.state && p.view.state.values) || {}, meta };
  }
  if (p.type === 'block_actions' && Array.isArray(p.actions) && p.actions[0]) {
    const a = p.actions[0];
    const kinds = { docket_done: 'done', docket_move: 'open_move', docket_comment: 'open_comment', docket_accept: 'accept' };
    const kind = kinds[a.action_id];
    if (!kind || !UUID.test(String(a.value || ''))) return { kind: 'ignore' };
    return { kind, user, task_id: String(a.value).toLowerCase(), trigger_id: p.trigger_id, response_url: p.response_url };
  }
  return { kind: 'ignore' };
}

// ── modals ──
const pt = (text) => ({ type: 'plain_text', text: String(text).slice(0, 150), emoji: true });
const input = (block_id, label, element, optional = false, hint = null) =>
  ({ type: 'input', block_id, optional, label: pt(label), element, ...(hint ? { hint: pt(hint) } : {}) });
const meta = (o) => JSON.stringify(o).slice(0, 3000);

// planOptions: [{ id, label }] (≤ 100, Slack's cap) — the plan field only when there are some.
export function taskModal({ title = '', ownerSlackId = null, planOptions = [], meta: m = {} } = {}) {
  const blocks = [
    input('title', 'Task', { type: 'plain_text_input', action_id: 'v', max_length: 200, ...(title ? { initial_value: title.slice(0, 200) } : {}) }),
    input('owner', 'Owner', { type: 'users_select', action_id: 'v', ...(ownerSlackId ? { initial_user: ownerSlackId } : {}) }, false, 'Defaults to you.'),
    input('deadline', 'Deadline', { type: 'datepicker', action_id: 'v' }, true, 'Set once — moving it later needs a reason.'),
  ];
  if (planOptions.length) {
    blocks.push(input('plan', 'Plan link', { type: 'static_select', action_id: 'v', placeholder: pt('Unplanned'),
      options: planOptions.slice(0, 100).map(o => ({ text: pt(o.label), value: o.id })) }, true));
  }
  blocks.push(input('handoff', 'Hand off to', { type: 'users_select', action_id: 'v' }, true, 'Someone on another team; you stay the owner.'));
  if (m.permalink || (m.channel && m.ts)) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'The message link is saved on the task.' }] });
  return { type: 'modal', callback_id: 'docket_task', title: pt('Add to Docket'), submit: pt('Add task'), close: pt('Cancel'),
    private_metadata: meta(m), blocks };
}
export function moveModal(taskId, m = {}) {
  return { type: 'modal', callback_id: 'docket_move', title: pt('Move date'), submit: pt('Move'), close: pt('Cancel'),
    private_metadata: meta({ ...m, task_id: taskId }),
    blocks: [input('date', 'New date', { type: 'datepicker', action_id: 'v' }),
      input('reason', 'Why is it moving?', { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 500 })] };
}
export function commentModal(taskId, m = {}) {
  return { type: 'modal', callback_id: 'docket_comment', title: pt('Comment'), submit: pt('Post'), close: pt('Cancel'),
    private_metadata: meta({ ...m, task_id: taskId }),
    blocks: [input('body', 'Comment', { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 4000 })] };
}
export function messageModal(title, text) {
  return { type: 'modal', title: pt(title), close: pt('Close'), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: String(text).slice(0, 2900) } }] };
}

// view_submission values → { value } | { errors: { block_id: message } } (field shape only; people are mapped after)
const val = (v, b) => (v && v[b] && v[b].v) || {};
// A date-only deadline lands at 18:00 IST, so after 18:00 IST "today" would already be past.
const pastCutoff = (date, nowMs) => date < istToday(nowMs) || (date === istToday(nowMs) && new Date(nowMs + 330 * 60000).getUTCHours() >= 18);
export function validateTaskSubmission(values, nowMs = Date.now()) {
  const errors = {};
  const title = String(val(values, 'title').value || '').replace(/\s+/g, ' ').trim();
  if (!title) errors.title = 'Give the task a title.';
  else if (title.length > 200) errors.title = 'Keep it under 200 characters.';
  const owner = val(values, 'owner').selected_user || null;
  if (!owner) errors.owner = 'Pick an owner.';
  const date = val(values, 'deadline').selected_date || null;
  if (date && (!isDate(date) || date < istToday(nowMs))) errors.deadline = 'Pick today or a later date.';
  else if (date && pastCutoff(date, nowMs)) errors.deadline = "It's past 6 pm — pick tomorrow or later.";
  const plan = (val(values, 'plan').selected_option || {}).value || null;
  if (plan && !UUID.test(plan)) errors.plan = 'Pick a plan item from the list.';
  const handoff = val(values, 'handoff').selected_user || null;
  if (handoff && owner && handoff === owner) errors.handoff = 'Hand it to someone other than the owner.';
  return Object.keys(errors).length ? { errors } : { value: { title, owner, date, plan, handoff } };
}
export function validateMoveSubmission(values, nowMs = Date.now()) {
  const date = val(values, 'date').selected_date || null;
  const reason = String(val(values, 'reason').value || '').trim();
  const errors = {};
  if (!date || !isDate(date) || date < istToday(nowMs)) errors.date = 'Pick today or a later date.';
  else if (pastCutoff(date, nowMs)) errors.date = "It's past 6 pm — pick tomorrow or later.";
  if (!reason) errors.reason = 'Give a reason — the move is recorded with it.';
  else if (reason.length > 500) errors.reason = 'Keep it under 500 characters.';
  return Object.keys(errors).length ? { errors } : { value: { date, reason } };
}
export function validateCommentSubmission(values) {
  const body = String(val(values, 'body').value || '').trim();
  if (!body) return { errors: { body: 'Write a comment.' } };
  if (body.length > 4000) return { errors: { body: 'Keep it under 4,000 characters.' } };
  return { value: { body } };
}

// ── /docket mine: overdue · due today · the next few (7 days), each with Done / Move date / Comment ──
const effMs = (t) => Date.parse(t.revised_deadline || t.deadline || '');
export const MINE_CAPS = { overdue: 8, today: 8, next: 5 };   // 3 headers + 21 × 2 + the link = 46 blocks ≤ Slack's 50
export function mineSections(tasks = [], nowMs = Date.now(), caps = MINE_CAPS) {
  const today = istToday(nowMs);
  const open = tasks.filter(t => t && t.status !== 'done' && t.status !== 'abandoned' && Number.isFinite(effMs(t)))
    .sort((a, b) => effMs(a) - effMs(b) || String(a.task_no || '').localeCompare(String(b.task_no || ''), undefined, { numeric: true }));
  const day = (t) => istToday(effMs(t));
  const all = {
    overdue: open.filter(t => effMs(t) < nowMs),
    today: open.filter(t => effMs(t) >= nowMs && day(t) === today),
    next: open.filter(t => day(t) > today && effMs(t) < nowMs + 7 * 86400000),
  };
  return {
    overdue: all.overdue.slice(0, caps.overdue), today: all.today.slice(0, caps.today), next: all.next.slice(0, caps.next),
    totals: { overdue: all.overdue.length, today: all.today.length, next: all.next.length },
    undated: tasks.filter(t => t && t.status !== 'done' && t.status !== 'abandoned' && !Number.isFinite(effMs(t))).length,
  };
}
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtDue = (t) => {
  const d = new Date(effMs(t) + 330 * 60000);
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
};
export function taskButtons(t, { accept = false } = {}) {
  const b = (action_id, text, style) => ({ type: 'button', action_id, text: pt(text), value: t.id, ...(style ? { style } : {}) });
  return { type: 'actions', block_id: `task_${t.id}`, elements: [b('docket_done', 'Done', 'primary'), b('docket_move', 'Move date'), b('docket_comment', 'Comment'),
    ...(accept ? [b('docket_accept', 'Accept hand-off')] : [])] };
}
export function mineMessage(tasks, nowMs = Date.now()) {
  const s = mineSections(tasks, nowMs);
  const blocks = [];
  const section = (label, rows) => {
    if (!rows.length) return;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${label}*` } });
    for (const t of rows) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `<${taskLink(t.id)}|${esc(t.task_no || 'Task')}> ${esc(t.title)} · due ${fmtDue(t)}` } });
      blocks.push(taskButtons(t));
    }
  };
  section('Overdue', s.overdue); section('Due today', s.today); section('Next 7 days', s.next);
  const count = (k, label) => `${s.totals[k]} ${label}${s.totals[k] > s[k].length ? ` (showing ${s[k].length})` : ''}`;
  const tail = `${s.undated ? `${s.undated} more with no deadline. ` : ''}<${DOCKET_URL}/tasks|All your tasks in Docket>`;
  if (!blocks.length) return { text: `Nothing overdue or due in the next 7 days. ${tail}` };
  blocks.length = Math.min(blocks.length, 49);   // the caps keep it far below; the link is always the last block
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: tail }] });
  return { text: `${count('overdue', 'overdue')}, ${count('today', 'due today')}, ${count('next', 'in the next 7 days')}.`, blocks };
}
// getPlan items → the modal's plan options: what linkError would accept (F/O/T, or a theme at R; proposed/agreed),
// ordered by code. Slack caps a static_select at 100; a longer plan shows the first 100 (the app has them all).
export function planOptions(items = []) {
  return items.filter(i => i && UUID.test(String(i.id || '')) && LINK_STATES.includes(i.state)
      && (LINKABLE_LEVELS.includes(i.level) || (i.level === 'R' && i.kind === 'theme')))
    .sort((a, b) => String(a.code || '').localeCompare(String(b.code || ''), undefined, { numeric: true }))
    .slice(0, 100).map(i => ({ id: i.id, label: `${i.code ? i.code + ' ' : ''}${i.title || ''}`.trim().slice(0, 75) }));
}

// A Slack work email → may it be looked up? (a plain address only: the lookup is a case-insensitive exact match)
export const lookupEmail = (email) => {
  const e = String(email || '').trim().toLowerCase();
  return /^[a-z0-9.+-]+(?:_[a-z0-9.+-]+)*@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) ? e : null;
};
