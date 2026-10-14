'use client';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState, useToast, Combobox } from '@throttle/ui';
import { ShieldCheck } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import { Card, Segmented, Typeahead, TableCard, Row, Avatar } from '../../../../components/ui/index.js';
import { matchRows } from '../../../../lib/typeahead.js';
import { PARTNER_TOGGLE_LABELS, defaultPartnerExpiry } from '../../../../lib/partner.js';

// Role colours per the Pit Control spec; any other role_key falls back to the neutral style.
const ROLE_STYLE = {
  ignition_admin:   { c: '#ff8a33', bg: 'rgba(255,107,0,.14)' },
  ignition_lead:    { c: '#F2CD1A', bg: 'rgba(242,205,26,.14)' },
  ignition_manager: { c: '#8ea2ff', bg: 'rgba(33,60,226,.22)' },
  ignition_viewer:  { c: '#a9b0c2', bg: '#1b1f2a' },
  ignition_partner: { c: '#4ade80', bg: 'rgba(74,222,128,.12)' },
};
const isExternal = (r) => !!r?.permissions?.ignition_external;
const inputStyle = { height: 44, boxSizing: 'border-box', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '0 14px', fontSize: 14, color: 'var(--text-1)', fontFamily: 'inherit', outline: 'none' };
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : null);
const roleStyle = (k) => ROLE_STYLE[k] || { c: 'var(--text-3)', bg: 'var(--surface-2)' };

