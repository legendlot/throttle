// test/_fake-forms-rpc.js — an in-memory comms.form_capture / comms.form_confirm (migration 0073).
//
// forms.js no longer writes form_submissions / consent as separate REST calls; both handlers make
// ONE rpc each and Postgres does the rest in a transaction. So the tests assert on OUTCOMES — the
// rows this store ends up holding — not on which PATCH/POST went out in which order.
//
// ⚠️ Mirrors migrations/0073_comms_form_capture_confirm_atomic.sql. Change one, change the other.
//   • capture: insert ON CONFLICT (form_id, dedupe_key) DO NOTHING; on conflict, channels not
//     already stored → none = deduped (no writes), some = widen (had || added) + consent for the
//     added only. Consent only when p_consent_purpose is non-null. A null dedupe_key never conflicts.
//   • confirm: unknown token → invalid_token; confirmed_at set → already; else channels = stored ∩
//     {email,whatsapp} (distinct), falling back to payload presence ONLY when stored is null/empty;
//     stamp confirmed_at + `marketing` opted_in consent rows.
//   • ATOMIC: `failNext(fn, stage)` raises mid-function and the whole call rolls back — no rows.
//     One call runs to completion before the next starts (no await inside), which is what the
//     row lock / unique index give the real thing under concurrency.
function createFakeFormsDb({ forms = [] } = {}) {
  const db = {
    forms: forms.slice(),        // {id, slug, consent_copy_version} — the confirm join
    submissions: [],
    consent: [],
    calls: [],                   // {fn, args} for every rpc, failed or not — the args contract
  };
  let seq = 0, failures = [];

  // stage: 'call' = PostgREST refuses before the function runs; 'consent' = the consent insert
  // raises AFTER the submission insert / confirmed_at stamp (the case the old code half-wrote).
  db.failNext = (fn, stage = 'consent') => { failures.push({ fn, stage }); };

  db.seedSubmission = (row) => {
    const s = { id: `sub-${++seq}`, form_id: null, profile_id: null, payload: {}, dedupe_key: null,
      channels: null, source_url: null, ip_hash: null, turnstile_ok: true, confirm_token: null,
      submitted_at: '2026-09-01T09:00:00Z', confirmed_at: null, ...row };
    db.submissions.push(s);
    return s;
  };

  const raise = (msg) => { const e = new Error(msg); e.pg = true; throw e; };
  const failAt = (fn, stage) => {
    const i = failures.findIndex((f) => f.fn === fn && f.stage === stage);
    if (i === -1) return;
    failures.splice(i, 1);
    // Echoes the row the way PostgREST does — the handler must never forward it.
    raise('insert or update on table "consent" violates foreign key constraint "consent_profile_id_fkey" ' +
      'Key (email)=(a@b.com) is not present');
  };

  function formCapture(a) {
    const channels = a.p_channels || [];
    const insert = (key) => {
      const s = { id: `sub-${++seq}`, form_id: a.p_form_id, profile_id: a.p_profile_id, payload: a.p_payload,
        dedupe_key: key, channels: channels.slice(), source_url: a.p_source_url, ip_hash: a.p_ip_hash,
        turnstile_ok: true, confirm_token: a.p_confirm_token, submitted_at: new Date().toISOString(),
        confirmed_at: null };
      db.submissions.push(s);
      return s;
    };
    let row, consentCh;
    const existing = a.p_dedupe_key != null
      ? db.submissions.find((s) => s.form_id === a.p_form_id && s.dedupe_key === a.p_dedupe_key) : null;
    if (existing) {
      const had = existing.channels || [];
      consentCh = channels.filter((c) => !had.includes(c));
      if (!consentCh.length) return { deduped: true, submission_id: existing.id };
      existing.channels = had.concat(consentCh);
      row = existing;
    } else {
      row = insert(a.p_dedupe_key ?? null);
      consentCh = channels.slice();
    }
    if (a.p_consent_purpose != null) {
      failAt('form_capture', 'consent');
      for (const c of consentCh) {
        db.consent.push({ profile_id: a.p_profile_id, channel: c, purpose: a.p_consent_purpose,
          state: 'opted_in', source: a.p_consent_source, evidence: a.p_evidence });
      }
    }
    return { deduped: false, submission_id: row.id, consent_channels: consentCh };
  }

  function formConfirm(a) {
    const s = db.submissions.find((x) => x.confirm_token != null && x.confirm_token === a.p_token);
    if (!s) return { error: 'invalid_token' };
    if (s.confirmed_at) return { confirmed: true, already: true };
    let ch = [...new Set((s.channels || []).filter((c) => c === 'email' || c === 'whatsapp'))].sort();
    if (!ch.length) {
      ch = [s.payload && s.payload.email ? 'email' : null, s.payload && s.payload.phone ? 'whatsapp' : null]
        .filter(Boolean);
    }
    const now = new Date().toISOString();
    const f = db.forms.find((x) => x.id === s.form_id) || {};
    s.confirmed_at = now;
    failAt('form_confirm', 'consent');
    for (const c of ch) {
      db.consent.push({ profile_id: s.profile_id, channel: c, purpose: 'marketing', state: 'opted_in',
        source: `website_form:${f.slug || 'unknown'}`,
        evidence: { form: f.slug ?? null, source_url: s.source_url, consent_copy_version: f.consent_copy_version ?? null,
          submitted_at: s.submitted_at, confirmed_at: now, turnstile_ok: true },
        captured_at: now });
    }
    return { confirmed: true, channels: ch };
  }

  const FNS = { form_capture: formCapture, form_confirm: formConfirm };

  // Returns an sbComms-shaped result for an rpc this fake owns, or undefined so the caller's own
  // mock answers everything else (forms lookup, resolve_identity, events, identifiers…).
  db.route = async (path, opts = {}) => {
    const m = /^\/rest\/v1\/rpc\/(form_capture|form_confirm)$/.exec(path);
    if (!m) return undefined;
    const fn = m[1];
    const args = opts.body ? JSON.parse(opts.body) : {};
    db.calls.push({ fn, args });
    const pre = failures.findIndex((f) => f.fn === fn && f.stage === 'call');
    if (pre !== -1) { failures.splice(pre, 1); return { ok: false, status: 503, data: { message: 'upstream timeout' } }; }
    // The transaction: snapshot, run, restore on any raise. Rows are restored IN PLACE so a
    // test holding a seeded row object still sees the rolled-back state.
    const snap = db.submissions.map((s) => [s, { ...s, channels: s.channels && s.channels.slice() }]);
    const nConsent = db.consent.length;
    try {
      return { ok: true, status: 200, data: FNS[fn](args) };
    } catch (e) {
      if (!e.pg) throw e;
      db.submissions.length = 0;
      for (const [row, was] of snap) db.submissions.push(Object.assign(row, was));
      db.consent.length = nConsent;   // append-only within a call, so truncation is the rollback
      return { ok: false, status: 409, data: { code: '23503', message: e.message } };
    }
  };

  db.callsTo = (fn) => db.calls.filter((c) => c.fn === fn);
  return db;
}

module.exports = { createFakeFormsDb };
