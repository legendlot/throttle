// General-space rethink P4 — Announcements (migration 0040). Pure: the team tree, input validation, who sees a post,
// ordering, the Slack mirror's settings / targets / message. The worker (index.js) reads, gates and writes; nothing
// here touches the network.
//   Teams are a hierarchy (podium.departments.parent_department_id) and a team post reaches the team's whole SUBTREE
//   (Afshaan, hostile review P4 #2). Built from the ACTIVE departments only (one read).
//   Posting: founders (docket_plan_admin) to everyone or any active team; a team head (head_employee_id) to the teams
//   they head and every team below them. Seeing: everyone-posts, your own posts, and a post naming any team in your
//   reader set (readerTeams: your team + its ancestors + the teams you head + their descendants); founders see all.
//   An exited employee has no team, heads nothing and is no founder here (everyone-posts only). Edit / archive: the
//   author or a founder.
//   Mirror (docket.settings.announcements): 'off' sends nothing · 'test' posts to no channel, only DMs the test
//   recipients · 'live' posts an everyone-post to org_channel and a team post to each team's channel (none set → no
//   mirror for that team). Only on create — never on an edit.
import { DOCKET_URL } from './slack-core.mjs';

export const ANN_MODES = ['off', 'test', 'live'];
export const ANN_TITLE_MAX = 200;
export const ANN_BODY_MAX = 5000;
export const CHANNEL_RE = /^[CG][A-Z0-9]{6,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// ── the team tree ──
// Active departments [{ id, parent_department_id, head_employee_id, name }] → { ids: Set, parent: Map, children: Map }.
// An inactive department (or one the read didn't return) is not in the tree: its subtree is cut off there.
export function deptTree(rows) {
  const live = (rows || []).filter(d => d && d.id && d.active !== false);
  const ids = new Set(live.map(d => lc(d.id)));
  const parent = new Map(), children = new Map();
  for (const d of live) {
    const p = d.parent_department_id ? lc(d.parent_department_id) : null;
    if (p && ids.has(p) && p !== lc(d.id)) {
      parent.set(lc(d.id), p);
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(lc(d.id));
    }
  }
  return { ids, parent, children };
}
// A team's ancestors (not itself), nearest first. A cycle stops at the first repeat.
export function ancestors(tree, id) {
  const out = [], seen = new Set([lc(id)]);
  for (let p = tree.parent.get(lc(id)); p && !seen.has(p); p = tree.parent.get(p)) { seen.add(p); out.push(p); }
  return out;
}
// The teams + everything below them (a Set, the teams themselves included even if not in the tree). Cycle-safe.
export function descendants(tree, ids) {
  const out = new Set(), stack = (ids || []).map(lc);
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const c of tree.children.get(id) || []) stack.push(c);
  }
  return out;
}
// The active teams an employee heads.
export const headedTeams = (tree, rows, employeeId) => (employeeId
  ? (rows || []).filter(d => d && d.head_employee_id && lc(d.head_employee_id) === lc(employeeId) && tree.ids.has(lc(d.id))).map(d => lc(d.id)) : []);
// A reader's team set: their own team + its ancestors (a post to a parent team reaches them) + the teams they head +
// everything below those.
export function readerTeams(tree, { departmentId = null, headOf = [] } = {}) {
  const out = descendants(tree, headOf);
  if (departmentId) { out.add(lc(departmentId)); for (const a of ancestors(tree, departmentId)) out.add(a); }
  return out;
}
// Where a head may post: the teams they head and every team below them (active only).
export const postableTeams = (tree, headOf) => [...descendants(tree, headOf)].filter(id => tree.ids.has(id));

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const lc = (s) => String(s || '').toLowerCase();

export const announcementLink = (id) => `${DOCKET_URL}/announcements?id=${encodeURIComponent(id)}`;

