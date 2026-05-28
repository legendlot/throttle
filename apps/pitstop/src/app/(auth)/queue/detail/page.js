'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Modal, Spinner, useToast } from '@throttle/ui';
import { ChevronLeft, AlertCircle, Plus, Link2, MessageSquare, ChevronRight } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../../lib/csopsFetch.js';
import { ShopifyPanel } from '../../../../components/ShopifyPanel.js';
import WhatsAppPanel from '../../../../components/WhatsAppPanel.js';
import { DISPOSITION_VALUES, DISPOSITION_LABELS } from '../../../../lib/dispositions.js';
import { DispositionBadge } from '../../../../components/DispositionBadge.js';

// ── Domain constants (mirror csops worker) ───────────────────────────────────

const SHARED = ['intake','awaiting_evidence','verified','pickup_scheduled','picked_up','at_warehouse','inspected'];
const BRANCH = {
  replacement: ['replacement_dispatched'],
  refund:      ['refund_initiated','refund_completed'],
  repair:      ['handed_to_production','repaired_ready','repair_dispatched'],
};

// Stages that allow disposition changes without admin
const TRIAGE_STAGES = new Set(['intake', 'awaiting_evidence']);

function lifecycleStages(disposition) {
  if (disposition === 'query' || disposition === 'no_action') {
    return ['intake', 'closed'];
  }
  if (disposition === 'awaiting_info') {
    return ['intake', 'awaiting_evidence'];
  }
  // replacement | refund | repair | pending → full logistics path
  return [...SHARED, ...(BRANCH[disposition] || []), 'closed'];
}

function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone);
  return s.length < 4 ? s : s.slice(0, -3) + '***';
}

