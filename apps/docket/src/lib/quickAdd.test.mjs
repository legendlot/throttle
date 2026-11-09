// node --test src/lib/*.test.mjs  (npm test) — capture quick-add tokens (Docket F2).
// `now` is injected; every expectation is an IST wall-clock time converted to UTC ISO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickAdd } from './quickAdd.js';

const people = [
  { id: 'e1', full_name: 'Riya Sharma' },
  { id: 'e2', full_name: 'Rohan Mehta' },
  { id: 'e3', full_name: 'Amit Kumar', preferred_name: 'AK' },
  { id: 'e4', full_name: 'Amitabh Rao' },
];
// IST wall clock → the ISO string DatePicker would emit (toISOString, UTC).
const ist = (y, mo, d, h = 18, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi) - 330 * 60000).toISOString();
// Mon 9 Nov 2026, 10:00 IST
const MON10 = new Date(ist(2026, 11, 9, 10, 0));
const p = (t, now = MON10) => parseQuickAdd(t, { people, now });

test('@name → owner: first name (exact or unique prefix), then full name; unique only', () => {
  assert.equal(p('call @riya').owner_employee_id, 'e1');
  assert.equal(p('call @Ri').owner_employee_id, 'e1');                // only Riya starts "ri"
  assert.equal(p('call @ak').owner_employee_id, 'e3');                // preferred_name: harmless path (absent in prod)
  assert.equal(p('call @amitk').owner_employee_id, 'e3');             // full name, no spaces
  assert.equal(p('call @riya').title, 'call');
  assert.equal(p('call @riya').tokens[0].label, 'Riya Sharma');
});

test('ambiguous / unknown @ and emails stay in the title', () => {
  const amb = p('call @r');                                           // Riya + Rohan
  assert.equal(amb.owner_employee_id, undefined);
  assert.equal(amb.title, 'call @r');
  assert.equal(p('call @ami').owner_employee_id, undefined);          // Amit + Amitabh
  assert.equal(p('ping @zed').title, 'ping @zed');
  const mail = p('mail a@b.com today');
  assert.equal(mail.owner_employee_id, undefined);
  assert.equal(mail.title, 'mail a@b.com');
});

test('!p0..!p3 → priority (any case); !p5 ignored', () => {
  assert.equal(p('fix !P1').priority, 'P1');
  assert.equal(p('fix !p0').priority, 'P0');
  assert.equal(p('fix !p3').title, 'fix');
  const five = p('fix !p5');
  assert.equal(five.priority, undefined);
  assert.equal(five.title, 'fix !p5');
});

test('relative dates default to 18:00 IST; tomorrow / tmrw', () => {
  assert.equal(p('ship today').deadline, ist(2026, 11, 9));
  assert.equal(p('ship tomorrow').deadline, ist(2026, 11, 10));
  assert.equal(p('ship tmrw').deadline, ist(2026, 11, 10));
});

test('weekdays short and long; same weekday = today', () => {
  assert.equal(p('ship fri').deadline, ist(2026, 11, 13));
  assert.equal(p('ship Friday').deadline, ist(2026, 11, 13));
  assert.equal(p('ship sun').deadline, ist(2026, 11, 15));            // last word
  assert.equal(p('ship mon').deadline, ist(2026, 11, 9));             // today, 18:00 still ahead
  assert.equal(p('ship mon 9am').deadline, ist(2026, 11, 16, 9, 0)); // passed today → next Monday
});

test('explicit dates: 12 nov, nov 12, 12/11 (day-first)', () => {
  assert.equal(p('pay 12 nov').deadline, ist(2026, 11, 12));
  assert.equal(p('pay nov 12').deadline, ist(2026, 11, 12));
  assert.equal(p('pay 12/11').deadline, ist(2026, 11, 12));
  assert.equal(p('pay 12/11').title, 'pay');
  assert.equal(p('pay 1/12').deadline, ist(2026, 12, 1));             // 1 Dec (day-first), 22 days out
  assert.equal(p('pay 31/02').deadline, undefined);                   // no such day → text
});

