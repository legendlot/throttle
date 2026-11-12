import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from './templates.js';

const N = (key, parent_key, kind, extra = {}) => ({ key, parent_key, kind, title: key, role_label: 'Lead', offset_days: 0, done_when: '', ...extra });
const codes = (r, k) => r.nodes[k] || [];

test('childKinds mirrors B1 for both audiences', () => {
  assert.deepEqual(T.childKinds('founders', null), ['milestone']);
  assert.deepEqual(T.childKinds('founders', 'milestone'), ['result', 'task']);
  assert.deepEqual(T.childKinds('founders', 'result'), ['task']);
  assert.deepEqual(T.childKinds('founders', 'task'), []);
  assert.deepEqual(T.childKinds('leads', null), ['result', 'task']);
  assert.deepEqual(T.childKinds('leads', 'result'), ['task']);
  assert.deepEqual(T.childKinds('leads', 'milestone'), []);
  assert.deepEqual(T.childKinds('nope', null), []);
});

test('valid founders + leads templates pass', () => {
  const f = { name: 'Launch', audience: 'founders', nodes: [
    N('m', null, 'milestone', { done_when: 'live' }), N('r', 'm', 'result', { done_when: 'x' }), N('t', 'r', 'task'), N('t2', 'm', 'task'),
    N('leaf', null, 'milestone') ] };   // a leaf milestone needs no done_when (created proposed)
  assert.equal(T.validateTemplate(f).ok, true);
  const l = { name: 'Sprint', audience: 'leads', nodes: [N('r', null, 'result', { done_when: 'x' }), N('t', 'r', 'task'), N('t0', null, 'task')] };
  assert.equal(T.validateTemplate(l).ok, true);
});

test('form errors: name, audience, description, node cap', () => {
  const r = T.validateTemplate({ name: '  ', audience: 'all', description: 'x'.repeat(2001), nodes: [] });
  assert.deepEqual(r.form.map(f => f.code), ['name_required', 'description_too_long', 'bad_audience']);
  assert.equal(T.validateTemplate({ name: 'x'.repeat(121), audience: 'leads', nodes: [] }).form[0].code, 'name_too_long');
  const many = Array.from({ length: 201 }, (_, i) => N('k' + i, null, 'task'));
  assert.ok(T.validateTemplate({ name: 'a', audience: 'leads', nodes: many }).form.some(f => f.code === 'too_many_nodes'));
});

test('shape errors by node key', () => {
  const r = T.validateTemplate({ name: 'a', audience: 'founders', nodes: [
    N('t', null, 'task'),                                    // founders root must be a milestone
    N('m', null, 'milestone', { done_when: 'd' }),
    N('tt', 'm', 'task'), N('under', 'tt', 'task'),          // tasks have no children
    N('lost', 'ghost', 'task'),                              // unknown parent
  ] });
  assert.ok(codes(r, 't').includes('bad_shape'));
  assert.ok(codes(r, 'under').includes('bad_shape'));
  assert.ok(codes(r, 'lost').includes('bad_shape'));
  assert.deepEqual(codes(r, 'm'), []);
  const l = T.validateTemplate({ name: 'a', audience: 'leads', nodes: [N('m', null, 'milestone'), N('r', null, 'result', { done_when: 'x' }), N('r2', 'r', 'result', { done_when: 'x' })] });
  assert.ok(codes(l, 'm').includes('bad_shape'));
  assert.ok(codes(l, 'r2').includes('bad_shape'));
});

test('done_when: every result; a milestone only when it has children', () => {
  const r = T.validateTemplate({ name: 'a', audience: 'founders', nodes: [N('m', null, 'milestone'), N('r', 'm', 'result')] });
  assert.ok(codes(r, 'm').includes('done_when_required'));
  assert.ok(codes(r, 'r').includes('done_when_required'));
});

test('node fields: role, offset range + integer, title, duplicate key, bad kind', () => {
  const r = T.validateTemplate({ name: 'a', audience: 'leads', nodes: [
    N('a', null, 'task', { role_label: '  ' }),
    N('b', null, 'task', { offset_days: 731 }), N('c', null, 'task', { offset_days: -366 }), N('d', null, 'task', { offset_days: 1.5 }),
    N('e', null, 'task', { offset_days: '' }),
    N('f', null, 'task', { title: ' ' }), N('g', null, 'task', { role_label: 'x'.repeat(41) }),
    N('a', null, 'task'), N('h', null, 'theme'),
  ] });
  assert.ok(codes(r, 'a').includes('role_required'));
  for (const k of ['b', 'c', 'd', 'e']) assert.ok(codes(r, k).includes('bad_offset'), k);
  assert.ok(codes(r, 'f').includes('bad_node'));
  assert.ok(codes(r, 'g').includes('bad_node'));
  assert.ok(codes(r, 'a').includes('duplicate_key'));
  assert.ok(codes(r, 'h').includes('bad_node'));
  assert.equal(T.validateTemplate({ name: 'a', audience: 'leads', nodes: [N('z', null, 'task', { offset_days: 730 }), N('y', null, 'task', { offset_days: -365 })] }).ok, true);
});

test('roles: distinct, case-insensitive + trimmed, first spelling kept', () => {
  assert.deepEqual(T.templateRoles([{ role_label: 'Lead' }, { role_label: ' lead ' }, { role_label: 'Designer' }, { role_label: '' }]), ['Lead', 'Designer']);
});