function ageDays(createdAt) {
  if (!createdAt) return 0;
  return (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function TicketDetailPage() {
  const { user, session, perms } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const ticket_no = searchParams.get('ticket_no');
  const { showToast } = useToast();

  const [data, setData] = useState(null);  // { ticket, history, attachments, notes, links, dispatch_info, past_cases, repair_run }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showRevealPhone, setShowRevealPhone] = useState(false);

  const refresh = useCallback(async () => {
    if (!session || !ticket_no) return;
    setLoading(true);
    try {
      const d = await csopsGet('getTicket', { ticket_no }, session);
      setData(d);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [session, ticket_no]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!ticket_no) {
    return (
      <div style={{ padding: 24, color: 'var(--state-error-fg)' }}>
        Missing ticket_no query parameter. <Link href="/queue" style={{ color: 'var(--t2)', textDecoration: 'underline' }}>Back to queue</Link>
      </div>
    );
  }

  if (loading && !data) return <Spinner />;
  if (error) {
    return (
      <div>
        <BackLink />
        <div style={{ padding: 16, background: 'var(--state-error-bg)', color: 'var(--state-error-fg)', borderRadius: 'var(--radius-md)' }}>
          {error}
        </div>
      </div>
    );
  }
  if (!data) return null;

  const t = data.ticket;
  const stages = lifecycleStages(t.disposition);
  const stageIndex = stages.indexOf(t.stage);
  const isClosed = !!t.closed_at;

  return (
    <div>
      <BackLink />

      {/* Header */}
      <DetailHeader ticket={t} onRefresh={refresh} session={session} stages={stages} perms={perms} />

      {/* Stepper */}
      <Stepper stages={stages} currentIndex={stageIndex} closed={isClosed} disposition={t.disposition} />

      {/* Three-column body */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(260px, 280px) minmax(0, 1fr) minmax(280px, 320px)',
        gap: 'var(--space-3)',
        marginTop: 'var(--space-4)',
      }}>
        <IdentityRail ticket={t} dispatch={data.dispatch_info} pastCases={data.past_cases} session={session} />
        <WorkArea ticket={t} dispatch={data.dispatch_info} repairRun={data.repair_run} session={session} perms={perms} onRefresh={refresh} stages={stages} />
        <ActivityFeed
          ticket={t}
          history={data.history}
          notes={data.notes}
          attachments={data.attachments}
          session={session}
          onRefresh={refresh}
        />
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function BackLink() {
  return (
    <Link href="/queue" style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontSize: 11,
      textDecoration: 'none', marginBottom: 'var(--space-3)',
      textTransform: 'uppercase', letterSpacing: '0.08em',
    }}>
      <ChevronLeft size={14} strokeWidth={1.75} /> Queue
    </Link>
  );
}

function DetailHeader({ ticket: t, onRefresh, session, stages, perms }) {
  const age = ageDays(t.created_at);
  const overdue = t.due_at && !t.closed_at && Date.now() > new Date(t.due_at).getTime();
  const daysOver = overdue ? Math.floor((Date.now() - new Date(t.due_at).getTime()) / (1000 * 60 * 60 * 24)) : 0;
  const stageIdx = stages.indexOf(t.stage);
  const inFlow = stageIdx >= 0;
  const nextStage = inFlow && stageIdx < stages.length - 1 ? stages[stageIdx + 1] : null;

  const [advancing, setAdvancing] = useState(false);
  const [dispositionBusy, setDispositionBusy] = useState(false);

  // Disposition triage lock: only admin can change once past intake/awaiting_evidence
  const isAdmin = !!(perms?.cs_ticket_admin);
  const triageLocked = !TRIAGE_STAGES.has(t.stage) && !isAdmin;

  async function handleDispositionChange(e) {
    const newDisp = e.target.value;
    if (!newDisp || newDisp === t.disposition) return;
    setDispositionBusy(true);
    try {
      await csopsPost('updateTicket', { ticket_id: t.id, patch: { disposition: newDisp } }, session);
      onRefresh();
    } catch (err) {
      console.error('disposition update failed:', err.message);
      showToast('Failed to update disposition: ' + (err.message || 'unknown error'), 'error');
    } finally { setDispositionBusy(false); }
  }

  const advanceLabel = useMemo(() => {
    if (!nextStage) return null;
    const map = {
      awaiting_evidence:      'Mark Awaiting Evidence →',
      verified:               'Mark Verified →',
      pickup_scheduled:       'Schedule Pickup →',
      picked_up:              'Mark Picked Up →',
      at_warehouse:           'Mark at Warehouse →',
      inspected:              'Mark Inspected →',
      replacement_dispatched: 'Dispatch Replacement →',
      refund_initiated:       'Initiate Refund →',
      refund_completed:       'Mark Refund Complete →',
      handed_to_production:   'Hand to Production →',
      repaired_ready:         'Mark Repaired Ready →',
      repair_dispatched:      'Mark Repair Dispatched →',
      closed:                 'Close Ticket →',
    };
    return map[nextStage] || `Advance → ${nextStage}`;
  }, [nextStage]);

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)',
      padding: '16px 18px',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      marginBottom: 'var(--space-3)',
    }}>
      <div style={{ flex: 1 }}>
        <h1 style={{
          fontFamily: 'var(--font-cond)',
          fontSize: 'var(--text-xl)',
          fontWeight: 600, color: 'var(--t1)',
          marginBottom: 4,
        }}>
          {t.customer_name} — {t.product || 'Unknown product'}{t.product_model && ` · ${t.product_model}`}
        </h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--t3)', fontSize: 12 }}>{t.ticket_no}</span>
          <span style={{ color: 'var(--t4)' }}>·</span>
          <span style={{ color: 'var(--t3)', fontSize: 12 }}>created {new Date(t.created_at).toLocaleDateString()}</span>
          <span style={{ color: 'var(--t4)' }}>·</span>
          <span style={{ color: 'var(--t3)', fontSize: 12 }}>{age.toFixed(0)}d old</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {/* Disposition triage control */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
          <select
            value={t.disposition || 'pending'}
            onChange={handleDispositionChange}
            disabled={triageLocked || dispositionBusy || !!t.closed_at}
            style={{
              background: 'var(--surface-2)',
              color: 'var(--t1)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: '5px 8px',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              cursor: triageLocked || !!t.closed_at ? 'not-allowed' : 'pointer',
              opacity: triageLocked ? 0.6 : 1,
            }}
          >
            {DISPOSITION_VALUES.map(d => (
              <option key={d} value={d}>{DISPOSITION_LABELS[d]}</option>
            ))}
          </select>
          {triageLocked && (
            <span style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}>
              admin only past triage
            </span>
          )}
        </div>

        <DispositionBadge disposition={t.disposition} />

        {overdue && (
          <span style={{
            padding: '3px 10px',
            background: 'var(--state-error-bg)',
            color: 'var(--state-error-fg)',
            border: '1px solid var(--state-error)',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
          }}>
            SLA: {daysOver}d over
          </span>
        )}
        {nextStage && !t.closed_at && (
          <AdvanceButton
            label={advanceLabel}
            ticket={t}
            nextStage={nextStage}
            session={session}
            onAdvanced={onRefresh}
            disabled={advancing}
          />
        )}
      </div>
    </div>
  );
}