test('times: 5pm, 5:30pm, 17:00; date + time as adjacent tokens either way', () => {
  assert.equal(p('call 5pm').deadline, ist(2026, 11, 9, 17, 0));
  assert.equal(p('call 5:30pm').deadline, ist(2026, 11, 9, 17, 30));
  assert.equal(p('call 17:00').deadline, ist(2026, 11, 9, 17, 0));
  assert.equal(p('call 09:30').deadline, ist(2026, 11, 10, 9, 30));   // two-digit 24h; passed → tomorrow
  assert.equal(p('call fri 5pm').deadline, ist(2026, 11, 13, 17, 0));
  assert.equal(p('call 5pm fri').deadline, ist(2026, 11, 13, 17, 0));
  assert.equal(p('call 12 nov 9:15am').deadline, ist(2026, 11, 12, 9, 15));
  const t = p('call fri 5pm');
  assert.equal(t.title, 'call');
  assert.equal(t.tokens.length, 1);
  assert.equal(t.tokens[0].raw, 'fri 5pm');
  assert.equal(t.tokens[0].label, 'Fri 13 Nov, 5pm');
});

test('never a past deadline', () => {
  assert.equal(p('call 9am').deadline, ist(2026, 11, 10, 9, 0));      // passed today → tomorrow
  assert.equal(p('pay 12 jan').deadline, ist(2027, 1, 12));           // worded rollover (≤183 days)
  const late = new Date(ist(2026, 11, 9, 20, 0));                     // 8pm: today 18:00 has passed
  assert.equal(p('ship today', late).deadline, ist(2026, 11, 9, 23, 59));
  assert.equal(p('ship today 9am', late).deadline, undefined);       // passed time on an explicit day → text
  assert.equal(p('pay 12/11/2025').deadline, undefined);              // explicit past year → text
  const midnightish = new Date(ist(2026, 11, 9, 23, 59));              // 23:59:00
  const lateLate = new Date(midnightish.getTime() + 30000);            // 23:59:30: the 23:59 fallback is past
  assert.equal(p('ship today', lateLate).deadline, ist(2026, 11, 10));    // → tomorrow 18:00
  assert.equal(p('ship by mon', lateLate).deadline, ist(2026, 11, 10));   // same weekday → tomorrow 18:00
  for (const t of ['today', 'by mon', 'call 9am', '12 jan', '12/11', 'x today 9am', 'pay 9 nov', 'pay 9 nov 9am', 'by mon 9am']) {
    for (const now of [MON10, late, lateLate]) {
      const d = p(t, now).deadline;
      if (d) assert.ok(new Date(d) > now, `${t} → ${d} is past`);
    }
  }
});

test('IST across the UTC midnight: 01:00 IST Tuesday is still Tuesday', () => {
  const tue1am = new Date(ist(2026, 11, 10, 1, 0));                   // = Mon 19:30 UTC
  assert.equal(p('ship today', tue1am).deadline, ist(2026, 11, 10));
  assert.equal(p('ship tue', tue1am).deadline, ist(2026, 11, 10));
});

test('only the first of each kind; others stay as text', () => {
  const r = p('a !p1 !p2 @riya @rohan tomorrow fri');
  assert.equal(r.priority, 'P1');
  assert.equal(r.owner_employee_id, 'e1');
  assert.equal(r.deadline, ist(2026, 11, 10));
  assert.equal(r.title, 'a !p2 @rohan fri');
});

test('all-token title → raw text, no tokens', () => {
  const r = p('@riya tomorrow !p1');
  assert.equal(r.title, '@riya tomorrow !p1');
  assert.deepEqual(r.tokens, []);
  assert.equal(r.owner_employee_id, undefined);
  assert.equal(r.deadline, undefined);
});

test('ignore: un-chipped words stay literal', () => {
  const r = parseQuickAdd('meet fri 5pm', { people, now: MON10, ignore: new Set(['fri', '5pm']) });
  assert.equal(r.deadline, undefined);
  assert.equal(r.title, 'meet fri 5pm');
  const r2 = parseQuickAdd('meet @riya', { people, now: MON10, ignore: new Set(['@riya']) });
  assert.equal(r2.owner_employee_id, undefined);
});

test('token offsets point at the raw text', () => {
  const t = 'call @riya fri';
  const r = p(t);
  for (const k of r.tokens) assert.equal(t.slice(k.start, k.end), k.raw);
});

test('year rollover only within 183 days; a date merely mentioned stays text', () => {
  const mon2pm = new Date(ist(2026, 11, 9, 14, 0));
  assert.equal(p('pay 12 jan', mon2pm).deadline, ist(2027, 1, 12));   // Jan next year: parsed
  const r = p('Review nov 3 report', mon2pm);                           // 6 days ago → a year out
  assert.equal(r.deadline, undefined);
  assert.equal(r.title, 'Review nov 3 report');
  assert.equal(p('pay 5 nov', mon2pm).deadline, undefined);
  assert.equal(p('pay 8 may', mon2pm).deadline, ist(2027, 5, 8));     // 8 May: ~180 days, parsed
  assert.equal(p('pay 12 may', mon2pm).deadline, undefined);          // 12 May: >183 days, text
  assert.equal(p('pay 3 dec', mon2pm).deadline, ist(2026, 12, 3));    // still ahead this year
});

