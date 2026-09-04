'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { useProducts } from '../../../../hooks/useProducts.js';
import { PageHead, Kpi, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { countryTone } from '@/components/format.js';
import { Plus, ArrowRight } from 'lucide-react';

const PO_SOURCES = ['China', 'India', 'USA', 'Germany', 'Taiwan', 'Vietnam', 'Bangladesh', 'Japan', 'South Korea', 'UK', 'Italy', 'Turkey', 'Other'];
const PO_CURRENCIES = ['INR', 'USD', 'RMB'];
const PO_PAYMENT_TERMS = ['Advance', 'Credit 30', 'Credit 60', 'LC', 'TT'];
const VENDOR_CATEGORIES = ['Packaging', 'Para', 'Components', 'Products', 'Consumables', 'Tools & Machines', 'Other'];
// What the vendor DOES to the part. A moulder makes the unpainted part, a coater paints it
// (§S336a) — the worker refuses a painted part code on a PO to a 'moulding' vendor, so this
// field is the thing that catches the next moulder at onboarding. Values match the
// store.vendors.process_type CHECK exactly.
const VENDOR_PROCESS_TYPES = [
  { value: 'moulding', label: 'Moulding' },
  { value: 'painting', label: 'Painting' },
  { value: 'assembly', label: 'Assembly' },
  { value: 'other',    label: 'Other' },
];

const PO_CATEGORY_KEYS = [
  { key: 'fbu',         label: 'Full Units (FBU)' },
  { key: 'ckd',         label: 'Components (CKD)' },
  { key: 'packaging',   label: 'Packaging' },
  { key: 'metal',       label: 'Metal Parts' },
  { key: 'electronics', label: 'Electronics' },
  { key: 'consumables', label: 'Consumables' },
  { key: 'para',        label: 'Para' },
  { key: 'other',       label: 'Other' },
];

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.2)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.25)' },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.3)' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)' },
};

function StatusBadge({ label, tone = 'gray' }) {
  const s = TONE_STYLES[tone] || TONE_STYLES.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
      textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{label}</span>
  );
}

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '14px 16px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

const tabBtn = (active) => ({
  background: active ? 'var(--yellow)' : 'var(--surface2)',
  color: active ? '#000' : 'var(--t3)',
  border: active ? '1px solid var(--yellow)' : '1px solid var(--border)',
  borderRadius: 4, padding: '5px 12px', fontFamily: 'var(--mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: active ? 700 : 500,
});

