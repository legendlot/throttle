'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, getValidSession, supabase } from '@throttle/db';
import { Spinner, useToast, Modal } from '@throttle/ui';
import { PageHead, Panel, Badge, Btn } from '@/components/ui.js';
import { fmtDateShort } from '@/components/format.js';
import { STATUS_TONE, STATUS_LABEL, money } from '../PaymentList.js';
import InvoiceUpload from '@/components/InvoiceUpload.js';

export default function PaymentRequestDetail() {
  const sp = useSearchParams();
  const id = sp.get('id');
  const { userId } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [pay, setPay] = useState({ payment_ref: '', payment_mode: 'neft', paid_amount: '' });
  const [proof, setProof] = useState([]);
  const [can, setCan] = useState({});
  const firstLoadDone = useRef(false);

  const load = useCallback(async () => {
    if (!userId || !id) return;
    if (!firstLoadDone.current) setLoading(true);
    try {
      const s = await getValidSession();
      const [detail, boot] = await Promise.all([
        garageFetch('getPaymentRequest', { id }, s),
        garageFetch('getPaymentBootstrap', {}, s),
      ]);
      setD(detail);
      setCan(boot?.can || {});
      if (detail?.request?.amount_to_pay != null)
        setPay(p => ({ ...p, paid_amount: String(detail.request.amount_to_pay) }));
    } catch (e) {
      showToast(e.message || 'Failed to load', 'error');
    } finally { firstLoadDone.current = true; setLoading(false); }
  }, [userId, id, showToast]);
  useEffect(() => { load(); }, [load]);

  async function act(action, data, okMsg) {
    setBusy(true);
    try {
      const s = await getValidSession();
      await workerFetch(action, { data }, s);
      showToast(okMsg, 'success');
      await load();
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    } finally { setBusy(false); }
  }

  async function openDoc(docId) {
    try {
      const s = await getValidSession();
      const r = await garageFetch('getPaymentDocUrl', { doc_id: docId }, s);
      window.open(r.url, '_blank', 'noopener');
    } catch (e) { showToast(e.message || 'Could not open', 'error'); }
  }

  async function confirmPaid() {
    setBusy(true);
    try {
      const s = await getValidSession();
      await workerFetch('markPaymentPaid', { data: {
        ids: [Number(id)], payment_ref: pay.payment_ref || null,
        payment_mode: pay.payment_mode || null,
        paid_amount: pay.paid_amount === '' ? null : Number(pay.paid_amount),
      } }, s);
      // proof attaches to the request, which is what removes the "is it done?" round-trip
      for (const item of proof) {
        const upRaw = await workerFetch('createPaymentDocUploadUrl',
          { data: { request_id: Number(id), file_name: item.file.name, doc_kind: 'payment_proof' } }, s);
        const up = upRaw?.data || upRaw;   // snorkelops wraps replies as `{ ok, data }`
        if (!up?.token || !up?.storage_path) throw new Error(`Could not prepare the upload for ${item.file.name}`);
        // Fleet-standard upload (Supabase client + signed token). The raw PUT this replaced never
        // checked its result, so a failed proof upload still recorded a document row pointing at
        // nothing — Finance would have seen "proof attached" with no file behind it.
        const put = await supabase.storage.from(up.bucket || 'payment-docs')
          .uploadToSignedUrl(up.storage_path, up.token, item.file, { contentType: item.file.type || 'application/octet-stream' });
        if (put.error) throw new Error(`Upload failed for ${item.file.name}: ${put.error.message || 'storage rejected it'}`);
        await workerFetch('recordPaymentDocument', { data: {
          request_id: Number(id), storage_path: up.storage_path, file_name: item.file.name,
          mime: item.file.type, size_bytes: item.file.size, doc_kind: 'payment_proof',
        } }, s);
      }
      setPayOpen(false); setProof([]);
      showToast('Marked paid', 'success');
      await load();
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    } finally { setBusy(false); }
  }

  if (loading) return <Spinner />;
  if (!d?.request) return <PageHead title="Not found" sub="This request does not exist, or is not yours." />;

  const r = d.request;
  const alreadyRequested = (d.related || []).reduce((a, x) => a + (Number(x.amount_to_pay) || 0), 0);
  const Row = ({ k, v }) => (
    <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--bd)' }}>
      <div style={{ width: 150, color: 'var(--t2)', fontSize: 13, flexShrink: 0 }}>{k}</div>
      <div style={{ fontSize: 14 }}>{v ?? '—'}</div>
    </div>
  );

  return (
    <>
      <PageHead title={`${r.request_no} — ${r.purpose}`}
        sub={<>
          <Badge tone={STATUS_TONE[r.status]} label={STATUS_LABEL[r.status]} />{' '}
          {r.is_urgent && <Badge tone="red" label="Urgent" />}
        </>} />

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0,1fr)' }}>
        <Panel title="Request">
          <div style={{ padding: 16 }}>
            <Row k="Payee" v={<>{r.payee?.name} <span style={{ color: 'var(--t2)' }}>({r.payee?.payee_code})</span></>} />
            <Row k="Category" v={r.category_key?.replace(/_/g, ' ')} />
            {r.linked_po_number && <Row k="PO" v={r.linked_po_number} />}
            <Row k="Invoice" v={r.invoice_no ? `${r.invoice_no}${r.invoice_date ? ' · ' + fmtDateShort(r.invoice_date) : ''}` : null} />
            <Row k="Invoice total" v={r.invoice_total != null ? money(r.invoice_total, r.currency) : null} />
            <Row k="Amount to pay" v={<b>{money(r.amount_to_pay, r.currency)}</b>} />
            <Row k="Needed by" v={r.needed_by ? fmtDateShort(r.needed_by) : null} />
            {r.urgency_reason && <Row k="Why urgent" v={r.urgency_reason} />}
            <Row k="Raised by" v={`${r.requested_by_name || '—'} · ${fmtDateShort(r.requested_at)}`} />
            {r.status === 'approved' && r.auto_approved && (
              <Row k="Approval" v={<span style={{ color: 'var(--t2)' }}>
                Not required — below the ₹{Number(r.threshold_at_submit).toLocaleString('en-IN')} threshold in force when it was raised
              </span>} />
            )}
            {r.approved_by_name && <Row k="Approved by" v={`${r.approved_by_name} · ${fmtDateShort(r.approved_at)}`} />}
            {r.rejected_by_name && <Row k="Rejected" v={`${r.rejected_by_name} — ${r.rejection_note}`} />}
            {r.status === 'paid' && (
              <>
                <Row k="Paid" v={`${r.paid_by_name || '—'} · ${fmtDateShort(r.paid_at)}`} />
                <Row k="Reference / UTR" v={r.payment_ref} />
                <Row k="Paid amount" v={r.paid_amount != null ? money(r.paid_amount, r.currency) : null} />
              </>
            )}
          </div>
        </Panel>

        {d.related?.length > 0 && (
          <Panel title="Other requests on this invoice" count={d.related.length}>
            <div style={{ padding: 16, fontSize: 13 }}>
              <div style={{ marginBottom: 8, color: 'var(--t2)' }}>
                {money(alreadyRequested, r.currency)} already requested against invoice <b>{r.invoice_no}</b>.
                Normal for a part-payment or a re-bill — worth a look if it is neither.
              </div>
              {d.related.map(x => (
                <div key={x.request_no} style={{ padding: '4px 0' }}>
                  {x.request_no} · {money(x.amount_to_pay, r.currency)} · {x.requested_by_name || '—'} ·{' '}
                  <Badge tone={STATUS_TONE[x.status]} label={STATUS_LABEL[x.status]} />
                </div>
              ))}
            </div>
          </Panel>
        )}

        <Panel title="Documents" count={d.documents?.length || 0}>
          <div style={{ padding: 16, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {(d.documents || []).length === 0 && <span style={{ color: 'var(--t2)' }}>None attached.</span>}
            {(d.documents || []).map(doc => (
              <Btn key={doc.id} onClick={() => openDoc(doc.id)}>
                {doc.doc_kind === 'payment_proof' ? '🧾 ' : '📄 '}{doc.file_name || 'file'}
              </Btn>
            ))}
          </div>
        </Panel>

        {can.bank_view && d.banks?.length > 0 && (
          <Panel title="Bank details">
            <div style={{ padding: 16, fontSize: 14 }}>
              {d.banks.map(b => (
                <div key={b.id} style={{ marginBottom: 10 }}>
                  <div>{b.account_name}</div>
                  <div style={{ color: 'var(--t2)' }}>
                    {b.account_number} · {b.ifsc} · {b.bank_name} {b.branch ? `· ${b.branch}` : ''}
                  </div>
                  {b.upi_id && <div style={{ color: 'var(--t2)' }}>UPI: {b.upi_id}</div>}
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        {can.approve && r.status === 'pending_approval' && (
          <>
            <Btn kind="primary" disabled={busy}
              onClick={() => act('approvePaymentRequests', { ids: [Number(id)] }, 'Approved')}>Approve</Btn>
            <Btn disabled={busy} onClick={() => setRejectOpen(true)}>Reject</Btn>
          </>
        )}
        {can.execute && r.status === 'approved' && (
          <Btn kind="primary" disabled={busy} onClick={() => setPayOpen(true)}>Mark paid</Btn>
        )}
        {r.requested_by_user_id === userId && !['paid','cancelled','rejected'].includes(r.status) && (
          <Btn disabled={busy}
            onClick={() => act('cancelPaymentRequest', { id: Number(id) }, 'Cancelled')}>Cancel request</Btn>
        )}
        <Btn onClick={() => router.back()}>Back</Btn>
      </div>

      {rejectOpen && (
        <Modal onClose={() => setRejectOpen(false)} title="Reject request">
          <div style={{ padding: 16, maxWidth: 460 }}>
            <p style={{ marginTop: 0, fontSize: 13, color: 'var(--t2)' }}>
              The requester sees this reason, so make it actionable.
            </p>
            <textarea value={rejectNote} onChange={e => setRejectNote(e.target.value)} rows={3}
              style={{ width: '100%', padding: 10, fontSize: 15, borderRadius: 8,
                       border: '1px solid var(--bd)', background: 'var(--surface)', color: 'var(--t1)' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Btn kind="primary" disabled={busy || !rejectNote.trim()}
                onClick={async () => {
                  await act('rejectPaymentRequest', { id: Number(id), rejection_note: rejectNote }, 'Rejected');
                  setRejectOpen(false); setRejectNote('');
                }}>Reject</Btn>
              <Btn onClick={() => setRejectOpen(false)}>Cancel</Btn>
            </div>
          </div>
        </Modal>
      )}

      {payOpen && (
        <Modal onClose={() => setPayOpen(false)} title="Mark paid">
          <div style={{ padding: 16, maxWidth: 460 }}>
            <label style={{ fontSize: 12, color: 'var(--t2)' }}>Reference / UTR</label>
            <input value={pay.payment_ref} onChange={e => setPay(p => ({ ...p, payment_ref: e.target.value }))}
              style={{ width: '100%', padding: 10, fontSize: 16, borderRadius: 8, marginBottom: 12,
                       border: '1px solid var(--bd)', background: 'var(--surface)', color: 'var(--t1)' }} />
            <label style={{ fontSize: 12, color: 'var(--t2)' }}>Mode</label>
            <select value={pay.payment_mode} onChange={e => setPay(p => ({ ...p, payment_mode: e.target.value }))}
              style={{ width: '100%', padding: 10, fontSize: 16, borderRadius: 8, marginBottom: 12,
                       border: '1px solid var(--bd)', background: 'var(--surface)', color: 'var(--t1)' }}>
              {['neft','rtgs','imps','upi','card','auto_debit','cash','other'].map(m =>
                <option key={m} value={m}>{m.toUpperCase()}</option>)}
            </select>
            <label style={{ fontSize: 12, color: 'var(--t2)' }}>Amount paid</label>
            <input type="number" inputMode="decimal" value={pay.paid_amount}
              onChange={e => setPay(p => ({ ...p, paid_amount: e.target.value }))}
              style={{ width: '100%', padding: 10, fontSize: 16, borderRadius: 8, marginBottom: 12,
                       border: '1px solid var(--bd)', background: 'var(--surface)', color: 'var(--t1)' }} />
            <label style={{ fontSize: 12, color: 'var(--t2)' }}>Payment proof (optional)</label>
            <InvoiceUpload files={proof} onChange={setProof} disabled={busy} />
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <Btn kind="primary" disabled={busy} onClick={confirmPaid}>{busy ? 'Saving…' : 'Confirm paid'}</Btn>
              <Btn onClick={() => setPayOpen(false)} disabled={busy}>Cancel</Btn>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