test('@name: an exact first / preferred name beats a prefix; a shared exact name is ambiguous', () => {
  const ppl = [{ id: 'r1', full_name: 'Riya Sharma' }, { id: 'r2', full_name: 'Riyaz Khan' },
    { id: 's1', full_name: 'Sam Lee' }, { id: 's2', full_name: 'Sam Patel' }, { id: 'k1', full_name: 'Karan Joshi', preferred_name: 'KJ' }];
  const q = (t) => parseQuickAdd(t, { people: ppl, now: MON10 });
  assert.equal(q('call @riya').owner_employee_id, 'r1');              // exact first name wins
  assert.equal(q('call @Riyaz').owner_employee_id, 'r2');
  assert.equal(q('call @riy').owner_employee_id, undefined);          // prefix of both → text
  assert.equal(q('call @kj').owner_employee_id, 'k1');                // exact preferred name
  const sam = q('call @sam');                                         // two exact "Sam"s
  assert.equal(sam.owner_employee_id, undefined);
  assert.equal(sam.title, 'call @sam');
  assert.equal(q('call @samp').owner_employee_id, 's2');              // unique full-name prefix
});

test('weekday words as plain words stay text; by/on/due…, a time, or the last word parse', () => {
  const none = (t) => { const r = p(t); assert.equal(r.deadline, undefined, t); assert.equal(r.title, t, t); };
  none('Sun pharma call');
  none('Sat with Riya on pricing');
  none('wed invite cards');
  none('Sunday Soul Sante booking (OCT)');
  assert.equal(p('Ship banner fri').deadline, ist(2026, 11, 13));
  assert.equal(p('Ship banner fri').title, 'Ship banner');
  const by = p('invite cards by wed');
  assert.equal(by.deadline, ist(2026, 11, 11));
  assert.equal(by.title, 'invite cards');
  assert.equal(by.tokens[0].raw, 'by wed');
  assert.equal(p('fri 5pm review').deadline, ist(2026, 11, 13, 17, 0)); // next to a time
  assert.equal(p('ship fri !p1').deadline, ist(2026, 11, 13));          // last word before tokens
  assert.equal(p('due tomorrow ship').title, 'ship');
});

test('clock-like numbers and fractions are not deadlines', () => {
  const none = (t) => { const r = p(t); assert.equal(r.deadline, undefined, t); assert.equal(r.title, t, t); };
  none('Make 9:16 reel');
  none('Cut 1/2 inch foam');
  none('3/4 sleeve tee samples');
  none('GST 1/4 filing');
  none('call 3:30');
  none('pay 12/01');                                                  // 12 Jan: 64 days > the 60-day slash window
  assert.equal(p('pay 12/11').deadline, ist(2026, 11, 12));           // 3 days out
  assert.equal(p('pay 1/12').deadline, ist(2026, 12, 1));
  assert.equal(p('pay 12/01/27').deadline, ist(2027, 1, 12));         // explicit year: no window
});

test('an explicit date with a passed time stays text (never moved to the next day)', () => {
  const d12 = new Date(ist(2026, 11, 12, 10, 0));
  for (const t of ['pay 12 nov 9am', 'pay 12/11 9am', 'pay nov 12 09:00']) {
    const r = p(t, d12);
    assert.equal(r.deadline, undefined, t);
    assert.equal(r.title, t, t);
  }
  assert.equal(p('pay 12 nov 5pm', d12).deadline, ist(2026, 11, 12, 17, 0));
  assert.equal(p('pay 12 nov', d12).deadline, ist(2026, 11, 12));
});

test('off: a kind picked in a chip is not parsed — its words stay in the title', () => {
  const r = parseQuickAdd('Meet fri 5pm @riya !p1', { people, now: MON10, off: new Set(['deadline', 'owner', 'priority']) });
  assert.equal(r.title, 'Meet fri 5pm @riya !p1');
  assert.equal(r.deadline, undefined);
  assert.equal(r.owner_employee_id, undefined);
  assert.equal(r.priority, undefined);
});

test('lookup tables are own-property only', () => {
  assert.equal(p('do constructor 12').deadline, undefined);
  assert.equal(p('do 12 toString').deadline, undefined);
});
