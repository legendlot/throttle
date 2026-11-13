import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarEventIds, endIso, syncedHash, buildInternalEvent, buildCandidateEvent, conferenceOf, meetUrlOf, eventTimes,
  calendarSyncAction, CAL_TZ,
} from '../src/calendar.js';

const NOW = Date.parse('2026-11-13T06:00:00Z');
const ID = '1f16f945-0a2b-4c3d-8e9f-0123456789ab';
const iv = (o = {}) => ({ id: ID, round_name: 'First round', scheduled_at: '2026-11-20T05:30:00.000Z', duration_min: 60,
  mode: 'video', location: null, status: 'scheduled', ...o });

test('event ids are deterministic base32hex, and refuse a non-uuid', () => {
  const a = calendarEventIds(ID), b = calendarEventIds(ID.toUpperCase());
  assert.deepEqual(a, b);
  assert.match(a.internal, /^[a-v0-9]{5,1024}$/);
  assert.match(a.candidate, /^[a-v0-9]{5,1024}$/);
  assert.notEqual(a.internal, a.candidate);
  for (const bad of [null, '', 'abc', '1f16f945-0a2b-4c3d-8e9f-0123456789ag', 42]) assert.equal(calendarEventIds(bad), null);
});

test('endIso adds the duration; junk → null', () => {
  assert.equal(endIso('2026-11-20T05:30:00Z', 45), '2026-11-20T06:15:00.000Z');
  assert.equal(endIso('', 45), null);
  assert.equal(endIso('2026-11-20T05:30:00Z', '45'), '2026-11-20T06:15:00.000Z');   // PostgREST-style string
  assert.equal(endIso('2026-11-20T05:30:00Z', '4.5'), null);
  assert.equal(endIso('2026-11-20T05:30:00Z', 0), null);
});

test('syncedHash: changes with time / duration / mode / place / panel, not with email case or order', () => {
  const base = { ...iv(), panelEmails: ['a@legendoftoys.com', 'b@legendoftoys.com'] };
  const h = syncedHash(base);
  assert.equal(h, syncedHash({ ...base, panelEmails: ['B@legendoftoys.com', 'a@legendoftoys.com', 'a@legendoftoys.com'] }));
  assert.equal(h, syncedHash({ ...base, scheduled_at: '2026-11-20T11:00:00+05:30' }));   // same instant
  for (const ch of [{ scheduled_at: '2026-11-20T06:00:00Z' }, { duration_min: 45 }, { mode: 'phone' }, { location: 'Room 2' },
    { panelEmails: ['a@legendoftoys.com'] }]) assert.notEqual(h, syncedHash({ ...base, ...ch }));
  assert.equal(syncedHash({ ...base, location: '  ' }), syncedHash({ ...base, location: null }));
});

test('internal event: panel guests minus the organiser, Podium link, locked guests, Meet on create for video', () => {
  const ev = buildInternalEvent({ id: 'lotivx1', iv: iv(), candidate: { full_name: 'Asha Rao', candidate_code: 'CAN-0007' },
    opening: { opening_code: 'OPN-003', designation: 'Designer' }, panelEmails: ['Org@legendoftoys.com', 'p1@legendoftoys.com', 'p1@legendoftoys.com'],
    organiserEmail: 'org@legendoftoys.com', link: 'https://podium.legendoftoys.com/hiring/interviews/detail/?id=x', conference: 'create', requestId: ID });
  assert.equal(ev.id, 'lotivx1');
  assert.deepEqual(ev.attendees, [{ email: 'p1@legendoftoys.com' }]);
  assert.equal(ev.guestsCanModify, false);
  assert.equal(ev.guestsCanInviteOthers, false);
  assert.match(ev.description, /Open in Podium: https:\/\/podium/);
  assert.match(ev.summary, /Asha Rao \(CAN-0007\) · First round/);
  assert.equal(ev.start.timeZone, CAL_TZ);
  assert.equal(ev.end.dateTime, '2026-11-20T06:30:00.000Z');
  assert.equal(ev.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.equal(ev.conferenceData.createRequest.requestId, ID);
});

test('internal event conference: keep omits it, remove nulls it, create on a non-video mode nulls it', () => {
  const keep = buildInternalEvent({ iv: iv(), conference: 'keep' });
  assert.equal('conferenceData' in keep, false);
  assert.equal('id' in keep, false);
  assert.equal(buildInternalEvent({ iv: iv({ mode: 'in_person' }), conference: 'remove' }).conferenceData, null);
  assert.equal(buildInternalEvent({ iv: iv({ mode: 'phone' }), conference: 'create' }).conferenceData, null);
  const inPerson = buildInternalEvent({ iv: iv({ mode: 'in_person', location: 'HSR office, 2nd floor' }) });
  assert.equal(inPerson.location, 'HSR office, 2nd floor');
  assert.equal(buildInternalEvent({ iv: iv({ location: 'zoom link' }) }).location, '');   // video: the note stays in the description
});

test('candidate event: no Podium link, no panel, guests hidden, Meet reused for video', () => {
  const conf = { conferenceId: 'abc-defg-hij', conferenceSolution: { key: { type: 'hangoutsMeet' } }, entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] };
  const ev = buildCandidateEvent({ id: 'lotcdx', iv: iv(), designation: 'Designer', candidateEmail: ' Asha@Example.com ', conf, meetUrl: 'https://meet.google.com/abc-defg-hij' });
  assert.deepEqual(ev.attendees, [{ email: 'asha@example.com' }]);
  assert.equal(ev.guestsCanSeeOtherGuests, false);
  assert.equal(ev.guestsCanModify, false);
  assert.doesNotMatch(ev.description, /podium/i);
  const leaky = buildCandidateEvent({ iv: iv({ round_name: 'Internal panel: Alice' }), designation: 'Designer', candidateEmail: 'a@b.co' });
  assert.doesNotMatch(leaky.description + leaky.summary, /Alice|panel/i);
  assert.match(ev.description, /meet\.google\.com/);
  assert.equal(ev.summary, 'Interview with Legend of Toys: Designer');
  assert.deepEqual(ev.conferenceData, conf);
  const ph = buildCandidateEvent({ iv: iv({ mode: 'phone' }), candidateEmail: 'a@b.co', conf });
  assert.equal(ph.conferenceData, null);
  assert.match(ph.description, /call you/);
});

