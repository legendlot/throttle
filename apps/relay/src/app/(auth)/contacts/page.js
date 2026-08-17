'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, Plus, RefreshCw, LogOut, Mail, MessageCircle, MessageSquare, Smartphone } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateTime } from '@/components/format.js';

// `rcs` is here so an EXPLICIT rcs opt-out/opt-in can be recorded — that override is what
// the gate's resolver honours. Day-to-day rcs consent is DERIVED from sms (see rcsEffective).
const CHANNELS = ['email', 'sms', 'rcs', 'whatsapp'];
const PURPOSES = ['marketing', 'transactional', 'utility'];
const STATES = ['opted_in', 'opted_out', 'unknown'];
const STATE_TONE = { opted_in: 'green', opted_out: 'red', unknown: 'gray' };

// Per-channel opt-in strip (BiteSpeed's Channels column, which is the reference Afshaan
// gave). One icon per channel, and the colour answers two different questions at once:
//   green  — opted in
//   red    — opted out (an explicit refusal; must never look the same as "we don't know")
//   amber  — reachable, but no marketing consent on record → `unknown` in the ledger
//   grey   — no address on file at all, so the channel is not a choice we ever had
// The grey/amber split matters: RULE-CONSENT-001 keeps `unknown` from overriding a known
// state, and collapsing "never asked" into "no address" would hide exactly the population
// worth asking.
const CHANNEL_ICONS = [
  { key: 'email', Icon: Mail, label: 'Email' },
  { key: 'whatsapp', Icon: MessageCircle, label: 'WhatsApp' },
  { key: 'sms', Icon: MessageSquare, label: 'SMS' },
  { key: 'rcs', Icon: Smartphone, label: 'RCS' },
];

// Effective RCS consent, mirroring comms.marketing_consented / gate.js exactly: rcs rides
// the SMS opt-in unless a row explicitly says otherwise, and an SMS opt-OUT always wins —
// even over an explicit rcs opt-in (S290). Showing the raw rcs ledger here instead would
// read "never asked" for ~10k people the gate happily sends to (the S251 contradiction class).
function rcsEffective(consent) {
  const r = consent?.rcs, s = consent?.sms;
  if (r === 'opted_out') return 'opted_out';
  if (r === 'opted_in') return s === 'opted_in' ? 'opted_in' : s;
  return s;
}
const CONSENT_COLOR = {
  opted_in: { fg: '#34d399', bg: 'rgba(52,211,153,.13)', bd: 'rgba(52,211,153,.34)' },
  opted_out: { fg: '#f87171', bg: 'rgba(248,113,113,.13)', bd: 'rgba(248,113,113,.34)' },
  unknown: { fg: '#f59e0b', bg: 'rgba(245,158,11,.12)', bd: 'rgba(245,158,11,.30)' },
  none: { fg: '#6b7178', bg: 'rgba(255,255,255,.03)', bd: 'rgba(255,255,255,.08)' },
};