test('editor ops: add under a parent inherits role + offset; move renumbers; remove takes the subtree', () => {
  let n = T.addNode([], null, 'milestone', 'm');
  n = T.updateNode(n, 'm', { role_label: 'Lead', offset_days: 5 });
  n = T.addNode(n, 'm', 'result', 'r1');
  n = T.addNode(n, 'm', 'task', 't1');
  n = T.addNode(n, 'r1', 'task', 'rt');
  assert.equal(n.find(x => x.key === 'r1').role_label, 'Lead');
  assert.equal(n.find(x => x.key === 'r1').offset_days, 5);
  assert.deepEqual(T.orderedNodes(n).map(x => x.node.key + ':' + x.depth), ['m:0', 'r1:1', 'rt:2', 't1:1']);
  n = T.moveNode(n, 't1', -1);
  assert.deepEqual(T.orderedNodes(n).map(x => x.node.key), ['m', 't1', 'r1', 'rt']);
  assert.deepEqual(T.moveNode(n, 'm', -1), n);   // already first
  assert.deepEqual(T.removeNode(n, 'r1').map(x => x.key).sort(), ['m', 't1']);
});

test('save body: nested order, sort renumbered, trimmed, done_when only when set', () => {
  const body = T.toSaveBody({ id: 'tid', name: ' A ', description: ' ', audience: 'leads', nodes: [
    { key: 't', parent_key: 'r', kind: 'task', title: ' do ', role_label: ' Lead ', offset_days: '3', done_when: '', sort: 5 },
    { key: 'r', parent_key: null, kind: 'result', title: 'R', role_label: 'Lead', offset_days: 0, done_when: ' ok ', sort: 1 },
  ] });
  assert.equal(body.name, 'A');
  assert.equal(body.description, null);
  assert.deepEqual(body.nodes, [
    { key: 'r', parent_key: null, kind: 'result', title: 'R', role_label: 'Lead', offset_days: 0, sort: 10, done_when: 'ok' },
    { key: 't', parent_key: 'r', kind: 'task', title: 'do', role_label: 'Lead', offset_days: 3, sort: 10 },
  ]);
  assert.deepEqual(T.fromServerNodes([{ id: 'x', parent_node_id: null, kind: 'task', title: 'T', role_label: 'L', offset_days: 2, done_when: null, sort: 10 }]),
    [{ key: 'x', parent_key: null, kind: 'task', title: 'T', role_label: 'L', offset_days: 2, done_when: '', sort: 10 }]);
});

test('apply: dates from the anchor, people by role (case-insensitive), body only when complete', () => {
  const nodes = [{ id: 'm', parent_node_id: null, kind: 'milestone', title: 'M', role_label: 'Lead', offset_days: 7 },
    { id: 't', parent_node_id: 'm', kind: 'task', title: 'T', role_label: 'designer', offset_days: -2 }];
  const p = T.applyPreview(nodes, '2026-11-30', { Lead: 'e1', Designer: 'e2' }, [{ id: 'e1', full_name: 'Asha' }, { id: 'e2', full_name: 'Ravi' }]);
  assert.deepEqual(p.map(x => [x.key, x.depth, x.date, x.person]), [['m', 0, '2026-12-07', 'Asha'], ['t', 1, '2026-11-28', 'Ravi']]);
  // preview-only nodes (no role / offset) still list with no date or person
  assert.deepEqual(T.applyPreview([{ id: 'x', parent_node_id: null, kind: 'task', title: 'X' }], '2026-11-30', {}, []).map(x => [x.date, x.person]), [[null, null]]);
  assert.equal(T.applyBody('tid', { anchorId: 'a', anchorDate: '2026-11-30', roles: { Lead: 'e1' }, labels: ['Lead', 'Designer'] }), null);
  assert.deepEqual(T.applyBody('tid', { anchorId: 'a', anchorDate: '2026-11-30', roles: { Lead: 'e1', Designer: 'e2', Old: 'e9' }, labels: ['Lead', 'Designer'] }),
    { id: 'tid', anchor_id: 'a', anchor_date: '2026-11-30', roles: { Lead: 'e1', Designer: 'e2' } });
  assert.equal(T.applyBody('tid', { anchorId: 'a', anchorDate: '2026-13-01', roles: {}, labels: [] }), null);
  assert.equal(T.nodeDate('2026-12-31', 1), '2027-01-01');
  assert.equal(T.dayHint(0), 'the anchor day');
  assert.equal(T.dayHint(3), 'day 3 after');
  assert.equal(T.dayHint(-1), '1 day before');
  assert.equal(T.spanText({ min_offset: -2, max_offset: 14 }), 'day -2 → 14');
});

test('nav rule: may create, or sees any', () => {
  assert.equal(T.showTemplatesNav({ templates: [], can_create: { founders: false, leads: false } }), false);
  assert.equal(T.showTemplatesNav({ templates: [], can_create: { founders: false, leads: true } }), true);
  assert.equal(T.showTemplatesNav({ templates: [{ id: 'x' }], can_create: {} }), true);
  assert.equal(T.showTemplatesNav(null), false);
});

test('errors: words, never codes; key → node title; label → role', () => {
  const e = Object.assign(new Error('done_when_required'), { detail: { key: 'r' } });
  assert.match(T.templateErrorText(e, { nodeTitle: () => 'Retail live' }), /done when.*“Retail live”/);
  const r = Object.assign(new Error('role_unmapped'), { detail: { label: 'Designer' } });
  assert.match(T.templateErrorText(r), /role “Designer”/);
  assert.equal(T.templateErrorText(new Error('missing_fields')), 'Owner, due date and done-when are required.');   // plan_create's own code
  assert.match(T.templateErrorText(new Error('forbidden_space')), /Founders’ space/);
  const odd = T.templateErrorText(new Error('weird_trigger_code'));
  assert.ok(!odd.includes('weird_trigger_code'));
  assert.ok(!T.errorCodeText('zzz').includes('zzz'));
});
