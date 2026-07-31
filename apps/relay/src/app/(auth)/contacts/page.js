'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, Plus, RefreshCw, LogOut, Mail, MessageCircle, MessageSquare } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateTime } from '@/components/format.js';

const CHANNELS = ['email', 'sms', 'whatsapp'];
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
];
const CONSENT_COLOR = {
  opted_in: { fg: '#34d399', bg: 'rgba(52,211,153,.13)', bd: 'rgba(52,211,153,.34)' },
  opted_out: { fg: '#f87171', bg: 'rgba(248,113,113,.13)', bd: 'rgba(248,113,113,.34)' },
  unknown: { fg: '#f59e0b', bg: 'rgba(245,158,11,.12)', bd: 'rgba(245,158,11,.30)' },
  none: { fg: '#6b7178', bg: 'rgba(255,255,255,.03)', bd: 'rgba(255,255,255,.08)' },
};

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
        // WhatsApp and SMS both ride the phone number; email rides the email address.
        const reachable = key === 'email' ? hasEmail : hasPhone;
        const state = consent?.[key];
        const tone = !reachable ? 'none' : (state === 'opted_in' ? 'opted_in'
          : state === 'opted_out' ? 'opted_out' : 'unknown');
        const c = CONSENT_COLOR[tone];
        const why = !reachable ? `${label}: no address on file`
          : state === 'opted_in' ? `${label}: opted in to marketing`
          : state === 'opted_out' ? `${label}: opted OUT of marketing`
          : `${label}: reachable, no marketing consent recorded`;
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

  const loadDetail = useCallback(async (id) => {
    setDetailLoading(true);
    setDetailError(false);
    try {
      const d = await garageFetch('getProfile', { id }, session);
      setDetail(d || null);
    } catch (e) { setDetailError(true); showToast(e.message || 'Failed to load contact', 'error'); }
    finally { setDetailLoading(false); }
  }, [session, showToast]);

  function open(r) {
    setDetail({ profile: r, identifiers: [], consent: [], events: [] });
    setDetailError(false);
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
      `Opt out ${name} from marketing on every channel (email, SMS, WhatsApp)?\n\n`
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
              )}
          </Panel>
        </div>

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
              : (
                <table className="dt">
                  <thead><tr><th>Channel</th><th>Purpose</th><th>State</th><th>Source</th><th>Captured</th></tr></thead>
                  <tbody>
                    {detail.consent.map((c) => (
                      <tr key={c.id}>
                        <td>{c.channel}</td>
                        <td className="dim">{c.purpose}</td>
                        <td><Badge label={c.state} tone={STATE_TONE[c.state] || 'gray'} /></td>
                        <td className="dim">{c.source || '—'}</td>
                        <td className="mono dim">{fmtDateTime(c.captured_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
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
              &quot;on-or-off-WhatsApp&quot; account-level withdrawal. Use when a customer&apos;s
              request covers every channel, not just the one they wrote in on.
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
            )}
      </Panel>
    </div>
  );
}