// Which consent row is ACTUALLY in effect per (channel, purpose) — i.e. what the send gate
// will use. Mirrors consent.js `_latestConsentRaw` exactly: latest by captured_at, EXCLUDING
// `unknown` (RULE-CONSENT-001).
//
// This exists because the raw ledger is genuinely misleading to read (found 2026-07-31 from
// a real contact). Shopflo BACK-DATES `captured_at` by ~3 minutes and arrives ~1 minute
// LATER than the Shopify webhook, so sorting the ledger by captured_at puts the row that
// arrived LAST *below* rows that arrived first. The screen therefore reads as
// "unknown overwrote opted_in" when the true order was the opposite — the unknowns were
// written first, when no known state existed, and the opt-in landed afterwards. Nothing
// marked which row won, so a CORRECT system looked broken (and a broken one would look fine).
function effectiveConsentIds(rows) {
  const best = new Map();
  for (const c of rows || []) {
    if (c.state === 'unknown') continue;          // carries no information — gate ignores it
    const k = `${c.channel}|${c.purpose}`;
    const prev = best.get(k);
    const key = (x) => `${x.captured_at || ''}|${x.created_at || ''}`;
    if (!prev || key(c) > key(prev)) best.set(k, c);
  }
  return new Set([...best.values()].map((c) => c.id));
}
// Back-dating is invisible unless shown: a row whose captured_at is materially older than
// when we actually recorded it is exactly the case that makes the ledger read out of order.
const BACKDATE_MS = 60 * 1000;
function backdatedBy(c) {
  if (!c?.captured_at || !c?.created_at) return 0;
  const d = new Date(c.created_at) - new Date(c.captured_at);
  return d > BACKDATE_MS ? d : 0;
}
function humanGap(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Header tiles (S252). Two different questions, shown side by side rather than collapsed:
//   ON FILE  — do we hold the identifier at all?
//   OPTED IN — do we hold it AND a marketing opt-in?
// Campaign sizing needs the second; only the first tells you the data is healthy. Showing
// one alone invites planning a broadcast against a number that is not sendable.
function Tile({ label, value, sub, tone, warn }) {
  return (
    <div style={{ flex: '1 1 150px', minWidth: 140, padding: '12px 14px',
      border: '1px solid var(--bd, #2a2e35)', borderRadius: 10, background: 'var(--surface-2, rgba(255,255,255,.02))' }}>
      <div className="dim" style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-disp)', fontSize: 22, fontWeight: 600, marginTop: 4,
        color: tone || 'var(--t1)' }}>
        {value == null ? '—' : Number(value).toLocaleString('en-IN')}
      </div>
      {sub && (
        <div style={{ fontSize: 10.5, marginTop: 2, color: warn ? 'var(--warn, #f59e0b)' : 'var(--t3, #9aa0aa)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function ChannelStrip({ consent, hasEmail, hasPhone }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {CHANNEL_ICONS.map(({ key, Icon, label }) => {
        // WhatsApp, SMS and RCS all ride the phone number; email rides the email address.
        const reachable = key === 'email' ? hasEmail : hasPhone;
        const state = key === 'rcs' ? rcsEffective(consent) : consent?.[key];
        const tone = !reachable ? 'none' : (state === 'opted_in' ? 'opted_in'
          : state === 'opted_out' ? 'opted_out' : 'unknown');
        const c = CONSENT_COLOR[tone];
        const derived = key === 'rcs' && consent?.rcs == null ? ' (follows SMS)' : '';
        const why = !reachable ? `${label}: no address on file`
          : state === 'opted_in' ? `${label}: opted in to marketing${derived}`
          : state === 'opted_out' ? `${label}: opted OUT of marketing${derived}`
          : `${label}: reachable, no marketing consent recorded${derived}`;
        return (
          <span key={key} title={why} aria-label={why}
            style={{ width: 24, height: 24, borderRadius: 6, display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center',
              color: c.fg, background: c.bg, border: `1px solid ${c.bd}` }}>
            <Icon size={13} />
          </span>
        );
      })}
    </span>
  );
}