function AdvanceButton({ label, ticket, nextStage, session, onAdvanced }) {
  const [modalOpen, setModalOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setModalOpen(true)}
        style={{
          padding: '8px 14px',
          background: 'var(--brand-red)',
          color: '#fff',
          border: '1px solid var(--brand-red)',
          borderRadius: 'var(--radius-md)',
          fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        {label}
      </button>
      <AdvanceModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        ticket={ticket}
        targetStage={nextStage}
        session={session}
        onAdvanced={() => { setModalOpen(false); onAdvanced(); }}
      />
    </>
  );
}

function AdvanceModal({ open, onClose, ticket, targetStage, session, onAdvanced }) {
  const [form, setForm] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Reset form on open
  useEffect(() => { if (open) { setForm({}); setError(null); } }, [open]);

  // Field configurations per target stage
  const fields = useMemo(() => {
    switch (targetStage) {
      case 'pickup_scheduled':       return [
        { name: 'return_awb', label: 'Return AWB', required: true },
        { name: 'return_courier', label: 'Courier', required: true },
        { name: 'return_tracking_url', label: 'Tracking URL', type: 'url' },
      ];
      case 'inspected':              return [
        { name: 'inspection_note', label: 'Inspection note', required: true, multiline: true },
        { name: 'return_cost_inr', label: 'Return cost (₹)', type: 'number' },
      ];
      case 'replacement_dispatched': return [
        { name: 'replacement_unit_upc', label: 'New unit UPC', required: true },
        { name: 'replacement_awb', label: 'Replacement AWB', required: true },
        { name: 'replacement_cost_inr', label: 'Replacement cost (₹)', type: 'number' },
      ];
      case 'refund_initiated':       return [
        { name: 'refund_amount_inr', label: 'Refund amount (₹)', required: true, type: 'number' },
      ];
      case 'refund_completed':       return [
        { name: 'refund_reference', label: 'UTR / payment reference', required: true },
      ];
      case 'handed_to_production':   return [
        { name: 'repair_run_id', label: 'Production run ID (optional)', type: 'number' },
      ];
      default: return [];
    }
  }, [targetStage]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const patch = {};
      for (const f of fields) {
        const v = form[f.name];
        if (v !== undefined && v !== '') {
          patch[f.name] = f.type === 'number' ? Number(v) : v;
        }
      }
      await csopsPost('advanceStage', {
        ticket_id: ticket.id,
        target_stage: targetStage,
        patch,
      }, session);
      onAdvanced();
    } catch (e) {
      setError(e.message);
    } finally { setSubmitting(false); }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Advance to: ${targetStage}`}
      confirmLabel={submitting ? 'Advancing…' : 'Advance'}
      onConfirm={submit}
      loading={submitting}
      error={error}
    >
      {fields.length === 0 ? (
        <p style={{ color: 'var(--t2)', fontSize: 13 }}>
          No additional fields required. Click <strong>Advance</strong> to confirm.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {fields.map(f => (
            <label key={f.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: 'var(--t3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--font-mono)' }}>
                {f.label}{f.required && <span style={{ color: 'var(--state-error-fg)' }}> *</span>}
              </span>
              {f.multiline ? (
                <textarea
                  value={form[f.name] || ''}
                  onChange={e => setForm(s => ({ ...s, [f.name]: e.target.value }))}
                  rows={3}
                  style={inputStyle}
                />
              ) : (
                <input
                  type={f.type || 'text'}
                  value={form[f.name] || ''}
                  onChange={e => setForm(s => ({ ...s, [f.name]: e.target.value }))}
                  style={inputStyle}
                />
              )}
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

const inputStyle = {
  background: 'var(--surface-2)',
  color: 'var(--t1)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '8px 10px',
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  outline: 'none',
};

function Stepper({ stages, currentIndex, closed, disposition }) {
  // For the awaiting_info disposition, relabel awaiting_evidence as "awaiting info"
  function stageLabel(s) {
    if (disposition === 'awaiting_info' && s === 'awaiting_evidence') return 'awaiting info';
    return s;
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 0,
      padding: '14px 18px',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      overflowX: 'auto',
    }}>
      {stages.map((s, i) => {
        const done = i < currentIndex || (closed && s === 'closed');
        const current = i === currentIndex && !closed;
        const dotBg = done ? 'var(--state-success)' : current ? 'var(--brand-red)' : 'var(--surface-3)';
        const dotShadow = current ? '0 0 0 3px rgba(222, 42, 42, 0.25)' : 'none';
        return (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 0, flexShrink: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '0 6px' }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: dotBg, boxShadow: dotShadow }} />
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 9.5,
                color: current ? 'var(--t1)' : done ? 'var(--t2)' : 'var(--t4)',
                fontWeight: current ? 700 : 500,
                whiteSpace: 'nowrap',
                letterSpacing: '0.02em',
              }}>{stageLabel(s)}</div>
            </div>
            {i < stages.length - 1 && (
              <div style={{ width: 28, height: 1, background: done ? 'var(--state-success)' : 'var(--border)' }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function IdentityRail({ ticket: t, dispatch, pastCases, session }) {
  const [revealPhone, setRevealPhone] = useState(false);
  return (
    <aside style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-4)',
    }}>
      <SectionLabel>Customer</SectionLabel>
      <Field label="Name" value={t.customer_name} />
      <Field
        label="Phone"
        value={revealPhone ? t.customer_phone : maskPhone(t.customer_phone)}
        mono
        action={t.customer_phone && (
          <button onClick={() => setRevealPhone(v => !v)} style={miniLink}>
            {revealPhone ? 'hide' : 'reveal'}
          </button>
        )}
      />
      <Field label="Email" value={t.customer_email || '—'} />
      <Field label="Address" value={t.customer_address || '—'} small />

      <div style={{ marginBottom: 'var(--space-2)' }}>
        <ShopifyPanel session={session} phone={t.customer_phone} email={t.customer_email} autoLoad />
      </div>

      {t.call_session_id && <CallBlock ticket={t} />}

      <SectionLabel style={{ marginTop: 18 }}>Order</SectionLabel>
      <Field label="Platform" value={t.platform || '—'} />
      <Field label="Order ID"  value={t.external_order_id || '—'} mono />
      <Field label="UPC"       value={t.lot_unit_upc || '—'} mono />

      {dispatch?.unit && (
        <>
          <SectionLabel style={{ marginTop: 18 }}>Linked from LOT</SectionLabel>
          <LinkedCard title="Dispatch info">
            <div>Product: {dispatch.unit.product} · {dispatch.unit.model}{dispatch.unit.color ? ` · ${dispatch.unit.color}` : ''}</div>
            <div>SKU: {dispatch.unit.sku || '—'}</div>
            {dispatch.shipment && (
              <>
                <div>Shipped: {dispatch.shipment.shipped_at ? new Date(dispatch.shipment.shipped_at).toLocaleDateString() : '—'}</div>
                {dispatch.shipment.awb && <div>Outbound AWB: {dispatch.shipment.awb}</div>}
                {dispatch.shipment.courier && <div>Courier: {dispatch.shipment.courier}</div>}
              </>
            )}
            {dispatch.allocation?.box_id && <div>Box: {dispatch.allocation.box_id}</div>}
          </LinkedCard>
        </>
      )}

      {pastCases?.length > 0 && (
        <LinkedCard title={`Past cases (${pastCases.length})`}>
          {pastCases.map(p => (
            <div key={p.ticket_no} style={{ marginBottom: 4 }}>
              <Link href={`/queue/detail/?ticket_no=${p.ticket_no}`} style={{ color: '#7b93ff', textDecoration: 'none' }}>
                {p.ticket_no}
              </Link>
              {' '}— {DISPOSITION_LABELS[p.disposition] || p.disposition || 'pending'}, {p.stage}{p.closed_reason ? ` (${p.closed_reason})` : ''}
            </div>
          ))}
        </LinkedCard>
      )}
    </aside>
  );
}

function CallBlock({ ticket: t }) {
  function fmtDuration(secs) {
    if (secs == null) return '—';
    const s = Number(secs);
    const m = Math.floor(s / 60);
    const rem = String(s % 60).padStart(2, '0');
    return `${m}:${rem}`;
  }
  function fmtAnswered(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  return (
    <div style={{
      marginTop: 18,
      marginBottom: 'var(--space-2)',
      padding: 10,
      background: 'var(--surface-2)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8,
      }}>
        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 10,
          letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase',
          color: 'var(--t3)', fontWeight: 600,
        }}>Call</div>
        {t.call_direction && (
          <span style={{
            display: 'inline-block', padding: '2px 7px',
            background: 'var(--surface-3)', color: 'var(--t2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
            letterSpacing: '0.08em', textTransform: 'uppercase',
          }}>{t.call_direction}</span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Duration</span>
          <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--t1)' }}>{fmtDuration(t.call_duration_seconds)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Answered</span>
          <span style={{ fontSize: 11, color: 'var(--t2)' }}>{fmtAnswered(t.call_answered_at)}</span>
        </div>
        {(t.call_recording_url || t.call_recording_filename) && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
            <span style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Recording</span>
            {t.call_recording_url ? (
              <a
                href={t.call_recording_url}
                target="_blank"
                rel="noreferrer"
                style={{ color: '#7b93ff', textDecoration: 'underline', fontFamily: 'var(--font-mono)', fontSize: 11 }}
              >Recording</a>
            ) : (
              <span style={{ color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {t.call_recording_filename} <span style={{ color: 'var(--t4)' }}>(resolving)</span>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WorkArea({ ticket: t, dispatch, repairRun, session, perms, onRefresh, stages }) {
  const [editing, setEditing] = useState(null);   // 'issue' | 'return' | 'resolution' | null
  const stageIdx = stages.indexOf(t.stage);
  const inFlow = stageIdx >= 0;
  const sharedDone = inFlow && stageIdx >= SHARED.length;       // past `inspected`
  const inspectedReached = inFlow && stageIdx >= SHARED.indexOf('inspected');
  const isClosed = !!t.closed_at;

  // Editability gates — treat out-of-flow tickets as fully locked
  const canEditIssue   = inFlow && stageIdx <= SHARED.indexOf('verified') && !isClosed;
  const canEditReturn  = inFlow && stageIdx >= SHARED.indexOf('verified') && stageIdx <= SHARED.indexOf('inspected') && !isClosed;
  const canEditResolve = inFlow && stageIdx >= SHARED.indexOf('inspected') && !isClosed;

  // Build a readable reason string from issue category/subcategory
  function issueReason() {
    const cat = t.issue_category;
    const sub = t.issue_subcategory;
    const custom = t.issue_subcategory_custom;
    if (!cat && !sub) return '—';
    if (sub === 'Other' && custom) return `${cat || ''} › ${custom}`.trim().replace(/^›\s*/, '');
    if (cat && sub) return `${cat} › ${sub}`;
    return cat || sub || '—';
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', minWidth: 0 }}>
      <Panel
        title="Issue"
        subtitle={t.stage === 'verified' || stageIdx > SHARED.indexOf('verified')
          ? `verified · ${DISPOSITION_LABELS[t.disposition] || t.disposition || 'pending'}`
          : 'unverified'}
        editable={canEditIssue}
        onEdit={() => setEditing('issue')}
      >
        <PanelRow label="Disposition" value={<DispositionBadge disposition={t.disposition} />} />
        <PanelRow label="Reason"      value={issueReason()} />
        <PanelRow label="Description" value={t.issue_description} multiline />
      </Panel>

      <Panel
        title="Return logistics"
        subtitle={t.warehouse_received_at ? `at warehouse · received ${new Date(t.warehouse_received_at).toLocaleDateString()}` : `stage: ${t.stage}`}
        editable={canEditReturn}
        onEdit={() => setEditing('return')}
        locked={!inspectedReached && stageIdx < SHARED.indexOf('verified')}
        lockedMessage="Will unlock once the issue is verified."
      >
        <PanelGrid>
          <PanelField label="Return AWB" value={t.return_awb || '—'} mono />
          <PanelField label="Courier"    value={t.return_courier || '—'} />
          <PanelField label="Return cost" value={t.return_cost_inr ? `₹${t.return_cost_inr}` : '—'} mono />
          <PanelField label="Warehouse received" value={t.warehouse_received_at ? new Date(t.warehouse_received_at).toLocaleDateString() : '—'} />
        </PanelGrid>
        {t.inspection_note && (
          <div style={{ marginTop: 12, padding: 10, background: 'var(--surface-2)', borderRadius: 'var(--radius-md)', fontSize: 12.5, color: 'var(--t2)' }}>
            <div style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Inspection note</div>
            {t.inspection_note}
          </div>
        )}
      </Panel>

      <Panel
        title={`Resolution — ${DISPOSITION_LABELS[t.disposition] || 'Other'}`}
        subtitle={isClosed ? `closed · ${t.closed_reason || 'resolved'}` : (canEditResolve ? 'ready' : 'awaiting inspection')}
        editable={canEditResolve}
        onEdit={() => setEditing('resolution')}
        locked={!canEditResolve}
        lockedMessage="Unlocks after warehouse inspection passes."
      >
        {t.disposition === 'replacement' && (
          <PanelGrid>
            <PanelField label="New unit UPC" value={t.replacement_unit_upc || '—'} mono />
            <PanelField label="Replacement AWB" value={t.replacement_awb || '—'} mono />
            <PanelField label="Replacement cost" value={t.replacement_cost_inr ? `₹${t.replacement_cost_inr}` : '—'} mono />
            <PanelField label="Dispatched" value={t.stage === 'replacement_dispatched' || t.stage === 'closed' ? new Date(t.stage_changed_at).toLocaleDateString() : '—'} />
          </PanelGrid>
        )}
        {t.disposition === 'refund' && (
          <PanelGrid>
            <PanelField label="Refund amount" value={t.refund_amount_inr ? `₹${t.refund_amount_inr}` : '—'} mono />
            <PanelField label="UTR / reference" value={t.refund_reference || '—'} mono />
            <PanelField label="Initiated"      value={t.stage === 'refund_initiated' || t.stage === 'refund_completed' || t.stage === 'closed' ? new Date(t.stage_changed_at).toLocaleDateString() : '—'} />
            <PanelField label="Completed"      value={t.stage === 'refund_completed' || t.stage === 'closed' ? new Date(t.stage_changed_at).toLocaleDateString() : '—'} />
          </PanelGrid>
        )}
        {t.disposition === 'repair' && (
          <>
            <PanelGrid>
              <PanelField label="Repair run" value={t.repair_run_id ? `#${t.repair_run_id}` : '—'} mono />
              <PanelField label="Run status" value={repairRun?.status || '—'} />
              <PanelField label="Repair AWB" value={t.replacement_awb || '—'} mono />
              <PanelField label="Dispatched" value={t.stage === 'repair_dispatched' || t.stage === 'closed' ? new Date(t.stage_changed_at).toLocaleDateString() : '—'} />
            </PanelGrid>
            {repairRun && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--t3)' }}>
                Linked to <span style={{ fontFamily: 'var(--font-mono)' }}>{repairRun.run_no}</span> on the production floor.
              </div>
            )}
          </>
        )}
      </Panel>

      {!isClosed && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <SideExitButton label="Cancel" ticket={t} action="cancel" session={session} onDone={onRefresh} color="muted" />
          <SideExitButton label="Reject" ticket={t} action="reject" session={session} onDone={onRefresh} color="muted" />
          <SideExitButton label="Escalate" ticket={t} action="escalate" session={session} onDone={onRefresh} color="amber" />
        </div>
      )}

      {editing && (
        <EditPanelModal
          ticket={t}
          field={editing}
          session={session}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onRefresh(); }}
        />
      )}

      <WhatsAppPanel ticket={t} session={session} />
    </div>
  );
}

