'use client';
import { useEffect, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { EmptyState } from '@throttle/ui';

const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const phdr  = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const th    = { textAlign: 'left', padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const td    = { padding: '8px 10px', fontSize: 13, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };

export default function JobWorkPage() {
  const { session, perms, userId } = useAuth();
  const allowed = hasPermission(perms, 'direct_issuance_request') || hasPermission(perms, 'users_manage');

  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  // Keyed on userId, NEVER session — onAuthStateChange re-fires on tab switch and a real token
  // refresh lands ~hourly.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await workerFetch('getJobworkBalance', {}, session);
        if (!alive) return;
        if (!r?.ok) setError(r?.error || 'Failed to load');
        else setRows(Array.isArray(r.data) ? r.data : []);
      } catch (e) {
        if (alive) setError(e.message || 'Failed to load');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [userId]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!allowed) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState title="Access denied" subtitle="You need direct_issuance_request permission." />
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={panel}>
        <div style={phdr}><span>Job Work — at the vendor</span></div>
        <div style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 12, lineHeight: 1.6 }}>
            Sent minus returned minus damaged, since the cutover. While a challan is open this is
            material still <strong>at the vendor</strong>; once it is closed the same number is
            <strong> paint loss</strong>.
            {/* Without this line the first reader concludes the painters are empty. They are not. */}
            <br />
            <span style={{ color: '#f2cd1a' }}>
              Excludes anything sent before 1 Sep 2026 — that material was never tracked going out,
              so an empty table does <strong>not</strong> mean nothing is out at a painter.
            </span>
          </div>

          {loading && <div style={{ fontSize: 13, color: 'var(--t3)' }}>Loading…</div>}
          {!loading && error && <div style={{ fontSize: 13, color: '#ff7070' }}>{error}</div>}

          {!loading && !error && (
            /* Wide tables scroll inside their own container — the page body must never scroll sideways. */
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 720 }}>
                <thead>
                  <tr>
                    <th style={th}>Vendor</th>
                    <th style={th}>Unpainted</th>
                    <th style={th}>Painted</th>
                    <th style={{ ...th, textAlign: 'right' }}>Sent</th>
                    <th style={{ ...th, textAlign: 'right' }}>Returned</th>
                    <th style={{ ...th, textAlign: 'right' }}>Damaged</th>
                    <th style={{ ...th, textAlign: 'right' }}>Remainder</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={7} style={{ ...td, color: 'var(--t3)', whiteSpace: 'normal' }}>
                      Nothing out on a job-work challan yet.
                    </td></tr>
                  )}
                  {rows.map((r, i) => {
                    const rem = Number(r.remainder);
                    return (
                      <tr key={i}>
                        <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11 }}>{r.vendor_code || '—'}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11 }}>{r.unpainted_part_code}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11 }}>{r.painted_part_code}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{Number(r.sent)}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{Number(r.returned)}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{Number(r.damaged)}</td>
                        {/* Negative is a REAL signal — more came back than went out — not a bug to clamp. */}
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700,
                                     color: rem < 0 ? '#ff7070' : 'var(--t1)' }}>{rem}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
