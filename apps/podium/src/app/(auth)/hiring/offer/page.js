'use client';
// Hiring C3 — one offer revision (?id=). Letter + annexure (salary viewers only), the actions its status
// and the caller's role allow, and its timeline. Download serves the STORED PDF (the issued record).
import { useCallback, useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, Download, Pencil, Send, Check, X, Mail, FileSignature, Ban, RefreshCw, Undo2 } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { fmtDate } from '../../../../lib/format.js';
import { Card, KV, F, Row, Note, Timeline, signedUpload, inp, backBtn, primaryBtn, ghostBtn, dangerBtn, muted } from '../../../../components/HiringBits.js';
import { LetterPreview, AnnexureTable, OfferStatusBadge, BandCheckBadge, Warnings } from '../../../../components/OfferBits.js';
import { OFFER_WITHDRAWABLE, hiringError, formatINR, formatBand, fmtDateTime, istTodayIso } from '../../../../lib/hiring.js';

function OfferInner() {
  const { session } = useAuth();
  const router = useRouter();
  const id = useSearchParams().get('id');
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState(null);   // 'send' | 'accept' | 'decline' | 'withdraw' | 'decide'
  const [form, setForm] = useState({});
  const [warn, setWarn] = useState(null);
  const setF = (k, v) => setForm(s => ({ ...s, [k]: v }));

  const load = useCallback(() => {
    if (!session || !id) return;
    podiumopsGet('getOffer', { id }, session).then(setData).catch(() => setData(false));
  }, [session, id]);
  useEffect(() => { load(); }, [load]);

  if (data === false) return <div style={{ color: 'var(--text-3)' }}>Not found, or you don't have access to this offer.</div>;
  if (!data) return <Spinner />;

  const o = data.offer || {};
  const can = data.can || {};
  const sal = !!can.see_salary;
  const st = o.status;

  async function run(fn, okMsg) {
    setBusy(true);
    try { const r = await fn(); if (okMsg) showToast(okMsg, 'success'); setPanel(null); setForm({}); load(); return r; }
    catch (e) { showToast(hiringError(e), 'error'); return null; }
    finally { setBusy(false); }
  }
  async function download() {
    try { const r = await podiumopsGet('getOfferPdfUrl', { id: o.id }, session); window.open(r.url, '_blank'); }
    catch (e) { showToast(hiringError(e, 'Could not open'), 'error'); }
  }
  const submit = () => run(async () => {
    const r = await podiumopsPost('submitOffer', { id: o.id }, session);
    showToast(r?.status === 'pending_approval' ? 'Sent for approval' : 'Offer issued — ready to send', 'success');
  });
  const decide = (decision) => run(() => podiumopsPost('decideOffer', { id: o.id, decision, note: form.note || null }, session)
    .then(r => { if (r?.render_error) showToast(`Approved — the PDF could not be issued yet (${hiringError({ message: r.render_error })}). The hiring owner can retry.`, 'error'); }),
    decision === 'approve' ? 'Approved' : 'Rejected');
  const markSent = () => run(async () => {
    let ev = {};
    if (form.file) {
      const m = await signedUpload('createOfferDocUploadUrl', { offer_id: o.id, kind: 'sent_evidence', file_size: form.file.size }, form.file, session);
      ev = { evidence_storage_path: m.storage_path, file_name: m.file_name, mime_type: m.mime_type, file_size: m.file_size };
    }
    const cc = String(form.sent_cc || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    return podiumopsPost('markOfferSent', { id: o.id, sent_to: form.sent_to, sent_cc: cc, sent_at: form.sent_at ? new Date(form.sent_at).toISOString() : null, ...ev }, session);
  }, 'Marked as sent');
  const accept = () => run(async () => {
    if (!form.file) throw new Error('Attach the signed copy (PDF)');
    const m = await signedUpload('createOfferDocUploadUrl', { offer_id: o.id, kind: 'signed', file_size: form.file.size }, form.file, session);
    const r = await podiumopsPost('recordOfferAcceptance', { id: o.id, accepted_at: form.accepted_at, signed_storage_path: m.storage_path,
      file_name: m.file_name, mime_type: m.mime_type, file_size: m.file_size }, session);
    if (r?.warnings?.length) setWarn(r.warnings);
  }, 'Acceptance recorded');
  const decline = () => run(() => podiumopsPost('recordOfferDecline', { id: o.id, note: form.note || null }, session), 'Decline recorded');
  const withdraw = () => run(() => {
    if (!String(form.reason || '').trim()) throw new Error('reason_required');
    return podiumopsPost('withdrawOffer', { id: o.id, reason: form.reason }, session);
  }, 'Offer withdrawn');

  const openPanel = (p) => {
    setPanel(p);
    if (p === 'send') setForm({ sent_to: data.candidate?.email || '', sent_cc: (data.default_cc || []).join(', ') });
    else if (p === 'accept') setForm({ accepted_at: istTodayIso() });
    else setForm({});
  };
  const revisable = can.manage && ['ready', 'sent', 'expired', 'declined', 'accepted', 'withdrawn', 'approval_rejected'].includes(st);

  return (
    <div style={{ maxWidth: 1200 }}>
      <button onClick={() => router.back()} style={backBtn}><ArrowLeft size={15} /> Back</button>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '10px 0 16px' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700 }}>
            {o.offer_ref} <span style={{ color: 'var(--text-3)', fontWeight: 500 }}>· r{o.revision}</span>
          </h1>
          <div style={{ color: 'var(--text-2)', fontSize: 13, cursor: 'pointer' }} onClick={() => data.candidate?.id && router.push(`/hiring/detail/?id=${data.candidate.id}`)}>
            {data.candidate?.full_name} <span style={muted}>{data.candidate?.candidate_code}</span> · {data.opening?.opening_code} {data.opening?.designation}
          </div>
        </div>
        <OfferStatusBadge status={st} />
        {sal && o.band_check && <BandCheckBadge check={o.band_check} />}
      </header>

      {warn && <Warnings list={warn} />}
      {data.template_error && <Note tone="bad">Template: {data.template_error}</Note>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {can.manage && ['draft', 'approval_rejected'].includes(st) && <>
          <button style={ghostBtn} onClick={() => router.push(`/hiring/offer/new/?id=${o.id}`)}><Pencil size={13} /> Edit</button>
          {st === 'draft' && <button style={primaryBtn} disabled={busy} onClick={submit}><Send size={13} /> Submit</button>}
        </>}
        {can.manage && st === 'approved' && <button style={primaryBtn} disabled={busy} onClick={submit}><RefreshCw size={13} /> Issue PDF</button>}
        {can.decide && <button style={primaryBtn} disabled={busy} onClick={() => openPanel('decide')}><Check size={13} /> Approve / reject</button>}
        {sal && o.pdf_path && <button style={ghostBtn} onClick={download}><Download size={13} /> Download PDF</button>}
        {can.manage && st === 'ready' && <button style={primaryBtn} onClick={() => openPanel('send')}><Mail size={13} /> Mark as sent</button>}
        {can.manage && ['sent', 'expired'].includes(st) && <>
          <button style={primaryBtn} onClick={() => openPanel('accept')}><FileSignature size={13} /> Record acceptance</button>
          <button style={ghostBtn} onClick={() => openPanel('decline')}><X size={13} /> Record decline</button>
        </>}
        {revisable && <button style={ghostBtn} onClick={() => router.push(`/hiring/offer/new/?application_id=${o.application_id}&from=${o.id}`)}><Undo2 size={13} /> Revise</button>}
        {can.manage && OFFER_WITHDRAWABLE.includes(st) && <button style={dangerBtn} onClick={() => openPanel('withdraw')}><Ban size={13} /> Withdraw</button>}
      </div>

      {panel && (
        <Card title={{ send: 'Mark as sent', accept: 'Record acceptance', decline: 'Record decline', withdraw: 'Withdraw offer', decide: 'Approve or reject' }[panel]} style={{ marginBottom: 14 }}>
          {panel === 'send' && <>
            <div style={{ ...muted, marginBottom: 8 }}>Send the downloaded PDF from your email, then record it here. Podium records the send; it does not email anyone.</div>
            <Row>
              <F label="Sent to *"><input style={inp} value={form.sent_to || ''} onChange={e => setF('sent_to', e.target.value)} /></F>
              <F label="Sent at (blank = now)"><input type="datetime-local" style={inp} value={form.sent_at || ''} onChange={e => setF('sent_at', e.target.value)} /></F>
            </Row>
            <F label="CC (HR, the opening's chain and Afshaan are prefilled)"><input style={inp} value={form.sent_cc || ''} onChange={e => setF('sent_cc', e.target.value)} /></F>
            <F label="Evidence (optional) — the email printed to PDF, or the exact PDF sent"><input type="file" accept=".pdf" onChange={e => setF('file', e.target.files?.[0] || null)} style={{ fontSize: 12 }} /></F>
            <button style={primaryBtn} disabled={busy} onClick={markSent}>{busy ? 'Saving…' : 'Mark as sent'}</button>
          </>}
          {panel === 'accept' && <>
            <Row>
              <F label="Accepted on *"><input type="date" style={inp} value={form.accepted_at || ''} max={istTodayIso()} onChange={e => setF('accepted_at', e.target.value)} /></F>
              <F label="Signed copy (PDF) *"><input type="file" accept=".pdf" onChange={e => setF('file', e.target.files?.[0] || null)} style={{ fontSize: 12 }} /></F>
            </Row>
            {o.valid_until && <div style={{ ...muted, marginBottom: 8 }}>Valid until {fmtDate(o.valid_until)} — a later acceptance needs a fresh revision.</div>}
            <button style={primaryBtn} disabled={busy} onClick={accept}>{busy ? 'Saving…' : 'Record acceptance'}</button>
          </>}
          {panel === 'decline' && <>
            <F label="Note (optional — only the salary chain sees it)"><input style={inp} value={form.note || ''} onChange={e => setF('note', e.target.value)} /></F>
            <div style={{ ...muted, marginBottom: 8 }}>The application stays at Offer — close it from the candidate page, or revise the offer.</div>
            <button style={dangerBtn} disabled={busy} onClick={decline}>Record decline</button>
          </>}
          {panel === 'withdraw' && <>
            <F label="Reason * (only the salary chain sees it)"><input style={inp} value={form.reason || ''} onChange={e => setF('reason', e.target.value)} /></F>
            <button style={dangerBtn} disabled={busy} onClick={withdraw}>Withdraw</button>
          </>}
          {panel === 'decide' && <>
            <F label="Note (optional)"><input style={inp} value={form.note || ''} onChange={e => setF('note', e.target.value)} /></F>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={primaryBtn} disabled={busy} onClick={() => decide('approve')}><Check size={13} /> Approve</button>
              <button style={dangerBtn} disabled={busy} onClick={() => decide('reject')}><X size={13} /> Reject</button>
            </div>
          </>}
          <div style={{ marginTop: 8 }}><button style={ghostBtn} onClick={() => setPanel(null)}>Cancel</button></div>
        </Card>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: sal ? 'minmax(280px, 360px) 1fr' : '1fr', gap: 14, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 14 }}>
          <Card title="Offer">
            <KV k="Designation" v={o.designation} />
            <KV k="Start (on or before)" v={fmtDate(o.start_date)} />
            {sal && <KV k={o.mode === 'stipend' ? 'Stipend / month' : 'Fixed / year'} v={formatINR(o.mode === 'stipend' ? o.stipend_monthly : o.fixed_annual)} />}
            {sal && o.mode !== 'stipend' && <KV k="Variable / year" v={formatINR(o.variable_annual)} />}
            {sal && <KV k="Total CTC" v={formatINR(o.total_ctc)} />}
            {sal && (o.joining_bonus > 0 || o.retention_bonus > 0) && <KV k="One-time bonuses" v={`${formatINR(o.joining_bonus)} joining · ${formatINR(o.retention_bonus)} retention`} />}
            {sal && data.band && <KV k="Band (pinned)" v={formatBand(data.band.band_min, data.band.band_max)} />}
            <KV k="Issued" v={o.issue_date ? fmtDate(o.issue_date) : '—'} />
            <KV k="Valid until" v={o.valid_until ? fmtDate(o.valid_until) : '—'} />
            <KV k="Sent" v={o.sent_at ? fmtDateTime(o.sent_at) : '—'} />
            <KV k="Accepted" v={o.accepted_at ? fmtDate(o.accepted_at) : '—'} />
            {sal && <KV k="Signed by" v={data.signatory?.display_name} />}
            {sal && <KV k="Template" v={data.template ? `${data.template.title} v${data.template.version}` : '—'} />}
            {sal && <KV k="Statutory rules" v={data.rule_set?.code} />}
            {sal && data.people?.approver && <KV k="Approver" v={data.people.approver} />}
            {sal && data.people?.decided_by && <KV k="Decided by" v={data.people.decided_by} />}
            {sal && o.decision_note && <div style={{ ...muted, marginTop: 6 }}>Decision note: {o.decision_note}</div>}
            {sal && o.outcome_note && <div style={{ ...muted, marginTop: 6 }}>Outcome note: {o.outcome_note}</div>}
            {sal && o.sent_to && <div style={{ ...muted, marginTop: 6 }}>Sent to {o.sent_to}{o.sent_cc?.length ? ` · cc ${o.sent_cc.join(', ')}` : ''}</div>}
            {sal && o.pdf_sha256 && <div style={{ ...muted, marginTop: 6, wordBreak: 'break-all', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>PDF SHA-256 {o.pdf_sha256}</div>}
            {!sal && <div style={{ ...muted, marginTop: 8 }}>Figures and the letter are visible to the opening's hiring owner, reporting manager, approver and the salary allow-list.</div>}
          </Card>
          <Card title="Timeline"><Timeline events={data.events} /></Card>
        </div>
        {sal && (
          <div style={{ display: 'grid', gap: 14 }}>
            {data.text && <LetterPreview view={data.text} />}
            {data.text?.annexure && <AnnexureTable annexure={data.text.annexure} />}
          </div>
        )}
      </div>
    </div>
  );
}

export default function OfferPage() {
  return <Suspense fallback={<Spinner />}><OfferInner /></Suspense>;
}