function SideExitButton({ label, ticket, action, session, onDone, color }) {
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const palette = color === 'amber'
    ? { bg: 'transparent', fg: 'var(--state-warning-fg)', border: 'var(--state-warning)' }
    : { bg: 'transparent', fg: 'var(--t2)', border: 'var(--border)' };

  async function go() {
    setSubmitting(true);
    setError(null);
    try {
      if (action === 'cancel') {
        await csopsPost('cancelTicket', { ticket_id: ticket.id, reason: reason || undefined }, session);
      } else if (action === 'reject') {
        await csopsPost('advanceStage', { ticket_id: ticket.id, target_stage: 'rejected' }, session);
      } else if (action === 'escalate') {
        await csopsPost('escalateTicket', { ticket_id: ticket.id, note: reason || undefined }, session);
      }
      setConfirm(false);
      onDone();
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  }

  return (
    <>
      <button onClick={() => setConfirm(true)} style={{
        padding: '7px 13px',
        background: palette.bg, color: palette.fg, border: `1px solid ${palette.border}`,
        borderRadius: 'var(--radius-md)',
        fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        cursor: 'pointer',
      }}>{label}</button>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`${action.charAt(0).toUpperCase() + action.slice(1)} ticket?`}
        confirmLabel={submitting ? 'Working…' : `${action.charAt(0).toUpperCase() + action.slice(1)}`}
        onConfirm={go}
        loading={submitting}
        error={error}
      >
        <p style={{ color: 'var(--t2)', fontSize: 13, marginBottom: 12 }}>
          {action === 'cancel' && 'Mark this ticket as cancelled (customer dropped, no resolution required).'}
          {action === 'reject' && 'Mark this ticket as rejected (warehouse inspection found no fault).'}
          {action === 'escalate' && 'Flag this ticket for manager attention. The ticket stays in its current stage.'}
        </p>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ color: 'var(--t3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--font-mono)' }}>
            {action === 'escalate' ? 'Note (optional)' : 'Reason (optional)'}
          </span>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={2}
            style={inputStyle}
          />
        </label>
      </Modal>
    </>
  );
}