// ── settings ──
// The stored value → { mode, org_channel, team_channels, test_employee_ids }. Read leniently: an unknown mode is 'off'
// (send nothing — never guessed), a malformed channel or id is dropped.
export function parseAnnouncementSettings(v) {
  const o = isObj(v) ? v : {};
  const mode = ANN_MODES.includes(o.mode) ? o.mode : 'off';
  const org_channel = typeof o.org_channel === 'string' && CHANNEL_RE.test(o.org_channel) ? o.org_channel : null;
  const team_channels = {};
  if (isObj(o.team_channels)) {
    for (const [k, c] of Object.entries(o.team_channels)) if (UUID.test(k) && typeof c === 'string' && CHANNEL_RE.test(c)) team_channels[lc(k)] = c;
  }
  const test_employee_ids = Array.isArray(o.test_employee_ids)
    ? [...new Set(o.test_employee_ids.filter(x => typeof x === 'string' && UUID.test(x)).map(lc))] : [];
  return { mode, org_channel, team_channels, test_employee_ids };
}
// An admin's save → { value } | { error, field }. Strict (a bad value is refused, never dropped). A field left out
// keeps its current value; '' / null clears a channel. Channel ids are trimmed and upper-cased first.
export function validateAnnouncementSettings(d, current) {
  const cur = parseAnnouncementSettings(current);
  const out = { ...cur, team_channels: { ...cur.team_channels } };
  const chan = (v) => (v == null ? '' : String(v).trim().toUpperCase());
  if (d.mode !== undefined) {
    if (!ANN_MODES.includes(d.mode)) return { error: 'bad_mode', field: 'mode' };
    out.mode = d.mode;
  }
  if (d.org_channel !== undefined) {
    const c = chan(d.org_channel);
    if (c && !CHANNEL_RE.test(c)) return { error: 'bad_channel', field: 'org_channel' };
    out.org_channel = c || null;
  }
  if (d.team_channels !== undefined) {
    if (!isObj(d.team_channels)) return { error: 'bad_team_channels', field: 'team_channels' };
    const next = {};
    for (const [k, v] of Object.entries(d.team_channels)) {
      if (!UUID.test(k)) return { error: 'bad_team', field: 'team_channels' };
      const c = chan(v);
      if (!c) continue;
      if (!CHANNEL_RE.test(c)) return { error: 'bad_channel', field: 'team_channels.' + k };
      next[lc(k)] = c;
    }
    out.team_channels = next;
  }
  if (d.test_employee_ids !== undefined) {
    if (!Array.isArray(d.test_employee_ids) || d.test_employee_ids.some(x => typeof x !== 'string' || !UUID.test(x))) {
      return { error: 'bad_test_employee_ids', field: 'test_employee_ids' };
    }
    out.test_employee_ids = [...new Set(d.test_employee_ids.map(lc))];
  }
  return { value: out };
}

// ── input ──
// Body: CRLF → LF, ends trimmed, inner line breaks kept. Title: one line, trimmed.
export const cleanTitle = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
export const cleanBody = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : '');
// An expiry: null / '' = none; 'YYYY-MM-DD' = the end of that day in IST; else a full ISO timestamp WITH an offset
// (Z or ±HH:MM — never a bare local time, read differently by each runtime). The date must exist (2027-02-30 is
// refused, not rolled into March). Must be in the future. → { value: iso | null } | { error }
const ISO_TS = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const realDate = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
export function parseExpiry(v, nowMs = Date.now()) {
  if (v == null || v === '') return { value: null };
  if (typeof v !== 'string') return { error: 'bad_expires_at' };
  const m = DATE.test(v) ? [v, v] : ISO_TS.exec(v);
  if (!m || !realDate(m[1])) return { error: 'bad_expires_at' };
  const ms = DATE.test(v) ? Date.parse(`${v}T23:59:59+05:30`) : Date.parse(v);
  if (!Number.isFinite(ms)) return { error: 'bad_expires_at' };
  if (ms <= nowMs) return { error: 'expires_in_past' };
  return { value: new Date(ms).toISOString() };
}
const bool = (v) => v === true || v === 'true';

