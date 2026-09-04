'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { PageHead, Panel, Badge, Btn, EmptyState, Kpi } from '@/components/ui.js';
import { fmtDateShort } from '@/components/format.js';

export const STATUS_TONE = {
  submitted: 'gray', pending_approval: 'yellow', approved: 'blue',
  paid: 'green', rejected: 'red', cancelled: 'gray',
};
export const STATUS_LABEL = {
  submitted: 'Submitted', pending_approval: 'Awaiting approval', approved: 'With Finance',
  paid: 'Paid', rejected: 'Rejected', cancelled: 'Cancelled',
};

export function money(v, cur = 'INR') {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${cur === 'INR' ? '₹' : cur + ' '}${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

// Shared list used by My Requests / Approvals / Finance Queue. `scope` decides both the server
// filter and whether bulk selection is offered.
export default function PaymentList({ scope, title, sub, bulkAction, bulkLabel, emptyHint, showNewCta }) {
  const { userId } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  // Non-null only when the worker says the read was cut short: { total, fetched, limit }.
  const [truncation, setTruncation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [ref, setRef] = useState('');
  const firstLoadDone = useRef(false);

  const load = useCallback(async () => {
    if (!userId) return;
    if (!firstLoadDone.current) setLoading(true);
    try {
      const s = await getValidSession();
      const data = await garageFetch('getPaymentRequests', { scope }, s);
      setRows(data?.requests || []);
      setTruncation(data?.truncated ? data : null);
      setSel(new Set());
    } catch (e) {
      showToast(e.message || 'Failed to load', 'error');
    } finally { firstLoadDone.current = true; setLoading(false); }
  }, [userId, scope, showToast]);
  useEffect(() => { load(); }, [load]);

  function toggle(id) {
    setSel(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  const allOn = rows.length > 0 && sel.size === rows.length;

  async function runBulk() {
    if (!sel.size) return;
    setBusy(true);
    try {
      const s = await getValidSession();
      const payload = { ids: [...sel] };
      if (bulkAction === 'markPaymentPaid' && ref.trim()) payload.payment_ref = ref.trim();
      const raw = await workerFetch(bulkAction, { data: payload }, s);
      const res = raw?.data || raw;   // snorkelops wraps replies as `{ ok, data }` — read the payload, not the wrapper
      const done = res.approved ?? res.paid ?? 0;
      // Say what actually moved, not what was asked for — a row can leave the queue between
      // the page loading and the bulk running.
      showToast(
        done === sel.size ? `${done} done` : `${done} of ${sel.size} moved — the rest had already changed state`,
        done ? 'success' : 'error');
      setRef('');
      await load();
    } catch (e) {
      showToast(e.message || 'Action failed', 'error');
    } finally { setBusy(false); }
  }

  if (loading) return <Spinner />;

  const total = rows.reduce((a, r) => a + (Number(r.amount_to_pay) || 0), 0);

  return (
    <>
      <PageHead title={title} sub={sub} />

      {truncation && (
        <div style={{
          margin: '0 0 16px', padding: '10px 14px', borderRadius: 8,
          background: 'var(--warn-bg, #fff7ed)', border: '1px solid var(--warn-br, #fdba74)',
          color: 'var(--warn-fg, #9a3412)', fontSize: 13, lineHeight: 1.5,
        }}>
          <strong>
            {truncation.total != null
              ? `Showing the first ${truncation.limit} of ${truncation.total} requests.`
              : `Showing the first ${truncation.limit} requests — there are more.`}
          </strong>{' '}
          The counts below cover the loaded rows only. Filter by status to narrow the list.
        </div>
      )}

      {/* Raising a request is the whole point of the page — one tap from the phone tab, never
          buried in the nav sheet. */}
      {showNewCta && (
        <div style={{ marginBottom: 16 }}>
          <Btn kind="primary" onClick={() => router.push('/payments/new')}
               style={{ width: '100%', maxWidth: 320, padding: '14px 16px', fontSize: 15 }}>
            + New payment request
          </Btn>
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <Kpi label="Requests" value={rows.length} />
          <Kpi label="Value" value={money(total)} />
          {scope === 'mine' && <Kpi label="Paid" value={rows.filter(r => r.status === 'paid').length} />}
        </div>
      )}

      {bulkAction && sel.size > 0 && (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
          padding: 12, marginBottom: 12, borderRadius: 8,
          background: 'var(--accent-soft)', border: '1px solid var(--accent-bd)',
        }}>
          <b>{sel.size} selected</b>
          {bulkAction === 'markPaymentPaid' && (
            <input value={ref} onChange={e => setRef(e.target.value)} placeholder="UTR / reference (optional)"
              style={{ padding: '8px 10px', fontSize: 14, borderRadius: 6,
                       border: '1px solid var(--bd)', background: 'var(--surface)', color: 'var(--t1)' }} />
          )}
          <Btn kind="primary" onClick={runBulk} disabled={busy}>{busy ? 'Working…' : bulkLabel}</Btn>
          <Btn onClick={() => setSel(new Set())} disabled={busy}>Clear</Btn>
        </div>
      )}

      <Panel title={title} count={rows.length}>
        {rows.length === 0
          ? <EmptyState icon="check-check" title="Nothing here" hint={emptyHint} />
          : (
            <div style={{ overflowX: 'auto' }}>
              <table className="dt">
                <thead>
                  <tr>
                    {bulkAction && (
                      <th style={{ width: 34 }}>
                        <input type="checkbox" checked={allOn}
                          onChange={() => setSel(allOn ? new Set() : new Set(rows.map(r => r.id)))} />
                      </th>
                    )}
                    <th>Request</th><th>Payee</th><th>Purpose</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th>Needed</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} style={{ cursor: 'pointer' }}
                        onClick={() => router.push(`/payments/detail?id=${r.id}`)}>
                      {bulkAction && (
                        <td onClick={e => e.stopPropagation()}>
                          <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} />
                        </td>
                      )}
                      <td>
                        <b>{r.request_no}</b>{' '}
                        {r.is_urgent && <Badge tone="red" label="Urgent" />}{' '}
                        {r.request_type !== 'payment' &&
                          <Badge tone="gray" label={r.request_type === 'credit_note' ? 'CN' : 'DN'} />}
                        <div style={{ fontSize: 11, color: 'var(--t2)' }}>{r.requested_by_name}</div>
                      </td>
                      <td>{r.payee?.name || '—'}</td>
                      <td style={{ maxWidth: 260 }}>{r.purpose}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.amount_to_pay, r.currency)}</td>
                      <td>{r.needed_by ? fmtDateShort(r.needed_by) : '—'}</td>
                      <td>
                        <Badge tone={STATUS_TONE[r.status]} label={STATUS_LABEL[r.status]} />
                        {r.auto_approved && r.status === 'approved' &&
                          <div style={{ fontSize: 10, color: 'var(--t2)' }}>below threshold</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Panel>
    </>
  );
}
