'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Lock, Globe, KeyRound } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';
import { fmtDate } from '../../../../lib/format.js';

/**
 * Admin-only space registry + break-glass recovery (RULE-DOCKET-003).
 * Shows space METADATA only (name/owner/counts) — never task contents. "Recover" makes
 * the admin the owner+member of an orphaned private space (audited in space_history).
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
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={h1}>Spaces</h1>
        <p style={sub}>Every space in Docket (metadata only — task contents stay private to members). Use <strong>Recover</strong> to break-glass into an orphaned private space; the action is logged.</p>
      </div>
      <div style={card}>
        <div style={cardHead}><span>Spaces {spaces.length > 0 && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>({spaces.length})</span>}</span></div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? <div style={{ padding: 24 }}><Spinner /></div> : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Space</th><th style={th}>Type</th><th style={th}>Owner</th>
                <th style={thNum}>Members</th><th style={th}>Created</th><th style={th}></th>
              </tr></thead>
              <tbody>
                {spaces.map(s => (
                  <tr key={s.id} style={{ opacity: s.archived_at ? 0.5 : 1 }}>
                    <td style={{ ...td, fontWeight: 600 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {s.is_default ? <Globe size={13} style={{ color: 'var(--text-3)' }} /> : <Lock size={13} style={{ color: 'var(--docket-accent)' }} />}
                        {s.name}{s.archived_at ? ' (archived)' : ''}
                      </span>
                    </td>
                    <td style={td}>{s.is_default ? 'General (open)' : 'Private'}</td>
                    <td style={td}>{s.is_default ? '—' : (s.owner_name || '—')}</td>
                    <td style={tdNum}>{s.is_default ? '—' : s.member_count}</td>
                    <td style={{ ...td, color: 'var(--text-3)', fontSize: 12 }}>{s.created_at ? fmtDate(s.created_at) : '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      {!s.is_default && (
                        <button className="dk-press" style={recoverBtn} disabled={busyId === s.id} onClick={() => recover(s)} title="Break-glass: become owner + member">
                          <KeyRound size={12} /> Recover
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {spaces.length === 0 && <tr><td style={td} colSpan={6}>No spaces.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const sub = { fontSize: 13, color: 'var(--text-3)', marginTop: 4, maxWidth: 680, lineHeight: 1.5 };
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' };
const cardHead = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 700, color: 'var(--text-1)' };
const th = { textAlign: 'left', padding: '9px 14px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border)', fontWeight: 700 };
const thNum = { ...th, textAlign: 'right', width: 90 };
const td = { padding: '9px 14px', fontSize: 13, color: 'var(--text-1)', borderBottom: '1px solid var(--border)' };
const tdNum = { ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-2)' };
const recoverBtn = { display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--surface-2)', color: 'var(--state-warning-fg)', border: '1px solid rgba(251,191,36,0.4)', borderRadius: 'var(--radius-sm)', padding: '5px 10px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' };
