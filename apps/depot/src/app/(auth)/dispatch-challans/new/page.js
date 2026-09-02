'use client';
/**
 * /dispatch-challans/new — create a new Delivery Challan.
 *
 * - From address: dropdown of company_addresses (defaults to is_registered_office=true),
 *   editable inline (name + address + GSTIN).
 * - To address: free-form (name + address + GSTIN).
 * - Line editor: each row supports a product combobox (searches product_master by
 *   name / model / EAN / SKU) that auto-fills description + EAN + HSN. Free-form
 *   text also allowed.
 * - GST rate dropdown {0, 5, 12, 18, 28}.
 * - Live total + EWB warning at ≥ ₹50,000.
 * - "Save Draft" creates with status='draft'. "Issue Challan" creates + issues
 *   in two steps (so the draft survives if issue fails).
 */
import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Panel, Combobox } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { Plus, Trash2, Search, AlertTriangle, Info } from 'lucide-react';

const GST_RATES = [
  { value: 0,  label: '0% (Exempt / Nil rated)' },
  { value: 5,  label: '5%' },
  { value: 12, label: '12%' },
  { value: 18, label: '18%' },
  { value: 28, label: '28%' },
];
const TRANSPORT_MODES = ['Road', 'Rail', 'Air', 'Ship'];
const PURPOSES = [
  'Material transfer',
  'Job work',
  'Sample',
  'Return for repair',
  'Branch transfer',
  'Replacement',
  'Other',
];
const UNITS = ['Pcs', 'Box', 'Kg', 'Set', 'Pair', 'Litre', 'Meter'];

const HSN_DEFAULT = '95030090'; // Toy vehicles per LOT GST registration

const inp = {
  background: 'var(--surface-2)', color: 'var(--t1)',
  border: '1px solid var(--border)', borderRadius: 3,
  padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 13,
  outline: 'none', width: '100%',
};
const lbl = {
  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
  color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em',
  marginBottom: 5, display: 'block',
};

function newLine() {
  return {
    description: '', hsn_code: HSN_DEFAULT, product_code: null, ean: null,
    quantity: '', unit: 'Pcs', rate: '',
  };
}

// company_addresses has no flat `address` column — compose it from the parts.
function composeCompanyAddress(a) {
  if (!a) return '';
  if (a.address) return a.address; // tolerate a flat field if one is ever added
  const cityLine = [a.city, a.state, a.pincode].filter(Boolean).join(', ');
  return [a.line1, a.line2, cityLine, a.country].filter(Boolean).join('\n');
}

export default function NewChallanPage() {
  // useSearchParams needs a Suspense boundary under static export (same pattern
  // as the challan detail page).
  return (
    <Suspense fallback={<div style={{ padding: 32 }}><Spinner /></div>}>
      <NewChallanInner />
    </Suspense>
  );
}

function NewChallanInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get('edit');   // present → editing an existing DRAFT (L100)
  const { session } = useAuth();
  const { showToast } = useToast();
  const [editChallanNo, setEditChallanNo] = useState('');

  const [addresses, setAddresses] = useState([]);
  const [fromId, setFromId] = useState('');

  const [challanDate, setChallanDate] = useState(() => todayStr());

  const [fromName, setFromName]       = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [fromGstin, setFromGstin]     = useState('');

  const [toName, setToName]       = useState('');
  const [toAddress, setToAddress] = useState('');
  const [toGstin, setToGstin]     = useState('');
  // Optional vendor link (Piyush, 2026-09-02). ⛔ The three free-text fields above remain the
  // authoritative recipient record and stay editable — picking a vendor only PREFILLS them.
  // A challan may go to a non-vendor (LOT HQ, a customer): 30 distinct recipients today, and
  // all 144 existing challans predate this field. Never make it required.
  const [vendorCode, setVendorCode] = useState('');
  const [vendors, setVendors]       = useState([]);

  // ⚠️ Starts EMPTY on purpose (S308). It used to default to 'Material transfer', and the
  // default did the choosing: 128 of 128 challans since 2026-06-02 carry it and `Job work` has
  // never once been selected — so job-work challans cannot be filtered for ITC-04 even though
  // ~62 of them demonstrably went to job-work vendors. Fixed at the source form rather than by
  // inferring the purpose from the vendor, because those same vendors also receive genuine
  // material transfers ([[feedback_fix_trivial_input_errors_at_source]]).
  const [purpose, setPurpose] = useState('');
  const [notes, setNotes]     = useState('');
  // Keyed by the field name each validation error reports, so a failed submit can put the
  // offending input on screen instead of only naming it in a toast.
  const fieldRefs = useRef({});

  const [transportMode, setTransportMode]       = useState('Road');
  const [vehicleNumber, setVehicleNumber]       = useState('');
  const [transporterName, setTransporterName]   = useState('');

  const [ewbNumber, setEwbNumber] = useState('');
  const [ewbDate, setEwbDate]     = useState('');

  const [gstRate, setGstRate] = useState(18);
  const [lines, setLines]     = useState([newLine()]);

  const [saving, setSaving] = useState(false);

  // Load company addresses on mount, default From to registered_office
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await garageFetch('getCompanyAddresses', {}, session);
        if (cancelled) return;
        const list = Array.isArray(data) ? data : [];
        setAddresses(list);
        // Vendor master for the optional recipient picker. Failing to load it must NEVER
        // block the form — the free-text recipient path is the primary one and works alone.
        garageFetch('getVendors', {}, session)
          .then(vs => { if (!cancelled) setVendors(Array.isArray(vs) ? vs : []); })
          .catch(() => {});
        // Prefer the registered office or first active row as default From —
        // but NOT when editing (the loaded challan's From must win).
        const def = list.find(a => a.is_registered_office) || list[0];
        if (def && !editId) {
          setFromId(String(def.id));
          setFromName(def.legal_name || def.company_name || '');
          setFromAddress(composeCompanyAddress(def));
          setFromGstin(def.gstin || '');
        }
      } catch (e) {
        showToast('Failed to load company addresses: ' + (e.message || e), 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [session, showToast, editId]);

  // Edit mode (L100): load an existing DRAFT and prefill the form. updateDeliveryChallan
  // is draft-only server-side; we also bounce non-drafts back to the read-only detail view.
  useEffect(() => {
    if (!editId || !session) return;
    let cancelled = false;
    (async () => {
      try {
        const dc = await garageFetch('getDeliveryChallan', { id: editId }, session);
        if (cancelled || !dc?.header) return;
        const h = dc.header;
        if (h.status !== 'draft') {
          showToast('Only draft challans can be edited', 'error');
          router.push(`/dispatch-challans/detail?id=${editId}`);
          return;
        }
        setEditChallanNo(h.challan_no || '');
        if (h.challan_date) setChallanDate(String(h.challan_date).slice(0, 10));
        setFromId('');
        setFromName(h.from_name || ''); setFromAddress(h.from_address || ''); setFromGstin(h.from_gstin || '');
        setToName(h.to_name || ''); setToAddress(h.to_address || ''); setToGstin(h.to_gstin || '');
        setVendorCode(h.vendor_code || '');
        setPurpose(h.purpose || ''); setNotes(h.notes || '');
        setTransportMode(h.transport_mode || 'Road'); setVehicleNumber(h.vehicle_number || ''); setTransporterName(h.transporter_name || '');
        setEwbNumber(h.ewb_number || ''); setEwbDate(h.ewb_date ? String(h.ewb_date).slice(0, 10) : '');
        setGstRate(Number(h.gst_rate) || 18);
        const ls = Array.isArray(dc.lines) ? dc.lines : [];
        setLines(ls.length ? ls.map(l => ({
          description: l.description || '', hsn_code: l.hsn_code || HSN_DEFAULT,
          product_code: l.product_code || null, ean: l.ean || null,
          quantity: l.quantity ?? '', unit: l.unit || 'Pcs', rate: l.rate ?? '',
        })) : [newLine()]);
      } catch (e) {
        showToast('Failed to load challan: ' + (e.message || e), 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [editId, session]);  // eslint-disable-line react-hooks/exhaustive-deps

  // When user picks a different From address from the dropdown, prefill but leave editable
  function onPickFromId(id) {
    setFromId(id);
    const a = addresses.find(x => String(x.id) === String(id));
    if (a) {
      setFromName(a.legal_name || a.company_name || '');
      setFromAddress(composeCompanyAddress(a));
      setFromGstin(a.gstin || '');
    }
  }

  // Totals — live
  const subtotal = useMemo(() => {
    return lines.reduce((s, l) => {
      const q = Number(l.quantity) || 0;
      const r = Number(l.rate) || 0;
      return s + (q * r);
    }, 0);
  }, [lines]);
  const gstAmount   = useMemo(() => Math.round(subtotal * (Number(gstRate) || 0)) / 100, [subtotal, gstRate]);
  const totalAmount = useMemo(() => subtotal + gstAmount, [subtotal, gstAmount]);
  const totalQty    = useMemo(() => lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0), [lines]);
  const ewbRequired = totalAmount >= 50000;
  const ewbApproaching = !ewbRequired && totalAmount >= 40000;

  // Validation.
  //
  // ⚠️ Deliberately NOT memoised. It was a useMemo whose dependency list
  // (`[fromName, fromAddress, toName, toAddress, lines]`) omitted `purpose`, which the body
  // reads — so once S308 made Purpose mandatory, SELECTING a purpose did not recompute the
  // errors. The operator picked one, pressed Issue Challan, and got "Purpose required"
  // anyway; the only way through was to go back and touch a line, which nothing on screen
  // suggests. Reported by Piyush 2026-08-26 (#bugs 1787729006.405699).
  //
  // The list is six string checks over a handful of lines — memoising it never bought
  // anything, and a stale dep list on a SUBMIT GATE fails in the one direction that blocks
  // real work. Compute it every render; there is then no dep list to get wrong again.
  const validation = (() => {
    const errors = [];
    if (!fromName.trim())    errors.push(['fromName', 'From name required']);
    if (!fromAddress.trim()) errors.push(['fromAddress', 'From address required']);
    if (!toName.trim())      errors.push(['toName', 'To name required']);
    if (!toAddress.trim())   errors.push(['toAddress', 'To address required']);
    if (!purpose)            errors.push(['purpose', 'Purpose required — pick Job work for anything going to a job-work vendor, so it can be filed for ITC-04']);
    const validLines = lines.filter(l => l.description.trim() && Number(l.quantity) > 0);
    if (validLines.length === 0) errors.push(['lines', 'At least one line with description + quantity required']);
    return errors;
  })();

  async function save({ andIssue }) {
    if (validation.length) {
      const [field, message] = validation[0];
      showToast(message, 'error');
      // The Challan Details panel is above the fold once the goods and transport sections are
      // filled in, so the operator reads "Purpose required" with the Purpose field scrolled off
      // screen. Put the offending field in front of them rather than making them hunt for it.
      const el = fieldRefs.current[field];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => { try { el.focus({ preventScroll: true }); } catch { /* not focusable */ } }, 250);
      }
      return;
    }
    setSaving(true);
    try {
      const cleanLines = lines
        .filter(l => l.description.trim() && Number(l.quantity) > 0)
        .map(l => ({
          description:  l.description.trim(),
          hsn_code:     (l.hsn_code || HSN_DEFAULT).trim(),
          product_code: l.product_code || null,
          ean:          l.ean || null,
          quantity:     Number(l.quantity) || 0,
          unit:         l.unit || 'Pcs',
          rate:         Number(l.rate) || 0,
        }));

      const payload = {
        challan_date:     challanDate,
        from_name:        fromName.trim(),
        from_address:     fromAddress.trim(),
        from_gstin:       fromGstin.trim() || null,
        to_name:          toName.trim(),
        to_address:       toAddress.trim(),
        to_gstin:         toGstin.trim() || null,
        // Always sent, even when blank. The worker guards this field with `!== undefined`
        // (its neighbours use `?? null`), so an explicit '' → null is how unlinking works.
        vendor_code:      vendorCode || null,
        purpose:          purpose || null,
        notes:            notes.trim() || null,
        transport_mode:   transportMode || null,
        vehicle_number:   vehicleNumber.trim() || null,
        transporter_name: transporterName.trim() || null,
        ewb_number:       ewbNumber.trim() || null,
        ewb_date:         ewbDate || null,
        gst_rate:         Number(gstRate) || 0,
        lines:            cleanLines,
      };
      const res = editId
        ? await workerFetch('updateDeliveryChallan', { data: { id: editId, ...payload } }, session)
        : await workerFetch('createDeliveryChallan', { data: payload }, session);
      if (!res.ok) {
        showToast(`${editId ? 'Update' : 'Create'} failed: ` + (res.error || 'unknown'), 'error');
        setSaving(false);
        return;
      }
      // updateDeliveryChallan returns {id,...} without challan_no; use the loaded one.
      const created = editId
        ? { id: editId, challan_no: editChallanNo || res.data?.challan_no || 'draft' }
        : res.data;
      if (andIssue) {
        const iss = await workerFetch('issueDeliveryChallan', { data: { id: created.id } }, session);
        if (!iss.ok) {
          showToast(`Saved ${created.challan_no} as draft, but issue failed: ${iss.error || 'unknown'}`, 'info');
          router.push(`/dispatch-challans/detail?id=${created.id}`);
          return;
        }
        showToast(`Challan ${created.challan_no} issued`, 'success');
      } else {
        showToast(`Draft ${created.challan_no} ${editId ? 'updated' : 'saved'}`, 'success');
      }
      router.push(`/dispatch-challans/detail?id=${created.id}`);
    } catch (e) {
      showToast('Save failed: ' + (e.message || e), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: '4px 4px 64px' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid var(--border)',
      }}>
        <button onClick={() => router.push('/dispatch-challans')}
          style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3,
            padding: '6px 10px', cursor: 'pointer', color: 'var(--t2)', fontSize: 12 }}>
          ← Back
        </button>
        <h1 style={{
          margin: 0,
          fontFamily: 'var(--cond)', fontSize: 'var(--text-xl)', fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--t1)',
        }}>
          {editId ? `Edit Draft${editChallanNo ? ` · ${editChallanNo}` : ''}` : 'New Delivery Challan'}
        </h1>
        <div style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
          {editId ? 'Editing a draft — changes replace the saved lines' : `Number auto-assigned on save (LOT-DC-${challanDate.slice(0,4)}-NNNN)`}
        </div>
      </div>

      {/* E-Way Bill banner (live) */}
      {ewbRequired && (
        <div style={{
          background: 'var(--state-warning-bg)',
          border: '1px solid rgba(251, 191, 36, 0.35)',
          borderRadius: 4, padding: '10px 14px', marginBottom: 12,
          display: 'flex', alignItems: 'flex-start', gap: 10,
        }}>
          <AlertTriangle size={18} color="#fbbf24" strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--state-warning-fg)', lineHeight: 1.5 }}>
            <strong style={{ fontWeight: 700 }}>E-Way Bill required.</strong>{' '}
            Total ₹{totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })} crosses the ₹50,000 threshold under
            GST Rule 138. Generate an EWB at <span style={{ color: 'var(--yellow)' }}>ewaybillgst.gov.in</span> using
            this challan, then capture the EWB number below for the print record.
            EWB is not required to save or issue this challan.
          </div>
        </div>
      )}
      {ewbApproaching && (
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)',
          marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <Info size={14} strokeWidth={1.75} />
          Approaching the e-way bill threshold (₹50,000). Currently at ₹{totalAmount.toLocaleString('en-IN')}.
        </div>
      )}

      {/* Header form */}
      <Panel header="Challan Details" style={{ marginBottom: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 12 }}>
          <div>
            <span style={lbl}>Date *</span>
            <input type="date" value={challanDate} onChange={(e) => setChallanDate(e.target.value)} style={inp} />
          </div>
          <div>
            <span style={lbl}>Purpose *</span>
            <select ref={(el) => { fieldRefs.current.purpose = el; }}
                    value={purpose} onChange={(e) => setPurpose(e.target.value)} style={inp}>
              <option value="">Select a purpose…</option>
              {PURPOSES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <span style={lbl}>GST Rate *</span>
            <select value={gstRate} onChange={(e) => setGstRate(Number(e.target.value))} style={inp}>
              {GST_RATES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <span style={lbl}>Notes</span>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
                   placeholder="Optional — appears on print" style={inp} />
          </div>
        </div>
      </Panel>

      {/* Addresses — From + To side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <Panel header="Dispatched From">
          <div style={{ marginBottom: 10 }}>
            <span style={lbl}>Pick from company addresses</span>
            <select value={fromId} onChange={(e) => onPickFromId(e.target.value)} style={inp}>
              <option value="">— Custom address —</option>
              {addresses.map(a => (
                <option key={a.id} value={a.id}>
                  {(a.legal_name || a.company_name || `Address #${a.id}`)}{a.is_registered_office ? ' (Registered Office)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div style={{ marginBottom: 10 }}>
            <span style={lbl}>Legal Name *</span>
            <input ref={(el) => { fieldRefs.current.fromName = el; }} type="text" value={fromName} onChange={(e) => setFromName(e.target.value)} style={inp} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <span style={lbl}>Address *</span>
            <textarea ref={(el) => { fieldRefs.current.fromAddress = el; }} value={fromAddress} onChange={(e) => setFromAddress(e.target.value)}
                      rows={3} style={{ ...inp, resize: 'vertical', minHeight: 70 }} />
          </div>
          <div>
            <span style={lbl}>GSTIN</span>
            <input type="text" value={fromGstin} onChange={(e) => setFromGstin(e.target.value.toUpperCase())}
                   placeholder="29AAFCF7834H1ZA" maxLength={15} style={inp} />
          </div>
        </Panel>

        <Panel header="Dispatched To">
          <div style={{ marginBottom: 10 }}>
            <span style={lbl}>Vendor (optional — fills the fields below)</span>
            {/* `portal` is required: this sits inside a bordered Panel, and without it the
                dropdown is clipped by the panel's bounds. Same reason as the DI form. */}
            <Combobox
              portal
              value={vendorCode}
              onChange={(v, opt) => {
                setVendorCode(v || '');
                // Prefill, never lock. The operator can still edit all three fields after
                // picking — a challan often goes to a vendor's site rather than their
                // registered address, and the printed block must be able to say so.
                if (opt) {
                  setToName(opt.vendor_name || '');
                  setToAddress(opt.address || '');
                  setToGstin(opt.gstin || '');
                }
              }}
              options={vendors.map(v => ({
                value: v.vendor_code,
                label: v.vendor_name,
                hint:  v.vendor_code,
                search: v.category || '',
                vendor_name: v.vendor_name, address: v.address, gstin: v.gstin,
              }))}
              placeholder="Search the vendor master… (leave blank for LOT HQ, a customer, or a one-off)"
            />
            {vendorCode && (
              <button
                onClick={() => setVendorCode('')}
                style={{ marginTop: 5, background: 'transparent', border: 'none', padding: 0,
                         color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>
                × unlink vendor (keeps the typed address)
              </button>
            )}
          </div>
          <div style={{ marginBottom: 10 }}>
            <span style={lbl}>Recipient Name *</span>
            <input ref={(el) => { fieldRefs.current.toName = el; }} type="text" value={toName} onChange={(e) => setToName(e.target.value)}
                   placeholder="e.g. Sundar Logistics Pvt Ltd" style={inp} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <span style={lbl}>Address *</span>
            <textarea ref={(el) => { fieldRefs.current.toAddress = el; }} value={toAddress} onChange={(e) => setToAddress(e.target.value)}
                      rows={3} placeholder="Full delivery address with PIN"
                      style={{ ...inp, resize: 'vertical', minHeight: 70 }} />
          </div>
          <div>
            <span style={lbl}>GSTIN (if registered)</span>
            <input type="text" value={toGstin} onChange={(e) => setToGstin(e.target.value.toUpperCase())}
                   placeholder="Optional" maxLength={15} style={inp} />
          </div>
        </Panel>
      </div>

      {/* Lines */}
      <Panel
        header="Goods Supplied"
        headerAction={
          <button
            onClick={() => setLines([...lines, newLine()])}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 3, padding: '5px 10px', cursor: 'pointer',
              color: 'var(--t1)', fontFamily: 'var(--mono)', fontSize: 12,
            }}>
            <Plus size={13} strokeWidth={2.25} /> Add Line
          </button>
        }
        padding={0}
        style={{ marginBottom: 12 }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <Th>#</Th>
              <Th align="left" style={{ minWidth: 280 }}>Description</Th>
              <Th align="left">HSN</Th>
              <Th align="right">Qty</Th>
              <Th align="left">Unit</Th>
              <Th align="right">Rate (₹)</Th>
              <Th align="right">Amount (₹)</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <LineRow
                key={i}
                index={i}
                line={l}
                session={session}
                onChange={(patch) => setLines(lines.map((x, j) => j === i ? { ...x, ...patch } : x))}
                onRemove={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : [newLine()])}
              />
            ))}
          </tbody>
        </table>
      </Panel>

      {/* Transport */}
      <Panel header="Transport (Optional)" style={{ marginBottom: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          <div>
            <span style={lbl}>Mode</span>
            <select value={transportMode} onChange={(e) => setTransportMode(e.target.value)} style={inp}>
              <option value="">—</option>
              {TRANSPORT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <span style={lbl}>Vehicle Number</span>
            <input type="text" value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())}
                   placeholder="e.g. KA01AB1234" style={inp} />
          </div>
          <div>
            <span style={lbl}>Transporter Name</span>
            <input type="text" value={transporterName} onChange={(e) => setTransporterName(e.target.value)}
                   placeholder="Optional" style={inp} />
          </div>
        </div>
      </Panel>

      {/* E-Way Bill — only shown when relevant or has value */}
      {(ewbRequired || ewbNumber || ewbDate) && (
        <Panel header="E-Way Bill (Optional)" style={{ marginBottom: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
            <div>
              <span style={lbl}>EWB Number</span>
              <input type="text" value={ewbNumber} onChange={(e) => setEwbNumber(e.target.value)}
                     placeholder="12-digit EWB number" style={inp} />
            </div>
            <div>
              <span style={lbl}>EWB Date</span>
              <input type="date" value={ewbDate} onChange={(e) => setEwbDate(e.target.value)} style={inp} />
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', alignSelf: 'flex-end', paddingBottom: 6 }}>
              {ewbRequired
                ? 'Recommended once you have generated the EWB at ewaybillgst.gov.in. Not required to issue this challan.'
                : 'EWB is not required below the ₹50,000 threshold.'}
            </div>
          </div>
        </Panel>
      )}

      {/* Totals + Actions */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)',
      }}>
        <div style={{
          display: 'flex', gap: 24, fontFamily: 'var(--mono)', fontSize: 13,
        }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Subtotal</div>
            <div style={{ fontSize: 16, color: 'var(--t1)', fontWeight: 600 }}>
              ₹{subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>GST @ {gstRate}%</div>
            <div style={{ fontSize: 16, color: 'var(--t1)', fontWeight: 600 }}>
              ₹{gstAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Total Qty</div>
            <div style={{ fontSize: 16, color: 'var(--t1)', fontWeight: 600 }}>{totalQty}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--yellow)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Total Amount</div>
            <div style={{ fontSize: 20, color: 'var(--yellow)', fontWeight: 700 }}>
              ₹{totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => router.push('/dispatch-challans')}
            style={{
              background: 'transparent', border: '1px solid var(--border)', borderRadius: 4,
              padding: '9px 16px', cursor: 'pointer', color: 'var(--t1)',
              fontFamily: 'var(--mono)', fontSize: 13,
            }}>
            Cancel
          </button>
          <button onClick={() => save({ andIssue: false })} disabled={saving}
            style={{
              background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4,
              padding: '9px 16px', cursor: saving ? 'wait' : 'pointer', color: 'var(--t1)',
              fontFamily: 'var(--mono)', fontSize: 13, opacity: saving ? 0.5 : 1,
            }}>
            {saving ? '…' : (editId ? 'Save Draft' : 'Save as Draft')}
          </button>
          <button onClick={() => save({ andIssue: true })} disabled={saving}
            style={{
              background: 'var(--yellow)', color: '#0a0a0a', border: 'none', borderRadius: 4,
              padding: '9px 16px', cursor: saving ? 'wait' : 'pointer',
              fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.06em',
              opacity: saving ? 0.5 : 1,
            }}>
            {saving ? 'Saving…' : 'Issue Challan'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Th({ children, align = 'center', style = {} }) {
  return (
    <th style={{
      textAlign: align, padding: '10px 12px',
      fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
      color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em',
      borderBottom: '1px solid var(--border)', background: 'var(--surface)',
      ...style,
    }}>{children}</th>
  );
}

function LineRow({ index, line, session, onChange, onRemove }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const boxRef = useRef(null);

  // Search effect
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await garageFetch('searchProductsForChallan', q ? { q } : {}, session);
        if (!cancelled) setResults(Array.isArray(data) ? data.slice(0, 50) : []);
      } catch (e) {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, open, session]);

  // Click-away
  useEffect(() => {
    if (!open) return;
    function onClick(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const amount = (Number(line.quantity) || 0) * (Number(line.rate) || 0);
  const cellStyle = { padding: '8px 10px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' };
  const inputCell = { ...inp, padding: '6px 9px', fontSize: 13, width: '100%' };

  function pickProduct(p) {
    onChange({
      description:  p.description,
      hsn_code:     p.hsn_code || HSN_DEFAULT,
      product_code: p.product_code || null,
      ean:          p.ean || null,
    });
    setOpen(false);
    setQ('');
  }

  return (
    <tr>
      <td style={{ ...cellStyle, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t2)' }}>
        {index + 1}
      </td>
      <td style={{ ...cellStyle, position: 'relative' }} ref={boxRef}>
        <div style={{ display: 'flex', gap: 4 }}>
          <input type="text" value={line.description}
                 onChange={(e) => onChange({ description: e.target.value })}
                 placeholder="e.g. Knox Burnout Black"
                 style={inputCell} />
          <button onClick={() => { setOpen(!open); setQ(''); }} title="Search products"
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 3,
                          padding: '0 9px', cursor: 'pointer', color: 'var(--t2)', flexShrink: 0 }}>
            <Search size={14} strokeWidth={1.75} />
          </button>
        </div>
        {line.ean && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', marginTop: 3 }}>
            EAN: {line.ean}{line.product_code ? ` · ${line.product_code}` : ''}
          </div>
        )}
        {open && (
          <div style={{
            position: 'absolute', top: '100%', left: 10, right: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 6, boxShadow: '0 4px 16px #00000066',
            zIndex: 20, marginTop: 4, maxHeight: 320, overflowY: 'auto',
          }}>
            <input type="text" autoFocus value={q} onChange={(e) => setQ(e.target.value)}
                   placeholder="Search by product, model, EAN, or SKU…"
                   style={{ ...inputCell, border: 'none', borderBottom: '1px solid var(--border)',
                            borderRadius: 0, width: '100%' }} />
            {searching ? (
              <div style={{ padding: 12, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>Searching…</div>
            ) : results.length === 0 ? (
              <div style={{ padding: 12, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
                {q ? 'No matches' : 'No products with EAN found'}
              </div>
            ) : (
              results.map((p, k) => (
                <div key={k} onMouseDown={(e) => { e.preventDefault(); pickProduct(p); }}
                     style={{ padding: '7px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
                     onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-3)'; }}
                     onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)' }}>{p.description}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>
                    {p.ean || '—'}{p.sku ? ` · ${p.sku}` : ''}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </td>
      <td style={cellStyle}>
        <input type="text" value={line.hsn_code || ''}
               onChange={(e) => onChange({ hsn_code: e.target.value })}
               placeholder={HSN_DEFAULT} style={inputCell} />
      </td>
      <td style={cellStyle}>
        <input type="number" min="0" step="1" value={line.quantity}
               onChange={(e) => onChange({ quantity: e.target.value })}
               style={{ ...inputCell, textAlign: 'right' }} />
      </td>
      <td style={cellStyle}>
        <select value={line.unit} onChange={(e) => onChange({ unit: e.target.value })} style={inputCell}>
          {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
      </td>
      <td style={cellStyle}>
        <input type="number" min="0" step="0.01" value={line.rate}
               onChange={(e) => onChange({ rate: e.target.value })}
               style={{ ...inputCell, textAlign: 'right' }} />
      </td>
      <td style={{ ...cellStyle, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)', fontWeight: 600 }}>
        ₹{amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </td>
      <td style={{ ...cellStyle, textAlign: 'center' }}>
        <button onClick={onRemove} title="Remove line"
                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3,
                        padding: '5px 7px', cursor: 'pointer', color: 'var(--state-error-fg)' }}>
          <Trash2 size={13} strokeWidth={1.75} />
        </button>
      </td>
    </tr>
  );
}
