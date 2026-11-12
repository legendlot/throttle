'use client';
// Podium O1 — the candidate's offer link (?t=<token>). PUBLIC: no login, no auth header; plain fetch to
// ${PD_URL}/public/offer*. Mobile-first. The worker decides everything (mode, name match, caps); this page
// only renders what it is told. Every API field it reads/sends is in the `api` helper + `V` reader below.
import { useCallback, useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@throttle/db';
import { PD_URL } from '../../lib/podiumopsFetch.js';
import { fmtDate } from '../../lib/format.js';
import { LetterPreview, AnnexureTable } from '../../components/OfferBits.js';
import { LINK_DOC_TYPES, declineReasons, bankView, joiningRows } from '../../lib/offerLink.js';

const DOC_BUCKET = 'podium-documents';
const MAX_BYTES = 10 * 1024 * 1024;
const GENERIC = 'Something went wrong. Please try again, or contact the Legend of Toys team.';

// ── the only place that talks to the worker ──
async function api(path, body, t) {
  const opts = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t, ...body }) };
  const url = body === undefined ? `${PD_URL}/public/offer?t=${encodeURIComponent(t)}` : `${PD_URL}/public/offer/${path}`;
  let res, j;
  try { res = await fetch(url, opts); j = await res.json(); } catch { throw Object.assign(new Error(GENERIC), { status: 0 }); }
  if (!res.ok || j.ok === false) throw Object.assign(new Error(j.message || (typeof j.error === 'string' && j.error.includes(' ') ? j.error : '') || GENERIC), { status: res.status, code: j.error });
  return j.data ?? j;
}
// view reader (mode-specific fields)
const V = (v) => ({
  mode: v.mode, notice: v.notice,
  first: v.candidate_first_name, designation: v.designation, department: v.department, location: v.location,
  start: v.start_date, until: v.valid_until, ref: v.offer_ref, rev: v.revision, owner: v.owner_first_name,
  annexure: v.annexure, letter: v.letter, pdf: v.pdf_url, reasons: declineReasons(v.decline_reasons),
  docs: joiningRows(v.docs), bank: bankView(v.bank), bankEditable: !!v.bank_editable, docsUntil: v.docs_open_until,
});

const ink = '#1a1a1a';
const box = { background: '#fff', border: '1px solid #e2e2dc', borderRadius: 10, padding: '16px 16px', marginBottom: 14, color: ink };
const field = { width: '100%', boxSizing: 'border-box', border: '1px solid #c9c9c2', borderRadius: 8, padding: '11px 12px', fontSize: 16, fontFamily: 'inherit', color: ink, background: '#fff' };
const lab = { display: 'block', fontSize: 13, color: '#555', margin: '12px 0 5px' };
const btn = { width: '100%', border: 'none', borderRadius: 8, padding: '14px 16px', fontSize: 15, fontWeight: 700, background: '#F2CD1A', color: '#1f1f1f', cursor: 'pointer', marginTop: 14 };
const btnGhost = { ...btn, background: '#fff', border: '1px solid #c9c9c2', fontWeight: 600, marginTop: 8 };
const chk = { display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14, lineHeight: 1.4, margin: '12px 0', cursor: 'pointer' };

function Shell({ children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, overflowY: 'auto', background: '#f3f3ee', fontFamily: "'Tomorrow', system-ui, -apple-system, sans-serif", WebkitOverflowScrolling: 'touch' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '20px 14px 48px' }}>
        <div style={{ background: '#1b1b1e', borderRadius: 10, padding: '12px 0', marginBottom: 18, textAlign: 'center' }}>
          <img src="/lot-logo.png" alt="Legend of Toys" style={{ height: 34, width: 'auto' }} />
        </div>
        {children}
      </div>
    </div>
  );
}

function Err({ msg }) { return msg ? <div role="alert" style={{ background: '#fdecec', color: '#8a1c1c', border: '1px solid #f3b8b8', borderRadius: 8, padding: '10px 12px', fontSize: 13.5, marginTop: 12 }}>{msg}</div> : null; }

