'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { PageHead, Panel, Badge, Btn } from '@/components/ui.js';

const CHANNELS = ['email', 'sms', 'whatsapp'];
const STATUS_TONE = { active: 'green', pending: 'yellow', draft: 'gray', disabled: 'red' };

export default function ConnectorsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [shopBusy, setShopBusy] = useState(false);
  const [shopResult, setShopResult] = useState(null);
  const [whBusy, setWhBusy] = useState(false);
  const [whResult, setWhResult] = useState(null);

  async function shopifyBackfill(mode) {
    if (mode === 'full' && !window.confirm('Import ALL Shopify customers into Relay?\n\nProfiles + consent only — no emails are sent (Test Mode is the separate lock). Runs in the background.')) return;
    setShopBusy(true); setShopResult(null);
    try {
      const r = await workerFetch('shopifyBackfill', { mode }, session);
      const d = r?.data || {};
      if (mode === 'full') { showToast('Full Shopify sync started — running in background', 'success'); setShopResult({ full: true }); }
      else { showToast(`Sample imported: ${d.profiles} profiles, ${d.consent} consent rows`, 'success'); setShopResult(d); }
    } catch (e) { showToast(e.message || 'Shopify sync failed', 'error'); setShopResult({ error: e.message }); }
    finally { setShopBusy(false); }
  }

  // Live-sync webhook management (M4) — idempotent register + read-back of subscriptions.
  async function shopifyWebhooks(action) {
    setWhBusy(true); setWhResult(null);
    try {
      const r = await workerFetch(action, {}, session);
      const d = r?.data;
      setWhResult(d);
      if (action === 'shopifyRegisterWebhooks') {
        const c = d?.created?.length || 0, s = d?.skipped?.length || 0, e = d?.errors?.length || 0;
        showToast(`Webhooks: ${c} created, ${s} already present${e ? `, ${e} errors` : ''}`, e ? 'error' : 'success');
      }
    } catch (e) { showToast(e.message || 'Webhook action failed', 'error'); setWhResult({ error: e.message }); }
    finally { setWhBusy(false); }
  }

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await garageFetch('getSenderIdentities', {}, session);
      setRows(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  if (perms && !perms.connector_channel_manage) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Channel-manage permission required.</div>;

  const byChannel = CHANNELS.map((ch) => ({
    channel: ch,
    senders: rows.filter((r) => r.channel === ch),
  }));

  return (
    <div className="pg">
      <PageHead title="Connectors" sub="Provider wiring per channel. Read-only overview of configured senders." />
      <div className="info-bar">
        Resend API key + DNS records are configured in M5. This view summarises the sender identities already on file.
      </div>

      {perms?.relay_super_admin && (
        <Panel title="Shopify — customer data sync">
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 12 }}>
              Imports Shopify customers → profiles + identifiers + consent + attributes (idempotent).
              <strong> No emails are sent</strong> — the Test Mode lock is separate. Start with a sample to eyeball the mapping, then run the full sync.
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Btn onClick={() => shopifyBackfill('sample')} disabled={shopBusy}>Dry-run: import 5</Btn>
              <Btn kind="primary" onClick={() => shopifyBackfill('full')} disabled={shopBusy}>Full sync — all customers</Btn>
            </div>
            {shopBusy && <div style={{ marginTop: 10, color: 'var(--text-3)', fontSize: 13 }}><Spinner /> working…</div>}
            {shopResult && !shopResult.full && !shopResult.error && (
              <div style={{ marginTop: 10, fontSize: 13 }}>
                Sample: fetched {shopResult.fetched}, {shopResult.profiles} profiles, {shopResult.consent} consent rows{shopResult.skipped ? `, ${shopResult.skipped} skipped (no email/phone)` : ''}.
              </div>
            )}
            {shopResult?.full && <div style={{ marginTop: 10, fontSize: 13 }}>Full sync running in the background — refresh contacts in a few minutes.</div>}
            {shopResult?.error && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--signal-red, #DE2A2A)' }}>Error: {shopResult.error}</div>}

            <div style={{ borderTop: '1px solid var(--border, #333)', margin: '18px 0 14px' }} />
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Live sync — webhooks</div>
            <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 12 }}>
              Registers Shopify webhooks (customers · orders · checkouts) so the substrate stays current and the
              abandoned-cart journey gets its <span className="mono">checkout_started</span> trigger. Idempotent — re-run anytime.
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Btn kind="primary" onClick={() => shopifyWebhooks('shopifyRegisterWebhooks')} disabled={whBusy}>Register webhooks</Btn>
              <Btn onClick={() => shopifyWebhooks('shopifyListWebhooks')} disabled={whBusy}>Check registered</Btn>
            </div>
            {whBusy && <div style={{ marginTop: 10, color: 'var(--text-3)', fontSize: 13 }}><Spinner /> working…</div>}
            {whResult?.error && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--signal-red, #DE2A2A)' }}>Error: {whResult.error}</div>}
            {whResult && !whResult.error && (
              <pre style={{ marginTop: 10, fontSize: 12, background: 'var(--surface-2, #1c1c1c)', padding: 12, borderRadius: 8, overflowX: 'auto' }}>
{JSON.stringify(whResult, null, 2)}</pre>
            )}
          </div>
        </Panel>
      )}
      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : byChannel.map(({ channel, senders }) => (
          <Panel key={channel} title={channel} count={senders.length}>
            {senders.length === 0
              ? <div style={{ padding: 18, color: 'var(--text-3)' }}>No {channel} sender configured yet.</div>
              : (
                <table className="dt">
                  <thead><tr><th>Address</th><th>Provider</th><th>Status</th></tr></thead>
                  <tbody>
                    {senders.map((r) => (
                      <tr key={r.id}>
                        <td className="mono">{r.address}</td>
                        <td className="dim">{r.provider || '—'}</td>
                        <td><Badge label={r.status} tone={STATUS_TONE[r.status] || 'gray'} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </Panel>
        ))}
    </div>
  );
}
