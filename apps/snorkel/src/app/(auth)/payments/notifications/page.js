'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { PageHead, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateShort } from '@/components/format.js';

const KIND_TONE = {
  approval_needed: 'yellow', payment_needed: 'blue', approved: 'blue',
  paid: 'green', rejected: 'red', cancelled: 'gray',
};
const KIND_LABEL = {
  approval_needed: 'Needs approval', payment_needed: 'Ready to pay', approved: 'Approved',
  paid: 'Paid', rejected: 'Rejected', cancelled: 'Cancelled',
};

export default function PaymentNotificationsPage() {
  const { userId } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const firstLoadDone = useRef(false);

  const load = useCallback(async () => {
    if (!userId) return;
    if (!firstLoadDone.current) setLoading(true);
    try {
      const s = await getValidSession();
      const data = await garageFetch('getPaymentNotifications', {}, s);
      setRows(data?.notifications || []);
    } catch (e) {
      showToast(e.message || 'Failed to load', 'error');
    } finally { firstLoadDone.current = true; setLoading(false); }
  }, [userId, showToast]);
  useEffect(() => { load(); }, [load]);

  async function markAll() {
    setBusy(true);
    try {
      const s = await getValidSession();
      await workerFetch('markPaymentNotificationsRead', { data: {} }, s);
      await load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  async function open(n) {
    try {
      const s = await getValidSession();
      if (!n.read_at) await workerFetch('markPaymentNotificationsRead', { data: { ids: [n.id] } }, s);
    } catch { /* opening matters more than the read flag */ }
    if (n.request_id) router.push(`/payments/detail?id=${n.request_id}`);
    else load();
  }

  if (loading) return <Spinner />;
  const unread = rows.filter(n => !n.read_at).length;

  return (
    <>
      <PageHead title="Notifications"
        sub="Payment activity that involves you — raised, approved, rejected or paid." />

      {unread > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Btn onClick={markAll} disabled={busy}>Mark all {unread} as read</Btn>
        </div>
      )}

      <Panel title="Recent" count={rows.length}>
        {rows.length === 0
          ? <EmptyState icon="bell" title="Nothing yet"
              hint="You'll be told here when a request of yours moves, or when one needs you." />
          : (
            <div>
              {rows.map(n => (
                <div key={n.id} onClick={() => open(n)}
                  style={{
                    padding: '12px 16px', borderBottom: '1px solid var(--bd)', cursor: 'pointer',
                    // unread is carried by weight + a dot, never colour alone
                    background: n.read_at ? 'transparent' : 'var(--accent-soft)',
                    display: 'flex', gap: 10, alignItems: 'flex-start',
                  }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%', marginTop: 6, flexShrink: 0,
                    background: n.read_at ? 'transparent' : 'var(--accent)',
                  }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: n.read_at ? 400 : 600, fontSize: 14 }}>{n.title}</div>
                    {n.body && (
                      <div style={{ fontSize: 13, color: 'var(--t2)', marginTop: 2 }}>{n.body}</div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--t2)', marginTop: 4 }}>
                      <Badge tone={KIND_TONE[n.kind] || 'gray'} label={KIND_LABEL[n.kind] || n.kind} />
                      {' '}{fmtDateShort(n.created_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
      </Panel>
    </>
  );
}
