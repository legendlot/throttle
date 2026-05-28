'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import StageBadge from '../../../components/StageBadge.js';

export default function UgcPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    ignitionopsGet('getEngagements', { type: 'ugc', limit: 200 }, session)
      .then(r => setRows(r.engagements || []))
      .finally(() => setLoading(false));
  }, [session]);

  return (
    <div>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          UGC Pipeline
        </h1>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
          Commission-based UGC engagements with ad-spend + ROAS tracking.
        </div>
      </header>

      {loading ? <Spinner /> : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
              <th style={th}>Engagement #</th><th style={th}>Influencer</th><th style={th}>Stage</th>
              <th style={th}>Product</th><th style={th}>Ad spend</th>
              <th style={th}>Commission</th><th style={th}>ROAS</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No UGC engagements.</td></tr>}
              {rows.map(r => (
                <tr key={r.id} onClick={() => router.push(`/engagements/detail/?id=${r.id}`)}
                  style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
                  <td style={td}><span style={{ color: '#FF6B00', fontWeight: 600 }}>{r.engagement_no}</span></td>
                  <td style={td}>{r.influencer?.channel_name || r.influencer?.influencer_code || '—'}</td>
                  <td style={td}><StageBadge stage={r.stage} /></td>
                  <td style={td}>{r.product_variant || r.product_code || '—'}</td>
                  <td style={td}>₹{Number(r.ad_spend || 0).toLocaleString()}</td>
                  <td style={td}>₹{Number(r.commission_amount || 0).toLocaleString()}</td>
                  <td style={td}>{r.actual_roas != null ? Number(r.actual_roas).toFixed(2) : '—'}</td>
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
