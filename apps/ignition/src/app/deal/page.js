'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@throttle/db';
import { contractPublic } from '../../lib/ignitionopsFetch.js';

// The creator's accept link. Outside (auth) on purpose: the only auth guard is RequireAuth in
// (auth)/layout.js, and AuthProvider in the root layout redirects nobody (no session, no redirect).
// The page keeps no state of its own that matters: every step is derived from the worker's answer,
// so coming back later lands where they stopped.
//
// The app is dark and html/body are overflow:hidden, so this wrapper re-points the Pit Control tokens
// at a light palette and owns its own scrolling.
const LIGHT = {
  '--bg': '#f5f6f8', '--surface': '#ffffff', '--input': '#ffffff',
  '--text-1': '#14171f', '--text-2': '#3c4252', '--text-3': '#5b6272', '--text-4': '#7a8191',
  '--border-2': '#d9dce3', '--border-3': '#c4c8d2', '--row-divider': '#e8eaef',
  '--state-error-fg': '#b3261e', '--state-success-fg': '#1b7f3b',
  colorScheme: 'light', background: 'var(--bg)', color: 'var(--text-1)',
  height: '100dvh', overflowY: 'auto', fontFamily: 'var(--font-ui)', fontSize: 16, lineHeight: 1.55,
};
const card = { background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 14, padding: 18, marginBottom: 14 };
const h2 = { margin: '0 0 8px', fontSize: 18, fontWeight: 700 };
const quiet = { margin: 0, fontSize: 14, color: 'var(--text-3)' };
const btn = (off) => ({
  width: '100%', minHeight: 48, padding: '0 16px', background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none',
  borderRadius: 10, fontFamily: 'var(--font-ui)', fontSize: 16, fontWeight: 700,
  cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.5 : 1,
});
const input = {
  width: '100%', boxSizing: 'border-box', minHeight: 46, padding: '0 12px', background: 'var(--input)', color: 'var(--text-1)',
  border: '1px solid var(--border-3)', borderRadius: 10, fontFamily: 'var(--font-ui)', fontSize: 16,
};
const INVOICE_TYPES = { 'application/pdf': 1, 'image/jpeg': 1, 'image/png': 1 };
const MAX_BYTES = 10 * 1024 * 1024;

export default function DealContractPage() {
  return (
    <div style={LIGHT}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '24px 16px 48px' }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16 }}>Legend of Toys</div>
        <Suspense fallback={<p style={quiet}>Loading…</p>}><Body /></Suspense>
      </div>
    </div>
  );
}

function Body() {
  const t = useSearchParams().get('t') || '';
  const [data, setData] = useState(null);
  const [fatal, setFatal] = useState('');

  useEffect(() => {
    if (!t) { setFatal('This link is no longer valid.'); return; }
    contractPublic('', t).then(setData).catch(e => setFatal(e.message));
  }, [t]);

  if (fatal) return <div style={card}><p style={{ margin: 0 }}>{fatal}</p></div>;
  if (!data) return <p style={quiet}>Loading…</p>;
  if (data.closed) {
    return <div style={card}><p style={{ margin: 0 }}>This collaboration is closed. If you have a question, please reply to our email.</p></div>;
  }

  const accepted = data.status === 'accepted';
  const bankDone = data.bank?.received && !data.bank_editable;
  const allDone = accepted && (!data.needs_payment || (data.bank?.received && (data.invoices || []).length > 0));
  return (
    <>
      {allDone && (
        <div style={card}>
          <h2 style={h2}>All done, thank you</h2>
          <p style={quiet}>We have everything we need. If something changes, just reply to our email.</p>
        </div>
      )}
      {!accepted && <AcceptStep t={t} data={data} onDone={setData} />}
      {accepted && <ContractText data={data} accepted />}
      {accepted && data.needs_payment && !bankDone && <BankStep t={t} data={data} onDone={setData} />}
      {accepted && data.needs_payment && bankDone && (
        <div style={card}>
          <h2 style={h2}>Bank details</h2>
          <p style={{ margin: 0 }}>Received, account ending {data.bank.account_last4}.</p>
          <p style={{ ...quiet, marginTop: 6 }}>To change them, ask the Legend of Toys team to reopen this.</p>
        </div>
      )}
      {accepted && data.needs_payment && <InvoiceStep t={t} data={data} onDone={setData} />}
    </>
  );
}

function ContractText({ data, accepted }) {
  return (
    <div style={card}>
      <h2 style={h2}>{data.subject}</h2>
      {accepted && <p style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 600, color: 'var(--state-success-fg)' }}>You have accepted this.</p>}
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 15 }}>{data.body}</div>
    </div>
  );
}

