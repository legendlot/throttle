'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { PageHead, Panel, Badge, Btn, EmptyState, Kpi } from '@/components/ui.js';
import { fmtDateShort } from '@/components/format.js';
import { STATUS_TABS, isINR, filterByTab, valueRowsForTab, otherStatusRows } from '@/lib/paymentList.js';
import { netPayable, hasTds } from '@/lib/tds.js';

export const STATUS_TONE = {
  submitted: 'gray', pending_approval: 'yellow', approved: 'blue', held: 'orange',
  paid: 'green', rejected: 'red', cancelled: 'gray',
};
export const STATUS_LABEL = {
  submitted: 'Submitted', pending_approval: 'Awaiting approval', approved: 'With Finance',
  // a hold is a finance PAUSE, not a closure — the requester still sees the request as open
  held: 'On hold with Finance',
  paid: 'Paid', rejected: 'Rejected', cancelled: 'Cancelled',
};

export function money(v, cur = 'INR') {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${cur === 'INR' ? '₹' : cur + ' '}${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

// Shared list used by My Requests / Approvals / Finance Queue. `scope` decides both the server
// filter and whether bulk selection is offered.
// `beforeList` is an optional node rendered directly under the page title (My Requests uses it
// for the privileged paid-payments export). Nothing renders when it is absent, so Approvals and
// the Finance Queue are byte-identical to before.
export default function PaymentList({ scope, title, sub, bulkAction, bulkLabel, emptyHint, showNewCta, beforeList }) {
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
  const [tab, setTab] = useState('all');
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

  // Status tabs (My Requests only — Approvals and Finance are status-pinned by the worker).
  // Client-side over the loaded rows, so the truncation banner must not claim they narrow the read.
  const tabs = scope === 'mine' ? STATUS_TABS : null;
  const visible = tabs ? filterByTab(rows, tab) : rows;
  // A cancelled or rejected request is not money anyone still owes — it must never sit in the
  // headline Value (Siddhanth, #bugs 1788853477: a cancelled ₹2,61,000 kept inflating the total).
  // On the All tab the Value is the ACTIVE value; on a specific tab it is that tab's value, so the
  // Cancelled tab still shows what was cancelled for tracking.
  const valueRows = valueRowsForTab(rows, tabs ? tab : 'all');
  // Never add rupees to dollars: the headline is INR-only, and any other currency is counted, not summed.
  const total = valueRows.filter(isINR).reduce((a, r) => a + (Number(r.amount_to_pay) || 0), 0);
  const foreign = valueRows.filter(r => !isINR(r)).length;
  // An 8th status (outside every tab's list) must still show up somewhere, or it can hide
  // indefinitely behind a tab count that never mentions it (2026-09-10).
  const other = tabs ? otherStatusRows(rows).length : 0;

  function toggle(id) {
    setSel(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  const allOn = visible.length > 0 && sel.size === visible.length;

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

  return (
    <>
      <PageHead title={title} sub={sub} />

      {beforeList}

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
          The counts and tabs below cover the loaded rows only.
        </div>
      )}

      {tabs && rows.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {tabs.map(t => {
            const n = t.statuses ? rows.filter(r => t.statuses.includes(r.status)).length : rows.length;
            const on = tab === t.key;
            return (
              <button key={t.key} type="button" onClick={() => { setTab(t.key); setSel(new Set()); }}
                style={{
                  padding: '6px 12px', borderRadius: 999, fontSize: 13, cursor: 'pointer',
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--bd)'}`,
                  background: on ? 'var(--accent-soft)' : 'var(--surface)',
                  color: on ? 'var(--accent)' : 'var(--t2)', fontWeight: on ? 700 : 500,
                }}>
                {t.label} <span style={{ opacity: 0.7 }}>{n}</span>
              </button>
            );
          })}
          {/* A status outside every tab's list (e.g. an 8th value added to the DB check
              constraint) would otherwise be visible on All only — this chip is the tripwire.
              Not clickable: there is no tab-filter for "unknown" to switch to. */}
          {other > 0 && (
            <span style={{
              padding: '6px 12px', borderRadius: 999, fontSize: 13,
              border: '1px solid var(--warn-br, #fdba74)', background: 'var(--warn-bg, #fff7ed)',
              color: 'var(--warn-fg, #9a3412)', fontWeight: 500,
            }}>
              Other <span style={{ opacity: 0.7 }}>{other}</span>
            </span>
          )}
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
          <Kpi label="Requests" value={visible.length} />
          <Kpi label={(tab === 'all' ? 'Value (active)' : 'Value') + (foreign ? ' · INR only' : '')} value={total} format={v => money(v)} />
          {foreign > 0 && <Kpi label="Other currencies" value={foreign} />}
          {scope === 'mine' && tab === 'all' && <Kpi label="Paid" value={rows.filter(r => r.status === 'paid').length} />}
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

      <Panel title={title} count={visible.length}>
        {visible.length === 0
          ? <EmptyState icon="check-check" title="Nothing here" hint={rows.length ? 'No requests in this status.' : emptyHint} />
          : (
            <div style={{ overflowX: 'auto' }}>
              <table className="dt">
                <thead>
                  <tr>
                    {bulkAction && (
                      <th style={{ width: 34 }}>
                        <input type="checkbox" checked={allOn}
                          onChange={() => setSel(allOn ? new Set() : new Set(visible.map(r => r.id)))} />
                      </th>
                    )}
                    <th>Request</th><th>Payee</th><th>Purpose</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th>Needed</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(r => (
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
                      <td style={{ textAlign: 'right' }}>
                        {money(r.amount_to_pay, r.currency)}
                        {/* Only where TDS applies — a NULL rate renders nothing at all, never
                            "0%", which would read as a deduction nobody made. */}
                        {hasTds(r) && (
                          <div style={{ fontSize: 10, color: 'var(--t2)' }}>
                            less {Number(r.tds_rate)}% TDS · net{' '}
                            {money(netPayable({ amountToPay: r.amount_to_pay, tdsAmount: r.tds_amount }), r.currency)}
                          </div>
                        )}
                      </td>
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
