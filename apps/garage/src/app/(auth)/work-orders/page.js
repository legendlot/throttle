'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { ConfirmModal, EmptyState, useToast } from '@throttle/ui';
import { WorkOrdersTable } from '../../../components/work-orders/WorkOrdersTable.js';

// Ad-hoc parts requests are now RAISED in Redline (New Run / Request → Ad Hoc Parts) —
// it's a production job. This Garage screen tracks open ad-hoc requests and lets them be
// cancelled; the store issues them from the Issue Queue. No create path lives here.

export default function WorkOrdersPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelling, setCancelling] = useState(false);

  async function loadOrders() {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const data = await garageFetch('getWorkOrders', {}, session);
      setOrders(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || 'Failed to load work orders');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadOrders();
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleConfirmCancel() {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      await workerFetch(
        'updateWorkOrder',
        { data: { wo_no: cancelTarget.wo_no, status: 'Cancelled' } },
        session,
      );
      showToast(`${cancelTarget.wo_no} cancelled`, 'success');
      setCancelTarget(null);
      loadOrders();
    } catch (e) {
      showToast(e.message || 'Cancel failed', 'error');
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div style={{ padding: '16px 24px', color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Ad Hoc Requests
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Track open ad hoc parts requests and cancel them. Requests are raised by production in Redline (New Run / Request); the store issues them from the Issue Queue.
        </p>
      </div>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <EmptyState message={error} />
        </div>
      )}

      <WorkOrdersTable
        orders={orders}
        loading={loading}
        onCancel={(wo) => setCancelTarget(wo)}
      />

      <ConfirmModal
        open={!!cancelTarget}
        onClose={() => !cancelling && setCancelTarget(null)}
        title={cancelTarget ? `Cancel ${cancelTarget.wo_no}` : ''}
        message={cancelTarget ? `Cancel work order ${cancelTarget.wo_no}? This cannot be undone.` : ''}
        confirmLabel={cancelling ? 'CANCELLING…' : 'Cancel WO'}
        confirmColor="red"
        onConfirm={handleConfirmCancel}
        loading={cancelling}
      />
    </div>
  );
}