// A create → { value: { title, body, audience, team_ids, pinned, expires_at } } | { error, status }.
// rights = { everyone: bool, department_ids: [...] } (announceRights): a founder holds every active team; a head
// their own. A team outside it: a head → 403 not_your_team; a founder → 422 unknown_team (not an active team).
export function validateCreate(d, rights, nowMs = Date.now()) {
  const title = cleanTitle(d.title), body = cleanBody(d.body);
  if (!title) return { error: 'title_required', status: 422 };
  if (title.length > ANN_TITLE_MAX) return { error: 'title_too_long', status: 422 };
  if (!body) return { error: 'body_required', status: 422 };
  if (body.length > ANN_BODY_MAX) return { error: 'body_too_long', status: 422 };
  if (d.audience !== 'everyone' && d.audience !== 'teams') return { error: 'bad_audience', status: 422 };
  let team_ids = [];
  if (d.audience === 'everyone') {
    if (!rights.everyone) return { error: 'forbidden_everyone', status: 403 };
  } else {
    if (!Array.isArray(d.team_ids) || !d.team_ids.length) return { error: 'teams_required', status: 422 };
    if (d.team_ids.some(x => typeof x !== 'string' || !UUID.test(x))) return { error: 'bad_team', status: 422 };
    team_ids = [...new Set(d.team_ids.map(lc))];
    const allowed = new Set((rights.department_ids || []).map(lc));
    if (team_ids.some(t => !allowed.has(t))) return rights.everyone ? { error: 'unknown_team', status: 422 } : { error: 'not_your_team', status: 403 };
  }
  const exp = parseExpiry(d.expires_at, nowMs);
  if (exp.error) return { error: exp.error, status: 422 };
  return { value: { title, body, audience: d.audience, team_ids, pinned: bool(d.pinned), expires_at: exp.value } };
}
// An edit → { patch } | { error, status }. Only title / body / pinned / expires_at; at least one.
export function validateUpdate(d, nowMs = Date.now()) {
  const patch = {};
  if (d.title !== undefined) {
    const t = cleanTitle(d.title);
    if (!t) return { error: 'title_required', status: 422 };
    if (t.length > ANN_TITLE_MAX) return { error: 'title_too_long', status: 422 };
    patch.title = t;
  }
  if (d.body !== undefined) {
    const b = cleanBody(d.body);
    if (!b) return { error: 'body_required', status: 422 };
    if (b.length > ANN_BODY_MAX) return { error: 'body_too_long', status: 422 };
    patch.body = b;
  }
  if (d.pinned !== undefined) patch.pinned = bool(d.pinned);
  if (d.expires_at !== undefined) {
    const exp = parseExpiry(d.expires_at, nowMs);
    if (exp.error) return { error: exp.error, status: 422 };
    patch.expires_at = exp.value;
  }
  if (!Object.keys(patch).length) return { error: 'nothing_to_update', status: 422 };
  return { patch };
}

// ── reading ──
export const teamIdsOf = (a) => (Array.isArray(a?.announcement_teams) ? a.announcement_teams.map(t => lc(t.department_id)) : (a?.team_ids || []).map(lc));
export function isLive(a, nowMs = Date.now()) {
  if (!a || a.archived_at) return false;
  return !a.expires_at || Date.parse(a.expires_at) > nowMs;
}
// who = { userId, founder, teams: Set (readerTeams) }
export function canSeeAnnouncement(a, who) {
  if (!a) return false;
  if (who.founder || (who.userId && a.author_user_id === who.userId)) return true;
  if (a.audience === 'everyone') return true;
  const t = who.teams || new Set();
  return teamIdsOf(a).some(id => t.has(id));
}
export const canManageAnnouncement = (a, who) => !!a && (!!who.founder || (!!who.userId && a.author_user_id === who.userId));
// Pinned first, then newest.
export function sortAnnouncements(rows) {
  return rows.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.created_at).localeCompare(String(a.created_at)));
}
// The audience of a post among `people` (active employees with a login: { auth_user_id, department_id }): everyone,
// or anyone in the subtree of its teams.
export function audienceOf(a, people, tree) {
  if (a.audience === 'everyone') return people;
  const t = descendants(tree || { children: new Map() }, teamIdsOf(a));
  return people.filter(p => p.department_id && t.has(lc(p.department_id)));
}
// Unread for getMe: live posts the caller can see and has not marked Seen. Rows carry announcement_seen (embedded,
// filtered to the caller).
export function unreadCount(rows, who, nowMs = Date.now()) {
  return rows.filter(a => isLive(a, nowMs) && canSeeAnnouncement(a, who)
    && !(Array.isArray(a.announcement_seen) && a.announcement_seen.some(s => s.user_id === who.userId))).length;
}

