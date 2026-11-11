'use client';
// Hiring C3 — create an offer revision (?application_id=…, optional &from=<offer id> to start from an
// earlier revision's terms) or edit a draft (?id=<offer id>). Live annexure preview via previewOffer
// (no write); Save draft / Submit. The worker decides everything — band, approval, who may do it.
import { useEffect, useRef, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, Save, Send } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../../lib/podiumopsFetch.js';
import { Card, F, Row, Note, KV, inp, backBtn, primaryBtn, ghostBtn, muted } from '../../../../../components/HiringBits.js';
import { LetterPreview, AnnexureTable, BandCheckBadge, Warnings } from '../../../../../components/OfferBits.js';
import { VARIABLE_LABELS, VARIABLE_FREQUENCIES, OFFER_TEMPLATE_KEYS, hiringError, formatINR, formatBand, numOrNull, labelFrom } from '../../../../../lib/hiring.js';

const TERM_KEYS = ['designation', 'department_name', 'location', 'start_date', 'probation_months', 'signatory_id',
  'fixed_annual', 'variable_annual', 'variable_label', 'variable_frequency', 'joining_bonus', 'retention_bonus',
  'stipend_monthly', 'internship_months', 'pf_opt_out', 'pf_opt_out_reason', 'valid_days'];
const MONEY = ['fixed_annual', 'variable_annual', 'joining_bonus', 'retention_bonus', 'stipend_monthly'];

function termsBody(f) {
  const b = { template_key: f.template_key };
  for (const k of TERM_KEYS) {
    const v = f[k];
    if (MONEY.includes(k)) b[k] = numOrNull(v);
    else if (['probation_months', 'internship_months', 'valid_days'].includes(k)) b[k] = v === '' || v == null ? null : Number(v);
    else if (k === 'pf_opt_out') b[k] = !!v;
    else b[k] = v === '' ? null : v;
  }
  return b;
}
const str = (v) => (v == null ? '' : String(v));

