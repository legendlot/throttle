'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { getValidSession } from '@throttle/db';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Combobox, Modal } from '@throttle/ui';
import { PageHead, Panel, Btn, Badge } from '@/components/ui.js';
import InvoiceUpload from '@/components/InvoiceUpload.js';

const CURRENCIES = ['INR', 'USD', 'CNY', 'EUR', 'GBP', 'AED'];
const todayISO = () => {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);   // IST, never UTC
  return d.toISOString().slice(0, 10);
};

export default function NewPaymentRequestPage() {
  const { session, userId, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();

  const [boot, setBoot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState([]);
  const [payeeOpen, setPayeeOpen] = useState(false);
  const [dupWarn, setDupWarn] = useState(null);
  const firstLoadDone = useRef(false);

  const [f, setF] = useState({
    request_type: 'payment', category_key: '', payee_id: '', purpose: '',
    invoice_no: '', invoice_date: '', invoice_total: '', amount_to_pay: '',
    currency: 'INR', needed_by: todayISO(), is_urgent: false, urgency_reason: '',
    linked_po_number: '',
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  // Keyed on userId, never on `session` — a token refresh changes the session object roughly
  // hourly and would otherwise remount this form mid-typing (CORE.md useAuth note).
  const load = useCallback(async () => {
    if (!userId) return;
    if (!firstLoadDone.current) setLoading(true);
    try {
      const s = await getValidSession();
      const data = await garageFetch('getPaymentBootstrap', {}, s);
      setBoot(data);
      if (data?.settings?.default_currency) set('currency', data.settings.default_currency);
    } catch (e) {
      showToast(e.message || 'Failed to load', 'error');
    } finally { firstLoadDone.current = true; setLoading(false); }
  }, [userId, showToast]);
  useEffect(() => { load(); }, [load]);

  const cat = useMemo(
    () => (boot?.categories || []).find(c => c.category_key === f.category_key) || null,
    [boot, f.category_key]);
  const poRequired = !!cat?.po_required && f.request_type === 'payment';

  const threshold = Number(boot?.settings?.approval_threshold_inr) || 100000;
  const amt = Number(f.amount_to_pay || 0);
  // The threshold is an INR figure. A foreign amount cannot be compared against it without an FX
  // rate, so a non-INR request always goes for approval — and the form must SAY so. The first
  // version hid the banner for non-INR, which was exactly backwards: it made the silent
  // auto-approval look deliberate.
  const isInr = f.currency === 'INR';
  const willNeedApproval = f.request_type === 'payment' && (!isInr || amt >= threshold);

  const balance = useMemo(() => {
    const total = Number(f.invoice_total || 0), pay = Number(f.amount_to_pay || 0);
    if (!total || !pay || pay >= total) return null;
    return total - pay;
  }, [f.invoice_total, f.amount_to_pay]);

  async function submit() {
    if (!f.payee_id)     return showToast('Pick a payee', 'error');
    if (!f.category_key) return showToast('Pick a category', 'error');
    if (!f.purpose.trim()) return showToast('Say what this payment is for', 'error');
    if (f.request_type === 'payment' && !(Number(f.amount_to_pay) > 0))
      return showToast('Enter the amount to pay now', 'error');
    if (poRequired && !f.linked_po_number.trim())
      return showToast(`A PO is required for ${cat.label}`, 'error');
    if (!files.length) return showToast('Attach the invoice — a photo is fine', 'error');
    if (files.some(x => x.error)) return showToast('Remove the oversized file first', 'error');

    setSaving(true);
    try {
      const s = await getValidSession();
      const res = await workerFetch('createPaymentRequest', { data: {
        ...f,
        invoice_total: f.invoice_total === '' ? null : Number(f.invoice_total),
        amount_to_pay: f.amount_to_pay === '' ? null : Number(f.amount_to_pay),
        payee_id: Number(f.payee_id),
      } }, s);

      // Upload after the request exists so documents are keyed to it, never to a draft that
      // may never be submitted.
      for (const item of files) {
        const up = await workerFetch('createPaymentDocUploadUrl', { data: {
          request_id: res.id, file_name: item.file.name, doc_kind: 'invoice',
        } }, s);
        const put = await fetch(up.signed_url, {
          method: 'PUT',
          headers: { 'Content-Type': item.file.type || 'application/octet-stream' },
          body: item.file,
        });
        if (!put.ok) throw new Error(`Upload failed for ${item.file.name}`);
        await workerFetch('recordPaymentDocument', { data: {
          request_id: res.id, storage_path: up.storage_path, file_name: item.file.name,
          mime: item.file.type, size_bytes: item.file.size, doc_kind: 'invoice',
        } }, s);
      }

      // The request is ALWAYS raised — these are advisories shown after the fact, never blocks.
      if (res.duplicate_of?.length || res.po_warning || res.po_overdrawn) {
        setDupWarn({
          request_no: res.request_no, status: res.status,
          dupes: res.duplicate_of || [],
          po_warning: res.po_warning, po_overdrawn: res.po_overdrawn,
        });
      } else {
        showToast(
          res.needs_approval
            ? `${res.request_no} raised — sent for approval`
            : `${res.request_no} raised — with Finance`,
          'success');
        router.push('/payments');
      }
    } catch (e) {
      showToast(e.message || 'Could not raise the request', 'error');
    } finally { setSaving(false); }
  }

  if (loading) return <Spinner />;
  if (!boot?.can?.request) {
    return <PageHead title="Payment Requests" sub="You do not have access to raise payment requests." />;
  }

  const L = { display: 'block', fontSize: 12, color: 'var(--t2)', marginBottom: 4 };
  const I = { width: '100%', padding: '10px 12px', fontSize: 16, borderRadius: 8,
              border: '1px solid var(--bd)', background: 'var(--surface)', color: 'var(--t1)' };
  const row = { marginBottom: 16 };

  return (
    <>
      <PageHead title="New Payment Request"
        sub="Raise it here instead of posting in #payments — you'll be able to see its status without asking." />

      <Panel title="Request">
        <div style={{ padding: 16, maxWidth: 640 }}>

          <div style={row}>
            <label style={L}>Type</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[['payment','Payment'],['credit_note','Credit note'],['debit_note','Debit note']].map(([k, lbl]) => (
                <Btn key={k} kind={f.request_type === k ? 'primary' : 'ghost'}
                     onClick={() => set('request_type', k)}>{lbl}</Btn>
              ))}
            </div>
          </div>

          <div style={row}>
            <label style={L}>Payee *</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <Combobox
                  value={f.payee_id}
                  onChange={(v) => set('payee_id', v)}
                  options={(boot.payees || []).map(p => ({
                    value: String(p.id), label: p.name, hint: p.payee_code,
                    search: `${p.payee_code} ${p.payee_type} ${p.gstin || ''}`,
                  }))}
                  placeholder="Search payee…"
                  portal
                />
              </div>
              <Btn onClick={() => setPayeeOpen(true)}>+ New</Btn>
            </div>
          </div>

          <div style={row}>
            <label style={L}>Category *</label>
            <select style={I} value={f.category_key} onChange={e => set('category_key', e.target.value)}>
              <option value="">Select…</option>
              {(boot.categories || []).map(c => (
                <option key={c.category_key} value={c.category_key}>
                  {c.label}{c.po_required ? ' — PO required' : ''}
                </option>
              ))}
            </select>
          </div>

          {poRequired && (
            <div style={row}>
              <label style={L}>PO number *</label>
              <input style={I} value={f.linked_po_number} placeholder="e.g. IN-CMP-0379"
                     onChange={e => set('linked_po_number', e.target.value)} />
              {/* "How do i get one?" was the actual blocker in #payments — say where, don't just refuse. */}
              <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 6 }}>
                {cat.label} needs a PO. No PO yet? Raise one under <b>Procurement → Purchase Orders</b>,
                or ask the procurement team — then come back here.
              </div>
            </div>
          )}

          <div style={row}>
            <label style={L}>What is this for? *</label>
            <input style={I} value={f.purpose} maxLength={160}
                   placeholder="e.g. Acrylic sheets for Shadow tooling"
                   onChange={e => set('purpose', e.target.value)} />
          </div>

          <div style={row}>
            <label style={L}>Invoice</label>
            <InvoiceUpload files={files} onChange={setFiles} disabled={saving} />
          </div>

          <div style={{ ...row, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={L}>Invoice no.</label>
              <input style={I} value={f.invoice_no} onChange={e => set('invoice_no', e.target.value)} />
            </div>
            <div>
              <label style={L}>Invoice date</label>
              <input style={I} type="date" value={f.invoice_date} onChange={e => set('invoice_date', e.target.value)} />
            </div>
          </div>

          <div style={{ ...row, display: 'grid', gridTemplateColumns: '96px 1fr 1fr', gap: 12 }}>
            <div>
              <label style={L}>Currency</label>
              <select style={I} value={f.currency} onChange={e => set('currency', e.target.value)}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label style={L}>Invoice total</label>
              <input style={I} type="number" inputMode="decimal" value={f.invoice_total}
                     onChange={e => {
                       set('invoice_total', e.target.value);
                       if (!f.amount_to_pay) set('amount_to_pay', e.target.value);
                     }} />
            </div>
            <div>
              <label style={L}>{f.request_type === 'payment' ? 'Pay now *' : 'Amount'}</label>
              <input style={I} type="number" inputMode="decimal" value={f.amount_to_pay}
                     disabled={f.request_type !== 'payment'}
                     onChange={e => set('amount_to_pay', e.target.value)} />
            </div>
          </div>

          {balance != null && (
            <div style={{ ...row, fontSize: 13, color: 'var(--t2)', marginTop: -6 }}>
              Part-payment — <b>{f.currency} {balance.toLocaleString('en-IN')}</b> will remain on this invoice.
            </div>
          )}

          {willNeedApproval && (
            <div style={{ ...row, padding: '10px 12px', borderRadius: 8,
                          background: 'var(--accent-soft)', border: '1px solid var(--accent-bd)', fontSize: 13 }}>
              {isInr
                ? <>This is at or above the ₹{threshold.toLocaleString('en-IN')} approval threshold, so it
                   goes for approval before Finance sees it.</>
                : <>Payments in {f.currency} always go for approval — the ₹{threshold.toLocaleString('en-IN')}
                   threshold is a rupee figure and cannot be applied to another currency.</>}
            </div>
          )}

          <div style={{ ...row, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={L}>Needed by</label>
              <input style={I} type="date" value={f.needed_by} onChange={e => set('needed_by', e.target.value)} />
            </div>
            <div>
              <label style={L}>Urgent?</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 42 }}>
                <input type="checkbox" checked={f.is_urgent} style={{ width: 18, height: 18 }}
                       onChange={e => set('is_urgent', e.target.checked)} />
                <span style={{ fontSize: 13, color: 'var(--t2)' }}>Mark urgent</span>
              </div>
            </div>
          </div>

          {f.is_urgent && (
            <div style={row}>
              <label style={L}>Why is it urgent?</label>
              <input style={I} value={f.urgency_reason} placeholder="e.g. line stops Thursday without it"
                     onChange={e => set('urgency_reason', e.target.value)} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <Btn kind="primary" onClick={submit} disabled={saving}>
              {saving ? 'Raising…' : 'Raise request'}
            </Btn>
            <Btn onClick={() => router.push('/payments')} disabled={saving}>Cancel</Btn>
          </div>
        </div>
      </Panel>

      {payeeOpen && (
        <NewPayeeModal
          canEnterBank
          onClose={() => setPayeeOpen(false)}
          onCreated={async (created) => {
            setPayeeOpen(false);
            await load();
            set('payee_id', String(created.id));
            showToast(`${created.payee_code} added`, 'success');
          }}
        />
      )}

      {dupWarn && (
        <Modal onClose={() => { setDupWarn(null); router.push('/payments'); }} title="Raised — but check this">
          <div style={{ padding: 16, maxWidth: 520 }}>
            <p style={{ marginTop: 0 }}>
              <b>{dupWarn.request_no}</b> was raised. {dupWarn.dupes.length || dupWarn.po_overdrawn
                ? 'A couple of things are worth a look before it moves on:'
                : 'One thing is worth a look before it moves on:'}
            </p>

            {dupWarn.dupes.length > 0 && (
              <>
                <p style={{ fontSize: 13, marginBottom: 4 }}>
                  Another request already exists against this payee and invoice number:
                </p>
                <ul style={{ fontSize: 13, color: 'var(--t2)' }}>
                  {dupWarn.dupes.map(d => (
                    <li key={d.request_no}>
                      {d.request_no} — {d.amount_to_pay} by {d.requested_by_name || 'someone'}
                    </li>
                  ))}
                </ul>
                <p style={{ fontSize: 13, color: 'var(--t2)' }}>
                  That is fine for a genuine part-payment or re-bill. If it is a duplicate, cancel yours
                  from My Requests.
                </p>
              </>
            )}

            {dupWarn.po_warning && (
              <p style={{ fontSize: 13, color: 'var(--t2)' }}>{dupWarn.po_warning} Worth confirming
                it is the PO you meant — a Soft PO is not committed yet, and a Closed one is already
                settled.
              </p>
            )}

            {dupWarn.po_overdrawn && (
              <>
                <p style={{ fontSize: 13, marginBottom: 4 }}>
                  This takes the PO past its own value:
                </p>
                <ul style={{ fontSize: 13, color: 'var(--t2)' }}>
                  <li>{dupWarn.po_overdrawn.po_number} is worth {dupWarn.po_overdrawn.po_value.toLocaleString('en-IN')}</li>
                  <li>already requested: {dupWarn.po_overdrawn.already_requested.toLocaleString('en-IN')}
                    {dupWarn.po_overdrawn.prior_requests.length > 0
                      && ` (${dupWarn.po_overdrawn.prior_requests.join(', ')})`}</li>
                  <li>this request: {dupWarn.po_overdrawn.this_request.toLocaleString('en-IN')}</li>
                </ul>
                <p style={{ fontSize: 13, color: 'var(--t2)' }}>
                  Normal for an advance or a vendor over-bill. If it is not, check the PO before Finance pays it.
                </p>
              </>
            )}
            <Btn kind="primary" onClick={() => { setDupWarn(null); router.push('/payments'); }}>Got it</Btn>
          </div>
        </Modal>
      )}
    </>
  );
}

// A requester MAY enter bank details here (they already paste them into Slack). They can never
// read them back — the worker masks every read without payment_bank_view.
export function NewPayeeModal({ onClose, onCreated, canEnterBank }) {
  const { showToast } = useToast();
  const [saving, setSaving] = useState(false);
  const [d, setD] = useState({
    name: '', payee_type: 'vendor', gstin: '', email: '', phone: '',
    account_name: '', account_number: '', ifsc: '', bank_name: '', branch: '', upi_id: '',
  });
  const set = (k, v) => setD(p => ({ ...p, [k]: v }));
  const L = { display: 'block', fontSize: 12, color: 'var(--t2)', marginBottom: 4 };
  const I = { width: '100%', padding: '10px 12px', fontSize: 16, borderRadius: 8,
              border: '1px solid var(--bd)', background: 'var(--surface)', color: 'var(--t1)',
              marginBottom: 12 };

  async function save() {
    if (!d.name.trim()) return showToast('Name required', 'error');
    setSaving(true);
    try {
      const s = await getValidSession();
      const res = await workerFetch('createPaymentPayee', { data: d }, s);
      onCreated(res);
    } catch (e) {
      showToast(e.message || 'Could not add payee', 'error');
    } finally { setSaving(false); }
  }

  return (
    <Modal onClose={onClose} title="New payee">
      <div style={{ padding: 16, maxWidth: 520 }}>
        <label style={L}>Name *</label>
        <input style={I} value={d.name} onChange={e => set('name', e.target.value)}
               placeholder="Legal name on the invoice, e.g. SHIVAM ENTERPRISES" />
        {/* "who is shivam?" / "this is Lalji" — the legal name is what Finance pays. */}
        <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: -6, marginBottom: 12 }}>
          Use the name on the invoice, not the person you deal with.
        </div>

        <label style={L}>Type</label>
        <select style={I} value={d.payee_type} onChange={e => set('payee_type', e.target.value)}>
          {['vendor','influencer','ad_platform','service_provider','logistics','utility','event','govt','other']
            .map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>

        <label style={L}>GSTIN</label>
        <input style={I} value={d.gstin} onChange={e => set('gstin', e.target.value.toUpperCase())} />

        {canEnterBank && (
          <>
            <div style={{ fontSize: 13, fontWeight: 600, margin: '8px 0' }}>Bank details</div>
            <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 10 }}>
              Enter them once here and nobody has to paste them into a chat again. Only Finance can
              read them back.
            </div>
            <label style={L}>Account name</label>
            <input style={I} value={d.account_name} onChange={e => set('account_name', e.target.value)} />
            <label style={L}>Account number</label>
            <input style={I} value={d.account_number} onChange={e => set('account_number', e.target.value)} />
            <label style={L}>IFSC</label>
            <input style={I} value={d.ifsc} onChange={e => set('ifsc', e.target.value.toUpperCase())} />
            <label style={L}>Bank / branch</label>
            <input style={I} value={d.bank_name} onChange={e => set('bank_name', e.target.value)} />
            <label style={L}>UPI ID</label>
            <input style={I} value={d.upi_id} onChange={e => set('upi_id', e.target.value)} />
          </>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <Btn kind="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add payee'}</Btn>
          <Btn onClick={onClose} disabled={saving}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  );
}
