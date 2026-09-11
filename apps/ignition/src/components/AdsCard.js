'use client';
import { useEffect, useState } from 'react';
import { Modal, useToast } from '@throttle/ui';
import { supabase } from '@throttle/db';
import { ignitionopsGet, ignitionopsPost } from '../lib/ignitionopsFetch.js';

const PROOF_BUCKET = 'ignition-payment-proofs';

// Ads on a deal (S373, Reann #bugs 2026-09-04 items 1·2·3·4·6).
//
// One row per ad, each boosting ONE take of the deal's video. Two axes, kept apart on purpose:
//   Approval — LOT's go-ahead. Only `ignition_approve` holders see the buttons (same people as the
//              deal's Approve), and Approve stays greyed until the take has been up 10 days (IST).
//              The worker enforces both; this card only mirrors them.
//   Run      — what the ad is doing. Hand-set "running" needs approval; the Meta sync reports
//              reality, so an unapproved ad Meta says is running gets a RED flag, not a block.
// Money here — ad payments (to the creator, for ad rights / usage) and Meta spend — is OUTSIDE the
// influencer budget: never in the deal's total cost, CPM, the monthly budget or the Payments page.
// NOT under the COMPLETE-deal lock: ads run after the video posts, which is when a deal completes.
//
// Every value sent to a CHECK column comes from these lists (the live CHECKs, 2026-09-11).
const PLATFORMS = [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['both', 'Instagram + Facebook']];
const RUN_STATUSES = [['not_started', 'Not started'], ['running', 'Running'], ['ended', 'Ended']];
const APPROVAL_LABEL = { pending: 'Pending approval', approved: 'Approved', rejected: 'Rejected' };
const APPROVAL_COLOUR = { pending: 'var(--text-3)', approved: '#27c93f', rejected: 'var(--state-error-fg)' };
const STALE_SYNC_MS = 36 * 3600 * 1000;   // daily cron + slack; older than this means it stopped

const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const istStamp = (ts) => new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
const takeLabel = (v) => v ? `Take #${v.seq} · ${v.post_date ? `posted ${v.post_date}` : 'not posted yet'}` : 'No take linked';