export default function ContactsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // M15 — a failed getProfile must not render as "no identifiers / no events" (a real empty
  // state); the seeded detail (set on open(), before the fetch resolves) carries [] for these.
  const [detailError, setDetailError] = useState(false);

  // record-consent form
  const [cf, setCf] = useState({ channel: 'email', purpose: 'marketing', state: 'opted_in', source: 'manual' });
  const [saving, setSaving] = useState(false);

  // opt-out-everywhere (LOW-optout) — the Meta "on-or-off-WhatsApp" account-level withdrawal
  const [optingOut, setOptingOut] = useState(false);
  const [optOutResult, setOptOutResult] = useState(null);

  const canConsent = !perms || perms.data_consent_admin;

  // Anonymous = a profile with no email and no phone: a browser session the pixel created.
  // 25,154 of 154,937 profiles, and because they are the NEWEST rows they sorted to the
  // top — 102 of the 200 rows this page used to render were unreachable noise. Hidden by
  // default; the toggle brings them back. They are never deleted from here.
  const [includeAnon, setIncludeAnon] = useState(false);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [counts, setCounts] = useState(null);

  // The search term is debounced rather than fired per keystroke — the RPC is ~7ms but
  // the round-trip is not, and an un-debounced search races its own responses.
  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(h);
  }, [q]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await garageFetch('getProfiles', {
        limit: 200,
        include_anonymous: includeAnon ? 'true' : 'false',
        ...(debouncedQ ? { q: debouncedQ } : {}),
      }, session);
      // The RPC returns {rows, include_anonymous}; tolerate the old bare-array shape so a
      // cached worker mid-deploy degrades to "no contacts" rather than a crash.
      const list = Array.isArray(r) ? r : (Array.isArray(r?.rows) ? r.rows : []);
      setRows(list);
    } catch (e) { showToast(e.message || 'Failed to load contacts', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast, includeAnon, debouncedQ]);
  useEffect(() => { load(); }, [load]);

  // Counts are their OWN request and deliberately never block the table: counting
  // anonymous profiles is a whole-table anti-join (~2.5s) while the list itself is ~18ms.
  // Fetched once per mount — the number moves slowly and is a data-health note, not state
  // anything on screen depends on. A failure is silent: a missing footnote is not an error.
  useEffect(() => {
    if (!session) return;
    let alive = true;
    (async () => {
      try {
        const c = await garageFetch('getProfileCounts', {}, session);
        if (alive && c && typeof c === 'object') setCounts(c);
      } catch { /* decoration only */ }
    })();
    return () => { alive = false; };
  }, [session]);

  // Delivery blocks for the open contact (S253). Loaded alongside the detail.
  //
  // ⚠️ Matched on the ADDRESS, never profile_id. `comms.suppressions` is keyed
  // (channel, value), and the Shopify customers/redact writer stores rows with NO
  // profile_id at all — so a profile_id lookup would silently miss exactly the
  // suppressions that matter most (legal erasures).
  const [blocks, setBlocks] = useState(null);
  const loadBlocks = useCallback(async (d) => {
    const vals = [
      ...(d?.identifiers || []).filter((i) => ['email', 'phone'].includes(i.type)).map((i) => i.value),
      d?.profile?.email, d?.profile?.phone,
    ].filter(Boolean);
    if (!vals.length) { setBlocks({ suppressions: [], lifts: [] }); return; }
    try {
      const r = await garageFetch('getSuppressions', { values: [...new Set(vals)].join(',') }, session);
      const mine = new Set(vals.map((v) => String(v).toLowerCase()));
      setBlocks({
        suppressions: (r?.suppressions || []),
        // Lifts come back as the recent-100 feed, so narrow to this contact's addresses.
        lifts: (r?.lifts || []).filter((l) => mine.has(String(l.value || '').toLowerCase())),
      });
    } catch { setBlocks({ suppressions: [], lifts: [], error: true }); }
  }, [session]);

  async function liftBlock(b) {
    if (b.reason === 'gdpr_redact') {
      showToast('A GDPR/DPDP erasure block cannot be lifted here', 'error');
      return;
    }
    const extra = b.reason === 'complaint'
      ? '\n\nThis address reported a previous message as SPAM. Re-enabling sending to it '
        + 'puts sender reputation at risk for every other customer.'
      : '';
    if (!window.confirm(
      `Lift the ${b.reason} block on ${b.value}?\n\n`
      + `They will start receiving ${b.channel} again — including marketing, if they are opted in.`
      + `${extra}\n\nThis is recorded against your name.`)) return;
    try {
      await workerFetch('removeSuppression', { id: b.id }, session);
      showToast('Block lifted', 'success');
      if (detail?.profile?.id) loadBlocks(detail);
    } catch (e) {
      const m = String(e.message || '');
      showToast(m === 'gdpr_redact_cannot_be_lifted'
        ? 'Erasure requests cannot be lifted — this is a legal block'
        : (m || 'Could not lift the block'), 'error');
    }
  }

  const loadDetail = useCallback(async (id) => {
    setDetailLoading(true);
    setDetailError(false);
    try {
      const d = await garageFetch('getProfile', { id }, session);
      setDetail(d || null);
      loadBlocks(d);                      // delivery blocks ride with the detail (S253)
    } catch (e) { setDetailError(true); showToast(e.message || 'Failed to load contact', 'error'); }
    finally { setDetailLoading(false); }
  }, [session, showToast, loadBlocks]);

  function open(r) {
    setDetail({ profile: r, identifiers: [], consent: [], events: [] });
    setDetailError(false);
    setBlocks(null);
    setOptOutResult(null);
    setView('detail');
    loadDetail(r.id);
  }

  async function addConsent() {
    if (!detail?.profile?.id) return;
    setSaving(true);
    try {
      await workerFetch('recordConsent', { profile_id: detail.profile.id, ...cf }, session);
      showToast('Consent recorded', 'success');
      loadDetail(detail.profile.id);
    } catch (e) { showToast(e.message || 'Failed to record consent', 'error'); }
    finally { setSaving(false); }
  }

  // LOW-optout — mirrors commsops-worker's optOutProfile contract exactly: POST
  // { profile_id, state }, channels defaults to ['email','sms','whatsapp'] server-side.
  // Response is { applied: [{ channel, ok, purpose, state }, ...] } on full success; a
  // partial failure comes back as a thrown error (workerFetch throws on !res.ok), so
  // optOutResult only ever renders after every channel succeeded.
  async function optOutEverywhere() {
    if (!detail?.profile?.id) return;
    const name = detail.profile.display_name || 'this contact';
    if (!window.confirm(
      `Opt out ${name} from marketing on every channel (email, SMS, WhatsApp — RCS follows SMS)?\n\n`
      + `This is the account-level withdrawal — equivalent to Meta's "on-or-off-WhatsApp" toggle. `
      + `Transactional/utility messages (orders, shipping) are unaffected.`)) return;
    setOptingOut(true);
    setOptOutResult(null);
    try {
      const r = await workerFetch('optOutProfile', {
        profile_id: detail.profile.id, state: 'opted_out', requested_via: 'relay_contacts_ui',
      }, session);
      const applied = r?.data?.applied || [];
      setOptOutResult(applied);
      showToast('Opted out on all channels', 'success');
      loadDetail(detail.profile.id);
    } catch (e) { showToast(e.message || 'Opt-out failed', 'error'); }
    finally { setOptingOut(false); }
  }

  if (perms && !perms.relay_view) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Relay access required.</div>;

  if (view === 'detail' && detail) {
    const p = detail.profile || {};
    const attrs = p.attributes || {};
    const attrEntries = Object.entries(attrs);
    return (
      <div className="pg">
        <div className="po-head">
          <div className="po-head-l">
            <Btn onClick={() => { setView('list'); setDetail(null); }}><ArrowLeft size={14} /> Back to contacts</Btn>
            <span className="po-head-no" style={{ fontSize: 18 }}>{p.display_name || 'Contact'}</span>
            {(p.city || p.locale) && <Badge label={[p.city, p.locale].filter(Boolean).join(' · ')} tone="gray" />}
          </div>
          <div className="po-head-r">
            <Btn onClick={() => loadDetail(p.id)} disabled={detailLoading}><RefreshCw size={14} /> Refresh</Btn>
          </div>
        </div>

        <div className="po-grid">
          <Panel title="Profile" pad>
            <div className="kv-grid">
              <div><div className="kv-k">Name</div><div className="kv-v">{p.display_name || '—'}</div></div>
              <div><div className="kv-k">Created</div><div className="kv-v mono">{fmtDateTime(p.created_at)}</div></div>
              {attrEntries.length === 0
                ? <div style={{ gridColumn: '1 / -1', color: 'var(--text-4)', fontSize: 12.5 }}>No derived attributes yet.</div>
                : attrEntries.map(([k, v]) => (
                    <div key={k}><div className="kv-k">{k}</div><div className="kv-v mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</div></div>
                  ))}
            </div>
          </Panel>

          <Panel title="Identifiers" count={detail.identifiers?.length || 0}>
            {detailLoading ? <div style={{ padding: 18, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
              : detailError
              ? (
                <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--red, #DE2A2A)', fontSize: 12.5 }}>Could not load identifiers.</span>
                  <Btn onClick={() => loadDetail(p.id)}><RefreshCw size={14} /> Retry</Btn>
                </div>
              )
              : (!detail.identifiers || detail.identifiers.length === 0)
              ? <div style={{ padding: 16, color: 'var(--text-4)', fontSize: 12.5 }}>No identifiers.</div>
              : (
                <div className="table-scroll">
                <table className="dt">
                  <thead><tr><th>Type</th><th>Value</th><th>Verified</th><th>Source</th></tr></thead>
                  <tbody>
                    {detail.identifiers.map((id) => (
                      <tr key={id.id}>
                        <td><Badge label={id.type} tone="blue" /></td>
                        <td className="mono">{id.value}</td>
                        <td>{id.is_verified ? <Badge label="yes" tone="green" /> : <span className="dim">no</span>}</td>
                        <td className="dim">{id.source || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
          </Panel>
        </div>

        {/* DELIVERY BLOCKS (S253) — the first surface for comms.suppressions.
            This is gate step ① and it outranks consent: a block here stops ORDER and
            SHIPPING messages too, not just marketing. Rendered above the consent ledger
            for exactly that reason — if something is blocked, no amount of consent below
            explains why nothing is arriving. */}
        <Panel title="Delivery blocks" count={blocks?.suppressions?.length || 0}>
          {blocks === null ? (
            <div style={{ padding: 18, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : blocks.error ? (
            <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--red, #DE2A2A)', fontSize: 12.5 }}>Could not check delivery blocks.</span>
              <Btn onClick={() => loadBlocks(detail)}><RefreshCw size={14} /> Retry</Btn>
            </div>
          ) : blocks.suppressions.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--text-4)', fontSize: 12.5 }}>
              No delivery blocks — nothing is stopping messages to this contact at the gate.
              {blocks.lifts?.length > 0 && (
                <span> Previously blocked and lifted:{' '}
                  {blocks.lifts.map((l) => `${l.original_reason} on ${l.channel} (${fmtDateTime(l.lifted_at)}${l.lifted_by ? ' by ' + l.lifted_by : ''})`).join(' · ')}
                </span>
              )}
            </div>
          ) : (
            <>
              <div className="tw-note" style={{ margin: '10px 12px', borderLeft: '3px solid var(--red, #f87171)' }}>
                <b>Blocked at the send gate.</b> This outranks consent and stops
                <b> every</b> message including order and shipping updates.
              </div>
              <div className="table-scroll">
              <table className="dt">
                <thead><tr><th>Channel</th><th>Address</th><th>Reason</th><th>Blocked</th><th></th></tr></thead>
                <tbody>
                  {blocks.suppressions.map((b) => (
                    <tr key={b.id}>
                      <td>{b.channel}</td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{b.value}</td>
                      <td>
                        <Badge label={b.reason}
                          tone={b.reason === 'gdpr_redact' ? 'red' : b.reason === 'complaint' ? 'red' : 'yellow'} />
                      </td>
                      <td className="mono dim">{fmtDateTime(b.created_at)}</td>
                      <td>
                        {b.reason === 'gdpr_redact'
                          ? <span className="dim" style={{ fontSize: 11.5 }}
                              title="Shopify customers/redact — a legal erasure request. Lifting it would re-enable messaging to someone who asked to be forgotten.">
                              legal erasure — cannot be lifted
                            </span>
                          : canConsent
                            ? <Btn onClick={() => liftBlock(b)}>Lift block</Btn>
                            : <span className="dim" style={{ fontSize: 11.5 }}>needs consent admin</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )}
        </Panel>

        <Panel title="Consent" count={detail.consent?.length || 0}>
          {detailLoading ? <div style={{ padding: 18, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            : detailError
              ? (
                <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--red, #DE2A2A)', fontSize: 12.5 }}>Could not load consent records.</span>
                  <Btn onClick={() => loadDetail(p.id)}><RefreshCw size={14} /> Retry</Btn>
                </div>
              )
              : (!detail.consent || detail.consent.length === 0)
              ? <div style={{ padding: 16, color: 'var(--text-4)', fontSize: 12.5 }}>No consent records.</div>
              : (() => {
                const eff = effectiveConsentIds(detail.consent);
                // Ordered by ARRIVAL (created_at), not captured_at. The ledger's own
                // timestamp is author-supplied and Shopflo back-dates it, so a captured_at
                // sort shows events out of the order they actually happened — which is
                // precisely what made this panel read as "unknown overwrote opted_in".
                const rows = [...detail.consent].sort((a, b) =>
                  String(b.created_at || b.captured_at || '').localeCompare(String(a.created_at || a.captured_at || '')));
                const anyBackdated = rows.some((c) => backdatedBy(c) > 0);
                return (
                  <>
                    <div className="tw-note" style={{ margin: '10px 12px' }}>
                      Append-only — newest first <b>by when we recorded it</b>.{' '}
                      <b>In effect</b> marks the row the send gate actually uses per channel and
                      purpose: the latest <i>known</i> state.{' '}
                      <code>unknown</code> rows carry no information and are skipped entirely
                      (RULE-CONSENT-001), so an older <code>opted_in</code> still wins over a
                      newer <code>unknown</code>.
                      {anyBackdated && <> ⚠️ Some rows were <b>back-dated</b> by their source —
                        the Captured column is when the customer acted, Recorded is when it
                        reached us, and they can disagree by minutes.</>}
                    </div>
                    <div className="table-scroll">
                    <table className="dt">
                      <thead><tr>
                        <th>Channel</th><th>Purpose</th><th>State</th><th>Source</th>
                        <th>Captured</th><th>Recorded</th><th></th>
                      </tr></thead>
                      <tbody>
                        {rows.map((c) => {
                          const isEff = eff.has(c.id);
                          const bd = backdatedBy(c);
                          const ignored = c.state === 'unknown';
                          return (
                            <tr key={c.id} style={ignored ? { opacity: .55 } : undefined}>
                              <td>{c.channel}</td>
                              <td className="dim">{c.purpose}</td>
                              <td><Badge label={c.state} tone={STATE_TONE[c.state] || 'gray'} /></td>
                              <td className="dim">{c.source || '—'}</td>
                              <td className="mono dim">{fmtDateTime(c.captured_at)}</td>
                              <td className="mono dim" title={bd ? `Recorded ${humanGap(bd)} after the customer acted — this source back-dates captured_at` : undefined}>
                                {bd ? <span style={{ color: 'var(--warn, #f59e0b)' }}>+{humanGap(bd)} later</span> : '—'}
                              </td>
                              <td>
                                {isEff ? <Badge label="in effect" tone="green" dot />
                                  : ignored ? <span className="dim" style={{ fontSize: 11 }}
                                      title="Carries no information, so the send gate skips it entirely — it can never override a known state.">
                                      no information
                                    </span>
                                  : <span className="dim" style={{ fontSize: 11 }}>superseded</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                  </>
                );
              })()}
        </Panel>

        {canConsent && (
          <Panel title="Record consent" pad>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="ff"><div className="kv-k">Channel</div>
                <select className="f-inp" style={{ width: 130 }} value={cf.channel} onChange={(e) => setCf({ ...cf, channel: e.target.value })} disabled={saving}>{CHANNELS.map((x) => <option key={x} value={x}>{x}</option>)}</select>
              </div>
              <div className="ff"><div className="kv-k">Purpose</div>
                <select className="f-inp" style={{ width: 140 }} value={cf.purpose} onChange={(e) => setCf({ ...cf, purpose: e.target.value })} disabled={saving}>{PURPOSES.map((x) => <option key={x} value={x}>{x}</option>)}</select>
              </div>
              <div className="ff"><div className="kv-k">State</div>
                <select className="f-inp" style={{ width: 130 }} value={cf.state} onChange={(e) => setCf({ ...cf, state: e.target.value })} disabled={saving}>{STATES.map((x) => <option key={x} value={x}>{x}</option>)}</select>
              </div>
              <div className="ff" style={{ flex: 1, minWidth: 140 }}><div className="kv-k">Source</div>
                <input className="f-inp" value={cf.source} onChange={(e) => setCf({ ...cf, source: e.target.value })} placeholder="manual / import" disabled={saving} />
              </div>
              <Btn kind="primary" onClick={addConsent} disabled={saving}><Plus size={14} /> {saving ? 'Saving…' : 'Add'}</Btn>
            </div>
            <div className="tw-note" style={{ marginBottom: 0, marginTop: 10 }}>The consent ledger is append-only — each record is a new immutable row; the latest one per channel×purpose wins.</div>
          </Panel>
        )}

        {canConsent && (
          <Panel title="Opt out everywhere" pad>
            <div className="tw-note" style={{ marginTop: 0 }}>
              Withdraws marketing consent on email, SMS, and WhatsApp in one action — the Meta
              &quot;on-or-off-WhatsApp&quot; account-level withdrawal. RCS follows the SMS
              opt-out automatically. Use when a customer&apos;s request covers every channel,
              not just the one they wrote in on.
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
              <Btn onClick={optOutEverywhere} disabled={optingOut}><LogOut size={14} /> {optingOut ? 'Working…' : 'Opt out everywhere'}</Btn>
              {optOutResult && optOutResult.length > 0 && (
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {optOutResult.map((r) => (
                    <Badge key={r.channel} label={`${r.channel}: ${r.ok ? 'opted out' : 'failed'}`} tone={r.ok ? 'green' : 'red'} />
                  ))}
                </span>
              )}
            </div>
          </Panel>
        )}

        <Panel title="Recent events" count={detail.events?.length || 0}>
          {detailLoading ? <div style={{ padding: 18, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            : detailError
            ? (
              <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--red, #DE2A2A)', fontSize: 12.5 }}>Could not load events.</span>
                <Btn onClick={() => loadDetail(p.id)}><RefreshCw size={14} /> Retry</Btn>
              </div>
            )
            : (!detail.events || detail.events.length === 0)
            ? <div style={{ padding: 16, color: 'var(--text-4)', fontSize: 12.5 }}>No events.</div>
            : (
              <div className="table-scroll">
              <table className="dt">
                <thead><tr><th>Event</th><th>When</th><th>Source</th></tr></thead>
                <tbody>
                  {detail.events.map((ev) => (
                    <tr key={ev.id}>
                      <td><Badge label={ev.name} tone="gray" /></td>
                      <td className="mono dim">{fmtDateTime(ev.occurred_at)}</td>
                      <td className="dim">{ev.source || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
        </Panel>
      </div>
    );
  }

  return (
    <div className="pg">
      <PageHead title="Contacts" sub="The unified profile substrate — identities, identifiers, consent, events."
        actions={<Btn onClick={load}><RefreshCw size={14} /> Refresh</Btn>} />
      {/* Tiles arrive on their own request (~1s over 155k profiles) and never block the
          table. Rendered as skeletons meanwhile rather than hidden, so the header does not
          jump once they land. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <Tile label="Contacts" value={counts?.total}
          sub={counts ? `${Number(counts.contactable).toLocaleString('en-IN')} reachable · ${Number(counts.anonymous).toLocaleString('en-IN')} anonymous` : 'loading…'} />
        <Tile label="Email" value={counts?.email_opted_in} tone="#a78bfa"
          sub={counts ? `opted in · ${Number(counts.email_on_file).toLocaleString('en-IN')} on file` : null} />
        <Tile label="WhatsApp" value={counts?.whatsapp_opted_in} tone="#25D366"
          // The gap is named, not buried: 16,324 profiles hold a WhatsApp marketing opt-in
          // with no phone number, so "opted in" alone overstates reachable audience by ~18%.
          sub={counts
            ? (counts.whatsapp_optin_unreachable
              ? `opted in · ${Number(counts.whatsapp_optin_unreachable).toLocaleString('en-IN')} more opted in with no number`
              : `opted in · ${Number(counts.phone_on_file).toLocaleString('en-IN')} on file`)
            : null}
          warn={!!counts?.whatsapp_optin_unreachable} />
        <Tile label="SMS" value={counts?.sms_opted_in} tone="#7c9bff"
          sub={counts ? `opted in · ${Number(counts.phone_on_file).toLocaleString('en-IN')} numbers on file` : null} />
        <Tile label="Opted out" value={counts?.opted_out_any} tone="#f87171"
          sub="on at least one channel" />
      </div>

      <Panel title="Contacts" count={rows.length}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
          padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
          <input className="f-inp" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email or phone…"
            style={{ flex: '1 1 240px', minWidth: 200, maxWidth: 360 }} />
          <Btn kind={includeAnon ? 'primary' : 'ghost'} onClick={() => setIncludeAnon((v) => !v)}
            title={includeAnon
              ? 'Currently showing anonymous browser sessions — profiles with no email and no phone'
              : 'Anonymous browser sessions (no email, no phone) are hidden'}>
            {includeAnon ? 'Showing anonymous' : 'Anonymous hidden'}
          </Btn>
          {/* The count arrives after the table paints — see the separate counts effect. */}
          {counts?.anonymous != null && !includeAnon && (
            <span className="dim" style={{ fontSize: 12 }}>
              {Number(counts.anonymous).toLocaleString('en-IN')} anonymous of{' '}
              {Number(counts.total).toLocaleString('en-IN')} hidden
            </span>
          )}
          <span className="dim" style={{ fontSize: 12, marginLeft: 'auto' }}>
            newest {rows.length}
          </span>
        </div>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : rows.length === 0
            ? <EmptyState icon="inbox"
                title={debouncedQ ? 'No contacts match' : 'No contacts yet'}
                hint={debouncedQ
                  ? 'Search covers name, email and phone. Anonymous sessions are excluded unless you show them.'
                  : 'Profiles arrive via ingestion (Shopify / internal events). Once seeded they appear here.'} />
            : (
              <div className="table-scroll">
              <table className="dt">
                <thead><tr>
                  <th>Name</th><th>Email</th><th>Phone</th><th>Channels</th>
                  <th className="num">Orders</th><th className="num">Lifetime ₹</th><th>Added</th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const a = r.attributes || {};
                    const initials = String(r.display_name || '')
                      .split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
                    return (
                      <tr key={r.id} className="row-click" onClick={() => open(r)}>
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              fontFamily: 'var(--font-disp)', fontSize: 11, fontWeight: 600,
                              color: 'var(--t2)', background: 'rgba(255,255,255,.06)' }}>
                              {initials || '—'}
                            </span>
                            <span style={{ fontWeight: 600, color: 'var(--t1)' }}>
                              {r.display_name
                                || <span className="dim" style={{ fontWeight: 400 }}>
                                     {(r.email || r.phone) ? '— unnamed —' : '— anonymous session —'}
                                   </span>}
                            </span>
                          </span>
                        </td>
                        <td className="mono dim" style={{ fontSize: 11.5 }}>{r.email || '—'}</td>
                        <td className="mono dim" style={{ fontSize: 11.5 }}>{r.phone || '—'}</td>
                        <td><ChannelStrip consent={r.consent} hasEmail={!!r.email} hasPhone={!!r.phone} /></td>
                        <td className="num mono dim">{a.lifetime_orders ?? '—'}</td>
                        <td className="num mono">{a.lifetime_value != null ? Number(a.lifetime_value).toLocaleString('en-IN') : <span className="dim">—</span>}</td>
                        <td className="mono dim">{fmtDateTime(r.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
      </Panel>
    </div>
  );
}
