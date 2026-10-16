import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepeatGate, overlayRect, readRect, roiRect, REPEAT_GAP_MS } from '../src/op/camera.mjs';

test('the crop is the factory Scanner’s: centre 60%, the same integer maths', () => {
  // 02_scanner scanFrame: roiW = floor(vw*0.6), roiX = floor((vw-roiW)/2)
  for (const [vw, vh] of [[1920, 1080], [1080, 1920], [1280, 720], [641, 479]]) {
    const w = Math.floor(vw * 0.6), h = Math.floor(vh * 0.6);
    assert.deepEqual(roiRect(vw, vh), { x: Math.floor((vw - w) / 2), y: Math.floor((vh - h) / 2), w, h });
  }
});

test('only what the viewfinder shows is read: the crop is clipped to the visible part of the frame', () => {
  // Landscape frame in a landscape box of the same shape: nothing is hidden, so it is exactly the Scanner's crop.
  assert.deepEqual(readRect(1920, 1080, 400, 225), roiRect(1920, 1080));
  // Portrait phone frame in a 4:3 box: only the middle ~810 of 1920 rows are on screen; the crop stops there.
  const r = readRect(1080, 1920, 360, 270);
  assert.equal(r.w, roiRect(1080, 1920).w);
  assert.ok(Math.abs(r.h - 810) <= 1 && r.y >= 554 && r.y + r.h <= 1366, JSON.stringify(r));
  // No box size known: the Scanner's crop.
  assert.deepEqual(readRect(1280, 720), roiRect(1280, 720));
});

test('the aiming frame sits exactly where the engine reads', () => {
  // Same aspect: the frame is exactly the centre 60%.
  const same = overlayRect(1920, 1080, 400, 225);
  assert.ok(Math.abs(same.left - 0.2) < 0.01 && Math.abs(same.width - 0.6) < 0.01 && Math.abs(same.top - 0.2) < 0.01);
  // A portrait phone frame in a 4:3 box: cover crops top and bottom, so the crop fills the box's height and 60% of its width.
  const tall = overlayRect(1080, 1920, 360, 270);
  assert.ok(Math.abs(tall.width - 0.6) < 0.01 && tall.top === 0 && Math.abs(tall.height - 1) < 1e-9);
  assert.equal(overlayRect(0, 0, 360, 270), null);
});

test('a sticker left in view is read once; taken away and shown again, it is read again', () => {
  const g = makeRepeatGate();
  assert.deepEqual(g.see(['LOT-00000001'], 0), ['LOT-00000001']);
  for (let t = 33; t < 10_000; t += 33) assert.deepEqual(g.see(['LOT-00000001'], t), [], 'still in view → quiet');
  assert.deepEqual(g.see(['LOT-00000001'], 10_000 + REPEAT_GAP_MS), ['LOT-00000001'], 'gone for the gap → read again');
});

test('a new sticker is read even while the last one is still in view', () => {
  const g = makeRepeatGate();
  g.see(['LOT-00000001'], 0);
  assert.deepEqual(g.see(['LOT-00000001', 'LOT-00000002'], 100), ['LOT-00000002']);
});

test('a code the screen could not take yet is read again on the next frame', () => {
  const g = makeRepeatGate();
  const first = g.see(['LOT-00000003'], 0);
  g.forget(first);
  assert.deepEqual(g.see(['LOT-00000003'], 33), ['LOT-00000003']);
});
