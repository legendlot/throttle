// Podium O3 — one-click Calendar scheduling: the pure parts (event ids, event bodies, the sync decision).
// Plan: docs/superpowers/plans/2026-11-13-podium-o3-calendar.md. Unit tests: test/calendar.test.mjs.
import { MIN_DURATION, MAX_DURATION, parseScheduledAt } from './interviews.js';

export const CAL_TZ = 'Asia/Kolkata';
export const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const COMPANY_NAME = 'Legend of Toys';
const MODE_LABEL = { in_person: 'In person', video: 'Video', phone: 'Phone' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// D5: deterministic ids (Calendar ids are base32hex: a–v and 0–9; "lotiv"/"lotcd" and uuid hex all qualify),
// so a retry after a lost response gets 409 for the same event instead of creating a second one.
export function calendarEventIds(interviewId) {
  if (!UUID_RE.test(String(interviewId || ''))) return null;
  const hex = String(interviewId).toLowerCase().replace(/-/g, '');
  return { internal: `lotiv${hex}`, candidate: `lotcd${hex}` };
}

export function endIso(startIso, durationMin) {
  const t = Date.parse(startIso || '');
  const d = Number(durationMin);
  if (!Number.isFinite(t) || !Number.isInteger(d) || d <= 0) return null;
  return new Date(t + d * 60000).toISOString();
}

// FNV-1a 32-bit over a stable JSON string: cheap, deterministic, no crypto needed (it only detects change).
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
// D6: the Podium fields an event mirrors. A different hash = Podium changed since the last push.
export function syncedHash({ scheduled_at, duration_min, mode, location, panelEmails = [] }) {
  const t = Date.parse(scheduled_at || '');
  const emails = [...new Set((panelEmails || []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean))].sort();
  return fnv1a(JSON.stringify([Number.isFinite(t) ? t : null, Number(duration_min) || null, mode || null,
    String(location || '').trim() || null, emails]));
}

const line = (label, v) => (v ? `${label}: ${v}` : null);
const timeBlock = (iv) => ({
  start: { dateTime: new Date(Date.parse(iv.scheduled_at)).toISOString(), timeZone: CAL_TZ },
  end: { dateTime: endIso(iv.scheduled_at, iv.duration_min), timeZone: CAL_TZ },
});

// The internal event (D4): panel as guests, the Podium link, a Meet link for video.
// conference: 'create' (new Meet), 'keep' (leave the event's conference alone), 'remove' (drop it).
export function buildInternalEvent({ id, iv, candidate = {}, opening = {}, panelEmails = [], organiserEmail = '', link,
  conference = 'keep', requestId = null }) {
  const org = String(organiserEmail || '').toLowerCase();
  const guests = [...new Set((panelEmails || []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean))]
    .filter(e => e !== org).map(email => ({ email }));
  const who = [candidate.full_name, candidate.candidate_code ? `(${candidate.candidate_code})` : null].filter(Boolean).join(' ') || 'Candidate';
  const place = String(iv.location || '').trim();
  const description = [
    line('Round', iv.round_name),
    line('Candidate', who),
    line('Opening', [opening.opening_code, opening.designation].filter(Boolean).join(' ')),
    line('Mode', MODE_LABEL[iv.mode] || iv.mode),
    place ? line(iv.mode === 'video' ? 'Meeting note' : iv.mode === 'phone' ? 'Call' : 'Place', place) : null,
    'Feedback is due 24 hours after the interview.',
    link ? `Open in Podium: ${link}` : null,
  ].filter(Boolean).join('\n');
  const ev = {
    summary: `Interview: ${who} · ${iv.round_name}`.slice(0, 250),
    description,
    location: iv.mode === 'in_person' ? place : '',
    ...timeBlock(iv),
    attendees: guests,
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: true,
    reminders: { useDefault: true },
    extendedProperties: { private: { podium_interview_id: iv.id, podium_kind: 'internal' } },
  };
  if (id) ev.id = id;
  if (conference === 'create' && iv.mode === 'video') {
    ev.conferenceData = { createRequest: { requestId: String(requestId || iv.id).slice(0, 200), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  } else if (conference === 'remove' || (conference === 'create' && iv.mode !== 'video')) {
    ev.conferenceData = null;
  }
  return ev;
}

// The candidate's own invite (D4): time, a neutral title, the Meet link or the place. No Podium link, no panel.
// conf = the internal event's conferenceData (reused so both sides join the same Meet), or null.
export function buildCandidateEvent({ id, iv, designation = '', candidateEmail, conf = null, meetUrl = null, company = COMPANY_NAME }) {
  const place = String(iv.location || '').trim();
  const role = String(designation || '').trim();
  const how = iv.mode === 'video'
    ? (meetUrl ? `Join by video: ${meetUrl}` : 'This is a video interview; the joining link follows by email.')
    : iv.mode === 'phone' ? 'This is a phone interview. We will call you at this time.'
    : place ? `Place: ${place}` : 'This is an in-person interview.';
  const ev = {
    summary: `Interview with ${company}${role ? `: ${role}` : ''}`.slice(0, 250),
    // D4: no internal round name, panel or link — the role, the company, the time and how to join.
    description: [`Your interview${role ? ` for ${role}` : ''} with ${company}.`, how].join('\n'),
    location: iv.mode === 'in_person' ? place : '',
    ...timeBlock(iv),
    attendees: candidateEmail ? [{ email: String(candidateEmail).trim().toLowerCase() }] : [],
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    reminders: { useDefault: true },
    extendedProperties: { private: { podium_interview_id: iv.id, podium_kind: 'candidate' } },
  };
  if (id) ev.id = id;
  ev.conferenceData = iv.mode === 'video' && conf ? conf : null;
  return ev;
}

// The reusable part of an event's conference (Calendar accepts an existing conferenceId on another event).
export function conferenceOf(ev) {
  const c = ev?.conferenceData;
  if (!c?.conferenceId || !c?.conferenceSolution?.key?.type) return null;
  return { conferenceId: c.conferenceId, conferenceSolution: { key: { type: c.conferenceSolution.key.type } },
    entryPoints: (c.entryPoints || []).map(e => ({ entryPointType: e.entryPointType, uri: e.uri, ...(e.label ? { label: e.label } : {}) })) };
}
export function meetUrlOf(ev) {
  const u = ev?.hangoutLink || (ev?.conferenceData?.entryPoints || []).find(e => e.entryPointType === 'video')?.uri || null;
  return u && /^https:\/\//.test(u) ? String(u).slice(0, 500) : null;
}
// → { start, end } in ms, or null for an all-day / malformed event.
export function eventTimes(ev) {
  const s = Date.parse(ev?.start?.dateTime || ''), e = Date.parse(ev?.end?.dateTime || '');
  return Number.isFinite(s) && Number.isFinite(e) && e > s ? { start: s, end: e } : null;
}

// D7: what a sync on open does. event = the internal event from Google (null = 404 gone).
// → { action: 'none' | 'push' | 'pull' | 'cancel_interview' | 'detach' | 'delete_events', reason?, scheduled_at?, duration_min? }
// detach = the event is gone but the interview stands (it already happened): only the link is marked cancelled.
export function calendarSyncAction({ iv, link, event, podiumHash, hasFeedback = false, now = Date.now() }) {
  if (!iv || !link) return { action: 'none' };
  if (iv.status === 'cancelled') return link.state === 'cancelled' ? { action: 'none' } : { action: 'delete_events' };
  if (iv.status !== 'scheduled') return { action: 'none' };                 // completed / no_show: leave the events
  if (link.state === 'cancelled') return { action: 'none' };
  if (!event || event.status === 'cancelled') {
    // An interview that has happened (or has feedback) stays: tidying a past event out of a calendar is not a cancel.
    if (hasFeedback || Date.parse(iv.scheduled_at) <= now) return { action: 'detach', reason: 'deleted_after_interview' };
    return { action: 'cancel_interview', reason: 'deleted_in_calendar' };
  }
  if (podiumHash !== link.synced_hash) return { action: 'push', reason: 'podium_changed' };
  const t = eventTimes(event);
  const ss = Date.parse(link.synced_start || ''), se = Date.parse(link.synced_end || '');
  if (!t) return { action: 'push', reason: 'bad_calendar_time' };
  if (t.start === ss && t.end === se) return { action: 'none' };
  if (hasFeedback) return { action: 'push', reason: 'feedback_in' };
  const dur = Math.round((t.end - t.start) / 60000);
  if ((t.end - t.start) % 60000 !== 0 || dur < MIN_DURATION || dur > MAX_DURATION) return { action: 'push', reason: 'bad_calendar_time' };
  const p = parseScheduledAt(new Date(t.start).toISOString(), now);
  if (p.error) return { action: 'push', reason: 'bad_calendar_time' };
  return { action: 'pull', scheduled_at: p.iso, duration_min: dur };
}

export const CAL_COPY = {
  calendar_off: 'Google Calendar is not switched on for Podium yet',
  calendar_not_scheduled: 'Only a scheduled interview can go on the calendar',
  calendar_past: 'This interview time has passed',
  calendar_linked: 'This interview is already on the calendar',
  calendar_busy: 'Someone is adding this interview to the calendar right now, refresh in a moment',
  calendar_no_mailbox: 'You need an active work mailbox to organise the calendar invite',
  calendar_no_candidate_email: 'The candidate has no email address for an invite',
  calendar_event_deleted: 'The calendar event was deleted in Google Calendar; schedule a new interview',
  calendar_failed: 'Google Calendar did not accept the invite, try again',
  calendar_not_linked: 'This interview is not on the calendar',
};
