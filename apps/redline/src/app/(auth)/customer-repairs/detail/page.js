'use client';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel, Chip, StatusBadge, useToast } from '@throttle/ui';
import { STAGES, StageBadge, fmtDate } from '../page.js';

const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 12px', fontSize: 13, color: 'var(--t1)', outline: 'none', fontFamily: 'var(--mono)', width: '100%' };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block', fontWeight: 600 };
const btnP  = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '8px 14px', fontSize: 13, color: '#0a0a0a', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 14px', fontSize: 13, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--mono)' };

const EDITABLE_FIELDS = [
  'customer_name','customer_phone','customer_address',
  'order_id','channel','product_claim','awb','logistics_partner',
  'pickup_contact','notes',
];

export default function CustomerRepairDetailPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>}>
      <CustomerRepairDetailInner />
    </Suspense>
  );
}

function CustomerRepairDetailInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const id = sp.get('id');
  const { session, perms } = useAuth();
  const { toast } = useToast();
  const allowed = hasPermission(perms, 'customer_repair_manage') || hasPermission(perms, 'users_manage');

  const [repair,    setRepair]    = useState(null);
  const [history,   setHistory]   = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [form,      setForm]      = useState({});
  const [saving,    setSaving]    = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [jumpTarget,setJumpTarget]= useState('');
  const [advanceNote, setAdvanceNote] = useState('');

  const load = useCallback(async () => {
    if (!session || !allowed || !id) return;
    setLoading(true);
    try {
      const r = await workerFetch('getCustomerRepair', { data: { id } }, session);
      if (!r?.ok) { toast(r?.error || 'Failed to load', 'err'); return; }
      const { history: hist = [], ...rest } = r.data || {};
      setRepair(rest);
      setHistory(hist);
      // Seed form from loaded record
      const seed = {};
      EDITABLE_FIELDS.forEach(k => { seed[k] = rest[k] ?? ''; });
      setForm(seed);
    } catch (e) {
      toast(e.message || 'Failed', 'err');
    } finally { setLoading(false); }
  }, [session, allowed, id, toast]);

  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(() => {
    if (!repair) return false;
    return EDITABLE_FIELDS.some(k => (form[k] ?? '') !== (repair[k] ?? ''));
  }, [form, repair]);

  async function saveChanges() {
    if (!dirty) return;
    setSaving(true);
    try {
      const patch = { id };
      EDITABLE_FIELDS.forEach(k => {
        if ((form[k] ?? '') !== (repair[k] ?? '')) patch[k] = form[k] || null;
      });
      const r = await workerFetch('updateCustomerRepair', { data: patch }, session);
      if (!r?.ok) { toast(r?.error || 'Save failed', 'err'); return; }
      toast(`Updated ${(r.data?.updated_fields || []).length} field(s)`, 'ok');
      load();
    } catch (e) {
      toast(e.message || 'Failed', 'err');
    } finally { setSaving(false); }
  }

  async function advance(targetStage) {
    if (!repair) return;
    if (advancing) return;
    setAdvancing(true);
    try {
      const payload = { id };
      if (targetStage) payload.target_stage = targetStage;
      if (advanceNote.trim()) payload.note = advanceNote.trim();
      const r = await workerFetch('advanceCustomerRepairStage', { data: payload }, session);
      if (!r?.ok) { toast(r?.error || 'Advance failed', 'err'); return; }
      toast(`Advanced to ${r.data.stage.replace(/_/g, ' ')}`, 'ok');
      setAdvanceNote('');
      setJumpTarget('');
      load();
    } catch (e) {
      toast(e.message || 'Failed', 'err');
    } finally { setAdvancing(false); }
  }

  if (!allowed) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState icon="🔒" message="Access denied — you need customer_repair_manage permission." />
      </div>
    );
  }

  if (!id) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState icon="❓" message="Missing id — no repair id supplied in the URL." />
      </div>
    );
  }

  if (loading && !repair) {
    return <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  }

  if (!repair) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState icon="🔍" message="Not found — that repair record does not exist." />
        <button onClick={() => router.push('/customer-repairs')} style={btnS}>← Back to list</button>
      </div>
    );
  }

  const currentIdx = STAGES.findIndex(s => s.id === repair.stage);
  const isFinal    = currentIdx === STAGES.length - 1;
  const nextStage  = !isFinal ? STAGES[currentIdx + 1] : null;
  const laterStages = STAGES.slice(currentIdx + 2); // skip-ahead options (excludes the immediate next)

  return (
    <div style={{ padding: 16 }}>
      {/* Header strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <button onClick={() => router.push('/customer-repairs')} style={btnS}>← Back</button>
        <span style={{ fontFamily: 'var(--cond)', fontSize: 22, color: 'var(--yellow)', fontWeight: 700, letterSpacing: '0.04em' }}>{repair.repair_no}</span>
        <StageBadge stage={repair.stage} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '0.04em' }}>
          Captured {fmtDate(repair.captured_at)}{repair.captured_by_name ? ` · ${repair.captured_by_name}` : ''}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        {/* LEFT — editable form */}
        <div style={{ marginBottom: 16 }}>
        <Panel
          header="Details"
          headerAction={dirty ? (
            <button onClick={saveChanges} style={btnP} disabled={saving}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          ) : null}
        >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={lbl}>Customer name *</label>
                <input value={form.customer_name || ''} onChange={e => setForm({ ...form, customer_name: e.target.value })} style={input} />
              </div>
              <div>
                <label style={lbl}>Phone</label>
                <input value={form.customer_phone || ''} onChange={e => setForm({ ...form, customer_phone: e.target.value })} style={input} />
              </div>
              <div style={{ gridColumn: '1 / 3' }}>
                <label style={lbl}>Address</label>
                <textarea rows={2} value={form.customer_address || ''} onChange={e => setForm({ ...form, customer_address: e.target.value })} style={{ ...input, resize: 'vertical' }} />
              </div>
              <div>
                <label style={lbl}>Order ID</label>
                <input value={form.order_id || ''} onChange={e => setForm({ ...form, order_id: e.target.value })} style={input} />
              </div>
              <div>
                <label style={lbl}>Channel</label>
                <input value={form.channel || ''} onChange={e => setForm({ ...form, channel: e.target.value })} style={input} />
              </div>
              <div style={{ gridColumn: '1 / 3' }}>
                <label style={lbl}>Product claim / issue</label>
                <textarea rows={3} value={form.product_claim || ''} onChange={e => setForm({ ...form, product_claim: e.target.value })} style={{ ...input, resize: 'vertical' }} />
              </div>
              <div>
                <label style={lbl}>AWB / Tracking</label>
                <input value={form.awb || ''} onChange={e => setForm({ ...form, awb: e.target.value })} style={input} />
              </div>
              <div>
                <label style={lbl}>Logistics partner</label>
                <input value={form.logistics_partner || ''} onChange={e => setForm({ ...form, logistics_partner: e.target.value })} style={input} />
              </div>
              <div style={{ gridColumn: '1 / 3' }}>
                <label style={lbl}>Pickup contact</label>
                <input value={form.pickup_contact || ''} onChange={e => setForm({ ...form, pickup_contact: e.target.value })} style={input} />
              </div>
              <div style={{ gridColumn: '1 / 3' }}>
                <label style={lbl}>Internal notes</label>
                <textarea rows={2} value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ ...input, resize: 'vertical' }} />
              </div>
            </div>
        </Panel>
        </div>

        {/* RIGHT — stage timeline + advance + history */}
        <div>
          {/* Stage timeline */}
          <div style={{ marginBottom: 16 }}>
          <Panel header="Stage Timeline">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {STAGES.map((s, i) => {
                  const done    = i < currentIdx;
                  const current = i === currentIdx;
                  return (
                    <div key={s.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 8px', borderRadius: 3,
                      background: current ? 'rgba(242,205,26,.08)' : 'transparent',
                      border: current ? '1px solid rgba(242,205,26,.3)' : '1px solid transparent',
                    }}>
                      <span style={{
                        width: 18, height: 18, borderRadius: '50%',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                        background: done ? '#22c55e' : current ? 'var(--yellow)' : 'var(--surface2)',
                        color: done || current ? '#0a0a0a' : 'var(--t3)',
                        border: '1px solid ' + (done ? '#22c55e' : current ? 'var(--yellow)' : 'var(--border)'),
                      }}>{done ? '✓' : i + 1}</span>
                      <span style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 13,
                        color: current ? 'var(--yellow)' : done ? 'var(--t2)' : 'var(--t3)',
                        fontWeight: current ? 700 : 400,
                      }}>{s.label}</span>
                    </div>
                  );
                })}
              </div>

              {!isFinal ? (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                  <label style={lbl}>Stage change note (optional)</label>
                  <input value={advanceNote} onChange={e => setAdvanceNote(e.target.value)} placeholder="e.g. AWB confirmed by courier" style={input} />
                  <button onClick={() => advance()} style={{ ...btnP, width: '100%', marginTop: 10 }} disabled={advancing}>
                    {advancing ? 'Advancing…' : `→ ${nextStage.label}`}
                  </button>

                  {laterStages.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <label style={lbl}>Or jump to a later stage</label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <select value={jumpTarget} onChange={e => setJumpTarget(e.target.value)} style={{ ...input, flex: 1 }}>
                          <option value="">— pick stage —</option>
                          {laterStages.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                        </select>
                        <button
                          onClick={() => jumpTarget && advance(jumpTarget)}
                          disabled={!jumpTarget || advancing}
                          style={btnS}
                        >Jump</button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', textAlign: 'center' }}>
                  <StatusBadge variant="success" icon="✓">Closed · Dispatched</StatusBadge>
                </div>
              )}
          </Panel>
          </div>

          {/* History */}
          <Panel header={`History · ${history.length}`} padding={0}>
            <div style={{ padding: 16, maxHeight: 380, overflowY: 'auto' }}>
              {history.length === 0 ? (
                <div style={{ padding: 12, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No events</div>
              ) : history.map(h => (
                <div key={h.id} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid rgba(64,64,64,.5)' }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginBottom: 2, letterSpacing: '0.04em' }}>
                    {fmtDate(h.created_at)} · {h.actor_name || '—'}
                  </div>
                  {h.event_type === 'created' && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>Created repair record</div>
                  )}
                  {h.event_type === 'stage_changed' && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t1)' }}>
                      Stage: <em style={{ color: 'var(--t3)' }}>{(h.old_stage || '').replace(/_/g, ' ')}</em>
                      {' → '}
                      <strong style={{ color: 'var(--yellow)' }}>{(h.new_stage || '').replace(/_/g, ' ')}</strong>
                      {h.note && <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', marginTop: 2, fontStyle: 'italic' }}>"{h.note}"</div>}
                    </div>
                  )}
                  {h.event_type === 'updated' && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>
                      Updated: {Object.keys(h.changes || {}).join(', ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