test('conferenceOf / meetUrlOf / eventTimes', () => {
  const ev = { hangoutLink: 'https://meet.google.com/x', conferenceData: { conferenceId: 'x', conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Meet' },
    entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/x', label: 'meet.google.com/x', pin: '1' }] },
    start: { dateTime: '2026-11-20T11:00:00+05:30' }, end: { dateTime: '2026-11-20T12:00:00+05:30' } };
  assert.deepEqual(conferenceOf(ev), { conferenceId: 'x', conferenceSolution: { key: { type: 'hangoutsMeet' } },
    entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/x', label: 'meet.google.com/x' }] });
  assert.equal(conferenceOf({}), null);
  assert.equal(meetUrlOf(ev), 'https://meet.google.com/x');
  assert.equal(meetUrlOf({ hangoutLink: 'javascript:alert(1)' }), null);
  assert.deepEqual(eventTimes(ev), { start: Date.parse('2026-11-20T05:30:00Z'), end: Date.parse('2026-11-20T06:30:00Z') });
  assert.equal(eventTimes({ start: { date: '2026-11-20' }, end: { date: '2026-11-21' } }), null);
});

test('sync action: every branch', () => {
  const H = 'h1';
  const link = { state: 'linked', synced_hash: H, synced_start: '2026-11-20T05:30:00.000Z', synced_end: '2026-11-20T06:30:00.000Z' };
  const same = { status: 'confirmed', start: { dateTime: '2026-11-20T11:00:00+05:30' }, end: { dateTime: '2026-11-20T12:00:00+05:30' } };
  const moved = { status: 'confirmed', start: { dateTime: '2026-11-21T10:00:00+05:30' }, end: { dateTime: '2026-11-21T10:45:00+05:30' } };
  const A = (o) => calendarSyncAction({ iv: iv(), link, event: same, podiumHash: H, now: NOW, ...o }).action;
  assert.equal(A({}), 'none');
  assert.equal(A({ iv: iv({ status: 'cancelled' }) }), 'delete_events');
  assert.equal(A({ iv: iv({ status: 'cancelled' }), link: { ...link, state: 'cancelled' } }), 'none');
  assert.equal(A({ iv: iv({ status: 'completed' }), event: null }), 'none');
  assert.equal(A({ iv: iv({ status: 'no_show' }), event: null }), 'none');
  assert.equal(A({ event: null }), 'cancel_interview');
  // Deleted after the interview happened, or with feedback in → the interview stands; only the link is dropped.
  assert.equal(A({ event: null, iv: iv({ scheduled_at: '2026-11-12T05:30:00.000Z' }) }), 'detach');
  assert.equal(A({ event: { ...same, status: 'cancelled' }, hasFeedback: true }), 'detach');
  assert.equal(A({ event: { ...same, status: 'cancelled' } }), 'cancel_interview');
  assert.equal(A({ podiumHash: 'h2' }), 'push');
  assert.equal(A({ podiumHash: 'h2', event: moved }), 'push');            // both changed: Podium wins
  const pull = calendarSyncAction({ iv: iv(), link, event: moved, podiumHash: H, now: NOW });
  assert.deepEqual(pull, { action: 'pull', scheduled_at: '2026-11-21T04:30:00.000Z', duration_min: 45 });
  assert.deepEqual(calendarSyncAction({ iv: iv(), link, event: moved, podiumHash: H, hasFeedback: true, now: NOW }), { action: 'push', reason: 'feedback_in' });
  // Calendar moved it to a length Podium refuses, or an all-day event, or two years out → Podium's time goes back.
  const tooLong = { ...moved, end: { dateTime: '2026-11-21T20:00:00+05:30' } };
  assert.equal(calendarSyncAction({ iv: iv(), link, event: tooLong, podiumHash: H, now: NOW }).reason, 'bad_calendar_time');
  assert.equal(calendarSyncAction({ iv: iv(), link, event: { status: 'confirmed', start: { date: '2026-11-21' }, end: { date: '2026-11-22' } }, podiumHash: H, now: NOW }).reason, 'bad_calendar_time');
  const far = { ...moved, start: { dateTime: '2028-11-21T10:00:00+05:30' }, end: { dateTime: '2028-11-21T11:00:00+05:30' } };
  assert.equal(calendarSyncAction({ iv: iv(), link, event: far, podiumHash: H, now: NOW }).reason, 'bad_calendar_time');
  const oddSec = { ...moved, end: { dateTime: '2026-11-21T10:45:30+05:30' } };
  assert.equal(calendarSyncAction({ iv: iv(), link, event: oddSec, podiumHash: H, now: NOW }).reason, 'bad_calendar_time');
  assert.equal(calendarSyncAction({ iv: null, link, event: same, podiumHash: H }).action, 'none');
});