export default function VendorsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const { PRODUCTS, loading: productsLoading } = useProducts();

  const [view, setView] = useState('list');
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingCode, setEditingCode] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState('');

  // form fields
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [processType, setProcessType] = useState('');
  const [country, setCountry] = useState('India');
  const [location, setLocation] = useState('');
  const [curr, setCurr] = useState('INR');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [leadTime, setLeadTime] = useState('');
  const [address, setAddress] = useState('');
  const [gstin, setGstin] = useState('');
  const [formNotes, setFormNotes] = useState('');

  // supplied items
  const [suppliedItems, setSuppliedItems] = useState([]);
  const [vsiType, setVsiType] = useState('product');
  const [vsiProduct, setVsiProduct] = useState('');
  const [vsiPartCode, setVsiPartCode] = useState('');
  const [vsiPartName, setVsiPartName] = useState('');
  const [vsiCategory, setVsiCategory] = useState('');
  const [partSuggestions, setPartSuggestions] = useState([]);
  const [showPartSuggestions, setShowPartSuggestions] = useState(false);
  const [vsiSubmitting, setVsiSubmitting] = useState(false);
  const partTimer = useRef(null);

  const loadList = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getVendors', {}, session);
      setVendors(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load vendors', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => {
    if (view === 'list') loadList();
  }, [view, loadList]);

  function resetForm() {
    setName('');
    setCategory('');
    setProcessType('');
    setCountry('India');
    setLocation('');
    setCurr('INR');
    setContactName('');
    setContactPhone('');
    setContactEmail('');
    setPaymentTerms('');
    setLeadTime('');
    setAddress('');
    setGstin('');
    setFormNotes('');
    setSuppliedItems([]);
    setVsiType('product');
    setVsiProduct('');
    setVsiPartCode('');
    setVsiPartName('');
    setVsiCategory('');
  }

  async function loadSuppliedItems(code) {
    try {
      const data = await garageFetch('getVendorSuppliedItems', { vendor_code: code }, session);
      setSuppliedItems(Array.isArray(data) ? data : []);
    } catch {
      setSuppliedItems([]);
    }
  }

  async function startEdit(code) {
    setEditingCode(code);
    setView('form');
    try {
      const v = await garageFetch('getVendor', { vendor_code: code }, session);
      const vendor = v?.vendor || v || {};
      setName(vendor.vendor_name || '');
      setCategory(vendor.category || '');
      setProcessType(vendor.process_type || '');
      setCountry(vendor.source_country || 'India');
      setLocation(vendor.location || '');
      setCurr(vendor.currency || 'INR');
      setContactName(vendor.contact_name || '');
      setContactPhone(vendor.contact_phone || '');
      setContactEmail(vendor.contact_email || '');
      setPaymentTerms(vendor.payment_terms || '');
      setLeadTime(vendor.lead_time_days != null ? String(vendor.lead_time_days) : '');
      setAddress(vendor.address || '');
      setGstin(vendor.gstin || '');
      setFormNotes(vendor.notes || '');
      loadSuppliedItems(code);
    } catch (e) {
      showToast(e.message || 'Failed to load vendor', 'error');
    }
  }

  function startCreate() {
    resetForm();
    setEditingCode(null);
    setView('form');
  }

  async function handleSave() {
    if (!name.trim()) { showToast('Vendor name required', 'error'); return; }
    // Required on CREATE only. 146 existing vendors are unclassified and editing one must not
    // force a reclassification, but nothing new gets on file without a process again.
    if (!editingCode && !processType) { showToast('Process required — what does this vendor do to the part?', 'error'); return; }
    setSubmitting(true);
    try {
      const data = {
        vendor_name: name.trim(),
        category:    category || null,
        process_type: processType || null,
        source_country: country,
        currency: curr,
        location: location || null,
        contact_name: contactName || null,
        contact_phone: contactPhone || null,
        contact_email: contactEmail || null,
        payment_terms: paymentTerms || null,
        lead_time_days: leadTime ? parseInt(leadTime, 10) : null,
        address: address || null,
        gstin: gstin.trim() || null,
        notes: formNotes || null,
      };
      const action = editingCode ? 'updateVendor' : 'postVendor';
      const payload = editingCode ? { vendor_code: editingCode, ...data } : data;
      const res = await workerFetch(action, { data: payload }, session);
      const result = res.data || res;
      showToast(editingCode ? `${editingCode} updated` : `${result.vendor_code} created`, 'success');
      setView('list');
      resetForm();
      setEditingCode(null);
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function handlePartSearch(value) {
    setVsiPartCode(value);
    setVsiPartName('');
    if (partTimer.current) clearTimeout(partTimer.current);
    if (value.length < 2) { setPartSuggestions([]); setShowPartSuggestions(false); return; }
    partTimer.current = setTimeout(async () => {
      try {
        const data = await garageFetch('getMaterials', { search: value }, session);
        setPartSuggestions(Array.isArray(data) ? data.slice(0, 8) : []);
        setShowPartSuggestions(true);
      } catch { setPartSuggestions([]); }
    }, 200);
  }

  function selectPart(p) {
    setVsiPartCode(p.part_code);
    setVsiPartName(p.part_name || '');
    setShowPartSuggestions(false);
    // Keep the chosen row as the sole option so the async Combobox can resolve its label.
    setPartSuggestions([p]);
  }

  async function addSuppliedItem() {
    if (!editingCode) return;
    let reference = '';
    if (vsiType === 'product') reference = vsiProduct;
    else if (vsiType === 'part') reference = vsiPartCode;
    else reference = vsiCategory;
    if (!reference) { showToast('Select a reference', 'error'); return; }
    if (!vsiCategory && vsiType !== 'category') { showToast('Select PO category', 'error'); return; }
    setVsiSubmitting(true);
    try {
      await workerFetch('postVendorSuppliedItem', {
        data: {
          vendor_code: editingCode,
          supply_type: vsiType,
          reference,
          po_category: vsiCategory || (vsiType === 'category' ? vsiCategory : ''),
        },
      }, session);
      showToast('Supplied item added', 'success');
      setVsiProduct('');
      setVsiPartCode('');
      setVsiPartName('');
      setVsiCategory('');
      loadSuppliedItems(editingCode);
    } catch (e) {
      showToast(e.message || 'Failed to add', 'error');
    } finally {
      setVsiSubmitting(false);
    }
  }

  if (perms && !perms.procurement_view) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  if (view === 'list') {
    const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = tokens.length === 0 ? vendors : vendors.filter(v => {
      const hay = `${v.vendor_code || ''} ${v.vendor_name || ''} ${v.category || ''} ${v.process_type || ''} ${v.source_country || ''} ${v.location || ''} ${v.contact_name || ''} ${v.contact_phone || ''} ${v.contact_email || ''} ${v.gstin || ''}`.toLowerCase();
      return tokens.every(t => hay.includes(t));
    });
    const activeCount = vendors.filter(v => v.active).length;
    const chinaCount = vendors.filter(v => v.source_country === 'China').length;
    const indiaCount = vendors.filter(v => v.source_country === 'India').length;
    return (
      <div className="pg">
        <PageHead title="Vendors" sub="Supplier directory — drives PO auto-fill."
          actions={perms?.vendor_manage && <Btn kind="primary" onClick={startCreate}><Plus size={14} /> New Vendor</Btn>} />

        <div className="kpi-row">
          <Kpi label="Vendors" value={vendors.length} sub="on file" tone="blue" />
          <Kpi label="Active" value={activeCount} sub="bookable" tone="green" />
          <Kpi label="China" value={chinaCount} sub="suppliers" tone="blue" />
          <Kpi label="India" value={indiaCount} sub="suppliers" tone="green" />
        </div>

        <Panel title="Directory" count={tokens.length > 0 ? `${filtered.length} of ${vendors.length}` : vendors.length}
          action={
            <div className="filters">
              <input className="sel" data-search-primary type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search code, name, category… · /" autoComplete="off" style={{ minWidth: 240 }} />
              {search && <button className="chip-clear" onClick={() => setSearch('')}>Clear ✕</button>}
            </div>
          }>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : filtered.length === 0 ? (
            <EmptyState icon="building-2" title="No vendors match" hint={vendors.length === 0 ? 'No vendors yet.' : 'Clear the search to see all suppliers.'} />
          ) : (
            <table className="dt">
              <thead><tr>
                <th>Code</th><th>Vendor</th><th>Category</th><th>Process</th><th>Country</th><th>Contact</th>
                <th>Terms</th><th className="num">Lead</th><th>Status</th><th className="num"></th>
              </tr></thead>
              <tbody>
                {filtered.map((v) => (
                  <tr key={v.vendor_code} className={perms?.vendor_manage ? 'row-click' : ''} onClick={() => perms?.vendor_manage && startEdit(v.vendor_code)}>
                    <td className="mono accent">{v.vendor_code}</td>
                    <td>{v.vendor_name}</td>
                    <td className="dim">{v.category || '—'}</td>
                    <td className="dim">{processLabel(v.process_type)}</td>
                    <td><Badge label={v.source_country || '—'} tone={countryTone(v.source_country)} soft={false} /></td>
                    <td className="dim">{v.contact_name || '—'}{v.contact_phone ? ` · ${v.contact_phone}` : ''}</td>
                    <td className="mono dim">{v.payment_terms || '—'}</td>
                    <td className="num mono">{v.lead_time_days != null ? `${v.lead_time_days}d` : '—'}</td>
                    <td><Badge label={v.active ? 'Active' : 'Inactive'} tone={v.active ? 'green' : 'gray'} dot /></td>
                    <td className="num">{perms?.vendor_manage && <span className="row-go"><ArrowRight size={14} /></span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    );
  }

  // form view
  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 12 }}>
        <button style={btnSecondary} onClick={() => { setView('list'); resetForm(); setEditingCode(null); }}>← Back to list</button>
      </div>
      <h2 style={{ fontFamily: 'var(--cond)', fontSize: 18, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px' }}>
        {editingCode ? `Edit Vendor — ${editingCode}` : 'New Vendor'}
      </h2>

      <div style={{ ...panelStyle, maxWidth: 800 }}>
        <div style={panelHeaderStyle}><span>Vendor Details</span></div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Vendor Name *" value={name} onChange={setName} disabled={submitting} />
            <SelectField label="Category" value={category} onChange={setCategory} options={['', ...VENDOR_CATEGORIES]} disabled={submitting} />
            <SelectField label={editingCode ? 'Process' : 'Process *'} value={processType} onChange={setProcessType}
              options={['', ...VENDOR_PROCESS_TYPES]} disabled={submitting} />
            <SelectField label="Source Country" value={country} onChange={setCountry} options={PO_SOURCES} disabled={submitting} />
            <Field label="Location" value={location} onChange={setLocation} disabled={submitting} />
            <SelectField label="Currency" value={curr} onChange={setCurr} options={PO_CURRENCIES} disabled={submitting} />
            <Field label="Contact Name" value={contactName} onChange={setContactName} disabled={submitting} />
            <Field label="Contact Phone" value={contactPhone} onChange={setContactPhone} disabled={submitting} />
            <Field label="Contact Email" value={contactEmail} onChange={setContactEmail} disabled={submitting} />
            <SelectField label="Default Payment Terms" value={paymentTerms} onChange={setPaymentTerms} options={['', ...PO_PAYMENT_TERMS]} disabled={submitting} />
            <Field label="Typical Lead Time (days)" value={leadTime} onChange={setLeadTime} type="number" disabled={submitting} />
            <div style={{ gridColumn: '1 / -1' }}>
              <span style={labelStyle}>Address</span>
              <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
            </div>
            <Field label="GSTIN" value={gstin} onChange={setGstin} placeholder="e.g. 29AALFA6686P1ZE" disabled={submitting} />
            <div style={{ gridColumn: '1 / -1' }}>
              <span style={labelStyle}>Notes</span>
              <textarea value={formNotes} onChange={(e) => setFormNotes(e.target.value)} rows={2} style={{ ...inputStyle, width: '100%', resize: 'vertical' }} disabled={submitting} />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
            <button style={btnSecondary} onClick={() => { setView('list'); resetForm(); setEditingCode(null); }} disabled={submitting}>Cancel</button>
            <button
              style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
              onClick={handleSave}
              disabled={submitting}
            >
              {submitting ? 'Saving…' : 'Save Vendor'}
            </button>
          </div>
        </div>
      </div>

      {editingCode && (
        <div style={{ ...panelStyle, maxWidth: 800 }}>
          <div style={panelHeaderStyle}>
            <span>Supplied Items</span>
            <span style={{ color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)', textTransform: 'none', letterSpacing: 0 }}>
              What this vendor supplies — drives PO auto-fill
            </span>
          </div>
          <div style={panelBodyStyle}>
            {suppliedItems.length === 0 ? (
              <div style={{ padding: '12px 0', color: 'var(--t3)', fontSize: 11, fontStyle: 'italic' }}>
                No items registered yet.
              </div>
            ) : (
              <div style={{ marginBottom: 14 }}>
                {suppliedItems.map((it) => (
                  <div key={it.id || `${it.supply_type}-${it.reference}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, marginBottom: 6, gap: 10 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <StatusBadge label={it.supply_type} tone="blue" />
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--yellow)' }}>{it.reference}</span>
                      <span style={{ fontSize: 11, color: 'var(--t3)' }}>{it.po_category || '—'}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style={{ ...labelStyle, marginBottom: 6 }}>Add Supplied Item</div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button style={tabBtn(vsiType === 'product')} onClick={() => setVsiType('product')}>Product</button>
                <button style={tabBtn(vsiType === 'part')} onClick={() => setVsiType('part')}>Part</button>
                <button style={tabBtn(vsiType === 'category')} onClick={() => setVsiType('category')}>Category</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                <div>
                  <span style={labelStyle}>Reference</span>
                  {vsiType === 'product' ? (
                    <Combobox
                      value={vsiProduct}
                      options={PRODUCTS.map((p) => ({ value: p, label: p }))}
                      onChange={(v) => setVsiProduct(v)}
                      placeholder="Search products…"
                      loading={productsLoading}
                    />
                  ) : vsiType === 'part' ? (
                    <Combobox
                      value={vsiPartCode}
                      options={partSuggestions.map((p) => ({
                        value: p.part_code,
                        label: `${p.part_code}${p.part_name ? ' — ' + p.part_name : ''}`,
                        hint: [p.product, p.part_category].filter(Boolean).join(' · '),
                        part_code: p.part_code, part_name: p.part_name, product: p.product,
                      }))}
                      onQueryChange={handlePartSearch}
                      onChange={(val, opt) => {
                        if (opt) selectPart(opt);
                        else { setVsiPartCode(''); setVsiPartName(''); }
                      }}
                      placeholder="Type to search part code / name…"
                      emptyLabel="Type 2+ characters…"
                      inputStyle={{ fontFamily: 'var(--mono)' }}
                    />
                  ) : (
                    <select value={vsiCategory} onChange={(e) => setVsiCategory(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
                      <option value="">Select…</option>
                      {PO_CATEGORY_KEYS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                  )}
                </div>
                <div>
                  <span style={labelStyle}>PO Category</span>
                  <select value={vsiCategory} onChange={(e) => setVsiCategory(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
                    <option value="">Select…</option>
                    {PO_CATEGORY_KEYS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </div>
                <button
                  style={{ ...btnPrimary, opacity: vsiSubmitting ? 0.6 : 1 }}
                  onClick={addSuppliedItem}
                  disabled={vsiSubmitting}
                >
                  + Add
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', disabled, placeholder }) {
  return (
    <div>
      <span style={labelStyle}>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={{ ...inputStyle, width: '100%' }} disabled={disabled} />
    </div>
  );
}

function processLabel(v) {
  return VENDOR_PROCESS_TYPES.find((p) => p.value === v)?.label || '—';
}

// `options` takes plain strings or { value, label } — the process types need a display
// label that differs from the stored value.
function SelectField({ label, value, onChange, options, disabled }) {
  return (
    <div>
      <span style={labelStyle}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={disabled}>
        {options.map((o) => {
          const val = typeof o === 'string' ? o : o.value;
          const lab = typeof o === 'string' ? o : o.label;
          return <option key={val} value={val}>{lab || '—'}</option>;
        })}
      </select>
    </div>
  );
}
