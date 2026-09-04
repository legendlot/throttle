'use client';
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { PageHead, Panel, Badge, Btn, EmptyState, Kpi } from '@/components/ui.js';
import { fmtDateShort } from '@/components/format.js';
import { money } from '../PaymentList.js';

const todayISO = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

function Copy({ value, label }) {
  const { showToast } = useToast();
  if (!value) return null;
  return (
    <button type="button" onClick={() => {
        navigator.clipboard?.writeText(String(value))
          .then(() => showToast(`${label} copied`, 'success'))
          .catch(() => showToast('Copy failed', 'error'));
      }}
      style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer',
               fontSize: 11, padding: '0 4px' }}>copy</button>
  );
}

// The finance worklist: one card per payment, everything needed to actually pay it on screen,
// and the UTR box right there. Built as a worklist rather than a table because the job is
// "work down the pile", not "scan a report".
export default function FinanceQueuePage() {
  const { userId } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [d, setD] = useState({ requests: [], banks: {}, documents: {} });
  // Non-null only when the worker says the read was cut short: { total, fetched, limit }.
  const [truncation, setTruncation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [refs, setRefs] = useState({});
  const [onlyUrgent, setOnlyUrgent] = useState(false);
  const firstLoadDone = useRef(false);

  const load = useCallback(async () => {
    if (!userId) return;
    if (!firstLoadDone.current) setLoading(true);
    try {
      const s = await getValidSession();
      const data = await garageFetch('getFinanceQueue', {}, s);
      setD({ requests: data?.requests || [], banks: data?.banks || {}, documents: data?.documents || {} });
      // ⚠️ Sharpest case of the truncation class: the money total below is a SUM. A cut list
      // under-reports what finance actually owes, and a short total reads as authoritative.
      setTruncation(data?.truncated ? data : null);
    } catch (e) {
      showToast(e.message || 'Failed to load', 'error');
    } finally { firstLoadDone.current = true; setLoading(false); }
  }, [userId, showToast]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(
    () => (onlyUrgent ? d.requests.filter(r => r.is_urgent) : d.requests),
    [d.requests, onlyUrgent]);

  const total   = rows.reduce((a, r) => a + (Number(r.amount_to_pay) || 0), 0);
  const overdue = rows.filter(r => r.needed_by && r.needed_by < todayISO()).length;

  async function pay(r) {
    setBusy(r.id);
    try {
      const s = await getValidSession();
      const raw = await workerFetch('markPaymentPaid', { data: {
        ids: [r.id], payment_ref: (refs[r.id] || '').trim() || null, paid_amount: r.amount_to_pay,
      } }, s);
      // snorkelops wraps replies as `{ ok, data }` — read the payload. Off the wrapper, `paid` was
      // undefined and EVERY successful payment toasted "It had already moved" (hostile review S345).
      const res = raw?.data || raw;
      if (!res.paid) {
        showToast('It had already moved — refreshing', 'error');
      } else {
        showToast(`${r.request_no} marked paid`, 'success');
      }
      setRefs(p => { const n = { ...p }; delete n[r.id]; return n; });
      await load();
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    } finally { setBusy(null); }
  }

  async function openDoc(docId) {
    try {
      const s = await getValidSession();
      const r = await garageFetch('getPaymentDocUrl', { doc_id: docId }, s);
      window.open(r.url, '_blank', 'noopener');
    } catch (e) { showToast(e.message || 'Could not open', 'error'); }
  }

  if (loading) return <Spinner />;

  const inp = { padding: '9px 10px', fontSize: 15, borderRadius: 8, border: '1px solid var(--bd)',
                background: 'var(--surface)', color: 'var(--t1)' };

  return (
    <>
      <PageHead title="Finance Queue"
        sub="Approved and unpaid, most urgent first. Everything needed to pay is on the card — bank details included." />

      {truncation && (
        <div style={{
          margin: '0 0 14px', padding: '10px 14px', borderRadius: 8,
          background: 'var(--warn-bg, #fff7ed)', border: '1px solid var(--warn-br, #fdba74)',
          color: 'var(--warn-fg, #9a3412)', fontSize: 13, lineHeight: 1.5,
        }}>
          <strong>
            {truncation.total != null
              ? `Showing the first ${truncation.limit} of ${truncation.total} approved requests.`
              : `Showing the first ${truncation.limit} approved requests — there are more.`}
          </strong>{' '}
          The Value total below covers only these {truncation.fetched} — the real amount owed is higher.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <Kpi label="To pay" value={truncation?.total != null ? `${rows.length} of ${truncation.total}` : (truncation ? `${rows.length}+` : rows.length)} />
        <Kpi label={truncation ? 'Value (partial)' : 'Value'} value={money(total)} />
        {overdue > 0 && <Kpi label="Past needed-by" value={overdue} />}
      </div>

      <div style={{ marginBottom: 12 }}>
        <Btn kind={onlyUrgent ? 'primary' : 'ghost'} onClick={() => setOnlyUrgent(v => !v)}>
          {onlyUrgent ? 'Showing urgent only' : 'Show urgent only'}
        </Btn>
      </div>

      {rows.length === 0 ? (
        <Panel title="Finance Queue">
          <EmptyState icon="check-check" title="All clear"
            hint="Nothing approved is waiting to be paid." />
        </Panel>
      ) : rows.map(r => {
        const bank = (d.banks[r.payee_id] || [])[0];
        const docs = d.documents[r.id] || [];
        const late = r.needed_by && r.needed_by < todayISO();
        return (
          <Panel key={r.id} title={`${r.request_no} · ${r.payee?.name || 'Unknown payee'}`}>
            <div style={{ padding: 16, display: 'grid', gap: 14,
                          gridTemplateColumns: 'minmax(0,1fr)' }}>

              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <div style={{ fontSize: 26, fontWeight: 700 }}>{money(r.amount_to_pay, r.currency)}</div>
                {r.is_urgent && <Badge tone="red" label="Urgent" />}
                {late && <Badge tone="red" label={`Needed ${fmtDateShort(r.needed_by)}`} />}
                {!late && r.needed_by && <Badge tone="gray" label={`Needed ${fmtDateShort(r.needed_by)}`} />}
                {r.auto_approved
                  ? <Badge tone="gray" label="Below threshold" />
                  : <Badge tone="blue" label={`Approved by ${r.approved_by_name || '—'}`} />}
              </div>

              <div style={{ fontSize: 14 }}>
                {r.purpose}
                <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 3 }}>
                  {r.requested_by_name} · {r.category_key?.replace(/_/g, ' ')}
                  {r.linked_po_number ? ` · PO ${r.linked_po_number}` : ''}
                  {r.invoice_no ? ` · Invoice ${r.invoice_no}` : ''}
                  {r.invoice_total && Number(r.invoice_total) > Number(r.amount_to_pay)
                    ? ` · part-payment of ${money(r.invoice_total, r.currency)}` : ''}
                </div>
                {r.urgency_reason && (
                  <div style={{ fontSize: 12, color: 'var(--red-fg)', marginTop: 4 }}>
                    Urgent: {r.urgency_reason}
                  </div>
                )}
              </div>

              {/* The reason this page exists — without this block finance opens every request
                  one at a time, which is the Slack workflow with extra steps. */}
              <div style={{ padding: 12, borderRadius: 8, background: 'var(--accent-soft)',
                            border: '1px solid var(--accent-bd)', fontSize: 13 }}>
                {bank ? (
                  <>
                    <div style={{ fontWeight: 600 }}>{bank.account_name || r.payee?.name}</div>
                    <div style={{ color: 'var(--t2)', marginTop: 2 }}>
                      {bank.account_number}<Copy value={bank.account_number} label="Account number" />
                      {bank.ifsc ? <> · {bank.ifsc}<Copy value={bank.ifsc} label="IFSC" /></> : null}
                    </div>
                    <div style={{ color: 'var(--t2)' }}>
                      {[bank.bank_name, bank.branch].filter(Boolean).join(' · ')}
                      {bank.upi_id ? <> · UPI {bank.upi_id}<Copy value={bank.upi_id} label="UPI" /></> : null}
                    </div>
                    {bank.masked && (
                      <div style={{ color: 'var(--t2)', marginTop: 4 }}>
                        Masked — you do not have permission to see full bank details.
                      </div>
                    )}
                  </>
                ) : (
                  // A missing account is the "who is shivam?" case. Say so plainly and name the fix.
                  <div style={{ color: 'var(--red-fg)' }}>
                    No bank account on file for {r.payee?.name}. Add one under Payees before paying —
                    do not chase it in chat.
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {docs.filter(x => x.doc_kind !== 'payment_proof').map(doc => (
                  <Btn key={doc.id} onClick={() => openDoc(doc.id)}>📄 {doc.file_name || 'invoice'}</Btn>
                ))}
                <Btn onClick={() => router.push(`/payments/detail?id=${r.id}`)}>Open</Btn>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input style={{ ...inp, flex: 1, minWidth: 180 }}
                  placeholder="UTR / reference"
                  value={refs[r.id] || ''}
                  onChange={e => setRefs(p => ({ ...p, [r.id]: e.target.value }))} />
                <Btn kind="primary" disabled={busy === r.id} onClick={() => pay(r)}>
                  {busy === r.id ? 'Saving…' : 'Mark paid'}
                </Btn>
              </div>
            </div>
          </Panel>
        );
      })}
    </>
  );
}
