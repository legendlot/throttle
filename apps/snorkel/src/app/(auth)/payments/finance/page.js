'use client';
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast, Modal } from '@throttle/ui';
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
  // ⚠️ getFinanceQueue admits execute OR super_admin, but markPaymentPaid requires EXECUTE alone
  // (snorkelops:3932). So a super admin could open this queue and click a Mark-paid button that
  // was certain to 403. Paying is finance's — Mahesh and Priya (Afshaan, 2026-09-04) — so super
  // admins get the queue read-only rather than a button that lies.
  const [canExecute, setCanExecute] = useState(false);
  // Hold/release admits execute OR super_admin (the hold belongs to Finance, not to whoever
  // placed it), which is a WIDER gate than Mark paid — hence the second flag.
  const [canSuperAdmin, setCanSuperAdmin] = useState(false);
  // { row } while the hold reason is being typed; the reason is required by the worker.
  const [holdFor, setHoldFor] = useState(null);
  const [holdNote, setHoldNote] = useState('');
  const firstLoadDone = useRef(false);

  const load = useCallback(async () => {
    if (!userId) return;
    if (!firstLoadDone.current) setLoading(true);
    try {
      const s = await getValidSession();
      // ⚠️ These two have DIFFERENT gates: the queue needs execute||super_admin, but
      // getPaymentBootstrap needs `payment_request`, which comes from the ROLE, not the grant.
      // Grant `execute` to someone whose role lacks it (or who has no Snorkel role at all) and an
      // un-caught Promise.all would take the whole queue down over the button's permission.
      // Degrade to view-only instead — never lose the queue over a secondary read.
      const [data, boot] = await Promise.all([
        garageFetch('getFinanceQueue', {}, s),
        garageFetch('getPaymentBootstrap', {}, s).catch(() => null),
      ]);
      setCanExecute(!!boot?.can?.execute);
      setCanSuperAdmin(!!boot?.can?.super_admin);
      setD({ requests: data?.requests || [], banks: data?.banks || {}, documents: data?.documents || {} });
      // ⚠️ Sharpest case of the truncation class: the money total below is a SUM. A cut list
      // under-reports what finance actually owes, and a short total reads as authoritative.
      setTruncation(data?.truncated ? data : null);
    } catch (e) {
      showToast(e.message || 'Failed to load', 'error');
    } finally { firstLoadDone.current = true; setLoading(false); }
  }, [userId, showToast]);
  useEffect(() => { load(); }, [load]);

  // The queue now carries two states. `ready` is the pile finance works down; `held` is parked
  // and deliberately kept OUT of the value total, the urgent filter and the overdue count —
  // a held request is not money finance can pay today.
  const ready = useMemo(() => d.requests.filter(r => r.status !== 'held'), [d.requests]);
  const held  = useMemo(() => d.requests.filter(r => r.status === 'held'), [d.requests]);
  const rows = useMemo(
    () => (onlyUrgent ? ready.filter(r => r.is_urgent) : ready),
    [ready, onlyUrgent]);

  const total   = rows.reduce((a, r) => a + (Number(r.amount_to_pay) || 0), 0);
  const overdue = rows.filter(r => r.needed_by && r.needed_by < todayISO()).length;

  const canHold = canExecute || canSuperAdmin;

  async function hold() {
    const r = holdFor;
    const reason = holdNote.trim();
    if (!r || !reason) return;
    setBusy(r.id);
    try {
      const s = await getValidSession();
      const raw = await workerFetch('holdPaymentRequest', { data: { id: r.id, held_reason: reason } }, s);
      const res = raw?.data || raw;   // `{ ok, data }` wrapper — read the payload, not the wrapper
      showToast(res?.held ? `${r.request_no} on hold` : 'It had already moved — refreshing',
                res?.held ? 'success' : 'error');
      setHoldFor(null); setHoldNote('');
      await load();
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    } finally { setBusy(null); }
  }

  async function release(r) {
    setBusy(r.id);
    try {
      const s = await getValidSession();
      const raw = await workerFetch('releasePaymentRequest', { data: { id: r.id } }, s);
      const res = raw?.data || raw;
      showToast(res?.released ? `${r.request_no} released` : 'It had already moved — refreshing',
                res?.released ? 'success' : 'error');
      await load();
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    } finally { setBusy(null); }
  }

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
        sub="Approved and unpaid, most urgent first — held requests are parked below. Everything needed to pay is on the card — bank details included." />

      {truncation && (
        <div style={{
          margin: '0 0 14px', padding: '10px 14px', borderRadius: 8,
          background: 'var(--warn-bg, #fff7ed)', border: '1px solid var(--warn-br, #fdba74)',
          color: 'var(--warn-fg, #9a3412)', fontSize: 13, lineHeight: 1.5,
        }}>
          <strong>
            {truncation.total != null
              ? `Showing the first ${truncation.limit} of ${truncation.total} requests in the queue.`
              : `Showing the first ${truncation.limit} requests in the queue — there are more.`}
          </strong>{' '}
          The Value total below covers only these {truncation.fetched} — the real amount owed is higher.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        {/* Kpi animates a NUMBER — a "12 of 340" string renders 0 (the Value bug, same class). */}
        <Kpi label="To pay" value={rows.length}
             format={v => truncation?.total != null ? `${Math.round(v)} of ${truncation.total}`
                        : (truncation ? `${Math.round(v)}+` : Math.round(v).toLocaleString('en-IN'))} />
        <Kpi label={truncation ? 'Value (partial)' : 'Value'} value={total} format={v => money(v)} />
        {overdue > 0 && <Kpi label="Past needed-by" value={overdue} />}
        {held.length > 0 && <Kpi label="On hold" value={held.length} />}
      </div>

      <div style={{ marginBottom: 12 }}>
        <Btn kind={onlyUrgent ? 'primary' : 'ghost'} onClick={() => setOnlyUrgent(v => !v)}>
          {onlyUrgent ? 'Showing urgent only' : 'Show urgent only'}
        </Btn>
      </div>

      {rows.length === 0 ? (
        <Panel title="Finance Queue">
          <EmptyState icon="check-check" title="All clear"
            hint={held.length
              ? `Nothing is waiting to be paid — ${held.length} request(s) are on hold below.`
              : 'Nothing approved is waiting to be paid.'} />
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

              {canExecute ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input style={{ ...inp, flex: 1, minWidth: 180 }}
                    placeholder="UTR / reference"
                    value={refs[r.id] || ''}
                    onChange={e => setRefs(p => ({ ...p, [r.id]: e.target.value }))} />
                  <Btn kind="primary" disabled={busy === r.id} onClick={() => pay(r)}>
                    {busy === r.id ? 'Saving…' : 'Mark paid'}
                  </Btn>
                  {canHold && (
                    <Btn disabled={busy === r.id}
                      onClick={() => { setHoldFor(r); setHoldNote(''); }}>Hold</Btn>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--t2)' }}>
                    View only — payments are marked by finance.
                  </span>
                  {canHold && (
                    <Btn disabled={busy === r.id}
                      onClick={() => { setHoldFor(r); setHoldNote(''); }}>Hold</Btn>
                  )}
                </div>
              )}
            </div>
          </Panel>
        );
      })}

      {/* Parked, not closed: the requester still sees these as open, so finance must be able to
          see WHY and release them without leaving the queue. */}
      {held.length > 0 && (
        <Panel title={`On hold (${held.length})`}>
          <div style={{ padding: 16, display: 'grid', gap: 12 }}>
            {held.map(r => (
              <div key={r.id} style={{ display: 'grid', gap: 6, paddingBottom: 10,
                                       borderBottom: '1px solid var(--bd)' }}>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <b>{r.request_no}</b>
                  <span>{r.payee?.name || 'Unknown payee'}</span>
                  <span style={{ fontWeight: 700 }}>{money(r.amount_to_pay, r.currency)}</span>
                  <Badge tone="orange" label="On hold" />
                </div>
                <div style={{ fontSize: 12, color: 'var(--t2)' }}>
                  Held by {r.held_by_name || '—'} · {r.held_at ? fmtDateShort(r.held_at) : '—'}
                </div>
                <div style={{ fontSize: 13 }}>{r.held_reason}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Btn onClick={() => router.push(`/payments/detail?id=${r.id}`)}>Open</Btn>
                  {canHold && (
                    <Btn kind="primary" disabled={busy === r.id} onClick={() => release(r)}>
                      {busy === r.id ? 'Saving…' : 'Release'}
                    </Btn>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {holdFor && (
        <Modal open onClose={() => { if (busy !== holdFor.id) { setHoldFor(null); setHoldNote(''); } }}
               title={`Put ${holdFor.request_no} on hold`}>
          <div style={{ padding: 16, maxWidth: 460 }}>
            <p style={{ marginTop: 0, fontSize: 13, color: 'var(--t2)' }}>
              The requester sees this reason and the request stays open on their side.
            </p>
            <textarea value={holdNote} onChange={e => setHoldNote(e.target.value)} rows={3}
              style={{ ...inp, width: '100%' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Btn kind="primary" disabled={busy === holdFor.id || !holdNote.trim()} onClick={hold}>
                {busy === holdFor.id ? 'Saving…' : 'Put on hold'}
              </Btn>
              <Btn onClick={() => { setHoldFor(null); setHoldNote(''); }}>Cancel</Btn>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