function EditPanelModal({ ticket, field, session, onClose, onSaved }) {
  // Minimal V1: a free-form panel for editing fields in the current section.
  // Locked-field rules already enforced by the backend.
  const sectionFields = {
    issue:      ['issue_category','issue_subcategory','issue_subcategory_custom','issue_description'],
    return:     ['return_awb','return_courier','return_tracking_url','return_cost_inr','inspection_note'],
    resolution: ticket.disposition === 'replacement'
                  ? ['replacement_unit_upc','replacement_awb','replacement_cost_inr']
                  : ticket.disposition === 'refund'
                  ? ['refund_amount_inr','refund_reference']
                  : ['repair_run_id'],
  };
  const fields = sectionFields[field] || [];
  const numericFields = new Set(['return_cost_inr','replacement_cost_inr','refund_amount_inr','repair_run_id']);
  const [form, setForm] = useState(() => Object.fromEntries(fields.map(f => [f, ticket[f] ?? ''])));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    setSubmitting(true);
    setError(null);
    try {
      const patch = {};
      for (const [k, v] of Object.entries(form)) {
        if (v !== '' && v !== null) {
          patch[k] = numericFields.has(k) ? Number(v) : v;
        }
      }
      await csopsPost('updateTicket', { ticket_id: ticket.id, patch }, session);
      onSaved();
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`Edit ${field}`}
      confirmLabel={submitting ? 'Saving…' : 'Save'}
      onConfirm={save}
      loading={submitting}
      error={error}
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {fields.map(f => (
          <label key={f} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: 'var(--t3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--font-mono)' }}>{f}</span>
            {f === 'issue_description' || f === 'inspection_note' ? (
              <textarea
                value={form[f] || ''}
                onChange={e => setForm(s => ({ ...s, [f]: e.target.value }))}
                rows={3}
                style={inputStyle}
              />
            ) : (
              <input
                type={numericFields.has(f) ? 'number' : 'text'}
                value={form[f] || ''}
                onChange={e => setForm(s => ({ ...s, [f]: e.target.value }))}
                style={inputStyle}
              />
            )}
          </label>
        ))}
      </div>
    </Modal>
  );
}

