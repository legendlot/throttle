'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { supabase } from '@throttle/db';
import { Modal } from '../../../../../components/ui/Modal.js';
import { ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import { INVOICE_TYPES, INVOICE_ACCEPT, MAX_INVOICE_BYTES } from '../../../../../lib/invoiceFile.js';
import { istToday } from '../../../../../lib/istDate.js';

// Raise a Snorkel payment request (Reann #2 S4), or add the invoice to one that is waiting. The money
// rules (fee cap incl. the hand log, full vs advance/balance, balance only at Live) are the
// database's; this form only fills sensible defaults and shows the refusal sentence as it comes back.
const KIND_TITLE = { advance: 'Raise advance', balance: 'Raise balance', full: 'Raise full payment' };
const UPLOAD = '__upload__';
const ctl = { width: '100%', boxSizing: 'border-box', background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-ctl)', padding: '9px 12px', fontFamily: 'var(--font-ui)', fontSize: 14 };
const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6 };
const fileDay = d => (d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }) : '');

export function DealPaymentModal({ mode, kind, request, engagement, dp, session, onClose, onDone, onInvoiceAdded }) {
  const { showToast: toast } = useToast();
  const attach = mode === 'attach';
  const invoices = dp.invoices || [];
  // Full and balance default to what is left of the fee; an advance is a judgement, so it starts blank.
  const [amount, setAmount] = useState(attach ? String(request.amount) : kind === 'advance' ? '' : String(dp.remaining || ''));
  // A commission request with no invoice starts on Upload: invoices[0] is the fee invoice or an earlier
  // month's commission invoice, never this month's (Reann #3).
  const [pick, setPick] = useState(attach
    ? (request.invoice_id || (request.kind === 'commission' ? UPLOAD : invoices[0]?.id || UPLOAD))
    : (invoices[0]?.id || ''));
  const [file, setFile] = useState(null);
  const [invNo, setInvNo] = useState(attach ? (request.invoice_no || '') : '');
  const [invDate, setInvDate] = useState(attach ? (request.invoice_date || istToday()) : istToday());
  // Design 6: an advance is raised against the full-fee invoice, so the total defaults to the fee.
  // A commission request (Reann #3) is invoiced on its own, for its verified amount — not the fee.
  const [invTotal, setInvTotal] = useState(attach
    ? String(request.invoice_total ?? (request.kind === 'commission' ? request.amount : dp.agreed) ?? '')
    : String(dp.agreed || ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const withInvoice = pick !== '';
  const amt = Number(amount);
  const amountOk = amount !== '' && Number.isFinite(amt) && amt > 0;
  const invoiceOk = !withInvoice || ((pick !== UPLOAD || !!file) && invNo.trim() && Number(invTotal) > 0);
  const canSave = !busy && (attach ? withInvoice && invoiceOk : amountOk && invoiceOk);

  function chooseFile(f) {
    setError('');
    if (!f) { setFile(null); return; }
    if (!INVOICE_TYPES[f.type]) { setFile(null); setError('The invoice must be a PDF, JPG or PNG.'); return; }
    if (f.size > MAX_INVOICE_BYTES) { setFile(null); setError('That file is over 10 MB.'); return; }
    setFile(f);
  }

  // Upload → the browser PUTs to the private bucket → recorded on the deal. Returns the invoice id.
  async function uploadInvoice() {
    const { storage_path, token, bucket } = await ignitionopsPost('createDealInvoiceUploadUrl',
      { engagement_id: engagement.id, file_name: file.name, mime: file.type }, session);
    if (!token) throw new Error('Could not get an upload link for the invoice');
    const { error: upErr } = await supabase.storage.from(bucket).uploadToSignedUrl(storage_path, token, file);
    if (upErr) throw upErr;
    const r = await ignitionopsPost('uploadDealInvoice',
      { engagement_id: engagement.id, path: storage_path, file_name: file.name, mime: file.type }, session);
    if (!r?.invoice_id) throw new Error('The invoice uploaded but could not be found on the deal — pick it from the list.');
    return r.invoice_id;
  }

  async function save() {
    setBusy(true); setError('');
    try {
      let invoiceId = pick === UPLOAD ? null : pick;
      if (pick === UPLOAD) {
        invoiceId = await uploadInvoice();
        // Uploaded once: a refusal below must not upload it again on the next click.
        setPick(invoiceId); setFile(null); onInvoiceAdded?.();
      }
      const inv = invoiceId
        ? { invoice_id: invoiceId, invoice_no: invNo.trim(), invoice_date: invDate || null, invoice_total: Number(invTotal) }
        : {};
      const res = attach
        ? await ignitionopsPost('attachDealPaymentInvoice', { request_id: request.id, ...inv }, session)
        : await ignitionopsPost('raiseDealPayment', { engagement_id: engagement.id, kind, amount: amt, ...inv }, session);
      const st = res?.request?.state;
      if (res?.error) toast(res.error, 'error');
      else if (st === 'send_failed') toast(res.request.last_error || 'Send failed', 'error');
      else toast(st === 'waiting_for_invoice' ? 'Raised — waiting for the invoice' : 'Sent to Snorkel', 'success');
      onDone();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  // The just-uploaded invoice is not in `dp` until the card reloads; keep it selectable meanwhile.
  const pickKnown = pick === '' || pick === UPLOAD || invoices.some(i => i.id === pick);
  return (
    <Modal open title={attach ? 'Add the invoice' : KIND_TITLE[kind]} onClose={onClose} onConfirm={save}
      confirmLabel={attach || withInvoice ? 'Send to Snorkel' : 'Raise'} confirmDisabled={!canSave} loading={busy} error={error} dismissOnBackdrop={false}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!attach && (
          <div>
            <label style={lbl}>Amount to pay (₹)</label>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={ev => setAmount(ev.target.value)} style={ctl} autoFocus />
            <div style={{ fontSize: 12, color: 'var(--text-4)', marginTop: 4 }}>
              Agreed ₹{Number(dp.agreed || 0).toLocaleString('en-IN')} · left to raise ₹{Number(dp.remaining || 0).toLocaleString('en-IN')}
            </div>
          </div>
        )}
        {attach && <div style={{ fontSize: 14, color: 'var(--text-2)' }}>Amount ₹{Number(request.amount).toLocaleString('en-IN')}</div>}

        <div>
          <label style={lbl}>Creator invoice</label>
          <select value={pick} onChange={ev => { setPick(ev.target.value); setFile(null); setError(''); }} style={ctl}>
            {!attach && <option value="">No invoice yet — raise now, send when it arrives</option>}
            {invoices.map(i => <option key={i.id} value={i.id}>{i.file_name || 'invoice'}{i.uploaded_at ? ` · ${fileDay(i.uploaded_at)}` : ''}{i.contract_id ? '' : ' · uploaded by the team'}</option>)}
            {!pickKnown && <option value={pick}>Just uploaded</option>}
            <option value={UPLOAD}>Upload an invoice…</option>
          </select>
          {pick === UPLOAD && (
            <input type="file" accept={INVOICE_ACCEPT} onChange={ev => chooseFile(ev.target.files?.[0])} style={{ ...ctl, marginTop: 8, padding: '7px 10px' }} />
          )}
          {!withInvoice && (
            <div style={{ fontSize: 12, color: 'var(--text-4)', marginTop: 4 }}>Finance only sees the request once its invoice is added.</div>
          )}
        </div>

        {withInvoice && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: 10 }}>
            <div>
              <label style={lbl}>Invoice no</label>
              <input value={invNo} onChange={ev => setInvNo(ev.target.value)} maxLength={100} style={ctl} />
            </div>
            <div>
              <label style={lbl}>Invoice date</label>
              <input type="date" value={invDate} onChange={ev => setInvDate(ev.target.value)} style={{ ...ctl, colorScheme: 'dark' }} />
            </div>
            <div>
              <label style={lbl}>Invoice total (₹)</label>
              <input type="number" inputMode="decimal" min="0" step="0.01" value={invTotal} onChange={ev => setInvTotal(ev.target.value)} style={ctl} />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
