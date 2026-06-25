'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { PageHead, Panel, Badge } from '@/components/ui.js';

const CHANNELS = ['email', 'sms', 'whatsapp'];
const STATUS_TONE = { active: 'green', pending: 'yellow', draft: 'gray', disabled: 'red' };

export default function ConnectorsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

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
