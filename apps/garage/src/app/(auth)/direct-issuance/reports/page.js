'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, EmptyState, useToast } from '@throttle/ui';
import { purposeLabel, fmtTs } from '../page';

const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const phdr  = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const pbody = { padding: '12px 14px' };
const th    = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td    = { padding: '8px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, verticalAlign: 'top' };
const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 11px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.05em', textTransform: 'uppercase' };
const tile  = { flex: '1 1 130px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: '12px 14px' };

function fmtISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function downloadCsv(filename, rows, cols) {
  if (!rows || !rows.length) return false;
  const lines = [cols.map(c => c.label).join(',')];
  for (const r of rows) lines.push(cols.map(c => JSON.stringify(r[c.key] ?? '')).join(','));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  return true;
}

// Lightweight horizontal bar list (no chart dependency in Garage)
function BarList({ title, rows, labelKey, fmtLabel }) {
  const max = Math.max(1, ...rows.map(r => r.count));
  return (
    <div style={panel}>
      <div style={phdr}>{title}</div>
      <div style={pbody}>
        {rows.length === 0 ? <span style={{ color: 'var(--t3)', fontSize: 12 }}>No data.</span> : rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ width: 150, fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fmtLabel ? fmtLabel(r[labelKey]) : r[labelKey]}
            </span>
            <div style={{ flex: 1, background: 'var(--surface2)', borderRadius: 2, height: 16, position: 'relative' }}>
              <div style={{ width: `${(r.count / max) * 100}%`, background: '#f2cd1a', height: '100%', borderRadius: 2 }} />
            </div>
            <span style={{ width: 36, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--t1)' }}>{r.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DirectIssuanceReportsPage() {
  const router = useRouter();
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const allowed = hasPermission(perms, 'direct_issuance_request') || hasPermission(perms, 'direct_issuance_approve') || hasPermission(perms, 'users_manage');

  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 5); d.setDate(1); return fmtISO(d); });
  const [to, setTo]     = useState(fmtISO(today));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!session || !allowed) return;
    setLoading(true);
    try {
      const body = {};
      if (from) body.from = from;
      if (to)   body.to = to;
      const r = await workerFetch('getDirectIssuanceReports', { data: body }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); setData(null); return; }
      setData(r.data);
    } catch (e) { toast(e.message || 'Failed', 'error'); setData(null); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [session, from, to]);

  if (!allowed) {
    return <div style={{ padding: 16 }}><EmptyState title="Access denied" subtitle="You need direct_issuance_request permission." /></div>;
  }

  const t = data?.totals || {};
  const aging = data?.aging || [];

  return (
    <div style={{ padding: 16 }}>
      <div style={panel}>
        <div style={phdr}>
          <span>Direct Issuance · Reports & Aging</span>
          <button onClick={() => router.push('/direct-issuance')} style={btnS}>← List</button>
        </div>
        <div style={{ ...pbody, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--t3)' }}>Period (issued)</span>
          <input type="date" style={input} value={from} onChange={e => setFrom(e.target.value)} />
          <span style={{ color: 'var(--t3)' }}>→</span>
          <input type="date" style={input} value={to} onChange={e => setTo(e.target.value)} />
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : !data ? (
        <EmptyState title="No data" subtitle="No direct issuances found." />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            <div style={tile}><div style={{ fontSize: 24, fontWeight: 800, color: 'var(--t1)', fontFamily: 'var(--mono)' }}>{t.total}</div><div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--t3)' }}>Total (all time)</div></div>
            <div style={tile}><div style={{ fontSize: 24, fontWeight: 800, color: '#7b93ff', fontFamily: 'var(--mono)' }}>{t.issued_out}</div><div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--t3)' }}>Still out (issued)</div></div>
            <div style={tile}><div style={{ fontSize: 24, fontWeight: 800, color: t.overdue ? '#ff7070' : '#4ade80', fontFamily: 'var(--mono)' }}>{t.overdue}</div><div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--t3)' }}>Overdue return</div></div>
          </div>

          {/* Aging dashboard */}
          <div style={panel}>
            <div style={phdr}>
              <span>⏰ Aging — overdue returns ({aging.length})</span>
              {aging.length > 0 && (
                <button style={btnS} onClick={() => downloadCsv(`di-aging-${fmtISO(today)}.csv`, aging,
                  [{ key: 'issue_no', label: 'DI No' }, { key: 'purpose', label: 'Purpose' }, { key: 'destination', label: 'Destination' }, { key: 'requester_name', label: 'Requester' }, { key: 'issued_at', label: 'Issued At' }, { key: 'expected_return_at', label: 'Expected Return' }, { key: 'days_overdue', label: 'Days Overdue' }])}>CSV</button>
              )}
            </div>
            <div style={{ ...pbody, padding: 0, overflowX: 'auto' }}>
              {aging.length === 0 ? (
                <div style={{ padding: 16, color: '#4ade80', fontSize: 12 }}>✓ Nothing overdue — all issued units are within their expected return window.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={th}>DI No</th><th style={th}>Purpose</th><th style={th}>Destination</th>
                    <th style={th}>Requester</th><th style={th}>Issued</th><th style={th}>Due</th><th style={th}>Overdue</th>
                  </tr></thead>
                  <tbody>
                    {aging.map(a => (
                      <tr key={a.id}>
                        <td style={{ ...td, fontFamily: 'var(--mono)', color: '#f2cd1a' }}>{a.issue_no}</td>
                        <td style={td}>{purposeLabel(a.purpose)}</td>
                        <td style={td}>{a.destination || '—'}</td>
                        <td style={td}>{a.requester_name || '—'}</td>
                        <td style={{ ...td, fontSize: 11, color: 'var(--t3)' }}>{fmtTs(a.issued_at)}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11 }}>{a.expected_return_at}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', fontWeight: 700, color: '#ff7070' }}>{a.days_overdue}d</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
            <BarList title="By purpose (in period)" rows={data.byPurpose} labelKey="purpose" fmtLabel={purposeLabel} />
            <BarList title="Issued per month" rows={data.byMonth} labelKey="month" />
            <BarList title="Still out — by purpose" rows={data.stillOutByPurpose} labelKey="purpose" fmtLabel={purposeLabel} />
            <BarList title="Top destinations (in period)" rows={data.topDestinations} labelKey="destination" />
          </div>
        </>
      )}
    </div>
  );
}
