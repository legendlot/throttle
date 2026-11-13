// Announcements (General-space rethink P4) — pure helpers for /announcements and /admin/announcements.
// The worker (docketops getAnnouncements / createAnnouncement / …) decides who posts and sees; this only formats.

export const TITLE_MAX = 200;
export const BODY_MAX = 5000;
// Same rule the worker enforces (saveAnnouncementSettings).
export const CHANNEL_RE = /^[CG][A-Z0-9]{6,}$/;

// '' (blank = no channel) is fine; anything else must look like a Slack channel id.
export function channelError(v) {
  const c = String(v || '').trim().toUpperCase();
  if (!c) return '';
  return CHANNEL_RE.test(c) ? '' : 'A channel ID looks like C0123ABCD (channel details → bottom of About).';
}

// "just now" · "5m ago" · "3h ago" · "2d ago" · then the date.
export function relTime(iso, nowMs = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });
}

// "Expires 20 Nov" / "Expired 12 Nov" / '' for none. IST dates.
export function expiryNote(iso, nowMs = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });
  return t > nowMs ? `Expires ${d}` : `Expired ${d}`;
}
// An ISO expiry → the YYYY-MM-DD (IST) a date input shows.
export function expiryDateInput(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  return new Date(t + 330 * 60000).toISOString().slice(0, 10);
}
// Today in IST, for the date input's min.
export function todayIst(nowMs = Date.now()) { return new Date(nowMs + 330 * 60000).toISOString().slice(0, 10); }

// A team's display name from getDepartments (which carries parent_department_id): a sub-team reads "Parent › Child",
// because Podium has same-named sub-teams (two "Build", two "Cars"). Used wherever a team list is shown — the
// composer, /admin/announcements, a space's team shares. → { [department id]: label }
export function teamLabels(departments) {
  const byId = Object.fromEntries((departments || []).map(d => [String(d.id), d]));
  const out = {};
  for (const d of departments || []) {
    const p = d.parent_department_id && byId[String(d.parent_department_id)];
    out[d.id] = p ? `${p.name || 'Team'} › ${d.name || 'Team'}` : (d.name || 'Team');
  }
  return out;
}

// The teams the composer offers: exactly can_announce.department_ids (a head's teams and everything below them),
// named by teamLabels, sorted by that label.
export function allowedTeams(canAnnounce, departments) {
  const ids = new Set((canAnnounce?.department_ids || []).map(String));
  const label = teamLabels(departments);
  return (departments || []).filter(d => ids.has(String(d.id))).map(d => ({ id: d.id, name: label[d.id] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The mirror status a card shows its author / a founder, from the post's `slack` results (the worker records one
// entry per target, plus one per test DM). [] = the mirror hasn't written yet (or the post predates it).
// names = { deptId: name }
export function mirrorStatus(slack, names = {}) {
  const rows = Array.isArray(slack) ? slack : [];
  if (!rows.length) return 'Slack: pending/none';
  if (rows.every(r => r.status === 'off')) return 'Slack: mirror was off';
  const targets = rows.filter(r => r.target !== 'test_dm'), dms = rows.filter(r => r.target === 'test_dm');
  const label = (r) => (r.target === 'everyone' ? 'Everyone' : (names[r.target] || 'Team'));
  const one = (r) => {
    if (r.status === 'sent') return `posted to #${r.channel}`;
    if (r.status === 'skipped') return 'skipped: no channel';
    if (r.status === 'test') return `test: would post to #${r.channel}`;
    if (r.error === 'not_in_channel') return 'not_in_channel: invite the Docket bot';
    return `failed: ${r.error || 'error'}`;
  };
  const parts = targets.map(r => (targets.length > 1 ? `${label(r)} ${one(r)}` : one(r)));
  if (rows.some(r => r.mode === 'test')) {
    const sent = dms.filter(r => r.status === 'sent').length, bad = dms.filter(r => r.status !== 'sent');
    if (!dms.length) parts.push('no test recipients, nothing sent');
    if (sent) parts.push(sent === 1 ? 'test DM sent' : `test DM sent to ${sent}`);
    if (bad.length) parts.push(`test DM failed for ${bad.length} (${[...new Set(bad.map(r => r.error || r.status))].join(', ')})`);
  }
  return 'Slack: ' + parts.join(' · ');
}
export const canPost = (c) => !!(c && (c.everyone || (c.department_ids || []).length));

// The composer's own check before it calls the worker → '' or the first problem.
export function composerError(d, canAnnounce) {
  if (!String(d.title || '').trim()) return 'Add a title.';
  if (String(d.title).trim().length > TITLE_MAX) return `Title is over ${TITLE_MAX} characters.`;
  if (!String(d.body || '').trim()) return 'Write the announcement.';
  if (String(d.body).trim().length > BODY_MAX) return `The announcement is over ${BODY_MAX} characters.`;
  if (d.audience === 'everyone' && !canAnnounce?.everyone) return 'Only founders can post to everyone.';
  if (d.audience === 'teams' && !(d.team_ids || []).length) return 'Pick at least one team.';
  return '';
}

// The toast after a post: where the Slack mirror goes (it runs right after the response).
// mirror = { mode, channels: [{ target, channel }], skipped: [target] }; names = { deptId: name }
export function mirrorToast(mirror, names = {}) {
  if (!mirror || mirror.mode === 'off') return 'Posted · Slack mirror is off';
  if (mirror.mode === 'test') return 'Posted · Slack: test mode';
  const label = (t) => (t === 'everyone' ? 'the org channel' : `${names[t] || 'team'} channel`);
  const sent = (mirror.channels || []).map(c => label(c.target));
  const skipped = (mirror.skipped || []).map(t => (t === 'everyone' ? 'no org channel set' : `${names[t] || 'a team'} has no channel`));
  const head = sent.length ? `Posted · Slack: ${sent.join(', ')}` : 'Posted · not on Slack';
  return skipped.length ? `${head} (${skipped.join('; ')})` : head;
}

// Friendly words for the worker's refusals.
const ERRORS = {
  forbidden_announce: 'Only founders and team heads can post announcements.',
  forbidden_everyone: 'Only founders can post to everyone.',
  not_your_team: 'You can only post to the teams you head.',
  teams_required: 'Pick at least one team.',
  unknown_team: 'One of those teams is no longer active.',
  title_required: 'Add a title.', title_too_long: `Title is over ${TITLE_MAX} characters.`,
  body_required: 'Write the announcement.', body_too_long: `The announcement is over ${BODY_MAX} characters.`,
  expires_in_past: 'The expiry date has passed.', bad_expires_at: 'That expiry date is not valid.',
  archived: 'This announcement was archived.', forbidden: 'Only the author or a founder can do that.',
  not_found: 'That announcement is gone.', bad_channel: 'That is not a Slack channel ID (C0123ABCD).',
  unknown_employee: 'A test recipient is no longer active.', forbidden_docket_admin: 'Admins only.',
};
export function announcementErrorText(e) {
  const code = String(e?.message || '').split(':')[0];
  return ERRORS[code] || '';
}
