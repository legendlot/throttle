'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../lib/ignitionopsFetch.js';

export default function BListPage() {
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const canManage = !!perms?.ignition_manage;

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    ignitionopsGet('getInfluencers', { tab: 'b_list', limit: 200 }, session)
      .then(r => setRows(r.influencers || []))
      .finally(() => setLoading(false));
  }, [session]);

  async function moveToMaster(r) {
    if (busy) return;
    const name = r.channel_name || r.person_name || r.influencer_code;
    if (!window.confirm(`Move ${r.influencer_code} (${name}) to the master list?`)) return;
    setBusy(r.id);
    try {
      await ignitionopsPost('updateInfluencer', { influencer_id: r.id, list_status: 'master' }, session);
      setRows(rs => rs.filter(x => x.id !== r.id));
      toast(`${r.influencer_code} moved to master`, 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(null); }
  }

  return (
    <div style={{ fontFamily: 'var(--font-ui)', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ animation: 'igUp 500ms cubic-bezier(.22,1,.36,1) both' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', color: 'var(--text-4)', textTransform: 'uppercase' }}>
          Lists · parked, not yet a fit
        </div>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6, color: 'var(--text-1)' }}>
          B-List{!loading && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--text-4)', marginLeft: 10 }}>{rows.length}</span>}
        </h1>
      </header>

      {loading ? <Spinner /> : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', overflowX: 'auto', animation: 'igUp 500ms 80ms cubic-bezier(.22,1,.36,1) both' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead><tr style={{ textAlign: 'left' }}>
              <th style={th}>Code</th><th style={th}>Channel</th><th style={th}>Type</th>
              <th style={{ ...th, textAlign: 'right' }}>Reach</th><th style={th}>Comments</th>
              {canManage && <th style={th}></th>}
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={canManage ? 6 : 5} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>B-List is empty.</td></tr>}
              {rows.map((r, i) => (
                <tr key={r.id} className="ig-row" onClick={() => router.push(`/influencers/detail/?id=${r.id}`)}
                  style={{ cursor: 'pointer', borderTop: '1px solid var(--border)', animation: `igSlide 380ms ${120 + Math.min(i, 12) * 40}ms both` }}>
                  <td style={td}><span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-hi)', fontWeight: 600, fontSize: 13 }}>{r.influencer_code}</span></td>
                  <td style={{ ...td, fontWeight: 600, color: 'var(--text-1)' }}>{r.channel_name || r.person_name || '—'}</td>
                  <td style={td}>
                    {r.influencer_type
                      ? <span style={{ fontSize: 12, fontWeight: 600, padding: '3px 9px', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text-2)' }}>{r.influencer_type}</span>
                      : '—'}
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 13, textAlign: 'right' }}>{r.reach != null && r.reach !== '' ? Number(r.reach).toLocaleString('en-IN') : '—'}</td>
                  <td style={{ ...td, color: 'var(--text-2)' }}>{r.rating_notes || '—'}</td>
                  {canManage && (
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                      <button type="button" disabled={busy === r.id}
                        onClick={e => { e.stopPropagation(); moveToMaster(r); }}
                        style={{ fontFamily: 'inherit', fontSize: 12, fontWeight: 700, padding: '7px 12px', borderRadius: 10, border: '1px solid var(--border-3)', background: 'transparent', color: 'var(--text-1)', cursor: busy === r.id ? 'default' : 'pointer', opacity: busy === r.id ? 0.5 : 1 }}>
                        {busy === r.id ? 'Moving…' : 'Move to master ↑'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
const th = { padding: '12px 18px', fontSize: 12, color: 'var(--text-4)', fontWeight: 600 };
const td = { padding: '11px 18px' };