function RespondMode({ v, t, setView }) {
  const [tab, setTab] = useState('accept');
  const [f, setF] = useState({ name: '', join: false, agree: false, reason: '', text: '', date: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sentQ, setSentQ] = useState(false);
  const set = (k, x) => setF(s => ({ ...s, [k]: x }));
  async function go(path, body, after) {
    setBusy(true); setErr('');
    try { const r = await api(path, body, t); if (after) after(r); else setView(r.mode ? r : await api('', undefined, t)); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const tabBtn = (id, label) => (
    <button key={id} onClick={() => { setTab(id); setErr(''); }} style={{ flex: 1, padding: '11px 4px', fontSize: 14, fontWeight: 700, border: 'none', borderBottom: `3px solid ${tab === id ? '#F2CD1A' : 'transparent'}`, background: 'transparent', color: ink, cursor: 'pointer' }}>{label}</button>
  );
  return (
    <>
      <div style={box}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Hi {v.first || 'there'},</div>
        <div style={{ fontSize: 14, color: '#444', marginTop: 6, lineHeight: 1.5 }}>We are delighted to offer you the role of <b>{v.designation}</b>{v.department ? ` in ${v.department}` : ''}{v.location ? `, ${v.location}` : ''}.</div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12, fontSize: 13 }}>
          <div><div style={{ color: '#777' }}>Start date</div><b>{fmtDate(v.start)}</b></div>
          <div><div style={{ color: '#777' }}>Valid until</div><b>{fmtDate(v.until)}</b></div>
          {v.ref && <div><div style={{ color: '#777' }}>Reference</div><b>{v.ref}{v.rev > 1 ? ` · r${v.rev}` : ''}</b></div>}
        </div>
        {v.pdf && <a href={v.pdf} target="_blank" rel="noreferrer" style={{ ...btnGhost, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box', color: ink }}>Open the offer letter (PDF)</a>}
      </div>
      {v.letter && <div style={{ marginBottom: 14 }}><LetterPreview view={v.letter} /></div>}
      {v.annexure && <div style={{ marginBottom: 14, overflowX: 'auto' }}><AnnexureTable annexure={v.annexure} /></div>}

      <div style={box}>
        <div style={{ display: 'flex', borderBottom: '1px solid #e2e2dc', margin: '-6px 0 8px' }}>
          {tabBtn('accept', 'Accept')}{tabBtn('decline', 'Decline')}{tabBtn('question', 'I have a question')}
        </div>
        {tab === 'accept' && <>
          <label style={lab} htmlFor="tn">Type your full name exactly as it appears on the offer</label>
          <input id="tn" style={field} autoComplete="name" value={f.name} onChange={e => set('name', e.target.value)} />
          <label style={chk}><input type="checkbox" checked={f.join} onChange={e => set('join', e.target.checked)} style={{ width: 20, height: 20, flex: 'none' }} /><span>I will join on {fmtDate(v.start)}</span></label>
          <label style={chk}><input type="checkbox" checked={f.agree} onChange={e => set('agree', e.target.checked)} style={{ width: 20, height: 20, flex: 'none' }} /><span>I have read and accept this offer</span></label>
          <button style={{ ...btn, opacity: f.name.trim() && f.join && f.agree ? 1 : 0.5 }} disabled={busy || !f.name.trim() || !f.join || !f.agree}
            onClick={() => go('accept', { typed_name: f.name.trim(), confirm_join: f.join, agree: f.agree })}>{busy ? 'Saving…' : 'Accept offer'}</button>
        </>}
        {tab === 'decline' && <>
          <label style={lab} htmlFor="dr">Reason</label>
          <select id="dr" style={field} value={f.reason} onChange={e => set('reason', e.target.value)}>
            <option value="">Select a reason</option>
            {v.reasons.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
          </select>
          <label style={lab} htmlFor="dt">Anything you would like to add (optional)</label>
          <textarea id="dt" rows={3} maxLength={2000} style={field} value={f.text} onChange={e => set('text', e.target.value)} />
          <button style={{ ...btn, opacity: f.reason ? 1 : 0.5 }} disabled={busy || !f.reason}
            onClick={() => { if (window.confirm('Decline this offer? This cannot be undone from this page.')) go('decline', { reason: f.reason, text: f.text.trim() || null }); }}>{busy ? 'Sending…' : 'Decline offer'}</button>
        </>}
        {tab === 'question' && (sentQ
          ? <div style={{ fontSize: 14, padding: '10px 0' }}>Thank you — your question has been sent. We will reply by email.</div>
          : <>
            <label style={lab} htmlFor="qt">Your question</label>
            <textarea id="qt" rows={4} maxLength={2000} style={field} value={f.text} onChange={e => set('text', e.target.value)} />
            <label style={lab} htmlFor="qd">A different joining date you would like to discuss (optional)</label>
            <input id="qd" type="date" style={field} value={f.date} onChange={e => set('date', e.target.value)} />
            <button style={{ ...btn, opacity: f.text.trim() ? 1 : 0.5 }} disabled={busy || !f.text.trim()}
              onClick={() => go('question', { text: f.text.trim(), proposed_join_date: f.date || null }, () => { setSentQ(true); set('text', ''); set('date', ''); })}>{busy ? 'Sending…' : 'Send question'}</button>
          </>)}
        <Err msg={err} />
      </div>
    </>
  );
}

// signed upload: mint → PUT to the private bucket → record.
async function uploadDoc(t, doc_type, file) {
  if (file.size > MAX_BYTES) throw new Error('That file is over 10 MB. Please choose a smaller one.');
  const mime = file.type || '';
  const m = await api('upload-url', { doc_type, file_name: file.name, mime }, t);
  if (m.token) {
    const { error } = await supabase.storage.from(DOC_BUCKET).uploadToSignedUrl(m.storage_path, m.token, file);
    if (error) throw new Error('The upload did not go through. Please try again.');
  } else if (/^https?:/.test(m.signed_url || m.upload_url || '')) {
    const r = await fetch(m.signed_url || m.upload_url, { method: 'PUT', headers: { 'Content-Type': mime }, body: file });
    if (!r.ok) throw new Error('The upload did not go through. Please try again.');
  } else throw new Error(GENERIC);
  return api('upload-done', { doc_type, storage_path: m.storage_path, file_name: file.name, mime, file_size: file.size }, t);
}

function DocumentsMode({ v, t, setView }) {
  const [busyDoc, setBusyDoc] = useState(null);
  const [err, setErr] = useState('');
  const [b, setB] = useState({ account_number: '', account_number_confirm: '', ifsc: '', account_name: '', bank_name: '' });
  const [bBusy, setBBusy] = useState(false);
  const [bErr, setBErr] = useState('');
  const [editing, setEditing] = useState(false);
  async function pick(doc_type, file) {
    if (!file) return;
    setBusyDoc(doc_type); setErr('');
    try { const r = await uploadDoc(t, doc_type, file); setView(r.mode ? r : await api('', undefined, t)); }
    catch (e) { setErr(e.message); } finally { setBusyDoc(null); }
  }
  async function saveBank() {
    setBBusy(true); setBErr('');
    try {
      const r = await api('bank', { ...b, ifsc: b.ifsc.trim().toUpperCase() }, t);
      setView(r.mode ? r : await api('', undefined, t)); setEditing(false);
      setB({ account_number: '', account_number_confirm: '', ifsc: '', account_name: '', bank_name: '' });
    } catch (e) { setBErr(e.message); } finally { setBBusy(false); }
  }
  const bk = v.bank;
  const showForm = !bk || (editing && v.bankEditable);
  const bf = (k, label, extra = {}) => <><label style={lab}>{label}</label><input style={field} value={b[k]} onChange={e => setB(s => ({ ...s, [k]: e.target.value }))} {...extra} /></>;
  return (
    <>
      <div style={{ ...box, borderColor: '#bfe3c6', background: '#f2faf3' }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Your acceptance is recorded</div>
        <div style={{ fontSize: 14, color: '#444', marginTop: 6, lineHeight: 1.5 }}>Thank you{v.first ? `, ${v.first}` : ''}. A confirmation is on its way to your email. Please share the documents below before you join{v.docsUntil ? ` (open until ${fmtDate(v.docsUntil)})` : ''}.</div>
      </div>
      <div style={box}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Joining documents</div>
        <div style={{ fontSize: 12.5, color: '#666', marginBottom: 6 }}>PDF, JPG or PNG, up to 10 MB each.</div>
        {v.docs.map(d => (
          <div key={d.doc_type} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderTop: '1px solid #eee' }}>
            <span style={{ width: 22, textAlign: 'center', color: d.uploaded ? '#1d8a3a' : '#bbb', fontWeight: 700, flex: 'none' }}>{d.uploaded ? '✓' : '○'}</span>
            <div style={{ flex: 1, minWidth: 0, fontSize: 14 }}>
              {d.label}{d.required && <span style={{ color: '#b42318' }}> *</span>}
              {d.uploaded && <div style={{ fontSize: 11.5, color: '#777' }}>{d.verified ? 'Verified' : 'Received'}{d.count > 1 ? ` · ${d.count} files` : ''}</div>}
            </div>
            <label style={{ flex: 'none', border: '1px solid #c9c9c2', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontWeight: 600, cursor: busyDoc ? 'default' : 'pointer', opacity: busyDoc && busyDoc !== d.doc_type ? 0.5 : 1 }}>
              {busyDoc === d.doc_type ? 'Uploading…' : (d.uploaded ? 'Add another' : 'Upload')}
              <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" disabled={!!busyDoc} style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; pick(d.doc_type, f); }} />
            </label>
          </div>
        ))}
        <Err msg={err} />
      </div>
      <div style={box}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Bank details for salary</div>
        {bk && !showForm && <>
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>
            {bk.name && <div>{bk.name}</div>}
            {bk.bank && <div>{bk.bank}</div>}
            <div style={{ fontFamily: 'monospace' }}>{bk.account}{bk.ifsc ? ` · ${bk.ifsc}` : ''}</div>
          </div>
          {v.bankEditable
            ? <button style={btnGhost} onClick={() => setEditing(true)}>Change my bank details</button>
            : <div style={{ fontSize: 12.5, color: '#666', marginTop: 8 }}>Your bank details are with us. To change them, ask the Legend of Toys team to reopen this.</div>}
        </>}
        {showForm && <>
          {bf('account_name', 'Name as on the account', { autoComplete: 'off' })}
          {bf('bank_name', 'Bank name')}
          {bf('account_number', 'Account number', { inputMode: 'numeric', autoComplete: 'off' })}
          {bf('account_number_confirm', 'Confirm account number', { inputMode: 'numeric', autoComplete: 'off' })}
          {bf('ifsc', 'IFSC', { autoCapitalize: 'characters', autoComplete: 'off' })}
          <button style={btn} disabled={bBusy} onClick={saveBank}>{bBusy ? 'Saving…' : 'Save bank details'}</button>
          {editing && <button style={btnGhost} onClick={() => setEditing(false)}>Cancel</button>}
          <Err msg={bErr} />
        </>}
      </div>
    </>
  );
}

function OfferInner() {
  const t = useSearchParams().get('t') || '';
  const [view, setView] = useState(null);
  const [fatal, setFatal] = useState('');
  const load = useCallback(() => {
    if (!t) { setFatal('This link is no longer valid.'); return; }
    api('', undefined, t).then(setView).catch(e => setFatal(e.status === 404 ? 'This link is no longer valid.' : e.message));
  }, [t]);
  useEffect(() => { load(); }, [load]);

  if (fatal) return <Shell><div style={{ ...box, fontSize: 15, textAlign: 'center' }}>{fatal}</div></Shell>;
  if (!view) return <Shell><div style={{ textAlign: 'center', color: '#777', padding: 40 }}>Loading…</div></Shell>;
  const v = V(view);
  return (
    <Shell>
      {v.mode === 'notice' && <div style={{ ...box, fontSize: 15, textAlign: 'center', lineHeight: 1.5 }}>{v.notice}</div>}
      {v.mode === 'respond' && <RespondMode v={v} t={t} setView={setView} />}
      {v.mode === 'documents' && <DocumentsMode v={v} t={t} setView={setView} />}
    </Shell>
  );
}

export default function PublicOfferPage() {
  return <Suspense fallback={null}><OfferInner /></Suspense>;
}
