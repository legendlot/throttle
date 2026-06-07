'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Lock, Hash, KeyRound } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';
import { fmtDate } from '../../../../lib/format.js';
import { AdminTabs } from '../../../../components/AdminTabs.js';

/**
 * Admin-only space registry + break-glass recovery (RULE-DOCKET-003).
 * Metadata only — never task contents. "Recover" makes the admin owner+member
 * of an orphaned private space (audited in space_history).
 */
export default function AdminSpacesPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [spaces, setSpaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try { setSpaces(await docketopsGet('getAllSpaces', {}, session)); }
    catch (e) { showToast(e.message || 'Failed to load spaces', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  async function recover(s) {
    if (!window.confirm(`Break-glass recover "${s.name}"?\nYou'll become its owner + member. This is logged in the space's audit trail.`)) return;
    setBusyId(s.id);
    try { await docketopsPost('recoverSpace', { space_id: s.id }, session); showToast('Space recovered', 'success'); router.push('/tasks?space=' + s.id); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusyId(null); }
  }

  if (perms && !perms.docket_admin) return <div style={{ color: 'var(--text-3)' }}>Requires docket_admin.</div>;

  return (
    <div className="screen">
      <AdminTabs />
      <div className="screen-head"><p>Every space in Docket (metadata only — task contents stay private to members). Use <strong>Recover</strong> to break-glass into an orphaned private space; the action is logged.</p></div>
      <div className="panel" style={{ padding: '8px 18px 14px' }}>
        {loading ? <div style={{ padding: 24 }}><Spinner /></div> : (
          <table className="dtable">
            <thead><tr><th>Space</th><th>Visibility</th><th>Owner</th><th className="num">Members</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {spaces.map(s => (
                <tr key={s.id} style={{ opacity: s.archived_at ? 0.5 : 1 }}>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600, color: 'var(--text-1)' }}>
                      {s.is_default ? <Hash size={14} style={{ color: 'var(--text-4)' }} /> : <Lock size={14} style={{ color: 'var(--accent)' }} />}
                      {s.name}{s.archived_at ? ' (archived)' : ''}
                    </span>
                  </td>
                  <td><span className="chip soft">{s.is_default ? 'Open' : 'Private'}</span></td>
                  <td>{s.is_default ? '—' : (s.owner_name || '—')}</td>
                  <td className="num">{s.is_default ? '—' : s.member_count}</td>
                  <td style={{ color: 'var(--text-3)', fontFamily: 'var(--f-mono)', fontSize: 12 }}>{s.created_at ? fmtDate(s.created_at) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {!s.is_default && (
                      <button className="btn btn-ghost" disabled={busyId === s.id} onClick={() => recover(s)} title="Break-glass: become owner + member" style={{ color: 'var(--st-blocked)' }}>
                        <KeyRound size={12} /> Recover
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {spaces.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--text-3)' }}>No spaces.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