function ActivityFeed({ ticket, history, notes, attachments, session, onRefresh }) {
  // Merge feeds by timestamp
  const merged = useMemo(() => {
    const items = [];
    for (const h of (history || [])) items.push({ kind: 'history', at: h.changed_at, data: h });
    for (const n of (notes || []))   items.push({ kind: 'note',    at: n.created_at, data: n });
    for (const a of (attachments || [])) items.push({ kind: 'attachment', at: a.added_at, data: a });
    return items.sort((a, b) => new Date(b.at) - new Date(a.at));
  }, [history, notes, attachments]);

  const [noteText, setNoteText] = useState('');
  const [attachUrl, setAttachUrl] = useState('');
  const [attachLabel, setAttachLabel] = useState('');
  const [attachKind, setAttachKind] = useState('issue_evidence');
  const [showAttach, setShowAttach] = useState(false);
  const [busy, setBusy] = useState(false);

  async function postNote() {
    if (!noteText.trim()) return;
    setBusy(true);
    try {
      await csopsPost('addNote', { ticket_id: ticket.id, body: noteText.trim(), visibility: 'internal' }, session);
      setNoteText('');
      onRefresh();
    } finally { setBusy(false); }
  }

  async function postAttachment() {
    if (!attachUrl.trim()) return;
    setBusy(true);
    try {
      await csopsPost('addAttachment', {
        ticket_id: ticket.id,
        url: attachUrl.trim(),
        kind: attachKind,
        label: attachLabel.trim() || null,
      }, session);
      setAttachUrl(''); setAttachLabel(''); setShowAttach(false);
      onRefresh();
    } finally { setBusy(false); }
  }

  return (
    <aside style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-4)',
      display: 'flex', flexDirection: 'column',
      minHeight: 360, maxHeight: 'calc(100dvh - 280px)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <SectionLabel>Activity</SectionLabel>
        <button onClick={() => setShowAttach(v => !v)} style={{
          ...miniLink, display: 'inline-flex', alignItems: 'center', gap: 3,
        }}>
          <Link2 size={11} strokeWidth={1.75} /> Attach link
        </button>
      </div>

      {showAttach && (
        <div style={{
          padding: 10, marginBottom: 12,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <select value={attachKind} onChange={e => setAttachKind(e.target.value)} style={inputStyle}>
            <option value="issue_evidence">Issue evidence (WhatsApp video/photo)</option>
            <option value="inspection_photo">Inspection photo</option>
            <option value="dispatch_proof">Dispatch proof</option>
            <option value="other">Other</option>
          </select>
          <input value={attachUrl} onChange={e => setAttachUrl(e.target.value)} placeholder="URL (WhatsApp / Drive / etc.)" style={inputStyle} />
          <input value={attachLabel} onChange={e => setAttachLabel(e.target.value)} placeholder="Label (optional)" style={inputStyle} />
          <button onClick={postAttachment} disabled={busy} style={ctaSecondary}>{busy ? 'Adding…' : 'Add attachment'}</button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {merged.length === 0 ? (
          <div style={{ color: 'var(--t4)', fontSize: 12, fontFamily: 'var(--font-mono)', textAlign: 'center', padding: '24px 0' }}>
            No activity yet.
          </div>
        ) : merged.map((it, idx) => <FeedItem key={`${it.kind}-${idx}`} item={it} />)}
      </div>

      <div style={{
        marginTop: 12, paddingTop: 10,
        borderTop: '1px solid var(--border)',
        display: 'flex', gap: 6,
      }}>
        <input
          value={noteText}
          onChange={e => setNoteText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) postNote(); }}
          placeholder="Add internal note… (⌘+Enter)"
          style={{ ...inputStyle, flex: 1, fontSize: 12 }}
        />
        <button onClick={postNote} disabled={busy || !noteText.trim()} style={ctaSecondary}>
          {busy ? '…' : 'Post'}
        </button>
      </div>
    </aside>
  );
}

function FeedItem({ item }) {
  const isNote = item.kind === 'note';
  const isAttach = item.kind === 'attachment';
  const isHist = item.kind === 'history';

  const when = new Date(item.at);
  const whenText = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  const who = item.data.changed_by_name || item.data.created_by_name || item.data.added_by_name || 'system';

  return (
    <div style={{
      padding: isNote ? 10 : 6,
      background: isNote ? 'var(--surface-2)' : 'transparent',
      borderRadius: isNote ? 'var(--radius-md)' : 0,
      borderLeft: isNote ? '2px solid var(--state-info)' : 'none',
      borderBottom: !isNote ? '1px solid var(--surface-2)' : 'none',
      fontSize: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
        <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{who}</span>
        <span style={{ color: 'var(--t4)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{whenText}</span>
      </div>
      <div style={{ marginTop: 3, color: 'var(--t2)', lineHeight: 1.5 }}>
        {isNote && item.data.body}
        {isAttach && (
          <span>
            Attached <Pill>{item.data.kind}</Pill>{' '}
            <a href={item.data.url} target="_blank" rel="noreferrer" style={{ color: '#7b93ff', textDecoration: 'underline' }}>
              {item.data.label || item.data.url}
            </a>
          </span>
        )}
        {isHist && (
          <span>
            {item.data.field_name === 'stage' ? (
              <>Advanced to <Pill>{item.data.new_value}</Pill></>
            ) : item.data.field_name === 'ticket_created' ? (
              <>Created ticket</>
            ) : item.data.field_name === 'note_added' ? (
              <>Added note</>
            ) : item.data.field_name === 'attachment_added' ? (
              <>Attached <Pill>{item.data.new_value}</Pill></>
            ) : item.data.field_name === 'escalated' ? (
              <>Escalated for manager attention</>
            ) : (
              <>Changed <Pill>{item.data.field_name}</Pill> — {(item.data.new_value || '').slice(0, 80)}</>
            )}
            {item.data.note && <div style={{ color: 'var(--t3)', marginTop: 2 }}>{item.data.note}</div>}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Tiny presentational helpers ──────────────────────────────────────────────

function SectionLabel({ children, style }) {
  return (
    <div style={{
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      letterSpacing: 'var(--tracking-wide)',
      textTransform: 'uppercase',
      color: 'var(--t3)',
      fontWeight: 600,
      marginBottom: 8,
      ...style,
    }}>{children}</div>
  );
}

function Field({ label, value, mono, small, action }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--font-mono)', display: 'flex', justifyContent: 'space-between' }}>
        <span>{label}</span>
        {action}
      </div>
      <div style={{
        marginTop: 2,
        fontSize: small ? 11 : 13,
        fontFamily: mono ? 'var(--font-mono)' : 'inherit',
        color: 'var(--t1)',
        lineHeight: 1.5,
        wordBreak: 'break-word',
      }}>{value || <span style={{ color: 'var(--t4)' }}>—</span>}</div>
    </div>
  );
}

function LinkedCard({ title, children }) {
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      padding: 10,
      background: 'var(--surface-2)',
      marginBottom: 10,
      fontSize: 11.5,
      color: 'var(--t2)',
      lineHeight: 1.5,
    }}>
      <div style={{ color: 'var(--state-info-fg)', fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
        ↪ {title}
      </div>
      {children}
    </div>
  );
}

function Panel({ title, subtitle, editable, onEdit, locked, lockedMessage, children }) {
  return (
    <section style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
      }}>
        <div>
          <div style={{ color: 'var(--t1)', fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-cond)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{title}</div>
          {subtitle && <div style={{ color: 'var(--t3)', fontSize: 11, marginTop: 2, fontFamily: 'var(--font-mono)' }}>{subtitle}</div>}
        </div>
        {editable && (
          <button onClick={onEdit} style={miniLink}>Edit</button>
        )}
      </div>
      <div style={{ padding: 14, opacity: locked ? 0.5 : 1 }}>
        {children}
        {locked && lockedMessage && (
          <div style={{
            marginTop: 10, padding: '8px 10px',
            background: 'var(--state-info-bg)',
            color: 'var(--state-info-fg)',
            borderLeft: '2px solid var(--state-info)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 11.5,
          }}>
            ⓘ {lockedMessage}
          </div>
        )}
      </div>
    </section>
  );
}

function PanelGrid({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>{children}</div>;
}

function PanelRow({ label, value, multiline }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--font-mono)', marginBottom: 2 }}>{label}</div>
      <div style={{ color: 'var(--t1)', fontSize: 13, lineHeight: multiline ? 1.55 : 1.4, whiteSpace: multiline ? 'pre-wrap' : 'normal' }}>{value}</div>
    </div>
  );
}

function PanelField({ label, value, mono }) {
  return (
    <div style={{
      padding: 9,
      background: 'var(--surface-2)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>{label}</div>
      <div style={{ color: 'var(--t1)', fontSize: 12.5, fontFamily: mono ? 'var(--font-mono)' : 'inherit', wordBreak: 'break-word' }}>{value}</div>
    </div>
  );
}

function Pill({ children }) {
  return <span style={{ display: 'inline-block', padding: '1px 6px', background: 'var(--surface-3)', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--t2)' }}>{children}</span>;
}

const miniLink = {
  background: 'transparent', border: 'none', padding: 0,
  color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontSize: 10,
  textTransform: 'uppercase', letterSpacing: '0.08em',
  cursor: 'pointer', textDecoration: 'underline',
};

const ctaSecondary = {
  padding: '6px 12px',
  background: 'var(--surface-3)',
  color: 'var(--t1)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600,
  cursor: 'pointer',
};
