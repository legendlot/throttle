'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { Scan, AlertCircle, Phone as PhoneIcon } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../lib/csopsFetch.js';
import { ShopifyPanel } from '../../../components/ShopifyPanel.js';
import { IssuePicker } from '../../../components/IssuePicker.js';

const PLATFORMS = [
  '', 'website','amazon','cred','blinkit','instamart','marketplace','offline','zepto','swiggy','investor','other'
];
const INTAKE_CHANNELS = ['phone','whatsapp','email','marketplace','walkin','other'];

const inputStyle = {
  background: 'var(--surface)',
  color: 'var(--t1)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '9px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  width: '100%',
  outline: 'none',
};

const labelStyle = {
  color: 'var(--t3)',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontFamily: 'var(--font-mono)',
  marginBottom: 4,
};

export default function NewTicketPage() {
  const { session } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const upcRef = useRef(null);

  // Prefill from URL query string (Calls view → "Create Ticket from Call")
  const fromCall = searchParams.get('from_call');
  const prefilledPhone = searchParams.get('phone') || '';
  const prefilledName  = searchParams.get('name')  || '';

  const [form, setForm] = useState({
    intake_channel:  'phone',
    customer_name:   prefilledName,
    customer_phone:  prefilledPhone,
    customer_email:  '',
    customer_address:'',
    platform:        '',
    external_order_id: '',
    lot_unit_upc:    '',
    product:         '',
    product_sku:     '',
    product_model:   '',
    product_color:   '',
    issue_category:  '',
    issue_subcategory: '',
    issue_subcategory_custom: '',
    disposition:     'pending',
    issue_description: fromCall ? '[Created from missed call]' : '',
  });

  const [upcLookup, setUpcLookup] = useState({ loading: false, data: null, error: null });
  const [pastCases, setPastCases] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Autofocus UPC field on mount
  useEffect(() => { upcRef.current?.focus(); }, []);

  // Debounced UPC lookup
  useEffect(() => {
    const upc = form.lot_unit_upc?.trim();
    if (!upc || upc.length < 4) {
      setUpcLookup({ loading: false, data: null, error: null });
      return;
    }
    const timer = setTimeout(async () => {
      setUpcLookup(s => ({ ...s, loading: true, error: null }));
      try {
        const data = await csopsGet('lookupByUpc', { upc }, session);
        if (data?.unit) {
          // Auto-fill product fields from the unit
          setForm(s => ({
            ...s,
            product:       s.product       || data.unit.product || '',
            product_sku:   s.product_sku   || data.unit.sku || '',
            product_model: s.product_model || data.unit.model || '',
            product_color: s.product_color || data.unit.color || '',
          }));
          setUpcLookup({ loading: false, data, error: null });
        } else {
          setUpcLookup({ loading: false, data: null, error: 'UPC not found in LOT system' });
        }
      } catch (e) {
        setUpcLookup({ loading: false, data: null, error: e.message });
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [form.lot_unit_upc, session]);

  // Past-case lookup on phone blur (when 10+ digit normalized)
  async function checkPastCases() {
    const phone = form.customer_phone.replace(/\D/g, '');
    if (phone.length < 10) return;
    const normalised = phone.length === 10 ? `+91${phone}` : `+${phone}`;
    try {
      const data = await csopsGet('lookupPastCases', { phone: normalised }, session);
      setPastCases(data || []);
    } catch (e) { /* silent */ }
  }

  function set(field) {
    return (e) => setForm(s => ({ ...s, [field]: e.target?.value ?? e }));
  }

  async function submit(e) {
    e?.preventDefault();
    if (!form.customer_name.trim())      return setError('Customer name required');
    if (!form.issue_description.trim())  return setError('Issue description required');
    setError(null);
    setSubmitting(true);
    try {
      let data;
      if (fromCall) {
        // Convert path — links the cs_calls row to the new ticket
        data = await csopsPost('createTicketFromCall', { call_id: fromCall, ...form }, session);
      } else {
        data = await csopsPost('createTicket', form, session);
      }
      router.push(`/queue/detail/?ticket_no=${data.ticket_no}`);
    } catch (e) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 880, margin: '0 auto' }}>
      <h1 style={{
        fontFamily: 'var(--font-cond)',
        fontSize: 'var(--text-xl)',
        fontWeight: 600,
        letterSpacing: 'var(--tracking-tight)',
        textTransform: 'uppercase',
        color: 'var(--t1)',
        marginBottom: 'var(--space-4)',
      }}>
        New Ticket
      </h1>

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {/* ── UPC lookup row (top, phone-call-optimised) ───────────────── */}
        <Section title="Order lookup" subtitle="Scan or type a UPC first — product fields auto-fill.">
          <Row>
            <Field label="Unit UPC">
              <input
                ref={upcRef}
                value={form.lot_unit_upc}
                onChange={set('lot_unit_upc')}
                placeholder="Scan or type UPC"
                style={inputStyle}
              />
            </Field>
            <Field label="Platform">
              <select value={form.platform} onChange={set('platform')} style={inputStyle}>
                {PLATFORMS.map(p => <option key={p} value={p}>{p || '— select —'}</option>)}
              </select>
            </Field>
            <Field label="External order ID">
              <input value={form.external_order_id} onChange={set('external_order_id')} placeholder="LOT8069 / 403-..." style={inputStyle} />
            </Field>
          </Row>

          {upcLookup.loading && (
            <Hint kind="info">Looking up UPC…</Hint>
          )}
          {upcLookup.error && (
            <Hint kind="warn">UPC lookup: {upcLookup.error}</Hint>
          )}
          {upcLookup.data?.unit && (
            <Hint kind="success">
              <strong>{upcLookup.data.unit.product}</strong>
              {upcLookup.data.unit.model && ` · ${upcLookup.data.unit.model}`}
              {upcLookup.data.unit.color && ` · ${upcLookup.data.unit.color}`}
              {upcLookup.data.unit.sku && <span style={{ color: 'var(--t3)' }}> · SKU {upcLookup.data.unit.sku}</span>}
              {upcLookup.data.shipment?.shipped_at && (
                <span style={{ color: 'var(--t3)' }}> · shipped {new Date(upcLookup.data.shipment.shipped_at).toLocaleDateString()}</span>
              )}
              {upcLookup.data.shipment?.awb && (
                <span style={{ color: 'var(--t3)' }}> · AWB {upcLookup.data.shipment.awb}</span>
              )}
            </Hint>
          )}

          <Row>
            <Field label="Product"><input value={form.product} onChange={set('product')} style={inputStyle} /></Field>
            <Field label="Model"><input value={form.product_model} onChange={set('product_model')} style={inputStyle} /></Field>
            <Field label="Colour"><input value={form.product_color} onChange={set('product_color')} style={inputStyle} /></Field>
            <Field label="SKU"><input value={form.product_sku} onChange={set('product_sku')} style={inputStyle} /></Field>
          </Row>
        </Section>

        {/* ── Customer ──────────────────────────────────────────────────── */}
        <Section title="Customer">
          <Row>
            <Field label="Name *">
              <input value={form.customer_name} onChange={set('customer_name')} required style={inputStyle} />
            </Field>
            <Field label="Phone">
              <input
                value={form.customer_phone}
                onChange={set('customer_phone')}
                onBlur={checkPastCases}
                placeholder="+91 or 10 digits"
                style={inputStyle}
              />
            </Field>
          </Row>
          <Row>
            <Field label="Email"><input type="email" value={form.customer_email} onChange={set('customer_email')} style={inputStyle} /></Field>
            <Field label="Address" wide>
              <textarea value={form.customer_address} onChange={set('customer_address')} rows={2} style={inputStyle} />
            </Field>
          </Row>

          {pastCases.length > 0 && (
            <Hint kind="warn">
              <strong>{pastCases.length} prior case{pastCases.length === 1 ? '' : 's'}</strong> for this phone:{' '}
              {pastCases.slice(0, 3).map((p, i) => (
                <span key={p.ticket_no}>
                  {i > 0 ? ', ' : ''}
                  <a href={`/queue/detail/?ticket_no=${p.ticket_no}`} target="_blank" rel="noreferrer" style={{ color: '#7b93ff', textDecoration: 'underline' }}>
                    {p.ticket_no}
                  </a>
                  {' '}({p.disposition}, {p.closed_reason || p.stage})
                </span>
              ))}
            </Hint>
          )}

          <ShopifyPanel
            session={session}
            phone={form.customer_phone}
            email={form.customer_email}
            onPick={(s) => setForm(f => ({
              ...f,
              customer_name:  f.customer_name  || s.customer.name,
              customer_email: f.customer_email || s.customer.email,
              customer_phone: f.customer_phone || s.customer.phone || '',
            }))}
          />
        </Section>

        {/* ── Issue ─────────────────────────────────────────────────────── */}
        <Section title="Issue">
          <IssuePicker
            session={session}
            value={form}
            onChange={p => setForm(f => ({ ...f, ...p }))}
          />
          <Row>
            <Field label="Intake channel">
              <select value={form.intake_channel} onChange={set('intake_channel')} style={inputStyle}>
                {INTAKE_CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
          </Row>
          <Field label="Description *" wide>
            <textarea
              value={form.issue_description}
              onChange={set('issue_description')}
              rows={4}
              placeholder="What did the customer report?"
              required
              style={inputStyle}
            />
          </Field>
        </Section>

        {/* ── Error + Submit ───────────────────────────────────────────── */}
        {error && (
          <div style={{
            padding: 12,
            background: 'var(--state-error-bg)',
            color: 'var(--state-error-fg)',
            border: '1px solid var(--state-error)',
            borderRadius: 'var(--radius-md)',
            fontSize: 12.5,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <AlertCircle size={14} strokeWidth={1.75} /> {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => router.push('/queue')}
            style={{
              padding: '10px 18px',
              background: 'transparent',
              color: 'var(--t2)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: '10px 22px',
              background: 'var(--brand-red)',
              color: '#fff',
              border: '1px solid var(--brand-red)',
              borderRadius: 'var(--radius-md)',
              fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              cursor: submitting ? 'wait' : 'pointer',
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {submitting ? 'Creating…' : 'Create Ticket'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Small layout helpers ─────────────────────────────────────────────────────

function Section({ title, subtitle, children }) {
  return (
    <section style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-4)',
    }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{
          fontFamily: 'var(--font-cond)', fontSize: 13, fontWeight: 700,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          color: 'var(--t1)',
        }}>{title}</div>
        {subtitle && <div style={{ color: 'var(--t3)', fontSize: 11, marginTop: 2, fontFamily: 'var(--font-mono)' }}>{subtitle}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </section>
  );
}

function Row({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${children.length || 1}, minmax(0, 1fr))`, gap: 12 }}>{children}</div>;
}

function Field({ label, wide, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gridColumn: wide ? '1 / -1' : 'auto' }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </label>
  );
}

function Hint({ kind, children }) {
  const palettes = {
    info:    { bg: 'var(--state-info-bg)',    fg: 'var(--state-info-fg)',    border: 'var(--state-info)' },
    success: { bg: 'var(--state-success-bg)', fg: 'var(--state-success-fg)', border: 'var(--state-success)' },
    warn:    { bg: 'var(--state-warning-bg)', fg: 'var(--state-warning-fg)', border: 'var(--state-warning)' },
  };
  const p = palettes[kind] || palettes.info;
  return (
    <div style={{
      padding: '8px 12px',
      background: p.bg,
      color: p.fg,
      border: `1px solid ${p.border}`,
      borderLeftWidth: 2,
      borderRadius: 'var(--radius-md)',
      fontSize: 12.5,
      lineHeight: 1.5,
    }}>{children}</div>
  );
}
