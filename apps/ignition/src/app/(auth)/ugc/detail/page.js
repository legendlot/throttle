'use client';
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Modal, useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import ProductLinesEditor, { linesToPayload } from '../../../../components/ProductLinesEditor.js';
import {
  UGC_STAGE_VALUES, UGC_STAGE_LABELS, UGC_STAGE_PALETTE, UGC_HAPPY_PATH,
  roasTone, roasToneColor,
} from '../../../../lib/ugcStages.js';

const ORANGE = '#FF6B00';
function inr(n) { return `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }
function num(n) { return n == null || n === '' ? null : Number(n); }
function computeRoas(spend, rev) {
  const s = Number(spend || 0);
  if (!s) return null;
  return Number(rev || 0) / s;
}
function amountOwed(e) {
  const fee = Number(e.payment_amount || 0);
  const feeUnpaid = e.creator_fee_status === 'paid' || e.is_barter ? 0 : fee;
  const commOut = Number(e.commission_earned || 0) - Number(e.commission_paid || 0);
  return feeUnpaid + Math.max(commOut, 0);
}

export default function UgcDetailPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const id = sp.get('id');
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [stageModal, setStageModal] = useState(null); // { to_stage }
  const [briefBusy, setBriefBusy] = useState(false);
  const canManage = !!perms?.ignition_manage;

  function reload() {
    if (!session || !id) return;
    ignitionopsGet('getEngagement', { id }, session).then(setData).catch(e => setErr(e.message));
  }
  useEffect(reload, [id, session]);

  async function save(patch) {
    await ignitionopsPost('updateEngagement', { engagement_id: data.engagement.id, ...patch }, session);
    toast('Saved', 'success');
    reload();
  }

  async function doAdvance(to_stage, extra = {}) {
    try {
      await ignitionopsPost('advanceStage', { engagement_id: data.engagement.id, to_stage, ...extra }, session);
      toast(`Moved to ${UGC_STAGE_LABELS[to_stage] || to_stage}`, 'success');
      setStageModal(null);
      reload();
    } catch (e) {
      const m = e?.message || '';
      if (/tracking_url_required_for_shipped/.test(m)) { setStageModal({ to_stage, need: 'tracking_url' }); return; }
      if (/video_link_required_for_live/.test(m)) { setStageModal({ to_stage, need: 'video_link' }); return; }
      toast(m || 'Could not move', 'error');
    }
  }

  function clickStage(to_stage) {
    if (!canManage || to_stage === data.engagement.stage) return;
    const e = data.engagement;
    // Pre-empt the worker guards: prompt up front when the value is missing.
    if (to_stage === 'shipped' && !(e.tracking_url || '').trim()) { setStageModal({ to_stage, need: 'tracking_url' }); return; }
    if (to_stage === 'live' && !(e.video_link || '').trim()) { setStageModal({ to_stage, need: 'video_link' }); return; }
    doAdvance(to_stage);
  }

  async function generateBrief() {
    setBriefBusy(true);
    try {
      await ignitionopsPost('generateUgcBrief', { engagement_id: data.engagement.id }, session);
      toast('Brief generated', 'success');
      reload();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBriefBusy(false); }
  }

  if (err) return <div style={{ color: 'var(--state-error-fg)', padding: 16 }}>Error: {err}</div>;
  if (!data) return <Spinner />;
  const e = data.engagement;
  const inf = e.influencer || {};
  const roas = computeRoas(e.ad_spend, e.conversions_value);
  const commOut = Number(e.commission_earned || 0) - Number(e.commission_paid || 0);
  const igHandle = inf.channel_name || inf.ig_handle || null;
  const igLink = inf.channel_link || inf.profile_url || null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 900 }}>
      {/* Header */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: ORANGE, fontWeight: 700, fontSize: 18 }}>{e.engagement_no}</span>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {inf.channel_name || inf.person_name || '—'}
        </h1>
        <UgcStageBadge stage={e.stage} />
        <button onClick={() => router.push('/ugc')} style={{ marginLeft: 'auto', ...ghostBtn }}>← Pipeline</button>
      </div>

      {/* Stepper */}
      <Card title="Pipeline">
        <UgcStepper stage={e.stage} onPick={clickStage} canManage={canManage} />
        {canManage && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>Click a stage to move the deal. Tracking link required at Shipped; video link required at Live.</div>}
      </Card>

      {/* Creator */}
      <Card title="Creator">
        <KV label="Name" value={inf.person_name || inf.channel_name || '—'} />
        <KV label="IG handle" value={igHandle ? (igLink ? <a href={igLink} target="_blank" rel="noreferrer" style={{ color: ORANGE }}>{igHandle}</a> : igHandle) : '—'} />
        <KV label="Phone" value={inf.contact_number || '—'} />
        <KV label="Platform" value={inf.channel_platform || '—'} />
        <KV label="Followers" value={inf.follower_count != null ? Number(inf.follower_count).toLocaleString() : '—'} />
      </Card>

      {/* Deal */}
      <Card title="Deal">
        <KV label="Creator fee" value={inr(e.payment_amount)} />
        <KV label="Commission rate" value={e.commission_rate != null && e.commission_rate !== '' ? `${Number(e.commission_rate)}%` : '—'} />
        <KV label="Barter" value={e.is_barter ? 'Yes' : 'No'} />
        <KV label="Amount owed" value={<strong style={{ color: amountOwed(e) > 0 ? ORANGE : 'var(--text-1)' }}>{inr(amountOwed(e))}</strong>} />
      </Card>

      {/* Product */}
      <ProductsCard products={data.products || []} engagementId={e.id} canEdit={canManage} session={session} onSaved={reload} />

      {/* Hook */}
      <HookCard e={e} canEdit={canManage} onSave={save} />

      {/* Ad performance */}
      <AdPerfCard e={e} roas={roas} canEdit={canManage} onSave={save} session={session} onRefreshed={reload} />

      {/* Payment */}
      <PaymentCard e={e} commOut={commOut} canEdit={canManage} onSave={save} />

      {/* Brief */}
      <Card title="UGC brief / contract"
        action={canManage ? <button onClick={generateBrief} disabled={briefBusy} style={primaryBtnSm}>{briefBusy ? 'Generating…' : 'Generate brief'}</button> : null}>
        {(data.ugc_briefs || []).length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No briefs generated yet. Generate one to log a timestamped paper trail.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {data.ugc_briefs.map((b, i) => (
              <div key={b.id || i} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                <div style={{ padding: '6px 10px', background: 'var(--surface-2)', fontSize: 11, color: 'var(--text-3)', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{i === 0 ? 'Latest' : `Version ${data.ugc_briefs.length - i}`}</span>
                  <span>{b.created_at ? new Date(b.created_at).toLocaleString() : ''}</span>
                </div>
                <pre style={{ margin: 0, padding: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-1)', lineHeight: 1.5 }}>{b.body || '(empty)'}</pre>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* History */}
      {data.history && (
        <Card title="History">
          {data.history.length === 0 ? <div style={{ color: 'var(--text-3)' }}>No history yet.</div> : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ background: 'var(--surface-2)' }}>
                <th style={th}>When</th><th style={th}>Action</th><th style={th}>From</th><th style={th}>To</th><th style={th}>Note</th>
              </tr></thead>
              <tbody>
                {data.history.map(h => (
                  <tr key={h.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={tdc}>{new Date(h.created_at).toLocaleString()}</td>
                    <td style={tdc}>{h.action}</td>
                    <td style={tdc}>{h.stage_from || '—'}</td>
                    <td style={tdc}>{h.stage_to || '—'}</td>
                    <td style={tdc}>{h.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {stageModal && (
        <StagePromptModal
          toStage={stageModal.to_stage}
          need={stageModal.need}
          engagement={e}
          onClose={() => setStageModal(null)}
          onConfirm={(extra) => doAdvance(stageModal.to_stage, extra)}
        />
      )}
    </div>
  );
}

function UgcStageBadge({ stage }) {
  if (!stage) return null;
  const pal = UGC_STAGE_PALETTE[stage] || { fg: 'var(--text-2)', bg: 'var(--surface-2)' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '4px 10px', fontSize: 12,
      fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
      color: pal.fg, background: pal.bg, border: '1px solid currentColor', borderRadius: 'var(--radius-sm)',
    }}>{UGC_STAGE_LABELS[stage] || stage}</span>
  );
}

// Stepper with clickable stages (happy path inline + off-path holds/exits below).
function UgcStepper({ stage, onPick, canManage }) {
  const currentIdx = UGC_HAPPY_PATH.indexOf(stage);
  const offPath = UGC_STAGE_VALUES.filter(s => !UGC_HAPPY_PATH.includes(s));
  function chip(s) {
    const idx = UGC_HAPPY_PATH.indexOf(s);
    const done = currentIdx >= 0 && idx >= 0 && idx <= currentIdx;
    const current = s === stage;
    const pal = UGC_STAGE_PALETTE[s] || {};
    const onPathColor = current ? ORANGE : done ? 'var(--text-1)' : 'var(--text-3)';
    return (
      <button key={s} type="button" onClick={() => onPick(s)} disabled={!canManage}
        style={{
          padding: '4px 10px', fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: current ? 700 : 500,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          color: current ? ORANGE : (UGC_HAPPY_PATH.includes(s) ? onPathColor : (pal.fg || 'var(--text-3)')),
          background: current ? 'rgba(255,107,0,0.12)' : 'transparent',
          border: `1px solid ${current ? ORANGE : done ? 'var(--border-2)' : 'var(--border)'}`,
          borderRadius: 'var(--radius-sm)', whiteSpace: 'nowrap', cursor: canManage ? 'pointer' : 'default',
        }}>{UGC_STAGE_LABELS[s]}</button>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
        {UGC_HAPPY_PATH.map(chip)}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 4 }}>Holds / exit</span>
        {offPath.map(chip)}
      </div>
    </div>
  );
}

function ProductsCard({ products, engagementId, canEdit, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);
  function startEdit() {
    setLines((products || []).map(p => ({
      product_code: p.product_code || '', product_variant: p.product_variant || '',
      quantity: p.quantity ?? 1, goodies_cost: p.goodies_cost ?? '', shipping_cost: p.shipping_cost ?? '',
    })));
    setEditing(true);
  }
  async function saveLines() {
    setBusy(true);
    try {
      await ignitionopsPost('setEngagementProducts', { engagement_id: engagementId, products: linesToPayload(lines) }, session);
      toast('Products updated', 'success'); setEditing(false); onSaved?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Card title="Product" action={canEdit && !editing ? <button onClick={startEdit} style={editBtn}>Edit</button> : null}>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ProductLinesEditor value={lines} onChange={setLines} session={session} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} style={ghostBtn}>Cancel</button>
            <button onClick={saveLines} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : (products || []).length === 0 ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No products.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {products.map((p, i) => (
            <div key={p.id || i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13 }}>
              <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{p.product_code || '—'}</span>
              {p.product_variant && <span style={{ color: 'var(--text-2)' }}>{p.product_variant}</span>}
              {Number(p.quantity) > 1 && <span style={{ color: 'var(--text-3)' }}>×{p.quantity}</span>}
              {p.goodies_cost != null && <span style={{ marginLeft: 'auto', color: 'var(--text-3)' }}>{inr(p.goodies_cost)}</span>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function HookCard({ e, canEdit, onSave }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  function start() { setForm({ hook_version: e.hook_version || '', hook_script: e.hook_script || '' }); setEditing(true); }
  async function save() {
    setBusy(true);
    try { await onSave({ hook_version: form.hook_version || null, hook_script: form.hook_script || null }); setEditing(false); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Card title="Hook" action={canEdit && !editing ? <button onClick={start} style={editBtn}>Edit</button> : null}>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Version (A/B/C)"><input value={form.hook_version} onChange={ev => setForm(f => ({ ...f, hook_version: ev.target.value }))} style={inp} /></Field>
          <Field label="Script"><textarea rows={4} value={form.hook_script} onChange={ev => setForm(f => ({ ...f, hook_script: ev.target.value }))} style={{ ...inp, resize: 'vertical' }} /></Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} style={ghostBtn}>Cancel</button>
            <button onClick={save} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : (
        <>
          <KV label="Version" value={e.hook_version || '—'} />
          <KV label="Script" value={e.hook_script ? <span style={{ whiteSpace: 'pre-wrap' }}>{e.hook_script}</span> : '—'} />
        </>
      )}
    </Card>
  );
}

const AD_FIELDS = [
  ['ad_spend', 'Ad spend ₹', 'money'],
  ['conversions_value', 'Revenue ₹', 'money'],
  ['ctr', 'CTR %', 'num'],
  ['frequency', 'Frequency', 'num'],
  ['purchases', 'Purchases', 'int'],
  ['meta_ad_id', 'Meta ad ID', 'text'],
];

function AdPerfCard({ e, roas, canEdit, onSave, session, onRefreshed }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  function start() { const f = {}; for (const [k] of AD_FIELDS) f[k] = e[k] ?? ''; setForm(f); setEditing(true); }
  async function refreshMeta() {
    setRefreshing(true);
    try {
      await ignitionopsPost('refreshUgcMetrics', { engagement_id: e.id }, session);
      toast('Pulled latest from Meta', 'success');
      onRefreshed && onRefreshed();
    } catch (err) {
      const msg = err.message === 'no_meta_ad_id' ? 'Add a Meta ad ID first'
        : err.message === 'meta_not_configured' ? 'Meta not connected yet (token not set)'
        : err.message;
      toast(msg, 'error');
    } finally { setRefreshing(false); }
  }
  async function save() {
    setBusy(true);
    try {
      const patch = {};
      for (const [k, , type] of AD_FIELDS) patch[k] = type === 'text' ? (form[k] || null) : num(form[k]);
      await onSave(patch); setEditing(false);
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  const tone = roasTone(roas);
  return (
    <Card title="Ad performance" action={canEdit && !editing ? <button onClick={start} style={editBtn}>Edit</button> : null}>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {AD_FIELDS.map(([k, label, type]) => (
            <Field key={k} label={label}>
              <input type={type === 'text' ? 'text' : 'number'} value={form[k]}
                onChange={ev => setForm(f => ({ ...f, [k]: ev.target.value }))} style={inp} />
            </Field>
          ))}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} style={ghostBtn}>Cancel</button>
            <button onClick={save} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : (
        <>
          <KV label="Ad spend" value={inr(e.ad_spend)} />
          <KV label="Revenue" value={inr(e.conversions_value)} />
          <KV label="ROAS" value={roas == null ? '—' : <span style={{ color: roasToneColor(tone), fontWeight: 600 }}>{roas.toFixed(2)}×</span>} />
          <KV label="CTR" value={e.ctr != null && e.ctr !== '' ? `${Number(e.ctr)}%` : '—'} />
          <KV label="Frequency" value={e.frequency != null && e.frequency !== '' ? Number(e.frequency).toFixed(2) : '—'} />
          <KV label="Purchases" value={e.purchases != null && e.purchases !== '' ? Number(e.purchases).toLocaleString() : '—'} />
          <KV label="Meta ad ID" value={e.meta_ad_id || '—'} />
        </>
      )}
      {canEdit && !editing && (
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={refreshMeta} disabled={refreshing || !e.meta_ad_id} style={ghostBtn}>
            {refreshing ? 'Refreshing…' : 'Refresh from Meta'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {e.meta_synced_at ? `Last synced ${new Date(e.meta_synced_at).toLocaleString('en-IN')}` : 'Never synced'}
          </span>
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>
        Auto-pulls daily from Meta per the deal's Meta ad ID. Editable manually too.
      </div>
    </Card>
  );
}

function PaymentCard({ e, commOut, canEdit, onSave }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  function start() {
    setForm({
      creator_fee_status: e.creator_fee_status || 'pending',
      creator_fee_paid_date: e.creator_fee_paid_date || '',
      is_barter: !!e.is_barter,
      commission_rate: e.commission_rate ?? '',
      commission_earned: e.commission_earned ?? '',
      commission_paid: e.commission_paid ?? '',
    });
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    try {
      await onSave({
        creator_fee_status: form.creator_fee_status,
        creator_fee_paid_date: form.creator_fee_paid_date || null,
        is_barter: !!form.is_barter,
        commission_rate: num(form.commission_rate),
        commission_earned: num(form.commission_earned),
        commission_paid: num(form.commission_paid),
      });
      setEditing(false);
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Card title="Payment" action={canEdit && !editing ? <button onClick={start} style={editBtn}>Edit</button> : null}>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Field label="Creator fee status">
            <select value={form.creator_fee_status} onChange={ev => setForm(f => ({ ...f, creator_fee_status: ev.target.value }))} style={inp}>
              <option value="pending">Pending</option>
              <option value="paid">Paid</option>
            </select>
          </Field>
          <Field label="Fee paid date"><input type="date" value={form.creator_fee_paid_date} onChange={ev => setForm(f => ({ ...f, creator_fee_paid_date: ev.target.value }))} style={inp} /></Field>
          <Field label="Barter">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-2)' }}>
              <input type="checkbox" checked={form.is_barter} onChange={ev => setForm(f => ({ ...f, is_barter: ev.target.checked }))} /> Barter deal (no cash fee)
            </label>
          </Field>
          <Field label="Commission rate %"><input type="number" value={form.commission_rate} onChange={ev => setForm(f => ({ ...f, commission_rate: ev.target.value }))} style={inp} /></Field>
          <Field label="Commission earned ₹"><input type="number" value={form.commission_earned} onChange={ev => setForm(f => ({ ...f, commission_earned: ev.target.value }))} style={inp} /></Field>
          <Field label="Commission paid ₹"><input type="number" value={form.commission_paid} onChange={ev => setForm(f => ({ ...f, commission_paid: ev.target.value }))} style={inp} /></Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} style={ghostBtn}>Cancel</button>
            <button onClick={save} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : (
        <>
          <KV label="Fee status" value={<span style={{ color: e.creator_fee_status === 'paid' ? 'var(--state-success-fg)' : 'var(--state-warning-fg)', fontWeight: 600 }}>{e.creator_fee_status === 'paid' ? 'Paid' : 'Pending'}</span>} />
          <KV label="Fee paid date" value={e.creator_fee_paid_date || '—'} />
          <KV label="Barter" value={e.is_barter ? 'Yes' : 'No'} />
          <KV label="Commission rate" value={e.commission_rate != null && e.commission_rate !== '' ? `${Number(e.commission_rate)}%` : '—'} />
          <KV label="Commission earned" value={inr(e.commission_earned)} />
          <KV label="Commission paid" value={inr(e.commission_paid)} />
          <KV label="Outstanding" value={<strong style={{ color: commOut > 0 ? ORANGE : 'var(--text-1)' }}>{inr(Math.max(commOut, 0))}</strong>} />
        </>
      )}
    </Card>
  );
}

// Inline modal that mirrors AdvanceModal's prompt-for-required-field pattern.
function StagePromptModal({ toStage, need, engagement, onClose, onConfirm }) {
  const [val, setVal] = useState(need === 'tracking_url' ? (engagement.tracking_url || '') : (engagement.video_link || ''));
  const [busy, setBusy] = useState(false);
  const isTrack = need === 'tracking_url';
  const label = isTrack ? 'Tracking link' : 'Video link';
  async function submit() {
    if (!val.trim()) return;
    setBusy(true);
    try { await onConfirm(isTrack ? { tracking_url: val.trim() } : { video_link: val.trim() }); }
    finally { setBusy(false); }
  }
  return (
    <Modal open title={`Move to ${UGC_STAGE_LABELS[toStage] || toStage}`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 360 }}>
        <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
          {isTrack ? 'A shipping tracking link is required to mark this shipped.' : 'A video link is required to mark this live.'}
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label} *</label>
          <input value={val} onChange={ev => setVal(ev.target.value)} placeholder="https://…"
            style={{ ...inp, marginTop: 6 }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy || !val.trim()} style={{ ...primaryBtn, opacity: busy || !val.trim() ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Confirm'}</button>
        </div>
      </div>
    </Modal>
  );
}

function Card({ title, action, children }) {
  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function KV({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
      <span style={{ width: 140, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ color: 'var(--text-1)', fontSize: 13, flex: 1 }}>{value}</span>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      {children}
    </div>
  );
}

const inp = { width: '100%', boxSizing: 'border-box', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const primaryBtn = { padding: '6px 12px', background: ORANGE, color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
const primaryBtnSm = { padding: '4px 12px', background: ORANGE, color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, cursor: 'pointer' };
const ghostBtn = { padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' };
const editBtn = { padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' };
const th = { padding: '6px 10px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, fontFamily: 'var(--font-mono)', textAlign: 'left' };
const tdc = { padding: '6px 10px', color: 'var(--text-2)' };