// ── the Slack mirror ──
// Where a new post goes: [{ target: 'everyone' | dept_id, channel | null }]. A team with no channel stays in the
// list with channel null (recorded 'skipped', never posted).
export function mirrorTargets(a, teamIds, settings) {
  if (a.audience === 'everyone') return [{ target: 'everyone', channel: settings.org_channel || null }];
  return (teamIds || []).map(t => ({ target: lc(t), channel: settings.team_channels[lc(t)] || null }));
}
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Long body → sections of ≤ 2,900 ESCAPED chars: the raw text is cut first (at a line break where one is near), then
// each piece escaped — so a cut never lands inside an &amp; / &lt; entity.
export function bodySections(body, max = 2900) {
  const out = [];
  let rest = String(body || '');
  while (rest.length) {
    let n = Math.min(rest.length, max);
    while (esc(rest.slice(0, n)).length > max) n--;   // escaping only grows the text
    if (n < rest.length) {
      const br = rest.lastIndexOf('\n', n);
      if (br > n * 0.7) n = br;
    }
    out.push(esc(rest.slice(0, n)));
    rest = rest.slice(n).replace(/^\n/, '');
  }
  return out;
}
// The message: a bold title, the body, then `Author · Everyone|Team names · Open in Docket`. Every piece of text —
// the blocks AND the `text` fallback (notifications, old clients) — has & < > escaped, so <!channel>, <!here> or
// <@U…> in a title or body shows as typed and pings nobody. Nothing here adds a mention.
export function announcementMessage(a, { authorName, teamNames = [] } = {}) {
  const aud = a.audience === 'everyone' ? 'Everyone' : (teamNames.filter(Boolean).join(', ') || 'Teams');
  const title = esc(a.title);
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
    ...bodySections(a.body).map(t => ({ type: 'section', text: { type: 'mrkdwn', text: t } })),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(authorName || 'Docket')} · ${esc(aud)} · <${announcementLink(a.id)}|Open in Docket>` }] },
  ];
  const text = esc(`${a.title}\n${a.body}`.slice(0, 3000));
  return { text, blocks };
}
// The test-mode DM: the message as it would appear, then one line per target — the channel it would post to, or
// that live would skip it (no channel set). Sent to the test recipients whenever any are set, channels or not.
export function testDmMessage(msg, targets, teamNames = {}) {
  const name = (t) => (t.target === 'everyone' ? 'Everyone' : (teamNames[t.target] || 'A team'));
  const lines = targets.map(t => (t.channel
    ? `• ${esc(name(t))}: would post to <#${t.channel}>`
    : `• ${esc(name(t))}: no ${t.target === 'everyone' ? 'org ' : ''}channel set, live would skip this`));
  const text = `:test_tube: Test mode — nothing was posted to a channel. In live mode:\n${lines.join('\n')}`;
  return { text: `[Test] ${msg.text}`, blocks: [...msg.blocks, { type: 'context', elements: [{ type: 'mrkdwn', text: text.slice(0, 2900) }] }] };
}
// What the composer is told right after a create (the mirror itself runs after the response):
// { mode, channels: [{ target, channel }], skipped: [target] }
export function mirrorSummary(settings, targets) {
  if (settings.mode === 'off') return { mode: 'off', channels: [], skipped: [] };
  return { mode: settings.mode, channels: targets.filter(t => t.channel), skipped: targets.filter(t => !t.channel).map(t => t.target) };
}