function AcceptStep({ t, data, onDone }) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function accept() {
    setBusy(true); setError('');
    try { onDone(await contractPublic('accept', t, {})); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return (
    <>
      <ContractText data={data} />
      <div style={card}>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 14 }}>
          <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ width: 20, height: 20, marginTop: 2, flexShrink: 0 }} />
          <span>I have read and agree</span>
        </label>
        {error && <p role="alert" style={{ margin: '0 0 10px', fontSize: 14, color: 'var(--state-error-fg)' }}>{error}</p>}
        <button type="button" onClick={accept} disabled={!agreed || busy} style={btn(!agreed || busy)}>{busy ? 'Saving…' : 'I accept'}</button>
      </div>
    </>
  );
}

function Field({ label, hint, error, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span style={{ display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{label}</span>
      {children}
      {hint && !error && <span style={{ display: 'block', fontSize: 13, color: 'var(--text-3)', marginTop: 3 }}>{hint}</span>}
      {error && <span role="alert" style={{ display: 'block', fontSize: 13, color: 'var(--state-error-fg)', marginTop: 3 }}>{error}</span>}
    </label>
  );
}

function BankStep({ t, data, onDone }) {
  const [f, setF] = useState({ account_name: '', account_number: '', account_number_confirm: '', ifsc: '', bank_name: '', pan: '', upi_id: '', gstin: '' });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bind = (k) => ({
    value: f[k], style: input,
    onChange: (e) => { const v = e.target.value; setF(x => ({ ...x, [k]: v })); setErrors(x => ({ ...x, [k]: undefined })); },
  });
  async function save(ev) {
    ev.preventDefault();
    setBusy(true); setError(''); setErrors({});
    try { onDone(await contractPublic('bank', t, f)); }
    catch (e) { setError(e.message); setErrors(e.fieldErrors || {}); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={save} style={card} autoComplete="off">
      <h2 style={h2}>Your bank details</h2>
      <p style={{ ...quiet, marginBottom: 14 }}>
        {data.bank?.received ? `We have an account ending ${data.bank.account_last4}. Enter the new details to replace it.` : 'So we can pay you.'}
      </p>
      <Field label="Name on the account" error={errors.account_name}><input {...bind('account_name')} /></Field>
      <Field label="Account number" error={errors.account_number}><input {...bind('account_number')} inputMode="numeric" /></Field>
      <Field label="Account number, again" error={errors.account_number_confirm}><input {...bind('account_number_confirm')} inputMode="numeric" onPaste={e => e.preventDefault()} /></Field>
      <Field label="IFSC" error={errors.ifsc}><input {...bind('ifsc')} autoCapitalize="characters" /></Field>
      <Field label="Bank name (optional)" error={errors.bank_name}><input {...bind('bank_name')} /></Field>
      <Field label="PAN" error={errors.pan}><input {...bind('pan')} autoCapitalize="characters" /></Field>
      <Field label="UPI ID (optional)" error={errors.upi_id}><input {...bind('upi_id')} autoCapitalize="none" /></Field>
      <Field label="GSTIN (optional)" error={errors.gstin}><input {...bind('gstin')} autoCapitalize="characters" /></Field>
      {error && <p role="alert" style={{ margin: '0 0 10px', fontSize: 14, color: 'var(--state-error-fg)' }}>{error}</p>}
      <button type="submit" disabled={busy} style={btn(busy)}>{busy ? 'Saving…' : 'Save bank details'}</button>
    </form>
  );
}

function InvoiceStep({ t, data, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function upload(file) {
    if (!file) return;
    if (!INVOICE_TYPES[file.type]) { setError('Please upload a PDF, JPG or PNG.'); return; }
    if (file.size > MAX_BYTES) { setError('That file is over 10 MB.'); return; }
    setBusy(true); setError('');
    try {
      const { storage_path, token, bucket } = await contractPublic('invoice-url', t, { file_name: file.name, mime: file.type });
      if (!token) throw new Error('Could not start the upload. Please try again.');
      const { error: upErr } = await supabase.storage.from(bucket).uploadToSignedUrl(storage_path, token, file);
      if (upErr) throw upErr;
      // Recorded only after the file is really in the bucket.
      onDone(await contractPublic('invoice-done', t, { path: storage_path, file_name: file.name, mime: file.type }));
    } catch (e) { setError(e.message || 'The upload failed. Please try again.'); }
    finally { setBusy(false); }
  }
  const invoices = data.invoices || [];
  return (
    <div style={card}>
      <h2 style={h2}>Your invoice</h2>
      {invoices.length > 0 && (
        <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 15 }}>
          {invoices.map((i, n) => <li key={n} style={{ overflowWrap: 'anywhere' }}>{i.file_name}</li>)}
        </ul>
      )}
      <p style={{ ...quiet, marginBottom: 10 }}>PDF, JPG or PNG, up to 10 MB.</p>
      {error && <p role="alert" style={{ margin: '0 0 10px', fontSize: 14, color: 'var(--state-error-fg)' }}>{error}</p>}
      <label style={{ ...btn(busy), display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>
        {busy ? 'Uploading…' : invoices.length ? 'Upload another' : 'Upload invoice'}
        <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" disabled={busy} style={{ display: 'none' }}
          onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} />
      </label>
    </div>
  );
}