const fieldLabel = { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' };
const COLS = 'minmax(240px,1.6fr) 180px minmax(160px,1fr) 110px 110px';

export default function AdminUsersPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const canAdmin = !!perms?.ignition_admin;

  const [data, setData] = useState(null);
  const [grantable, setGrantable] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pickUser, setPickUser] = useState('');
  const [pickRole, setPickRole] = useState('ignition_manager');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  // Invite partner (S419) — external, own-email sign-in, expiry defaults to today + 90 days.
  const [invEmail, setInvEmail] = useState('');
  const [invName, setInvName] = useState('');
  const [invExpiry, setInvExpiry] = useState(defaultPartnerExpiry());

  const load = useCallback(async () => {
    if (!session || !canAdmin) { setLoading(false); return; }
    setLoading(true);
    try {
      const [access, users] = await Promise.all([
        ignitionopsGet('getIgnitionAccess', {}, session),
        ignitionopsGet('getGrantableUsers', {}, session),
      ]);
      setData(access);
      setGrantable(users?.users || []);
    } catch (e) {
      showToast(e.message || 'Failed to load access list', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, canAdmin, showToast]);

  useEffect(() => { load(); }, [load]);

  if (!canAdmin) return <div style={{ padding: 16, color: 'var(--text-3)' }}>Admin only.</div>;
  if (loading) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const roles = data?.roles || [];
  const users = data?.users || [];
  const roleLabel = (k) => roles.find((r) => r.role_key === k)?.label || k;

  async function grant() {
    if (!pickUser) { showToast('Pick a person', 'error'); return; }
    setBusy(true);
    try {
      await ignitionopsPost('grantIgnitionAccess', { data: { user_id: pickUser, role_key: pickRole } }, session);
      showToast('Access granted', 'success');
      setPickUser('');
      load();
    } catch (e) {
      showToast(e.message || 'Grant failed', 'error');
    } finally { setBusy(false); }
  }

  async function invite() {
    if (!invEmail.trim() || !invName.trim() || !invExpiry) { showToast('Email, name and expiry are all required', 'error'); return; }
    setBusy(true);
    try {
      const r = await ignitionopsPost('invitePartner', { data: { email: invEmail.trim(), full_name: invName.trim(), expires_at: invExpiry } }, session);
      showToast(`${r?.email || 'Partner'} invited — they sign in with “Partner sign-in” on the login page`, 'success');
      setInvEmail(''); setInvName(''); setInvExpiry(defaultPartnerExpiry());
      load();
    } catch (e) {
      showToast(e.message || 'Invite failed', 'error');
    } finally { setBusy(false); }
  }

  async function setToggle(role, key, value) {
    setBusy(true);
    try {
      await ignitionopsPost('setIgnitionRolePermission', { data: { role_key: role.role_key, key, value } }, session);
      showToast(`${role.label}: ${key} ${value ? 'on' : 'off'}`, 'success');
      load();
    } catch (e) {
      showToast(e.message || 'Update failed', 'error');
    } finally { setBusy(false); }
  }

  async function toggle(u) {
    setBusy(true);
    try {
      await ignitionopsPost('setIgnitionUserActive', { data: { user_id: u.user_id, active: !u.active } }, session);
      showToast(u.active ? 'Access revoked' : 'Access restored', 'success');
      load();
    } catch (e) {
      showToast(e.message || 'Update failed', 'error');
    } finally { setBusy(false); }
  }

  // Everyone active is grantable — a person's other job (CS, social, production) no
  // longer competes with Ignition access, which is the point of the separate layer.
  const userOptions = grantable
    .filter((u) => !users.some((a) => a.user_id === u.id && a.active))
    .map((u) => ({ value: u.id, label: u.full_name, hint: u.role || '' }));

  const activeCount = users.filter((u) => u.active).length;
  const userFields = (u) => [u.full_name, u.email, roleLabel(u.role_key), u.global_role];
  const staffRoles = roles.filter((r) => !isExternal(r));
  const byStatus = users.filter((u) => status === 'all' || (status === 'active' ? u.active : !u.active));
  const rows = matchRows(byStatus, q, userFields);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text-4)' }}>Admin · Users</div>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6 }}>Ignition Access</h1>
        <p style={{ fontSize: 14, color: 'var(--text-3)', marginTop: 6, maxWidth: 720, lineHeight: 1.55 }}>
          Ignition access is granted here and nowhere else. It is independent of a person’s
          role in other systems — granting or revoking Ignition never affects their Pitstop,
          Garage or Throttle access.
        </p>
      </div>

      <Card padding="20px 22px" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 32, height: 32, borderRadius: 10, background: 'rgba(255,107,0,.14)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#ff8a33' }}>
            <ShieldCheck size={17} strokeWidth={1.75} />
          </span>
          <span style={{ fontFamily: 'var(--font-cond)', fontSize: 17, fontWeight: 700 }}>Grant access</span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 340, maxWidth: '100%' }}>
            <span style={fieldLabel}>Person</span>
            <Combobox
              value={pickUser}
              options={userOptions}
              onChange={(v) => setPickUser(v)}
              placeholder="Search anyone in the company…"
              portal
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: '100%' }}>
            <span style={fieldLabel}>Role</span>
            <Segmented
              value={pickRole}
              onChange={setPickRole}
              disabled={busy}
              options={staffRoles.map((r) => ({ value: r.role_key, label: r.label }))}
              style={{ background: 'var(--bg)', borderRadius: 12 }}
            />
          </div>
          <button
            onClick={grant}
            disabled={busy}
            style={{ height: 44, padding: '0 22px', borderRadius: 12, border: 'none', background: 'var(--accent)', color: '#0a0a0a', fontWeight: 700, fontSize: 14, fontFamily: 'inherit', cursor: busy ? 'not-allowed' : 'pointer', opacity: pickUser && !busy ? 1 : 0.55 }}
          >
            {busy ? 'Saving…' : 'Grant'}
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
          {roles.map((r) => {
            const rs = roleStyle(r.role_key);
            const sel = r.role_key === pickRole;
            return (
              <div key={r.role_key} style={{ padding: '12px 14px', borderRadius: 12, border: `1px solid ${sel ? rs.c : 'var(--border)'}`, background: sel ? 'rgba(255,255,255,.02)' : 'transparent' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 14, fontWeight: 700 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: rs.c }} />{r.label}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-4)' }}>
                    {users.filter((u) => u.active && u.role_key === r.role_key).length} active
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6, lineHeight: 1.45 }}>{r.description}</div>
                {isExternal(r) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                    {PARTNER_TOGGLE_LABELS.map((t) => {
                      const on = !!r.permissions?.[t.key];
                      return (
                        <label key={t.key} title={t.hint} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-2)', cursor: busy ? 'not-allowed' : 'pointer' }}>
                          <input type="checkbox" role="switch" checked={on} disabled={busy}
                            onChange={() => setToggle(r, t.key, !on)} />
                          <span style={{ fontWeight: 600 }}>{t.label}</span>
                          <span style={{ color: 'var(--text-4)' }}>{t.hint}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card padding="20px 22px" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontFamily: 'var(--font-cond)', fontSize: 17, fontWeight: 700 }}>Invite partner</span>
        <p style={{ fontSize: 13, color: 'var(--text-3)', margin: 0, lineHeight: 1.5, maxWidth: 720 }}>
          External agency staff (e.g. Clearshot). They sign in with their own email via a one-time link,
          see Roster influencers read-only, and lose access on the expiry date. Their account never
          opens any other LOT system.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={fieldLabel}>Email</span>
            <input type="email" value={invEmail} onChange={(e) => setInvEmail(e.target.value)} placeholder="name@agency.com" style={{ ...inputStyle, width: 260 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={fieldLabel}>Name</span>
            <input value={invName} onChange={(e) => setInvName(e.target.value)} placeholder="Full name" style={{ ...inputStyle, width: 220 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={fieldLabel}>Access until</span>
            <input type="date" value={invExpiry} onChange={(e) => setInvExpiry(e.target.value)} style={inputStyle} />
          </label>
          <button
            onClick={invite}
            disabled={busy}
            style={{ height: 44, padding: '0 22px', borderRadius: 12, border: 'none', background: 'var(--accent)', color: '#0a0a0a', fontWeight: 700, fontSize: 14, fontFamily: 'inherit', cursor: busy ? 'not-allowed' : 'pointer', opacity: invEmail && invName && !busy ? 1 : 0.55 }}
          >
            {busy ? 'Saving…' : 'Invite'}
          </button>
        </div>
      </Card>

      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '4px 2px 12px' }}>
          <span style={{ fontFamily: 'var(--font-cond)', fontSize: 17, fontWeight: 700 }}>
            Who has access <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-4)', fontWeight: 500, marginLeft: 6 }}>{activeCount} active</span>
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* No per-user page: a pick narrows the table to that person (plan 2026-10-08 S5). */}
            <Typeahead
              value={q}
              onChange={setQ}
              placeholder="Search people, role…"
              width={280}
              quiet
              debounceMs={0}
              refreshKey={data}
              // From the status-filtered list, so a pick is always a row the table can show.
              fetchResults={async (text) => matchRows(byStatus.filter((u) => u.full_name), text, userFields).slice(0, 6).map((u) => ({
                id: u.user_id,
                primary: u.full_name,
                secondary: [roleLabel(u.role_key), u.active ? 'Active' : 'Revoked'].join(' · '),
                lead: <Avatar name={u.full_name || '?'} seed={u.user_id} size={28} />,
              }))}
              onPick={(it) => setQ(it.primary)}
              onSubmit={() => {}}
            />
            <Segmented
              value={status}
              onChange={setStatus}
              options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'revoked', label: 'Revoked' }]}
            />
          </div>
        </div>
        {!users.length ? (
          <EmptyState title="Nobody has Ignition access yet" />
        ) : (
          <TableCard columns={COLS} minWidth={820} head={['Name', 'Ignition role', 'Their other role', 'Status', '']}>
            {rows.map((u, i) => {
              const rs = roleStyle(u.role_key);
              return (
                <Row key={u.user_id} columns={COLS} first={i === 0} animate index={i} style={{ opacity: u.active ? 1 : 0.5 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                    <Avatar name={u.full_name || '?'} seed={u.user_id} size={34} />
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {u.full_name || <span style={{ color: 'var(--text-4)' }}>—</span>}
                      </span>
                      {u.email && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</span>}
                    </span>
                  </span>
                  <span style={{ justifySelf: 'start', fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 99, color: rs.c, background: rs.bg }}>{roleLabel(u.role_key)}</span>
                  {u.expires_at ? (
                    // Partner rows: the expiry IS the context that matters (their global role is inert).
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: Date.parse(u.expires_at) <= Date.now() ? '#ff7b7b' : 'var(--text-3)' }}>
                      {Date.parse(u.expires_at) <= Date.now() ? 'Expired ' : 'Until '}{fmtDate(u.expires_at)}
                    </span>
                  ) : (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)' }}>{u.global_role || '—'}</span>
                  )}
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: u.active ? '#4ade80' : 'var(--text-4)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'currentColor' }} />
                    {u.active ? 'Active' : 'Revoked'}
                  </span>
                  <button
                    onClick={() => toggle(u)}
                    disabled={busy}
                    style={{ justifySelf: 'end', fontSize: 12, fontWeight: 700, padding: '7px 12px', borderRadius: 10, background: 'transparent', fontFamily: 'inherit', cursor: busy ? 'not-allowed' : 'pointer', border: `1px solid ${u.active ? 'rgba(255,123,123,.4)' : 'var(--border-3)'}`, color: u.active ? '#ff7b7b' : 'var(--text-1)' }}
                  >
                    {u.active ? 'Revoke' : 'Restore'}
                  </button>
                </Row>
              );
            })}
            {!rows.length && (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-4)', fontSize: 14, borderTop: '1px solid var(--row-divider)' }}>
                No one with access matches the current filter.
              </div>
            )}
          </TableCard>
        )}
      </section>
    </div>
  );
}
