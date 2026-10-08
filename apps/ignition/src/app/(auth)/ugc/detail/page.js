'use client';
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Modal } from '../../../../components/ui/Modal.js';
import { Card, Tile, StagePill, Avatar } from '../../../../components/ui/index.js';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import ProductLinesEditor, { linesToPayload, linesAreValid } from '../../../../components/ProductLinesEditor.js';
import {
  UGC_STAGE_VALUES, UGC_STAGE_LABELS, UGC_STAGE_PALETTE, UGC_HAPPY_PATH, UGC_TERMINAL,
  roasTone, roasToneColor,
} from '../../../../lib/ugcStages.js';
import { titleish } from '../../../../lib/productLabel.js';

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

// Keyed by the record id: global search (⌘K) can move from one record to another on this same route,
// and Next keeps the page mounted across a ?id= change — without the key, open edit forms, typed
// notes and the loaded record would carry over to the next record (typeahead S3 review).
export default function UgcDetailPage() {
  const sp = useSearchParams();
  return <UgcDetailPageBody key={sp.get('id') || ''} />;
}

function UgcDetailPageBody() {
  const sp = useSearchParams();
  const router = useRouter();
  const id = sp.get('id');
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [stageModal, setStageModal] = useState(null); // { to_stage }
  const [briefBusy, setBriefBusy] = useState(false);
  const [moving, setMoving] = useState(false);
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
    if (moving) return;
    setMoving(true);
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
    } finally {
      setMoving(false);
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

  // Header shortcuts route through clickStage, so they get the same tracking/video prompts as the stepper.
  const hpIdx = UGC_HAPPY_PATH.indexOf(e.stage);
  // An unapproved proposal can't advance (the worker 422s approval_required; Approve lives on the deal page).
  const nextStage = hpIdx >= 0 ? UGC_HAPPY_PATH[hpIdx + 1] : (e.stage === 'proposed' && e.approved_at) ? UGC_HAPPY_PATH[0] : null;
  // Vault from a closed deal would reopen it (the worker clears closed_at/closed_reason) — the stepper still can.
  const canVault = e.stage !== 'vault' && !UGC_TERMINAL.has(e.stage);
  function vaultFromHeader() {
    if (e.stage === 'live' && !confirm('Move this live deal to the vault? Its affiliate window closes today.')) return;
    clickStage('vault');
  }
  const roasColor = roas == null ? 'var(--text-1)' : roasToneColor(roasTone(roas));
  const displayName = inf.channel_name || inf.person_name || '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <button type="button" onClick={() => router.push('/ugc')} className="ig-card-action"
        style={{ fontSize: 13, color: 'var(--text-3)', width: 'max-content' }}>← UGC</button>

      {/* Header */}
      <div className="ig-up" style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <Avatar name={displayName} seed={inf.id || displayName} size={56} square />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--accent-hi)', overflowWrap: 'anywhere' }}>
            {e.engagement_no}
            {igHandle && <span style={{ color: 'var(--text-4)', fontWeight: 400 }}> · {igHandle}</span>}
          </div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, lineHeight: 1.15, marginTop: 6, overflowWrap: 'anywhere' }}>
            {displayName}
          </h1>
        </div>
        <StagePill stage={e.stage} ugc size="lg" />
        {canManage && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canVault && (
              <button type="button" disabled={moving} onClick={vaultFromHeader} className="ig-ghost-btn" style={ghostBtnLg}>Move to vault</button>
            )}
            {nextStage && (
              <button type="button" disabled={moving} onClick={() => clickStage(nextStage)} className="ig-cta" style={primaryBtnLg}>Advance →</button>
            )}
          </div>
        )}
      </div>

      {/* Stepper */}
      <Card title="Pipeline" hero className="ig-up" style={{ animationDelay: '60ms' }}>
        <UgcStepper stage={e.stage} onPick={clickStage} canManage={canManage} />
        {canManage && <div style={{ fontSize: 12, color: 'var(--text-4)', marginTop: 12 }}>Click a stage to move the deal. Tracking link required at Shipped; video link required at Live.</div>}
      </Card>

      {/* KPI tiles — every value already on the engagement row. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <Tile size={22} label="Ad spend" value={inr(e.ad_spend)} />
        <Tile size={22} label="Revenue" value={inr(e.conversions_value)} />
        <Tile size={22} label="ROAS" value={roas == null ? '—' : `${roas.toFixed(2)}×`} color={roasColor} />
        <Tile size={22} label="Orders" value={e.purchases != null && e.purchases !== '' ? Number(e.purchases).toLocaleString() : '—'} />
        <Tile size={22} label="Commission owed" value={inr(Math.max(commOut, 0))} color={commOut > 0 ? 'var(--accent-hi)' : undefined} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 14, alignItems: 'start' }}>
        {/* Creator */}
        <Card title="Creator">
          <KV label="Name" value={inf.person_name || inf.channel_name || '—'} />
          <KV label="IG handle" value={igHandle ? (igLink ? <a href={igLink} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{igHandle}</a> : igHandle) : '—'} />
          <KV label="Phone" value={inf.contact_number || '—'} />
          <KV label="Platform" value={inf.channel_platform || '—'} />
          <KV label="Followers" value={inf.follower_count != null ? Number(inf.follower_count).toLocaleString() : '—'} />
        </Card>

        {/* Deal */}
        <Card title="Deal">
          <KV label="Creator fee" value={inr(e.payment_amount)} />
          <KV label="Commission rate" value={e.commission_rate != null && e.commission_rate !== '' ? `${Number(e.commission_rate)}%` : '—'} />
          <KV label="Barter" value={e.is_barter ? 'Yes' : 'No'} />
          <KV label="Amount owed" value={<strong style={{ color: amountOwed(e) > 0 ? 'var(--accent-hi)' : 'var(--text-1)' }}>{inr(amountOwed(e))}</strong>} />
        </Card>

        {/* Product */}
        <ProductsCard products={data.products || []} engagementId={e.id} canEdit={canManage} session={session} onSaved={reload} />

        {/* Hook */}
        <HookCard e={e} canEdit={canManage} onSave={save} />

        {/* Ad performance */}
        <AdPerfCard e={e} roas={roas} canEdit={canManage} onSave={save} session={session} onRefreshed={reload} />

        {/* Payment */}
        <PaymentCard e={e} commOut={commOut} canEdit={canManage} onSave={save} />
      </div>

      {/* Brief */}
      <Card title="UGC brief / contract"
        action={canManage ? (briefBusy ? 'Generating…' : 'Generate brief') : null}
        onAction={canManage && !briefBusy ? generateBrief : undefined}>
        {(data.ugc_briefs || []).length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No briefs generated yet. Generate one to log a timestamped paper trail.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {data.ugc_briefs.map((b, i) => (
              <div key={b.id || i} style={{ background: 'var(--surface-sunk)', border: '1px solid var(--border)', borderRadius: 'var(--r-row)', overflow: 'hidden' }}>
                <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--row-divider)', fontSize: 12, color: 'var(--text-3)', display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, color: i === 0 ? 'var(--accent-hi)' : 'var(--text-3)' }}>{i === 0 ? 'Latest' : `Version ${data.ugc_briefs.length - i}`}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-4)' }}>{b.created_at ? new Date(b.created_at).toLocaleString() : ''}</span>
                </div>
                <pre style={{ margin: 0, padding: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-1)', lineHeight: 1.5 }}>{b.body || '(empty)'}</pre>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* History */}
      {data.history && (
        <Card title="History">
          {data.history.length === 0 ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No history yet.</div> : (
            <div>
              {data.history.map(h => {
                const moved = h.stage_from || h.stage_to;
                const dot = (UGC_STAGE_PALETTE[h.stage_to] || {}).fg || 'var(--text-4)';
                return (
                  <div key={h.id} style={{ display: 'grid', gridTemplateColumns: '14px minmax(0,1fr) auto', gap: 10, padding: '8px 0', borderTop: '1px solid var(--row-divider)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 6, background: dot }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, color: 'var(--text-1)', overflowWrap: 'anywhere' }}>
                        {moved ? `${UGC_STAGE_LABELS[h.stage_from] || h.stage_from || '—'} → ${UGC_STAGE_LABELS[h.stage_to] || h.stage_to || '—'}` : h.action}
                      </div>
                      {(moved && h.action || h.note) && (
                        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2, overflowWrap: 'anywhere' }}>
                          {[moved ? h.action : null, h.note].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </div>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-4)', whiteSpace: 'nowrap' }}>{new Date(h.created_at).toLocaleString()}</span>
                  </div>
                );
              })}
            </div>
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

// Clickable stepper (happy path as Stepper-style nodes + off-path holds/exits as pills below).
// The shared `Stepper` primitive renders static nodes, so it can't carry the click-to-move; this
// mirrors its look (28px nodes, 3px track, orange fill, igRing on current) with each node a button.
function UgcStepper({ stage, onPick, canManage }) {
  const currentIdx = UGC_HAPPY_PATH.indexOf(stage);
  const offPath = UGC_STAGE_VALUES.filter(s => !UGC_HAPPY_PATH.includes(s));
  const n = UGC_HAPPY_PATH.length;
  const inset = 50 / n;
  const fill = currentIdx <= 0 ? 0 : (currentIdx / (n - 1)) * (100 - 2 * inset);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${n}, minmax(0,1fr))`, position: 'relative' }}>
        <div style={{ position: 'absolute', left: `${inset}%`, right: `${inset}%`, top: 13, height: 3, background: 'var(--border-2)', borderRadius: 2 }} />
        <div style={{ position: 'absolute', left: `${inset}%`, top: 13, height: 3, width: `${fill}%`, background: 'var(--accent)',
          borderRadius: 2, transition: 'width 700ms var(--ease-out)' }} />
        {UGC_HAPPY_PATH.map((s, i) => {
          const done = currentIdx >= 0 && i < currentIdx;
          const now = s === stage;
          return (
            <button key={s} type="button" onClick={() => onPick(s)} disabled={!canManage}
              title={canManage && !now ? `Move to ${UGC_STAGE_LABELS[s]}` : undefined}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, position: 'relative', minWidth: 0,
                background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit',
                cursor: canManage && !now ? 'pointer' : 'default',
              }}>
              <span style={{
                width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
                background: done ? 'var(--accent)' : now ? 'var(--bg)' : 'var(--surface)',
                color: done ? 'var(--accent-fg)' : now ? 'var(--accent)' : 'var(--text-5)',
                border: `2px solid ${done || now ? 'var(--accent)' : 'var(--border-3)'}`,
                animation: now ? 'igRing 1.8s infinite' : undefined,
                transition: 'background 400ms, border-color 400ms, color 400ms',
              }}>{done ? '✓' : i + 1}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, textAlign: 'center', maxWidth: '100%', overflowWrap: 'anywhere',
                color: now ? 'var(--text-1)' : done ? 'var(--text-2)' : 'var(--text-5)' }}>{UGC_STAGE_LABELS[s]}</span>
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text-4)', marginRight: 4 }}>Holds / exits</span>
        {offPath.map(s => {
          const now = s === stage;
          const pal = UGC_STAGE_PALETTE[s] || { fg: 'var(--text-2)', bg: 'var(--chip-neutral)' };
          return (
            <button key={s} type="button" onClick={() => onPick(s)} disabled={!canManage}
              className={canManage && !now ? 'ig-ghost-btn' : undefined}
              style={{
                padding: '4px 11px', borderRadius: 99, fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: now ? 700 : 600,
                whiteSpace: 'nowrap', color: now ? pal.fg : 'var(--text-3)', background: now ? pal.bg : 'transparent',
                border: `1px solid ${now ? pal.fg : 'var(--border-3)'}`, cursor: canManage && !now ? 'pointer' : 'default',
              }}>{UGC_STAGE_LABELS[s]}</button>
          );
        })}
      </div>
    </div>
  );
}

function ProductsCard({ products, engagementId, canEdit, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);
  const [productsValid, setProductsValid] = useState(true);
  function startEdit() {
    setLines((products || []).map(p => ({
      product_code: p.product_code || '', product_variant: p.product_variant || '',
      // product_ref/cogs_inr must survive the editor round-trip — see engagements/detail.
      product_ref: p.product_ref || null, cogs_inr: p.cogs_inr ?? null,
      quantity: p.quantity ?? 1, goodies_cost: p.goodies_cost ?? '', shipping_cost: p.shipping_cost ?? '',
    })));
    setEditing(true);
  }
  async function saveLines() {
    // Unresolved product line — refuse, don't just grey the button (2026-09-04).
    if (!productsValid || !linesAreValid(lines)) { toast('Pick a product from the list for every line', 'error'); return; }
    setBusy(true);
    try {
      await ignitionopsPost('setEngagementProducts', { engagement_id: engagementId, products: linesToPayload(lines) }, session);
      toast('Products updated', 'success'); setEditing(false); onSaved?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Card title="Product" action={canEdit && !editing ? 'Edit' : null} onAction={startEdit}>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ProductLinesEditor value={lines} onChange={setLines} session={session} onValidityChange={setProductsValid} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} className="ig-ghost-btn" style={ghostBtn}>Cancel</button>
            <button onClick={saveLines} disabled={busy || !productsValid} style={{ ...primaryBtn, opacity: (busy || !productsValid) ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : (products || []).length === 0 ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No products.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {products.map((p, i) => (
            <div key={p.id || i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 14, padding: '8px 0', borderTop: i ? '1px solid var(--row-divider)' : 'none' }}>
              <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{titleish(p.product_code) || '—'}</span>
              {p.product_variant && <span style={{ color: 'var(--text-2)' }}>{titleish(p.product_variant)}</span>}
              {Number(p.quantity) > 1 && <span style={{ color: 'var(--text-3)' }}>×{p.quantity}</span>}
              {p.goodies_cost != null && <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-3)' }}>{inr(p.goodies_cost)}</span>}
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
    <Card title="Hook" action={canEdit && !editing ? 'Edit' : null} onAction={start}>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Version (A/B/C)"><input value={form.hook_version} onChange={ev => setForm(f => ({ ...f, hook_version: ev.target.value }))} style={inp} /></Field>
          <Field label="Script"><textarea rows={4} value={form.hook_script} onChange={ev => setForm(f => ({ ...f, hook_script: ev.target.value }))} style={{ ...inp, resize: 'vertical' }} /></Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} className="ig-ghost-btn" style={ghostBtn}>Cancel</button>
            <button onClick={save} disabled={busy} className="ig-cta" style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
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
    <Card title="Ad performance" action={canEdit && !editing ? 'Edit' : null} onAction={start}>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {AD_FIELDS.map(([k, label, type]) => (
            <Field key={k} label={label}>
              <input type={type === 'text' ? 'text' : 'number'} value={form[k]}
                onChange={ev => setForm(f => ({ ...f, [k]: ev.target.value }))} style={inp} />
            </Field>
          ))}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} className="ig-ghost-btn" style={ghostBtn}>Cancel</button>
            <button onClick={save} disabled={busy} className="ig-cta" style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
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
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={refreshMeta} disabled={refreshing || !e.meta_ad_id} className="ig-ghost-btn" style={ghostBtn}>
            {refreshing ? 'Refreshing…' : 'Refresh from Meta'}
          </button>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-4)' }}>
            {e.meta_synced_at ? `Last synced ${new Date(e.meta_synced_at).toLocaleString('en-IN')}` : 'Never synced'}
          </span>
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-4)' }}>
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
    <Card title="Payment" action={canEdit && !editing ? 'Edit' : null} onAction={start}>
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
            <button onClick={() => setEditing(false)} className="ig-ghost-btn" style={ghostBtn}>Cancel</button>
            <button onClick={save} disabled={busy} className="ig-cta" style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
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
          <KV label="Outstanding" value={<strong style={{ color: commOut > 0 ? 'var(--accent-hi)' : 'var(--text-1)' }}>{inr(Math.max(commOut, 0))}</strong>} />
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
          {isTrack ? 'A shipping tracking link is required to mark this shipped.' : 'A video link is required to mark this live.'}
        </div>
        <div>
          <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)' }}>{label} *</label>
          <input value={val} onChange={ev => setVal(ev.target.value)} placeholder="https://…"
            style={{ ...inp, marginTop: 6 }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} className="ig-ghost-btn" style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy || !val.trim()} style={{ ...primaryBtn, opacity: busy || !val.trim() ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Confirm'}</button>
        </div>
      </div>
    </Modal>
  );
}

function KV({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderTop: '1px solid var(--row-divider)', alignItems: 'baseline' }}>
      <span style={{ width: 132, flexShrink: 0, color: 'var(--text-3)', fontSize: 13 }}>{label}</span>
      <span style={{ color: 'var(--text-1)', fontSize: 14, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)' }}>{label}</span>
      {children}
    </div>
  );
}

const inp = { width: '100%', boxSizing: 'border-box', background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', padding: '9px 12px', fontFamily: 'var(--font-ui)', fontSize: 14 };
const primaryBtn = { height: 36, padding: '0 16px', background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
const ghostBtn = { height: 36, padding: '0 14px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const primaryBtnLg = { ...primaryBtn, height: 40, padding: '0 18px', fontSize: 14 };
const ghostBtnLg = { ...ghostBtn, height: 40, color: 'var(--text-1)' };
