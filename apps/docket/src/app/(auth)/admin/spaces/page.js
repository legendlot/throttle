'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Lock, Hash, KeyRound } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';
import { fmtDate } from '../../../../lib/format.js';
import { Button, EmptyState } from '../../../../components/ui/index.js';
import { AdminHead } from '../../../../components/AdminParts.js';

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

  if (perms && !perms.docket_admin) return <div className="adm"><EmptyState icon={Lock} title="Admins only" body="Requires docket_admin." /></div>;

  return (
    <div className="adm wide">
      <AdminHead title="Spaces"
        lede={<>Every space in Docket (metadata only — task contents stay private to members). Use <strong>Recover</strong> to break-glass into an orphaned private space; the action is logged.</>} />
      <section className="adm-card">
        <div className="adm-card-h"><span>All spaces <span className="adm-count">{spaces.length || ''}</span></span></div>
        {loading ? <div className="adm-card-b"><Spinner /></div> : (
          <div className="dtable-wrap">
            <table className="dtable">
              <thead><tr><th>Space</th><th>Visibility</th><th className="dt-owner">Owner</th><th className="num">Members</th><th className="dt-created">Created</th><th aria-label="Actions"></th></tr></thead>
              <tbody>
                {spaces.map(s => (
                  <tr key={s.id} className={s.archived_at ? 'inactive' : ''}>
                    <td>
                      <span className="dtable-name strong">
                        {s.is_default ? <Hash size={14} className="dt-ic" aria-hidden /> : <Lock size={14} className="dt-ic lock" aria-hidden />}
                        {s.name}{s.archived_at ? ' (archived)' : ''}
                      </span>
                    </td>
                    <td><span className="adm-badge">{s.is_default ? 'Open' : 'Private'}</span></td>
                    <td className="dt-owner">{s.is_default ? '—' : (s.owner_name || '—')}</td>
                    <td className="num">{s.is_default ? '—' : s.member_count}</td>
                    <td className="dt-created mono">{s.created_at ? fmtDate(s.created_at) : '—'}</td>
                    <td className="dt-act">
                      {!s.is_default && (
                        <Button size="sm" variant="ghost" icon={KeyRound} className="adm-recover" loading={busyId === s.id} onClick={() => recover(s)} title="Break-glass: become owner + member">Recover</Button>
                      )}
                    </td>
                  </tr>
                ))}
                {spaces.length === 0 && <tr><td colSpan={6} className="dtable-none">No spaces.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
