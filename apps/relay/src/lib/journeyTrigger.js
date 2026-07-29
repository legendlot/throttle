// journeyTrigger — the journey `trigger` jsonb ⇄ form-state mapping, extracted from
// journeys/page.js so it can be unit-tested (S243).
//
// WHY THIS IS ITS OWN MODULE. `buildTrigger` is the SOLE writer of `comms.journeys.trigger`
// and every save REPLACES the whole object. That makes an omission here silent and
// destructive rather than merely incomplete: the key isn't left stale, it is deleted.
//
// It has now happened twice.
//   S241 — the function emitted only {type,name}, so a `filter` set out-of-band was dropped
//          the next time anyone opened the journey and pressed Save, quietly widening a
//          deliberately narrowed rollout to the full audience.
//   S242 — `requires_identifier` was added to the engine as a data-only field. From that day
//          every canvas Save STRIPPED the reachability gate off whichever journey was open.
//          Both gated journeys (ATC, Browse Abandonment) sat one Save away from silently
//          resuming anonymous enrolment.
//
// A warning comment was written after the first and did not prevent the second, because a
// comment cannot fail a build. Hence: this module is pure, and `roundTrips` below is the
// property the tests assert over EVERY key. **Adding a trigger key means adding it to
// buildTrigger, to triggerToForm, and to the round-trip test's fixture list — or the test
// fails, which is the point.**
//
// CJS exports (same as journey-canvas/graph.js): required by the node test, imported by JSX.

// Trigger-property filter rows ⇄ the stored `trigger.filter` object. The worker
// (ingest.js) ANDs simple equality over the EVENT's properties and string-compares, so the
// UI deliberately offers equality only — anything richer belongs on a condition node.
const filterRowsToObj = (rows) => (rows || [])
  .filter((r) => r && String(r.prop || '').trim())
  .reduce((o, r) => { o[String(r.prop).trim()] = String(r.value ?? '').trim(); return o; }, {});

const objToFilterRows = (f) => (f && typeof f === 'object' && !Array.isArray(f))
  ? Object.entries(f).map(([prop, value]) => ({ prop, value: String(value ?? '') }))
  : [];

// `requires_identifier` accepts a STRING (one type) or an ARRAY (any-of) in the worker. The
// form holds a comma-separated string for a single <select>, so the two shapes must convert
// symmetrically — writing "phone,email" back as a string would give the worker ONE bogus
// identifier type that matches nobody, silently blocking every enrolment. That failure looks
// identical to "the journey just doesn't fire", which is why it gets its own tested pair.
const requiresIdentifierToForm = (ri) => (Array.isArray(ri) ? ri.join(',') : (ri || ''));

const requiresIdentifierFromForm = (s) => {
  const parts = String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return null;          // omit the key entirely — absent means "no check"
  return parts.length === 1 ? parts[0] : parts;
};

// Build the stored trigger jsonb from form state — the shape ingest.js (event) and
// segment-entry.js (segment_entry) each match on.
function buildTrigger(j) {
  if (j.triggerType === 'segment_entry') {
    return { type: 'segment_entry', segment_id: j.triggerSegmentId };
  }
  const t = { type: 'event', name: (j.triggerEvent || '').trim() };
  const filter = filterRowsToObj(j.triggerFilter);
  if (Object.keys(filter).length) t.filter = filter;   // omit when empty — {} would be a no-op key
  const ri = requiresIdentifierFromForm(j.triggerRequiresIdentifier);
  if (ri) t.requires_identifier = ri;
  return t;
}

// The inverse: stored trigger → the form fields buildTrigger reads. Kept adjacent so the pair
// is obviously a pair; `roundTrips` is only true if they agree.
function triggerToForm(t) {
  const tr = t || {};
  return {
    triggerType: tr.type === 'segment_entry' ? 'segment_entry' : 'event',
    triggerEvent: tr.name || 'checkout_started',
    triggerSegmentId: tr.segment_id || '',
    triggerFilter: objToFilterRows(tr.filter),
    triggerRequiresIdentifier: requiresIdentifierToForm(tr.requires_identifier),
  };
}

// Does this stored trigger survive an open→save cycle unchanged? The guard the two incidents
// above needed. Used by the tests, and cheap enough to call anywhere.
function roundTrips(storedTrigger) {
  const a = JSON.stringify(sortKeys(storedTrigger));
  const b = JSON.stringify(sortKeys(buildTrigger(triggerToForm(storedTrigger))));
  return a === b;
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => { o[k] = sortKeys(v[k]); return o; }, {});
  }
  return v;
}

function triggerSummary(t, segments) {
  if (!t || !t.type) return '—';
  if (t.type === 'event') {
    const f = t.filter && typeof t.filter === 'object' ? Object.entries(t.filter) : [];
    const suffix = f.length ? ` where ${f.map(([k, v]) => `${k}=${v}`).join(' & ')}` : '';
    // Surfaced so the journey LIST shows gated-vs-ungated without opening each one — the
    // absence of any such signal is how two journeys went live enrolling unreachable profiles.
    const ri = requiresIdentifierToForm(t.requires_identifier).replace(',', '/');
    return `event: ${t.name || '?'}${suffix}${ri ? ` · needs ${ri}` : ''}`;
  }
  if (t.type === 'segment_entry') {
    const s = (segments || []).find((x) => x.id === t.segment_id);
    return `enters: ${s ? s.name : (t.segment_id || '?')}`;
  }
  return t.type;
}

module.exports = {
  buildTrigger, triggerToForm, roundTrips, triggerSummary,
  filterRowsToObj, objToFilterRows,
  requiresIdentifierToForm, requiresIdentifierFromForm,
};