export default function AdsCard({ engagement, videos, ads, adPayments, canManage, canApprove, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(null);        // ad id, or 'new'
  const [busy, setBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);         // { kind: 'ok'|'error', text }
  const [payModal, setPayModal] = useState(null);       // null | { mode: 'new' } | { mode: 'paid', payment }
  const takes = [...(videos || [])].sort((a, b) => Number(a.seq) - Number(b.seq));
  const takeById = Object.fromEntries(takes.map(v => [v.id, v]));

  const list = ads || [];
  const pays = adPayments || [];
  const payPending = pays.filter(p => p.status !== 'paid').reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const payPaid = pays.filter(p => p.status === 'paid').reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const metaSpend = list.reduce((s, a) => s + (Number(a.meta_spend) || 0), 0);
  const hasMeta = list.some(a => a.meta_ad_id);

  async function decide(ad, decision) {
    let note;
    if (decision === 'rejected') {
      note = window.prompt('Reject this ad. Why? (optional)', '');
      if (note === null) return;
    }
    setBusy(true);
    try {
      await ignitionopsPost('decideEngagementAd', { id: ad.id, decision, note: note || undefined }, session);
      toast(decision === 'approved' ? 'Ad approved' : decision === 'rejected' ? 'Ad rejected' : 'Ad set back to pending', 'success');
      onSaved?.();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function remove(ad) {
    if (!window.confirm('Delete this ad? Any ad payment linked to it stays, unlinked.')) return;
    setBusy(true);
    try {
      const r = await ignitionopsPost('deleteEngagementAd', { id: ad.id }, session);
      toast(r?.warning || 'Ad deleted', r?.warning ? 'error' : 'success');
      onSaved?.();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function refreshMeta() {
    setBusy(true); setSyncMsg(null);
    try {
      const r = await ignitionopsPost('syncEngagementAds', { engagement_id: engagement.id }, session);
      const failed = r?.failed || [];
      setSyncMsg(failed.length
        ? { kind: 'error', text: `Refreshed ${r.updated} of ${r.scanned}. Failed: ${failed.map(f => `${f.meta_ad_id || 'deal'} — ${f.error}`).join('; ')}` }
        : { kind: 'ok', text: `Refreshed ${r?.updated ?? 0} ad${r?.updated === 1 ? '' : 's'} from Meta.` });
      onSaved?.();
    } catch (e) {
      // Said ON the card, not only in a toast that vanishes — a Meta outage must be visible here.
      setSyncMsg({ kind: 'error', text: `Meta refresh failed: ${e.message}` });
    } finally { setBusy(false); }
  }

  async function viewProof(id) {
    try {
      const r = await ignitionopsGet('getAdPaymentProofUrl', { id }, session);
      if (r?.url) window.open(r.url, '_blank', 'noopener');
      else toast('No screenshot on this payment', 'error');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function removePayment(p) {
    if (!window.confirm(`Delete this ${inr(p.amount)} ad payment?`)) return;
    setBusy(true);
    try {
      await ignitionopsPost('deleteAdPayment', { id: p.id }, session);
      toast('Ad payment deleted', 'success');
      onSaved?.();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function backToPending(p) {
    setBusy(true);
    try {
      await ignitionopsPost('updateAdPayment', { id: p.id, status: 'pending' }, session);
      toast('Marked pending', 'success');
      onSaved?.();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  const adLabel = (id) => {
    const a = list.find(x => x.id === id);
    if (!a) return null;
    const v = takeById[a.video_id];
    return `${(PLATFORMS.find(p => p[0] === a.platform) || [, a.platform])[1]}${v ? ` · take #${v.seq}` : ''}`;
  };

  return (
    <section style={{ gridColumn: '1 / -1', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Ads</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {canManage && hasMeta && (
            <button onClick={refreshMeta} disabled={busy} style={btn}>{busy ? 'Working…' : 'Refresh from Meta'}</button>
          )}
          {canManage && editing !== 'new' && (
            <button onClick={() => setEditing('new')} disabled={busy} style={btn}>+ Add ad</button>
          )}
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
        <strong style={{ color: 'var(--text-2)' }}>Ad total {inr(payPending + payPaid + metaSpend)}</strong>
        {' '}= ad payments {inr(payPending + payPaid)} + Meta spend {inr(metaSpend)} — outside the influencer budget, not in this deal&apos;s total cost.
        {Number(engagement?.ad_rights_amount) > 0 && (
          <> Agreed ad-rights fee (Deal Terms) {inr(Number(engagement.ad_rights_amount))} — paid {inr(payPaid)} so far.</>
        )}
      </div>

      {syncMsg && (
        <div style={{ marginBottom: 10, padding: '8px 10px', fontSize: 12, borderRadius: 'var(--radius-sm)', lineHeight: 1.5,
          background: syncMsg.kind === 'error' ? 'var(--state-error-bg)' : 'var(--surface-2)',
          border: `1px solid ${syncMsg.kind === 'error' ? 'var(--state-error-fg)' : 'var(--border)'}`, color: 'var(--text-1)' }}>
          {syncMsg.text}
        </div>
      )}

      {ads === null ? (
        <div style={{ color: 'var(--state-error-fg)', fontSize: 13 }}>Could not load this deal&apos;s ads — reload the page.</div>
      ) : list.length === 0 && editing !== 'new' ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No ads on this deal.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map(ad => editing === ad.id ? (
            <AdForm key={ad.id} ad={ad} takes={takes} session={session} busy={busy} setBusy={setBusy}
              onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onSaved?.(); }} />
          ) : (
            <AdRow key={ad.id} ad={ad} take={takeById[ad.video_id]} canManage={canManage} canApprove={canApprove} busy={busy}
              onEdit={() => setEditing(ad.id)} onDelete={() => remove(ad)} onDecide={(d) => decide(ad, d)} />
          ))}
          {editing === 'new' && (
            <AdForm ad={{ engagement_id: engagement.id, platform: 'instagram', run_status: 'not_started', approval_status: 'pending' }}
              takes={takes} session={session} busy={busy} setBusy={setBusy}
              onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onSaved?.(); }} />
          )}
        </div>
      )}

      {/* Ad payments — modelled on the deal's Payments card, but a separate table and total. */}
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Ad payments</div>
          {canManage && <button onClick={() => setPayModal({ mode: 'new' })} disabled={busy} style={btn}>+ Record</button>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>
          Pending <strong>{inr(payPending)}</strong> · Paid <strong style={{ color: '#27c93f' }}>{inr(payPaid)}</strong>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>Outside the influencer budget</div>
        {adPayments === null ? (
          <div style={{ color: 'var(--state-error-fg)', fontSize: 13 }}>Could not load ad payments — reload the page.</div>
        ) : pays.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Nothing recorded yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pays.map(p => (
              <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{inr(p.amount)}</span>
                <span style={{ fontSize: 11, textTransform: 'uppercase', color: p.status === 'paid' ? '#27c93f' : '#F2CD1A' }}>{p.status === 'paid' ? 'Paid' : 'Pending'}</span>
                <span style={{ color: 'var(--text-3)' }}>{p.status === 'paid' ? (p.paid_on || '—') : ''}</span>
                {p.ad_id && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{adLabel(p.ad_id) || 'ad'}</span>}
                {p.note && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{p.note}</span>}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  {p.proof_path
                    ? <button onClick={() => viewProof(p.id)} title={p.proof_name || 'View screenshot'} style={linkBtn}>screenshot</button>
                    : <span style={{ color: 'var(--text-3)', fontSize: 11 }}>no proof</span>}
                  {canManage && p.status !== 'paid' && <button onClick={() => setPayModal({ mode: 'paid', payment: p })} disabled={busy} style={linkBtn}>mark paid</button>}
                  {canManage && p.status === 'paid' && <button onClick={() => backToPending(p)} disabled={busy} style={linkBtn}>back to pending</button>}
                  {canManage && <button onClick={() => removePayment(p)} disabled={busy} style={{ ...linkBtn, color: 'var(--state-error-fg)' }}>delete</button>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <AdPaymentModal state={payModal} onClose={() => setPayModal(null)} engagement={engagement} ads={list}
        adLabel={adLabel} session={session} onSaved={onSaved} />
    </section>
  );
}

function AdRow({ ad, take, canManage, canApprove, busy, onEdit, onDelete, onDecide }) {
  const gate = ad.approve_gate || { ok: false, message: 'approval rule unavailable — reload' };
  const runningUnapproved = ad.run_status === 'running' && ad.approval_status !== 'approved';
  const synced = ad.meta_synced_at ? Date.parse(ad.meta_synced_at) : NaN;
  const stale = ad.meta_ad_id && (!Number.isFinite(synced) || Date.now() - synced > STALE_SYNC_MS);
  return (
    <div style={{ padding: 10, background: 'var(--surface-2)', border: `1px solid ${runningUnapproved ? 'var(--state-error-fg)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        <strong>{takeLabel(take)}</strong>
        <span style={{ color: 'var(--text-2)' }}>{(PLATFORMS.find(p => p[0] === ad.platform) || [, ad.platform])[1]}</span>
        <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: APPROVAL_COLOUR[ad.approval_status] || 'var(--text-3)' }}>
          {APPROVAL_LABEL[ad.approval_status] || ad.approval_status}
        </span>
        <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-2)' }}>
          {(RUN_STATUSES.find(r => r[0] === ad.run_status) || [, ad.run_status])[1]}
        </span>
        {runningUnapproved && (
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--state-error-fg)', textTransform: 'uppercase' }}>⚠ running without approval</span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {canApprove && ad.approval_status !== 'approved' && (
            <button onClick={() => onDecide('approved')} disabled={busy || !gate.ok} title={gate.ok ? undefined : gate.message}
              style={{ ...btn, background: gate.ok ? '#27c93f' : 'var(--surface-3)', color: gate.ok ? '#04140a' : 'var(--text-3)', cursor: (busy || !gate.ok) ? 'not-allowed' : 'pointer' }}>Approve</button>
          )}
          {canApprove && ad.approval_status !== 'rejected' && <button onClick={() => onDecide('rejected')} disabled={busy} style={btn}>Reject</button>}
          {canApprove && ad.approval_status !== 'pending' && <button onClick={() => onDecide('pending')} disabled={busy} style={btn}>Back to pending</button>}
          {canManage && <button onClick={onEdit} disabled={busy} style={btn}>Edit</button>}
          {canManage && <button onClick={onDelete} disabled={busy} style={{ ...btn, color: 'var(--state-error-fg)' }}>Delete</button>}
        </span>
      </div>
      {ad.approval_status !== 'approved' && !gate.ok && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>Approval: {gate.message}</div>
      )}
      <div style={{ marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-2)' }}>
        <span>Start {ad.start_date || '—'}</span>
        <span>End {ad.end_date || '—'}</span>
        <span>Meta ad {ad.meta_ad_id || '—'}</span>
        {ad.decided_at && <span style={{ color: 'var(--text-3)' }}>Decided {istStamp(ad.decided_at)}{ad.decision_note ? ` — ${ad.decision_note}` : ''}</span>}
      </div>
      {ad.meta_ad_id && (
        <div style={{ marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-2)' }}>
          {ad.meta_synced_at ? (
            <>
              <span>Meta {ad.meta_status || '—'}</span>
              <span>Spend {inr(ad.meta_spend)}</span>
              <span>Views {Number(ad.meta_views || 0).toLocaleString('en-IN')}</span>
              <span>Impressions {Number(ad.meta_impressions || 0).toLocaleString('en-IN')}</span>
              <span style={{ color: stale ? 'var(--state-error-fg)' : 'var(--text-3)' }}>Synced {istStamp(ad.meta_synced_at)}{stale ? ' — stale, the daily sync has not reached it' : ''}</span>
            </>
          ) : (
            <span style={{ color: 'var(--state-error-fg)' }}>Not synced from Meta yet — press Refresh from Meta.</span>
          )}
        </div>
      )}
      {ad.note && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-3)' }}>{ad.note}</div>}
    </div>
  );
}

function AdForm({ ad, takes, session, busy, setBusy, onCancel, onSaved }) {
  const { showToast: toast } = useToast();
  const [f, setF] = useState({
    video_id: ad.video_id || '', platform: ad.platform || 'instagram', run_status: ad.run_status || 'not_started',
    start_date: ad.start_date || '', end_date: ad.end_date || '', meta_ad_id: ad.meta_ad_id || '', note: ad.note || '',
  });
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  // Same rule the worker enforces: hand-set Running needs approval (unless Meta already has it running).
  const canRun = ad.approval_status === 'approved' || ad.run_status === 'running';

  async function save() {
    setBusy(true);
    try {
      const r = await ignitionopsPost('saveEngagementAd', {
        ...(ad.id ? { id: ad.id } : { engagement_id: ad.engagement_id }),
        video_id: f.video_id || null, platform: f.platform, run_status: f.run_status,
        start_date: f.start_date || null, end_date: f.end_date || null,
        meta_ad_id: f.meta_ad_id.trim() || null, note: f.note.trim() || null,
      }, session);
      toast(r?.warning || (ad.id ? 'Ad updated' : 'Ad added'), r?.warning ? 'error' : 'success');
      onSaved?.();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ padding: 10, background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
      <Field label="Take">
        <select value={f.video_id} onChange={e => set('video_id', e.target.value)} style={inp}>
          <option value="">Pick the take this ad boosts…</option>
          {takes.map(v => <option key={v.id} value={v.id}>{takeLabel(v)}</option>)}
        </select>
      </Field>
      <Field label="Platform">
        <select value={f.platform} onChange={e => set('platform', e.target.value)} style={inp}>
          {PLATFORMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
      <Field label="Run status">
        <select value={f.run_status} onChange={e => set('run_status', e.target.value)} style={inp}>
          {RUN_STATUSES.map(([v, l]) => (
            <option key={v} value={v} disabled={v === 'running' && !canRun}>{l}{v === 'running' && !canRun ? ' (needs approval)' : ''}</option>
          ))}
        </select>
      </Field>
      <Field label="Start"><input type="date" value={f.start_date} onChange={e => set('start_date', e.target.value)} style={inp} /></Field>
      <Field label="End"><input type="date" value={f.end_date} onChange={e => set('end_date', e.target.value)} style={inp} /></Field>
      <Field label="Meta ad id">
        <input value={f.meta_ad_id} onChange={e => set('meta_ad_id', e.target.value)} placeholder="from Ads Manager (digits)" style={inp} />
      </Field>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Note"><input value={f.note} onChange={e => set('note', e.target.value)} placeholder="optional" style={inp} /></Field>
      </div>
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={ghost}>Cancel</button>
        <button onClick={save} disabled={busy} style={{ ...primary, opacity: busy ? 0.5 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}>{busy ? 'Saving…' : 'Save ad'}</button>
      </div>
    </div>
  );
}

// Record an ad payment (new), or mark a pending one paid. Screenshot required once PAID.
function AdPaymentModal({ state, onClose, engagement, ads, adLabel, session, onSaved }) {
  const { showToast: toast } = useToast();
  const open = !!state;
  const marking = state?.mode === 'paid';
  const [form, setForm] = useState({ amount: '', status: 'pending', paid_on: '', ad_id: '', note: '' });
  const [proofFile, setProofFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Reset each time the modal opens for a different target (same pattern as NewPaymentModal).
  const key = open ? (marking ? state.payment.id : 'new') : null;
  useEffect(() => {
    if (!key) return;
    setForm({ amount: '', status: marking ? 'paid' : 'pending', paid_on: '', ad_id: '', note: '' });
    setProofFile(null); setErr(null);
  }, [key]);
  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const paid = marking || form.status === 'paid';

  async function submit() {
    if (!marking && (form.amount === '' || !(Number(form.amount) >= 0))) { setErr('Enter an amount'); return; }
    if (paid && !proofFile && !(marking && state.payment.proof_path)) { setErr('A payment screenshot is required once it is paid'); return; }
    setBusy(true); setErr(null);
    try {
      let proof = {};
      if (proofFile) {
        const { storage_path, token } = await ignitionopsPost('createPaymentProofUploadUrl',
          { engagement_id: engagement.id, file_name: proofFile.name, for: 'ad_payment' }, session);
        if (!token) throw new Error('Could not get an upload link for the screenshot');
        const { error } = await supabase.storage.from(PROOF_BUCKET).uploadToSignedUrl(storage_path, token, proofFile);
        if (error) throw error;
        proof = { proof_path: storage_path, proof_name: proofFile.name, proof_mime: proofFile.type || null };
      }
      if (marking) {
        await ignitionopsPost('updateAdPayment', { id: state.payment.id, status: 'paid', paid_on: form.paid_on || undefined, ...proof }, session);
        toast('Ad payment marked paid', 'success');
      } else {
        await ignitionopsPost('addAdPayment', {
          engagement_id: engagement.id, amount: Number(form.amount), status: form.status,
          paid_on: paid ? (form.paid_on || undefined) : undefined, ad_id: form.ad_id || undefined,
          note: form.note || undefined, ...proof,
        }, session);
        toast('Ad payment recorded', 'success');
      }
      onClose?.(); onSaved?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={marking ? 'Mark ad payment paid' : 'Record ad payment'}
      confirmLabel={busy ? 'Saving…' : 'Save'} confirmColor="#FF6B00" onConfirm={submit} loading={busy} error={err}>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
        Paid to the creator for ad rights / usage on {engagement.engagement_no}. Outside the influencer budget —
        it does not count toward this deal&apos;s total cost or the Payments page.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {!marking && (
          <>
            <Field label="Amount (₹) *"><input type="number" min="0" value={form.amount} onChange={e => setField('amount', e.target.value)} placeholder="0" style={inp} /></Field>
            <Field label="Status">
              <select value={form.status} onChange={e => setField('status', e.target.value)} style={inp}>
                <option value="pending">Pending</option>
                <option value="paid">Paid</option>
              </select>
            </Field>
            <Field label="For ad (optional)">
              <select value={form.ad_id} onChange={e => setField('ad_id', e.target.value)} style={inp}>
                <option value="">Not linked to one ad</option>
                {ads.map(a => <option key={a.id} value={a.id}>{adLabel(a.id)}</option>)}
              </select>
            </Field>
            <Field label="Note"><input value={form.note} onChange={e => setField('note', e.target.value)} placeholder="UTR / ref (optional)" style={inp} /></Field>
          </>
        )}
        {paid && (
          <Field label="Paid on"><input type="date" value={form.paid_on} onChange={e => setField('paid_on', e.target.value)} style={inp} /></Field>
        )}
      </div>
      {paid && (
        <div style={{ marginTop: 14 }}>
          <div style={lbl}>Payment screenshot *</div>
          <input type="file" accept="image/*,application/pdf" onChange={e => setProofFile(e.target.files?.[0] || null)} style={{ fontSize: 12, color: 'var(--text-2)' }} />
          {proofFile && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-3)' }}>{proofFile.name}</span>}
          {paid && !form.paid_on && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>Paid on defaults to today (IST).</div>}
        </div>
      )}
    </Modal>
  );
}

function Field({ label, children }) {
  return <div><div style={lbl}>{label}</div>{children}</div>;
}
const lbl = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 };
const inp = { width: '100%', boxSizing: 'border-box', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 9px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const btn = { padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' };
const ghost = { padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' };
const primary = { padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700 };
const linkBtn = { background: 'transparent', border: 'none', color: '#FF6B00', cursor: 'pointer', padding: 0, fontSize: 12, textDecoration: 'underline' };
