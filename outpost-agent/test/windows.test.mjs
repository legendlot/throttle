// The Windows driver's sent / not-sent classification, against a fake spooler (koffi never loads here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsDriver, printerFlags } from '../lib/printers.mjs';

function fakeSpool(over = {}) {
  const calls = [];
  const w = {
    open: () => (calls.push('open'), 'H'),
    close: () => (calls.push('close'), true),
    info: () => ({ attributes: 0, status: 0 }),
    startDoc: () => (calls.push('startDoc'), true),
    startPage: () => (calls.push('startPage'), true),
    write: (h, buf) => (calls.push('write'), buf.length),
    endPage: () => (calls.push('endPage'), true),
    endDoc: () => (calls.push('endDoc'), true),
    abort: () => (calls.push('abort'), true),
    ...over,
  };
  return { w, calls };
}
const fails = async (p, sent) => { const e = await p.then(() => null, e => e); assert.ok(e, 'should throw'); assert.equal(e.sent, sent, e.message); return e; };

test('a clean job: one document, closed once, never aborted', async () => {
  const { w, calls } = fakeSpool();
  await windowsDriver('TSC TE244', w).send('SIZE 50 mm\r\nPRINT 1\r\n', 't');
  assert.deepEqual(calls, ['open', 'startDoc', 'startPage', 'write', 'endPage', 'endDoc', 'close']);
});

test('nothing sent: printer missing, paused, offline, or job refused', async () => {
  await fails(windowsDriver('X', fakeSpool({ open: () => null }).w).send('a'), false);
  await fails(windowsDriver('X', fakeSpool({ info: () => ({ attributes: 0, status: 0x1 }) }).w).send('a'), false);
  await fails(windowsDriver('X', fakeSpool({ info: () => ({ attributes: 0x400, status: 0 }) }).w).send('a'), false);
  const s = fakeSpool({ startDoc: () => false });
  await fails(windowsDriver('X', s.w).send('a'), false);
  assert.ok(!s.calls.includes('abort') && s.calls.at(-1) === 'close');
});

test('a short or failed write is unknown and the half-written job is aborted, not printed', async () => {
  const s = fakeSpool({ write: () => 3 });
  await fails(windowsDriver('X', s.w).send('abcdef'), true);
  assert.ok(s.calls.includes('abort') && !s.calls.includes('endDoc'));
  const t = fakeSpool({ write: () => { throw new Error('ffi blew up'); } });
  await fails(windowsDriver('X', t.w).send('abc'), true);           // a plain Error after the write began = unknown
  assert.ok(t.calls.includes('abort'));
});

test('a plain Error before any byte is not_printed; after the write it is unknown', async () => {
  await fails(windowsDriver('X', fakeSpool({ startPage: () => { throw new Error('x'); } }).w).send('a'), false);
  await fails(windowsDriver('X', fakeSpool({ endDoc: () => { throw new Error('x'); } }).w).send('a'), true);
  await fails(windowsDriver('X', fakeSpool({ endDoc: () => false }).w).send('a'), true);
});

test('status: flags from Status bits and the WORK_OFFLINE attribute; unreadable is said, not hidden', async () => {
  assert.deepEqual(printerFlags({ attributes: 0x400, status: 0x10 }), ['PAPER_OUT', 'WORK_OFFLINE']);
  assert.deepEqual(await windowsDriver('X', fakeSpool().w).status(), { ok: true, detail: null });
  assert.deepEqual(await windowsDriver('X', fakeSpool({ info: () => null }).w).status(), { ok: true, detail: 'status unreadable' });
  assert.equal((await windowsDriver('X', fakeSpool({ open: () => null }).w).status()).ok, false);
});

test('an empty printer name is refused at start-up', () => {
  assert.throws(() => windowsDriver('  ', fakeSpool().w), /needs a name/);
});