function OfferFormInner() {
  const { session } = useAuth();
  const router = useRouter();
  const sp = useSearchParams();
  const offerId = sp.get('id');
  const fromId = sp.get('from');
  const { showToast } = useToast();
  const [setup, setSetup] = useState(null);
  const [appId, setAppId] = useState(sp.get('application_id'));
  const [f, setF] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewErr, setPreviewErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const timer = useRef(null);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  // Load: an existing draft (edit) or a source revision (revise) → its inputs; then the setup for its application.
  useEffect(() => {
    if (!session) return;
    let alive = true;
    (async () => {
      try {
        let seed = null, app = appId;
        const srcId = offerId || fromId;
        if (srcId) {
          const o = await podiumopsGet('getOffer', { id: srcId }, session);
          if (!o?.can?.see_salary) throw new Error('forbidden');
          seed = { ...(o.offer.inputs || {}), template_key: o.offer.inputs?.template_key || (o.offer.mode === 'stipend' ? 'internship' : 'employment') };
          app = o.offer.application_id;
          if (alive) setAppId(app);
        }
        if (!app) throw new Error('application_id required');
        const s = await podiumopsGet('getOfferSetup', { application_id: app }, session);
        if (!alive) return;
        setSetup(s);
        const d = s.defaults || {};
        const base = {
          template_key: d.template_key || 'employment', designation: str(d.designation), department_name: str(d.department_name),
          location: str(d.location), start_date: str(d.start_date), probation_months: '3', signatory_id: s.signatories?.[0]?.id || '',
          fixed_annual: '', variable_annual: '', variable_label: d.variable_label || 'variable pay', variable_frequency: d.variable_frequency || 'half-yearly',
          joining_bonus: '', retention_bonus: '', stipend_monthly: '', internship_months: '6', pf_opt_out: false, pf_opt_out_reason: '',
          valid_days: String(d.valid_days || 7),
        };
        if (seed) for (const k of [...TERM_KEYS, 'template_key']) if (seed[k] !== undefined && seed[k] !== null) base[k] = typeof seed[k] === 'boolean' ? seed[k] : String(seed[k]);
        setF(base);
      } catch (e) { if (alive) setLoadErr(hiringError(e, 'Could not load')); }
    })();
    return () => { alive = false; };
  }, [session, offerId, fromId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live preview (debounced; no write).
  useEffect(() => {
    if (!f || !appId || !session) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const p = await podiumopsPost('previewOffer', { application_id: appId, ...termsBody(f) }, session);
        setPreview(p); setPreviewErr(null);
      } catch (e) { setPreview(null); setPreviewErr(hiringError(e, 'Fill in the terms to see the annexure')); }
    }, 450);
    return () => clearTimeout(timer.current);
  }, [f, appId, session]);

  if (loadErr) return <div style={{ color: 'var(--text-3)' }}>{loadErr}</div>;
  if (!setup || !f) return <Spinner />;

  const stipend = f.template_key === 'internship';
  const cand = setup.candidate || {};
  const op = setup.opening || {};

  async function save(thenSubmit) {
    setBusy(true);
    try {
      let id = offerId;
      if (offerId) await podiumopsPost('updateOfferDraft', { id: offerId, ...termsBody(f) }, session);
      else {
        const r = await podiumopsPost('createOffer', { application_id: appId, ...termsBody(f) }, session);
        id = r?.offer?.id;
      }
      if (thenSubmit && id) {
        const s = await podiumopsPost('submitOffer', { id }, session);
        showToast(s?.status === 'pending_approval' ? 'Sent for approval' : 'Offer issued — ready to send', 'success');
      } else showToast('Draft saved', 'success');
      router.replace(`/hiring/offer/?id=${id}`);
    } catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }

  const check = preview?.band_check;
  return (
    <div style={{ maxWidth: 1200 }}>
      <button onClick={() => router.back()} style={backBtn}><ArrowLeft size={15} /> Back</button>
      <header style={{ margin: '10px 0 16px' }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700 }}>{offerId ? 'Edit offer draft' : 'New offer'}</h1>
        <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
          {cand.full_name} <span style={muted}>{cand.candidate_code}</span> · {op.opening_code} {op.designation}
        </div>
      </header>
      {!op.has_band && <Note>The opening has no approved band yet — an offer can't be created until it does.</Note>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 440px) 1fr', gap: 14, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 14 }}>
          <Card title="Terms">
            <F label="Letter">
              <select style={inp} value={f.template_key} disabled={!!offerId} onChange={e => set('template_key', e.target.value)}>
                {OFFER_TEMPLATE_KEYS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </F>
            {stipend ? (
              <Row>
                <F label="Stipend / month (₹) *"><input style={inp} inputMode="numeric" value={f.stipend_monthly} onChange={e => set('stipend_monthly', e.target.value)} /></F>
                <F label="Months *"><input style={inp} inputMode="numeric" value={f.internship_months} onChange={e => set('internship_months', e.target.value)} /></F>
              </Row>
            ) : (
              <>
                <F label="Fixed salary — annual (₹) *"><input style={inp} inputMode="numeric" value={f.fixed_annual} onChange={e => set('fixed_annual', e.target.value)} /></F>
                <Row>
                  <F label="Variable — annual (₹)"><input style={inp} inputMode="numeric" value={f.variable_annual} onChange={e => set('variable_annual', e.target.value)} /></F>
                  <F label="Called">
                    <select style={inp} value={f.variable_label} onChange={e => set('variable_label', e.target.value)}>
                      {VARIABLE_LABELS.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                    </select>
                  </F>
                  <F label="Paid">
                    <select style={inp} value={f.variable_frequency} onChange={e => set('variable_frequency', e.target.value)}>
                      {VARIABLE_FREQUENCIES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                    </select>
                  </F>
                </Row>
              </>
            )}
            <Row>
              <F label="Joining bonus (₹)"><input style={inp} inputMode="numeric" value={f.joining_bonus} onChange={e => set('joining_bonus', e.target.value)} /></F>
              <F label="Retention bonus (₹)"><input style={inp} inputMode="numeric" value={f.retention_bonus} onChange={e => set('retention_bonus', e.target.value)} /></F>
            </Row>
            <div style={{ ...muted, marginTop: -4, marginBottom: 10 }}>Any one-time bonus needs the approver, even inside the band.</div>
            {!stipend && (
              <>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, marginBottom: 8 }}>
                  <input type="checkbox" checked={!!f.pf_opt_out} onChange={e => set('pf_opt_out', e.target.checked)} /> Not opting in to PF
                </label>
                {f.pf_opt_out && <F label="Reason * (eligible only above the PF wage ceiling)"><input style={inp} value={f.pf_opt_out_reason} onChange={e => set('pf_opt_out_reason', e.target.value)} /></F>}
              </>
            )}
          </Card>
          <Card title="Role">
            <F label="Designation *"><input style={inp} value={f.designation} onChange={e => set('designation', e.target.value)} /></F>
            <Row>
              <F label="Department (optional)"><input style={inp} value={f.department_name} onChange={e => set('department_name', e.target.value)} /></F>
              <F label="Location *"><input style={inp} value={f.location} onChange={e => set('location', e.target.value)} /></F>
            </Row>
            <Row>
              <F label="Start date (on or before) *"><input type="date" style={inp} value={f.start_date} onChange={e => set('start_date', e.target.value)} /></F>
              <F label="Probation (months)"><input style={inp} inputMode="numeric" value={f.probation_months} onChange={e => set('probation_months', e.target.value)} placeholder="0 = none" /></F>
            </Row>
            <Row>
              <F label="Signed by *">
                <select style={inp} value={f.signatory_id} onChange={e => set('signatory_id', e.target.value)}>
                  <option value="">—</option>
                  {(setup.signatories || []).map(s => <option key={s.id} value={s.id}>{s.display_name}{s.phone ? '' : ' (no phone)'}</option>)}
                </select>
              </F>
              <F label="Valid for (days)"><input style={inp} inputMode="numeric" value={f.valid_days} onChange={e => set('valid_days', e.target.value)} /></F>
            </Row>
          </Card>
          <Card title="Band">
            <KV k="Approved band (total CTC)" v={setup.band ? formatBand(setup.band.band_min, setup.band.band_max) : '—'} />
            <KV k="Offer total CTC" v={preview ? formatINR(preview.total_ctc) : '—'} />
            <div style={{ marginTop: 6 }}><BandCheckBadge check={check} /></div>
            {(check === 'above_band' || check === 'extras') && setup.approver && (
              <div style={{ ...muted, marginTop: 6 }}>Goes to {setup.approver.full_name} for approval when you submit.</div>
            )}
            {preview?.rule_set && <div style={{ ...muted, marginTop: 6 }}>Statutory rules: {preview.rule_set} (by start date)</div>}
            <Warnings list={preview?.warnings} />
          </Card>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => save(false)} style={ghostBtn} disabled={busy}><Save size={13} /> Save draft</button>
            <button onClick={() => save(true)} style={primaryBtn} disabled={busy || !preview}><Send size={13} /> {busy ? 'Working…' : 'Submit'}</button>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 14 }}>
          {previewErr && <Note>{previewErr}</Note>}
          {preview?.template_error && <Note tone="bad">Template: {preview.template_error}</Note>}
          {preview?.text && <LetterPreview view={preview.text} />}
          {preview?.text?.annexure && <AnnexureTable annexure={preview.text.annexure} />}
          {!preview && !previewErr && <div style={muted}>{labelFrom(OFFER_TEMPLATE_KEYS, f.template_key)} — the preview appears as you type.</div>}
        </div>
      </div>
    </div>
  );
}

export default function OfferFormPage() {
  return <Suspense fallback={<Spinner />}><OfferFormInner /></Suspense>;
}
