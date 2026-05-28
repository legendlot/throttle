'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, Chip } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';

const TABS = [
  { id: 'all', label: 'All', value: '' },
  { id: 'unused', label: 'Unused', value: 'false' },
  { id: 'used', label: 'Used', value: 'true' },
];

export default function DiscountCodesPage() {
  const { session } = useAuth();
  const [tab, setTab] = useState('all');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    const params = { limit: 200 };
    const v = TABS.find(t => t.id === tab)?.value;
    if (v) params.utilized = v;
    ignitionopsGet('getDiscountCodes', params, session)
      .then(r => setRows(r.codes || []))
      .finally(() => setLoading(false));
  }, [tab, session]);

  return (
    <div>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Discount Codes
        </h1>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
          Pre-minted code pool. Bulk-generate UI lands in Phase B.
        </div>
      </header>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {TABS.map(t => <Chip key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</Chip>)}
      </div>

      {loading ? <Spinner /> : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
              <th style={th}>Code</th><th style={th}>Pool</th><th style={th}>Used</th>
              <th style={th}>Order</th><th style={th}>Value</th>
              <th style={th}>Used at</th><th style={th}>Engagement</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No codes.</td></tr>}
              {rows.map(c => (
                <tr key={c.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{c.code}</td>
                  <td style={td}>{c.pool_label || '—'}</td>
                  <td style={td}>
                    {c.utilized
                      ? <span style={{ color: 'var(--state-success-fg)' }}>YES</span>
                      : <span style={{ color: 'var(--text-3)' }}>—</span>}
                  </td>
                  <td style={td}>{c.order_name || '—'}</td>
                  <td style={td}>{c.order_value != null ? `₹${Number(c.order_value).toLocaleString()}` : '—'}</td>
                  <td style={td}>{c.used_at ? new Date(c.used_at).toLocaleDateString() : '—'}</td>
                  <td style={td}>{c.engagement_id ? '✓' : '—'}</td>
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
