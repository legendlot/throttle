'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';

export default function CampaignsPage() {
  const { session } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    ignitionopsGet('getCampaigns', {}, session)
      .then(r => setRows(r.campaigns || []))
      .finally(() => setLoading(false));
  }, [session]);

  return (
    <div>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Campaigns
        </h1>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
          Multi-video deal groupings. Phase B will add full create/edit UI.
        </div>
      </header>

      {loading ? <Spinner /> : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
              <th style={th}>Campaign #</th><th style={th}>Influencer</th><th style={th}>Videos</th>
              <th style={th}>Agreed total</th><th style={th}>Status</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No campaigns yet.</td></tr>}
              {rows.map(c => (
                <tr key={c.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}><span style={{ color: '#FF6B00', fontWeight: 600 }}>{c.campaign_no}</span></td>
                  <td style={td}>{c.influencer?.channel_name || c.influencer?.influencer_code || '—'}</td>
                  <td style={td}>{c.video_count}</td>
                  <td style={td}>{c.agreed_total != null ? `₹${Number(c.agreed_total).toLocaleString()}` : '—'}</td>
                  <td style={td}>{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
const th = { padding: '10px 12px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const td = { padding: '10px 12px' };
