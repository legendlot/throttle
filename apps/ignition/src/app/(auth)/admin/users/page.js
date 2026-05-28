'use client';
import { useAuth } from '@throttle/auth';

export default function AdminUsersPage() {
  const { perms } = useAuth();
  if (!perms?.ignition_admin) return <div style={{ padding: 16, color: 'var(--text-3)' }}>Admin only.</div>;
  return (
    <div>
      <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 16 }}>
        User Roles
      </h1>
      <div style={{ padding: 16, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
        <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 12 }}>
          Ignition uses the shared <code>store.roles</code> permission map. Manage user role
          assignments via Garage <code>/users</code>; the five Ignition permission keys
          (<code>ignition_view</code>, <code>ignition_manage</code>, <code>ignition_approve</code>,
          <code>ignition_admin</code>, <code>ignition_reports_view</code>) appear there once
          a row exists in <code>store.users_profile</code> with one of the Ignition roles.
        </p>
        <p style={{ color: 'var(--text-2)', fontSize: 13 }}>
          Two dedicated roles: <strong>ignition_manager</strong> (view + manage + reports) and
          <strong> ignition_lead</strong> (adds approve). <strong>admin</strong> and
          <strong> super_admin</strong> get full access automatically.
        </p>
      </div>
    </div>
  );
}
