'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';

export default function BListPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    ignitionopsGet('getInfluencers', { tab: 'b_list', limit: 200 }, session)
      .then(r => setRows(r.influencers || []))
      .finally(() => setLoading(false));
  }, [session]);

  return (
    <div>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          B-List
        </h1>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
          Parked candidates — lower priority, interested but not yet aligned.
        </div>
      </header>

      {loading ? <Spinner /> : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
              <th style={th}>Code</th><th style={th}>Channel</th><th style={th}>Type</th>
              <th style={th}>Reach</th><th style={th}>Comments</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>B-List is empty.</td></tr>}
              {rows.map(r => (
                <tr key={r.id} onClick={() => router.push(`/influencers/detail/?id=${r.id}`)}
                  style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
                  <td style={td}><span style={{ color: '#FF6B00', fontWeight: 600 }}>{r.influencer_code}</span></td>
                  <td style={td}>{r.channel_name || r.person_name || '—'}</td>
                  <td style={td}>{r.influencer_type || '—'}</td>
                  <td style={td}>{r.reach?.toLocaleString() || '—'}</td>
                  <td style={td}>{r.rating_notes || '—'}</td>
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
