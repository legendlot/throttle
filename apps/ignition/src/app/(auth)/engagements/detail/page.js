'use client';
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Modal, useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import StageBadge from '../../../../components/StageBadge.js';
import StageStepper from '../../../../components/StageStepper.js';
import DealTypeBadge from '../../../../components/DealTypeBadge.js';
import AdvanceModal from '../../../../components/AdvanceModal.js';
import OpenPitstopButton from '../../../../components/OpenPitstopButton.js';
import ProductLinesEditor, { linesToPayload } from '../../../../components/ProductLinesEditor.js';

export default function EngagementDetailPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const id = sp.get('id');
  const eno = sp.get('engagement_no');
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [advOpen, setAdvOpen] = useState(false);
  const [note, setNote] = useState('');
  const [delOpen, setDelOpen] = useState(false);
  const canManage = !!perms?.ignition_manage;

  function reload() {
    if (!session || (!id && !eno)) return;
    const params = id ? { id } : { engagement_no: eno };
    ignitionopsGet('getEngagement', params, session).then(setData).catch(e => setErr(e.message));
  }
  useEffect(reload, [id, eno, session]);

  async function doAdvance({ to_stage, note, ...extra }) {
    // Forward all extra fields (video_link / rating / shipping_order_id /
    // expected_post_date) so the AdvanceModal's guard re-tries work.
    await ignitionopsPost('advanceStage', { engagement_id: data.engagement.id, to_stage, note, ...extra }, session);
    toast(`Advanced to ${to_stage}`, 'success');
    reload();
  }

  async function doDelete() {
    try {
      const res = await ignitionopsPost('deleteEngagement', { engagement_id: data.engagement.id }, session);
      toast(`Deleted ${res.engagement_no}`, 'success');
      router.push('/engagements');
    } catch (e) {
      if (/has_payments_cannot_delete/.test(e.message)) {
        toast('Has payments — cancel/close it instead of deleting.', 'error');
      } else {
        toast(e.message, 'error');
      }
      setDelOpen(false);
    }
  }

  async function addNote() {
    if (!note.trim()) return;
    await ignitionopsPost('addNote', { engagement_id: data.engagement.id, body: note }, session);
    setNote('');
    toast('Note added', 'success');
    reload();
  }

  if (err) return <div style={{ color: 'var(--state-error-fg)', padding: 16 }}>Error: {err}</div>;
  if (!data) return <Spinner />;
  const e = data.engagement;
  const inf = e.influencer || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1200 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: '#FF6B00', fontWeight: 700, fontSize: 18 }}>{e.engagement_no}</span>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {inf.channel_name || inf.influencer_code || '—'}
        </h1>
        <StageBadge stage={e.stage} size="lg" />
        <DealTypeBadge dealType={e.deal_type} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <OpenPitstopButton engagement={e} onLinked={reload} />
          <button
            onClick={() => setAdvOpen(true)}
            disabled={data.allowed_next.length === 0}
            style={{
              padding: '6px 14px', background: '#FF6B00', color: '#fff',
              border: 'none', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              cursor: data.allowed_next.length === 0 ? 'not-allowed' : 'pointer',
              opacity: data.allowed_next.length === 0 ? 0.5 : 1,
            }}
          >Advance →</button>
          {canManage && (
            <button
              onClick={() => setDelOpen(true)}
              style={{
                padding: '6px 14px', background: 'transparent', color: 'var(--state-error-fg)',
                border: '1px solid var(--state-error-fg)', borderRadius: 'var(--radius-sm)',
                fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
                letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
              }}
            >Delete</button>
          )}
        </div>
      </div>

      <Card title="Pipeline">
        <StageStepper stage={e.stage} />
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <Card title="Deal Terms">
          <KV label="Type" value={e.engagement_type === 'ugc' ? 'UGC' : 'Video'} />
          <KV label="Deal type" value={e.deal_type} />
          <KV label="Payment terms" value={e.payment_terms || '—'} />
          <KV label="Payment amount" value={`₹${Number(e.payment_amount || 0).toLocaleString()}`} />
          {(() => {
            const agreed = Number(e.payment_amount || 0);
            const paid = Number(data.paid_total || 0);
            const done = agreed > 0 && paid >= agreed;
            return (
              <KV label="Paid" value={
                <span style={{ color: done ? '#27c93f' : paid > 0 ? '#F2CD1A' : 'var(--text-3)', fontWeight: 600 }}>
                  ₹{paid.toLocaleString()} of ₹{agreed.toLocaleString()}{done ? ' ✓' : ''}
                </span>
              } />
            );
          })()}
          {e.affiliate_pct != null && <KV label="Affiliate %" value={`${e.affiliate_pct}%`} />}
          {e.commission_amount != null && <KV label="Commission" value={`₹${Number(e.commission_amount).toLocaleString()}`} />}
        </Card>

        <ProductsCard
          products={data.products || []}
          directedTo={e.directed_to}
          engagementId={e.id}
          canEdit={canManage}
          session={session}
          onSaved={reload}
        />

        <Card title="POC">
          <KV label="Assigned to" value={e.poc_name || '—'} />
        </Card>

        <Card title="Costs">
          <KV label="Goodies" value={`₹${Number(e.goodies_cost || 0).toLocaleString()}`} />
          <KV label="Shipping" value={`₹${Number(e.shipping_cost || 0).toLocaleString()}`} />
          <KV label="Return" value={`₹${Number(e.return_cost || 0).toLocaleString()}`} />
          <KV label="Ad spend" value={`₹${Number(e.ad_spend || 0).toLocaleString()}`} />
          <KV label="CPM" value={e.cpm != null
            ? <span style={{ color: Number(e.cpm) > 100 ? 'var(--state-error-fg)' : 'var(--text-1)', fontWeight: Number(e.cpm) > 100 ? 700 : 400 }}>
                ₹{Number(e.cpm).toFixed(2)}{Number(e.cpm) > 100 ? ' ⚠ high' : ''}
              </span>
            : '—'} />
          <KV label="TOTAL" value={<strong style={{ color: '#FF6B00' }}>₹{Number(e.total_cost || 0).toLocaleString()}</strong>} />
        </Card>

        <Card title="Logistics">
          <KV label="Shipping order" value={e.shipping_order_id || '—'} />
          <KV label="Tracking" value={e.tracking_id || '—'} />
          <KV label="Shipping date" value={e.shipping_date || '—'} />
          <KV label="Delivered" value={e.delivered_date || '—'} />
          {e.cs_ticket_no && <KV label="Pitstop ticket" value={<span style={{ color: 'var(--state-error-fg)' }}>{e.cs_ticket_no}</span>} />}
        </Card>

        <Card title="Post-live">
          <KV label="Expected post" value={e.expected_post_date || '—'} />
          <KV label="Actual post" value={e.post_date || '—'} />
          <KV label="Video link" value={e.video_link ? <a href={e.video_link} target="_blank" rel="noreferrer" style={{ color: '#FF6B00' }}>{e.video_link.slice(0, 40)}…</a> : '—'} />
          <KV label="UTM link" value={e.utm_link ? <a href={e.utm_link} target="_blank" rel="noreferrer" style={{ color: '#FF6B00' }}>open</a> : '—'} />
        </Card>

        <PerformanceCard
          e={e}
          canEdit={!!perms?.ignition_manage && ['live', 'completed'].includes(e.stage)}
          session={session}
          onSaved={reload}
        />

        <ComplianceCard e={e} canManage={canManage} session={session} onSaved={reload} />
      </div>

      <CodesCard engagementId={e.id} canManage={canManage} session={session} />

      <Card title="Notes">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={note} onChange={(ev) => setNote(ev.target.value)}
            placeholder="Add a note…"
            onKeyDown={(ev) => { if (ev.key === 'Enter') addNote(); }}
            style={{
              flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13,
            }}
          />
          <button onClick={addNote} style={{
            padding: '8px 14px', background: 'var(--surface-3)', color: 'var(--text-1)',
            border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer',
          }}>Add</button>
        </div>
        {data.notes.length === 0 ? <div style={{ color: 'var(--text-3)' }}>No notes yet.</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.notes.map(n => (
              <div key={n.id} style={{ padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>
                  {new Date(n.created_at).toLocaleString()}
                </div>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{n.body}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="History">
        {data.history.length === 0 ? <div style={{ color: 'var(--text-3)' }}>No history yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ background: 'var(--surface-2)' }}>
              <th style={th}>When</th><th style={th}>Action</th><th style={th}>From</th><th style={th}>To</th><th style={th}>Note</th>
            </tr></thead>
            <tbody>
              {data.history.map(h => (
                <tr key={h.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}>{new Date(h.created_at).toLocaleString()}</td>
                  <td style={td}>{h.action}</td>
                  <td style={td}>{h.stage_from || '—'}</td>
                  <td style={td}>{h.stage_to || '—'}</td>
                  <td style={td}>{h.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <AdvanceModal
        open={advOpen}
        engagement={e}
        onClose={() => setAdvOpen(false)}
        onAdvance={doAdvance}
      />

      {delOpen && (
        <Modal open title={`Delete ${e.engagement_no}?`} onClose={() => setDelOpen(false)}>
          <div style={{ minWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
              This permanently removes the deal and its products, notes and history.
              Deals with recorded payments can&apos;t be deleted — cancel/close them instead.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setDelOpen(false)} style={{ padding: '8px 14px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
              <button onClick={doDelete} style={{ padding: '8px 14px', background: 'var(--state-error-fg)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Delete deal</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Multi-product lines (#4) with inline edit → setEngagementProducts (replace-set,
// rolls cost up on the worker). Legacy single-product deals show a synthesized line.
function ProductsCard({ products, directedTo, engagementId, canEdit, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);

  function startEdit() {
    setLines((products || []).map(p => ({
      product_code: p.product_code || '',
      product_variant: p.product_variant || '',
      quantity: p.quantity ?? 1,
      goodies_cost: p.goodies_cost ?? '',
      shipping_cost: p.shipping_cost ?? '',
    })));
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    try {
      await ignitionopsPost('setEngagementProducts', { engagement_id: engagementId, products: linesToPayload(lines) }, session);
      toast('Products updated', 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Products</h2>
        {canEdit && !editing && (
          <button onClick={startEdit} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
        )}
      </div>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ProductLinesEditor value={lines} onChange={setLines} session={session} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : (
        <>
          {(products || []).length === 0 ? (
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No products.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {products.map((p, i) => (
                <div key={p.id || i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{p.product_code || '—'}</span>
                  {p.product_variant && <span style={{ color: 'var(--text-2)' }}>{p.product_variant}</span>}
                  {Number(p.quantity) > 1 && <span style={{ color: 'var(--text-3)' }}>×{p.quantity}</span>}
                  {p.goodies_cost != null && <span style={{ marginLeft: 'auto', color: 'var(--text-3)' }}>₹{Number(p.goodies_cost).toLocaleString()}</span>}
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <KV label="Directed to" value={directedTo || '—'} />
          </div>
        </>
      )}
    </section>
  );
}

// #13 — editable performance stats once the deal is live/completed.
const METRIC_FIELDS = [
  ['views', 'Views'], ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'],
  ['impressions', 'Impressions'], ['sessions', 'Sessions'], ['orders', 'Orders'],
  ['conversions_value', 'Conversions ₹'],
];

function PerformanceCard({ e, canEdit, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);

  function startEdit() {
    const f = {};
    for (const [k] of METRIC_FIELDS) f[k] = e[k] ?? '';
    setForm(f); setEditing(true);
  }
  async function save() {
    setBusy(true);
    try {
      const patch = { engagement_id: e.id };
      for (const [k] of METRIC_FIELDS) patch[k] = form[k] === '' ? null : Number(form[k]);
      await ignitionopsPost('updateEngagement', patch, session);
      toast('Performance updated', 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Performance</h2>
        {canEdit && !editing && (
          <button onClick={startEdit} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
        )}
      </div>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {METRIC_FIELDS.map(([k, label]) => (
            <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
              <input type="number" value={form[k]} onChange={ev => setForm(f => ({ ...f, [k]: ev.target.value }))}
                style={{ flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 13 }} />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => setEditing(false)} style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : (
        <>
          <KV label="Views" value={(e.views || 0).toLocaleString()} />
          <KV label="Likes" value={(e.likes || 0).toLocaleString()} />
          <KV label="Comments" value={(e.comments || 0).toLocaleString()} />
          <KV label="Shares" value={(e.shares || 0).toLocaleString()} />
          <KV label="Impressions" value={(e.impressions || 0).toLocaleString()} />
          <KV label="Sessions" value={(e.sessions || 0).toLocaleString()} />
          <KV label="Orders" value={(e.orders || 0).toLocaleString()} />
          <KV label="Conversions ₹" value={`₹${Number(e.conversions_value || 0).toLocaleString()}`} />
          {e.actual_roas != null && <KV label="Actual ROAS" value={Number(e.actual_roas).toFixed(2)} />}
        </>
      )}
    </section>
  );
}

// Coupon registry + attribution per engagement (Batch B theme ②). Gift = internal
// 100%-off own-order record; affiliate = per-video code for the audience, multi-use,
// commission accrues only while the engagement is live. Codes are created on / retired
// from Shopify; "Sync" reconciles redemptions (net of refunds) onto the deal.
function CodesCard({ engagementId, canManage, session }) {
  const { showToast: toast } = useToast();
  const [coupons, setCoupons] = useState(null);
  const [pct, setPct] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    if (!session || !engagementId) return;
    ignitionopsGet('getCouponsForEngagement', { engagement_id: engagementId }, session)
      .then(r => setCoupons(r.coupons || [])).catch(() => setCoupons([]));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [engagementId, session]);

  async function issue(kind) {
    setBusy(true);
    try {
      const body = { engagement_id: engagementId, kind };
      if (kind === 'affiliate') {
        const p = Number(pct);
        if (!p || p <= 0 || p > 100) { toast('Enter a discount % (1–100)', 'error'); setBusy(false); return; }
        body.discount_pct = p;
      }
      const res = await ignitionopsPost('issueCoupon', body, session);
      if (res.shopify === 'created') toast(`Code ${res.coupon.code} created on Shopify`, 'success');
      else toast(`Code ${res.coupon.code} reserved — Shopify pending (${res.note || 'add write_discounts'})`, 'info');
      setPct(''); load();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }
  async function retire(id) {
    if (!window.confirm('Retire this code? It will be deactivated on Shopify; redemption history is kept.')) return;
    try { await ignitionopsPost('retireCoupon', { coupon_code_id: id }, session); toast('Code retired', 'success'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function sync(id) {
    try { const r = await ignitionopsPost('syncCouponRedemptions', { coupon_code_id: id }, session); toast(`Redemptions synced (${r.synced})`, 'success'); load(); }
    catch (e) { toast(e.message === 'shopify_not_configured' ? 'Shopify not connected' : e.message, 'error'); }
  }

  const gift = (coupons || []).filter(c => c.kind === 'gift');
  const aff = (coupons || []).filter(c => c.kind === 'affiliate');

  return (
    <Card title="Codes & attribution">
      {coupons == null ? <div style={{ color: 'var(--text-3)' }}>Loading…</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={subhead}>Affiliate code — for the creator&apos;s audience</div>
            {aff.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>None yet.</div>
              : aff.map(c => <CodeRow key={c.id} c={c} canManage={canManage} onRetire={retire} onSync={sync} big />)}
            {canManage && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <input type="number" min="1" max="100" placeholder="% off" value={pct} onChange={e => setPct(e.target.value)} style={pctInp} />
                <button onClick={() => issue('affiliate')} disabled={busy} style={issueBtn}>Issue affiliate code</button>
              </div>
            )}
          </div>
          <div>
            <div style={subhead}>Gift code — internal, places the creator&apos;s free order (100% off)</div>
            {gift.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>None yet.</div>
              : gift.map(c => <CodeRow key={c.id} c={c} canManage={canManage} onRetire={retire} onSync={sync} />)}
            {canManage && <button onClick={() => issue('gift')} disabled={busy} style={{ ...issueBtn, marginTop: 8 }}>Issue gift code</button>}
          </div>
        </div>
      )}
    </Card>
  );
}

// Post-live compliance checklist (B12) + gifted-but-never-posted flag (B14).
function ComplianceCard({ e, canManage, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [busy, setBusy] = useState(false);
  const postLive = ['live', 'completed'].includes(e.stage);
  const checks = [
    ['compliance_caption_link', 'Link in caption'],
    ['compliance_coupon_verbal', 'Coupon mentioned verbally'],
    ['compliance_car_motion', 'Car in motion 15–20s'],
  ];
  async function toggle(key, val) {
    setBusy(true);
    try { await ignitionopsPost('updateEngagement', { engagement_id: e.id, [key]: val }, session); onSaved?.(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  async function flagGifted(val) {
    if (val && !window.confirm('Mark as gifted-but-never-posted? This flags the creator do-not-ship.')) return;
    setBusy(true);
    try { await ignitionopsPost('markGiftedNoPost', { engagement_id: e.id, value: val }, session); toast(val ? 'Flagged' : 'Cleared', 'success'); onSaved?.(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  const anyFalse = checks.some(([k]) => e[k] === false);
  const allTrue = checks.every(([k]) => e[k] === true);
  return (
    <Card title="Compliance & flags">
      {postLive ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {checks.map(([k, label]) => (
              <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: canManage ? 'pointer' : 'default' }}>
                <input type="checkbox" disabled={!canManage || busy} checked={e[k] === true} onChange={ev => toggle(k, ev.target.checked)} />
                <span style={{ color: 'var(--text-2)' }}>{label}</span>
              </label>
            ))}
          </div>
          {allTrue ? <span style={okPill}>Compliant ✓</span>
            : anyFalse ? <span style={badPill}>Non-compliant — request correction</span>
            : <span style={{ color: 'var(--text-3)', fontSize: 12 }}>Not reviewed yet</span>}
        </>
      ) : (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Checklist appears once the deal is live.</div>
      )}
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        {e.gifted_no_post ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={badPill}>Gifted · never posted</span>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>creator set do-not-ship</span>
            {canManage && <button onClick={() => flagGifted(false)} disabled={busy} style={miniBtn}>Clear</button>}
          </div>
        ) : (
          canManage && <button onClick={() => flagGifted(true)} disabled={busy} style={miniBtn}>Flag &ldquo;gifted, never posted&rdquo;</button>
        )}
      </div>
    </Card>
  );
}
const okPill = { display: 'inline-block', fontSize: 11, color: '#27c93f', border: '1px solid #27c93f', borderRadius: 'var(--radius-sm)', padding: '3px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' };
const badPill = { display: 'inline-block', fontSize: 11, color: 'var(--state-error-fg)', border: '1px solid var(--state-error-fg)', borderRadius: 'var(--radius-sm)', padding: '3px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' };

function CodeRow({ c, canManage, onRetire, onSync, big }) {
  const retired = c.status === 'retired';
  const pending = c.status === 'pending_shopify';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: big ? 18 : 14, color: retired ? 'var(--text-3)' : '#FF6B00', textDecoration: retired ? 'line-through' : 'none', letterSpacing: '0.04em' }}>{c.code}</span>
      <span style={pill}>{c.discount_pct}% off</span>
      {pending && <span style={{ ...pill, color: '#F2CD1A', borderColor: '#F2CD1A' }}>Shopify pending</span>}
      {retired && <span style={{ ...pill, color: 'var(--text-3)' }}>retired</span>}
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
        {c.redemptions || 0} uses · ₹{Number(c.attributed_revenue_net || 0).toLocaleString()} net
        {c.kind === 'affiliate' ? ` · ₹${Number(c.commission_accrued || 0).toLocaleString()} commission` : ''}
      </span>
      {canManage && !retired && (
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => onSync(c.id)} style={miniBtn}>Sync</button>
          <button onClick={() => onRetire(c.id)} style={miniBtn}>Retire</button>
        </span>
      )}
    </div>
  );
}

const subhead = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, fontWeight: 600 };
const pill = { fontSize: 10, color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '2px 6px', textTransform: 'uppercase', letterSpacing: '0.04em' };
const pctInp = { width: 90, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const issueBtn = { padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
const miniBtn = { padding: '4px 10px', background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' };

function Card({ title, children }) {
  return (
    <section style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)', padding: 16,
    }}>
      <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>{title}</h2>
      {children}
    </section>
  );
}

function KV({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
      <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ color: 'var(--text-1)', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
    </div>
  );
}
const th = { padding: '6px 10px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, textAlign: 'left' };
const td = { padding: '6px 10px' };
