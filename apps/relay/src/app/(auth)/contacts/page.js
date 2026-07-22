'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, Mail, Plus, RefreshCw, LogOut } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDate } from '@/components/format.js';

const CHANNELS = ['email', 'sms', 'whatsapp'];
const PURPOSES = ['marketing', 'transactional', 'utility'];
const STATES = ['opted_in', 'opted_out', 'unknown'];
const STATE_TONE = { opted_in: 'green', opted_out: 'red', unknown: 'gray' };

function fmtDateTime(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 16);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
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

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await garageFetch('getProfiles', { limit: 200 }, session);
      setRows(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load contacts', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

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
              <div><div className="kv-k">Created</div><div className="kv-v mono">{fmtDate(p.created_at)}</div></div>
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
      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : rows.length === 0
          ? <Panel><EmptyState icon="inbox" title="No contacts yet" hint="Profiles arrive via ingestion (Shopify / internal events). Once seeded they appear here." /></Panel>
          : (
            <Panel title="Contacts" count={rows.length}>
              <table className="dt">
                <thead><tr><th>Name</th><th>City</th><th>Locale</th><th className="num">Orders</th><th className="num">Lifetime ₹</th><th>Added</th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const a = r.attributes || {};
                    return (
                      <tr key={r.id} className="row-click" onClick={() => open(r)}>
                        <td><Mail size={13} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--text-4)' }} />{r.display_name || <span className="dim">— unnamed —</span>}</td>
                        <td className="dim">{r.city || '—'}</td>
                        <td className="dim">{r.locale || '—'}</td>
                        <td className="num mono dim">{a.lifetime_orders ?? '—'}</td>
                        <td className="num mono dim">{a.lifetime_value != null ? Number(a.lifetime_value).toLocaleString('en-IN') : '—'}</td>
                        <td className="mono dim">{fmtDate(r.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          )}
    </div>
  );
}
