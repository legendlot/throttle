'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { PageHead, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';

const GRANT_LABEL = {
  approve: 'Approve payments above the threshold',
  execute: 'Pay & record UTR (Finance)',
  super_admin: 'Payments super admin',
};

export default function PaymentsAdminPage() {
  const { userId } = useAuth();
  const { showToast } = useToast();
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [threshold, setThreshold] = useState('');
  const firstLoadDone = useRef(false);

  const load = useCallback(async () => {
    if (!userId) return;
    if (!firstLoadDone.current) setLoading(true);
    try {
      const s = await getValidSession();
      const data = await garageFetch('getPaymentAdmin', {}, s);
      setD(data);
      if (data?.settings) setThreshold(String(data.settings.approval_threshold_inr));
    } catch (e) {
      showToast(e.message || 'Not authorised', 'error');
    } finally { firstLoadDone.current = true; setLoading(false); }
  }, [userId, showToast]);
  useEffect(() => { load(); }, [load]);

  async function saveThreshold() {
    const t = Number(threshold);
    if (!(t >= 0)) return showToast('Enter a number', 'error');
    setBusy(true);
    try {
      const s = await getValidSession();
      await workerFetch('updatePaymentSettings', { data: { approval_threshold_inr: t } }, s);
      showToast('Threshold updated', 'success');
      await load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  async function toggleCat(c) {
    setBusy(true);
    try {
      const s = await getValidSession();
      await workerFetch('upsertPaymentCategory',
        { data: { category_key: c.category_key, po_required: !c.po_required } }, s);
      await load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  async function toggleGrant(g) {
    setBusy(true);
    try {
      const s = await getValidSession();
      await workerFetch('setPaymentGrant',
        { data: { user_id: g.user_id, grant_key: g.grant_key, active: !g.active } }, s);
      await load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  if (loading) return <Spinner />;
  if (!d) return <PageHead title="Payments Settings" sub="Super admins only." />;

  return (
    <>
      <PageHead title="Payments Settings"
        sub="Super admins only. Changes here affect how every payment request is routed." />

      <Panel title="Approval threshold">
        <div style={{ padding: 16, maxWidth: 520 }}>
          <label style={{ fontSize: 12, color: 'var(--t2)' }}>
            Requests at or above this amount go for approval before Finance sees them.
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input type="number" inputMode="decimal" value={threshold}
              onChange={e => setThreshold(e.target.value)}
              style={{ flex: 1, padding: '10px 12px', fontSize: 16, borderRadius: 8,
                       border: '1px solid var(--bd)', background: 'var(--surface)', color: 'var(--t1)' }} />
            <Btn kind="primary" onClick={saveThreshold} disabled={busy}>Save</Btn>
          </div>
          {/* The stamp is what makes changing this safe. */}
          <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 10 }}>
            Changing this only affects requests raised from now on. Every existing request keeps the
            threshold that was in force when it was raised, so history is not reinterpreted.
          </div>
        </div>
      </Panel>

      <Panel title="Categories" count={d.categories?.length || 0}>
        <div style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 10 }}>
            A category marked <b>PO required</b> will not accept a payment request without a linked PO.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="dt">
              <thead><tr><th>Category</th><th>PO required</th><th>Active</th><th /></tr></thead>
              <tbody>
                {(d.categories || []).map(c => (
                  <tr key={c.category_key}>
                    <td><b>{c.label}</b><div style={{ fontSize: 11, color: 'var(--t2)' }}>{c.category_key}</div></td>
                    <td><Badge tone={c.po_required ? 'yellow' : 'gray'}>{c.po_required ? 'Yes' : 'No'}</Badge></td>
                    <td><Badge tone={c.is_active ? 'green' : 'gray'}>{c.is_active ? 'Active' : 'Off'}</Badge></td>
                    <td><Btn disabled={busy} onClick={() => toggleCat(c)}>
                      {c.po_required ? 'Make PO optional' : 'Require a PO'}</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>

      <Panel title="Who can approve, pay and administer" count={d.grants?.length || 0}>
        <div style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 10 }}>
            These are per-person, not part of a Snorkel role — so approving payments is never granted
            by accident along with something else. To add someone, use Admin → Users to find their
            id, then grant them here.
          </div>
          {(d.grants || []).length === 0
            ? <EmptyState icon="shield" title="No grants" hint="Nobody can approve or pay yet." />
            : (
              <div style={{ overflowX: 'auto' }}>
                <table className="dt">
                  <thead><tr><th>Person</th><th>Capability</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {d.grants.map(g => (
                      <tr key={`${g.user_id}-${g.grant_key}`}>
                        <td><b>{g.full_name || g.user_id}</b></td>
                        <td>{GRANT_LABEL[g.grant_key] || g.grant_key}</td>
                        <td><Badge tone={g.active ? 'green' : 'gray'}>{g.active ? 'Active' : 'Revoked'}</Badge></td>
                        <td><Btn disabled={busy} onClick={() => toggleGrant(g)}>
                          {g.active ? 'Revoke' : 'Restore'}</Btn></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </Panel>
    </>
  );
}
