'use client';
import { useState, useEffect } from 'react';
import Layout from '@/components/Layout';
import { supabaseBrand as supabase, workerFetch } from '@throttle/db';
import { useAuth } from '@throttle/auth';

const ROLES = ['admin', 'lead', 'member', 'requester'];
const DISCIPLINES = ['designer', '3d', 'copywriter', 'photo_video', 'social_media', 'lead'];

export default function SettingsPage() {
  const { session, brandUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);

  async function loadUsers() {
    try {
      const { data, error } = await supabase.from('users').select('*').order('name');
      if (error) throw error;
      setUsers(data || []);
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    if (session && brandUser?.role === 'admin') loadUsers();
  }, [session, brandUser]);

  async function updateUser(userId, field, value) {
    setSaving(userId);
    setError(null);
    try {
      await workerFetch('updateUserRole', { user_id: userId, [field]: value }, session?.access_token);
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, [field]: value } : u));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(null);
    }
  }

  if (brandUser?.role !== 'admin') {
    return (
      <Layout>
        <div style={{ maxWidth: 512, margin: '0 auto', paddingTop: 80, paddingBottom: 80, textAlign: 'center' }}>
          <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>Admin access required.</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div style={{ maxWidth: 896, margin: '0 auto' }}>
        <h1 style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 18, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--text)', marginBottom: 4 }}>Settings</h1>
        <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginBottom: 24 }}>Manage team roles and disciplines</p>

        {!loaded ? (
          <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>Loading team...</p>
        ) : loadError ? (
          <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#DE2A2A' }}>{loadError}</p>
        ) : (
          <div>
            {error && (
              <div style={{ background: 'rgba(222,42,42,0.08)', border: '1px solid rgba(222,42,42,0.3)', borderRadius: 6, padding: '10px 14px', marginBottom: 16 }}>
                <p style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{error}</p>
              </div>
            )}
            {(() => {
              const GROUP_ORDER = [
                { key: 'lead',      label: 'Lead',        roles: ['lead'] },
                { key: 'team',      label: 'Brand Team',  roles: ['member', 'admin'] },
                { key: 'requester', label: 'Requesters',  roles: ['requester'] },
              ];

              const thStyle = { fontFamily: 'var(--head)', fontSize: 9, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--t3)', fontWeight: 700, padding: '9px 16px', textAlign: 'left', borderBottom: '1px solid var(--b1)' };
              const tdBase  = { padding: '10px 16px' };

              return GROUP_ORDER.map(group => {
                const groupUsers = users.filter(u => group.roles.includes(u.role));
                if (groupUsers.length === 0) return null;
                return (
                  <div key={group.key} style={{ marginBottom: 24 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <span style={{ fontFamily: 'var(--head)', fontSize: 10, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--t3)', fontWeight: 700 }}>{group.label}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', background: 'var(--s2)', border: '1px solid var(--b1)', borderRadius: 10, padding: '1px 8px' }}>{groupUsers.length}</span>
                    </div>
                    <div style={{ background: 'var(--s1)', border: '1px solid var(--b1)', borderRadius: 8, overflow: 'hidden' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 12 }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--b1)' }}>
                            <th style={thStyle}>Name</th>
                            <th style={thStyle}>Email</th>
                            <th style={thStyle}>Role</th>
                            <th style={thStyle}>Discipline</th>
                          </tr>
                        </thead>
                        <tbody>
                          {groupUsers.map((user, i) => (
                            <tr key={user.id} style={{ borderBottom: i < groupUsers.length - 1 ? '1px solid var(--b1)' : 'none' }}>
                              <td style={{ ...tdBase, color: 'var(--text)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                                {user.id === brandUser?.id && (
                                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, background: 'rgba(242,205,26,0.12)', color: '#F2CD1A', border: '1px solid rgba(242,205,26,0.25)', borderRadius: 3, padding: '1px 5px', letterSpacing: '.06em' }}>you</span>
                                )}
                                {user.name}
                              </td>
                              <td style={{ ...tdBase, color: 'var(--t3)', fontSize: 11 }}>{user.email}</td>
                              <td style={tdBase}>
                                <select
                                  value={user.role}
                                  disabled={user.id === brandUser?.id || saving === user.id}
                                  onChange={e => updateUser(user.id, 'role', e.target.value)}
                                  style={{ background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '4px 8px', fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--mono)', outline: 'none', opacity: (user.id === brandUser?.id || saving === user.id) ? 0.4 : 1 }}
                                >
                                  {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                              </td>
                              <td style={tdBase}>
                                <select
                                  value={user.discipline || ''}
                                  disabled={saving === user.id}
                                  onChange={e => updateUser(user.id, 'discipline', e.target.value || null)}
                                  style={{ background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '4px 8px', fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--mono)', outline: 'none', opacity: saving === user.id ? 0.4 : 1 }}
                                >
                                  <option value="">— none —</option>
                                  {DISCIPLINES.map(d => <option key={d} value={d}>{d}</option>)}
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        )}

        {brandUser?.role === 'admin' && (
          <section style={{ marginTop: 40 }}>
            <h2 style={{ fontFamily: 'var(--head)', fontSize: 13, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text)', marginBottom: 16 }}>Ageing Thresholds</h2>
            <AgeingConfigSection session={session} />
          </section>
        )}
      </div>
    </Layout>
  );
}

function AgeingConfigSection({ session }) {
  const [config, setConfig] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [edits, setEdits] = useState({});

  async function loadConfig() {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await workerFetch('getAgeingConfig', {}, session?.access_token);
      setConfig(d.config || []);
      const initial = {};
      for (const row of d.config || []) {
        initial[row.stage] = {
          warning_hours:    row.warning_hours,
          critical_hours:   row.critical_hours,
          auto_close_hours: row.auto_close_hours ?? '',
        };
      }
      setEdits(initial);
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (session) loadConfig();
  }, [session]);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const updates = config.map(row => ({
        stage:            row.stage,
        warning_hours:    Number(edits[row.stage]?.warning_hours),
        critical_hours:   Number(edits[row.stage]?.critical_hours),
        auto_close_hours: edits[row.stage]?.auto_close_hours !== '' ? Number(edits[row.stage]?.auto_close_hours) : null,
      }));
      await workerFetch('updateAgeingConfig', { updates }, session?.access_token);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  function update(stage, field, value) {
    setEdits(e => ({ ...e, [stage]: { ...e[stage], [field]: value } }));
  }

  if (loading) return <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>Loading...</p>;
  if (loadError) return <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#DE2A2A' }}>{loadError}</p>;
  if (config.length === 0) return <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>No config found.</p>;

  return (
    <div>
      {loading && <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>Loading...</p>}
      {config.length > 0 && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
            <thead>
              <tr>
                {['Stage', 'Warning (hrs)', 'Critical (hrs)', 'Auto-close (hrs)'].map(h => (
                  <th key={h} style={{ textAlign: 'left', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', letterSpacing: '.1em', textTransform: 'uppercase', padding: '6px 10px', borderBottom: '1px solid var(--b1)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {config.map(row => (
                <tr key={row.stage}>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', padding: '8px 10px', borderBottom: '1px solid var(--b1)' }}>{row.label}</td>
                  {['warning_hours', 'critical_hours', 'auto_close_hours'].map(field => (
                    <td key={field} style={{ padding: '6px 10px', borderBottom: '1px solid var(--b1)' }}>
                      <input
                        type="number"
                        value={edits[row.stage]?.[field] ?? ''}
                        onChange={e => update(row.stage, field, e.target.value)}
                        placeholder={field === 'auto_close_hours' ? 'n/a' : ''}
                        style={{ width: 70, background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '4px 8px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, outline: 'none' }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <button
            onClick={save}
            disabled={saving}
            style={{ background: '#F2CD1A', color: '#080808', border: 'none', borderRadius: 4, padding: '7px 14px', fontFamily: 'var(--head)', fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', cursor: 'pointer', opacity: saving ? 0.5 : 1 }}
          >
            {saved ? 'Saved ✓' : saving ? 'Saving...' : 'Save Changes'}
          </button>
        </>
      )}
    </div>
  );
}
