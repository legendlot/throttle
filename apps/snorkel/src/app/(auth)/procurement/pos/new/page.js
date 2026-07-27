'use client';
import { Fragment, Suspense, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useProducts } from '../../../../../hooks/useProducts.js';
import { computeTax } from '@/lib/poTax';
import { Car, Wrench, Package, Cog, BatteryFull, Bolt, FileText, Tag, Pencil } from 'lucide-react';

const PO_SOURCES = ['China', 'India', 'USA', 'Germany', 'Taiwan', 'Vietnam', 'Bangladesh', 'Japan', 'South Korea', 'UK', 'Italy', 'Turkey', 'Other'];
const PO_TYPES   = ['Product', 'Packaging', 'Para', 'Consumable', 'Component', 'Tools', 'Machines'];
const PO_CURRENCIES = ['INR', 'USD', 'RMB'];
const PO_INCOTERMS  = ['FOB', 'CIF', 'DDP', 'Ex-Works', 'Local delivery'];
const PO_PAYMENT_TERMS = ['Advance', 'Credit 30', 'Credit 60', 'LC', 'TT'];
const PO_SHIP_MODES = ['Sea', 'Air', 'Land'];

// PO_CATEGORIES — procurement redesign (Session C, 2026-05-21).
// Each card carries a `bom_filter` describing which `bom_register` rows the line-group flow shows.
// Filter axis is intentionally hybrid: some cards use part_category (Packaging/Para/Sticker),
// others use part_type (Metal/Electronic/Hardware). Components has no pre-filter — it's the
// umbrella search across all active BOM rows.
const PO_CATEGORIES = [
  { key: 'full_products', Icon: Car,         title: 'Full Products',  sub: 'FBU / CKD',          desc: 'Finished units ordered at product level',     order_type: 'Product',    source: 'India', currency: 'INR', incoterms: '',                bom_filter: null },
  { key: 'components',    Icon: Wrench,      title: 'Components',     sub: 'All categories',     desc: 'Multi-product BOM line entry (any category)', order_type: 'Component',  source: 'India', currency: 'INR', incoterms: 'Local delivery', bom_filter: null },
  { key: 'packaging',     Icon: Package,     title: 'Packaging',      sub: 'India',              desc: 'Boxes, trays, shrink wrap, inserts',          order_type: 'Packaging',  source: 'India', currency: 'INR', incoterms: 'Local delivery', bom_filter: { type: 'part_category', value: ['Packaging','Primary Packaging'] } },
  { key: 'metal',         Icon: Cog,         title: 'Metal Parts',    sub: 'India',              desc: 'Springs, axles, metal hardware',              order_type: 'Component',  source: 'India', currency: 'INR', incoterms: 'Local delivery', bom_filter: { type: 'part_type', value: 'Metal' } },
  { key: 'electronics',   Icon: BatteryFull, title: 'Electronics',    sub: 'India',              desc: 'Batteries, PCBs, chargers',                   order_type: 'Component',  source: 'India', currency: 'INR', incoterms: 'Local delivery', bom_filter: { type: 'part_type', value: 'Electronic' } },
  { key: 'consumables',   Icon: Bolt,        title: 'Consumables',    sub: 'India',              desc: 'Screws, fasteners, elastic bands',            order_type: 'Consumable', source: 'India', currency: 'INR', incoterms: 'Local delivery', bom_filter: { type: 'part_type', value: 'Hardware' } },
  { key: 'para',          Icon: FileText,    title: 'Para',           sub: 'India',              desc: 'Comics, licences, manuals',                   order_type: 'Para',       source: 'India', currency: 'INR', incoterms: 'Local delivery', bom_filter: { type: 'part_category', value: 'Para' } },
  { key: 'stickers',      Icon: Tag,         title: 'Stickers',       sub: 'India',              desc: 'Product stickers, decals',                    order_type: 'Para',       source: 'India', currency: 'INR', incoterms: 'Local delivery', bom_filter: { type: 'part_category', value: 'Sticker' } },
  { key: 'other',         Icon: Pencil,      title: 'Custom / Other', sub: 'Any',                desc: 'Free-form lines, factory ad-hoc',             order_type: '',           source: 'India', currency: 'INR', incoterms: '',                bom_filter: null },
];

const BOM_GROUPS = [
  { key: 'full',        label: '🚗 Full Product' },
  { key: 'car',         label: '🔩 Car Parts' },
  { key: 'remote',      label: '📡 Remote Only' },
  { key: 'accessories', label: '🧰 Accessories' },
  { key: 'metal',       label: '⚙ Metal Parts' },
  { key: 'packaging',   label: '📦 Packaging' },
  { key: 'para',        label: '📄 Para' },
  { key: 'consumables', label: '🔧 Consumables' },
];

const ITEM_TYPES = ['Part', 'Other', 'FBU Unit', 'Ecom Packaging', 'Comic', 'Consumable'];

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
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const panelBodyStyle   = { padding: '14px 16px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '7px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

const modeBtn = (active) => ({
  background: active ? 'var(--yellow)' : 'var(--surface2)',
  color: active ? '#000' : 'var(--t3)',
  border: active ? '1px solid var(--yellow)' : '1px solid var(--border)',
  borderRadius: 4, padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: active ? 700 : 500,
});

const cardStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: 24,
  cursor: 'pointer',
  textAlign: 'center',
  transition: 'border-color 0.15s, transform 0.15s',
};

const cardHover = { borderColor: 'var(--yellow)', transform: 'translateY(-2px)' };

function addDays(dateStr, n) {
  if (!dateStr || !n) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  d.setDate(d.getDate() + parseInt(n, 10));
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromStr, toStr) {
  if (!fromStr || !toStr) return 0;
  const f = new Date(fromStr);
  const t = new Date(toStr);
  if (isNaN(f) || isNaN(t)) return 0;
  return Math.round((t - f) / (1000 * 60 * 60 * 24));
}

function ModesByCategory(catKey) {
  // Full Products → unit-row entry with per-line FBU/CKD + remote_qty.
  if (catKey === 'full_products') return ['units'];
  // Components (umbrella) + 5 BOM-pre-filtered cards → bom (line-group) + manual escape hatch.
  if (catKey === 'components' || catKey === 'packaging' || catKey === 'metal'
      || catKey === 'electronics' || catKey === 'consumables'
      || catKey === 'para' || catKey === 'stickers') {
    return ['bom', 'manual'];
  }
  // Custom / Other → manual only.
  return ['manual'];
}

export default function NewPOPageWrapper() {
  return (
    <Suspense fallback={<div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>}>
      <NewPOPage />
    </Suspense>
  );
}

function NewPOPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const { PRODUCTS, PRODUCT_VARIANTS, PRODUCT_COLORS, HAS_REMOTE, loading: productsLoading } = useProducts();

  const [step, setStep] = useState('category');
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [hoverCard, setHoverCard] = useState(null);
  // China PO mode (procurement redesign, 2026-05-21):
  // Set true when the user enters via the gated "China PO" card. Forces source=China,
  // currency=RMB, incoterms=FOB on category selection; filters vendor picker to Chinese vendors;
  // exposes the "Save as Soft PO" submit option.
  const [chinaMode, setChinaMode] = useState(false);

  // Header
  const [orderType, setOrderType] = useState('');
  const [source, setSource] = useState('India');
  const [currency, setCurrency] = useState('INR');
  const [incoterms, setIncoterms] = useState('');
  const [vendor, setVendor] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [leadTimeDays, setLeadTimeDays] = useState('');
  const [portOfLoading, setPortOfLoading] = useState('');
  const [notes, setNotes] = useState('');
  const [showAutoFields, setShowAutoFields] = useState(false);

  // Timeline
  const [readyDate, setReadyDate] = useState('');
  const [shippingDate, setShippingDate] = useState('');
  const [shippingMode, setShippingMode] = useState('');
  const [forwarderCode, setForwarderCode] = useState('');
  const [transitDays, setTransitDays] = useState('');

  // Lines
  const [lineMode, setLineMode] = useState('bom');
  const [lineItems, setLineItems] = useState([]); // {part_code, description, item_type, qty_ordered, unit, unit_price, product, variant}
  const [mouldsCache, setMouldsCache] = useState(null); // mould master for the Mould line-kind
  const [mouldPreview, setMouldPreview] = useState({}); // mould_no → parts[] (for the "will receive" preview)

  // BOM mode
  const [bomProduct, setBomProduct] = useState('');
  const [bomVariant, setBomVariant] = useState('');
  const [bomQty, setBomQty] = useState(1);
  const [bomGroup, setBomGroup] = useState(null);
  const [bomChecklist, setBomChecklist] = useState([]); // {part_code, part_name, category, type, bom_qty, qty (overrideable), checked}
  const [bomLoading, setBomLoading] = useState(false);

  // Units mode
  const [fbuProduct, setFbuProduct] = useState('');
  const [unitsRows, setUnitsRows] = useState([]); // for FBU unit-grid: {variant, color, qty, withRemote}

  // Caches
  const [vendorCache, setVendorCache] = useState([]);
  const [forwarderCache, setForwarderCache] = useState([]);
  const [partsCache, setPartsCache] = useState(null);     // null = not loaded yet
  const [partsLoading, setPartsLoading] = useState(false);
  const [companyAddresses, setCompanyAddresses] = useState([]);
  const [deliveryAddressId, setDeliveryAddressId] = useState('');

  // HSN → GST rate map (PO-GST feature). Loaded once on mount; powers
  // auto-fill + lock on the GST% column when a known HSN is entered.
  const [hsnMap, setHsnMap] = useState({});
  const [partHsnMap, setPartHsnMap] = useState({});   // part_code -> { hsn_code, gst_percent }

  const [submitting, setSubmitting] = useState(false);
  const rrParam = searchParams?.get('rr') || null;
  const announcedRR = useRef(false);
  // Side-by-side: when arriving from a PO request, load it to show alongside the form.
  const requestParam = searchParams?.get('request') || null;
  const [linkedRequest, setLinkedRequest] = useState(null);
  useEffect(() => {
    if (!session || !requestParam) return;
    garageFetch('getRequest', { request_no: requestParam }, session)
      .then((res) => setLinkedRequest(res?.request || null))
      .catch(() => {});
  }, [session, requestParam]);

  // Lazy caches
  useEffect(() => {
    if (!session) return;
    garageFetch('getVendors', {}, session).then((d) => setVendorCache(Array.isArray(d) ? d : [])).catch(() => {});
    garageFetch('getForwarders', {}, session).then((d) => setForwarderCache(Array.isArray(d) ? d : [])).catch(() => {});
    garageFetch('getCompanyAddresses', {}, session).then((d) => {
      const list = Array.isArray(d) ? d : [];
      setCompanyAddresses(list);
      const def = list.find((a) => a.is_default_delivery);
      if (def) setDeliveryAddressId(String(def.id));
    }).catch(() => {});
    garageFetch('getHsnRates', {}, session).then((d) => {
      const map = {};
      (Array.isArray(d) ? d : []).forEach((r) => {
        if (r.hsn_code) map[r.hsn_code] = parseFloat(r.gst_percent);
      });
      setHsnMap(map);
    }).catch(() => {});
    // part -> HSN from the part master. The BOM-add path fills HSN from getBOM, i.e.
    // bom_register.hsn_code, which is empty for every part — so without this the
    // pre-fill silently produces a blank (the reason ~401 INR PO lines carry no HSN).
    garageFetch('getPartHsnMap', {}, session).then((d) => {
      const m = {};
      (Array.isArray(d) ? d : []).forEach((r) => { if (r.part_code) m[r.part_code] = r; });
      setPartHsnMap(m);
    }).catch(() => {});
  }, [session]);

  // RR conversion toast
  useEffect(() => {
    if (rrParam && !announcedRR.current) {
      showToast(`Create the PO — it will be linked to ${rrParam}`, 'info');
      announcedRR.current = true;
    }
  }, [rrParam, showToast]);

  function applyCategory(cat, isChina = false) {
    setSelectedCategory(cat);
    setOrderType(cat.order_type || '');
    // China mode: force China sourcing defaults regardless of card defaults.
    setSource(isChina ? 'China' : (cat.source || 'India'));
    setCurrency(isChina ? 'RMB' : (cat.currency || 'INR'));
    setIncoterms(isChina ? 'FOB' : (cat.incoterms || ''));
    const modes = ModesByCategory(cat.key);
    setLineMode(modes[0]);
    setLineItems([]);
    setStep('form');
  }

  function vendorMatch(name) {
    if (!name) return null;
    const lo = name.trim().toLowerCase();
    return vendorCache.find((v) => (v.vendor_name || '').toLowerCase() === lo) || null;
  }

  function onForwarderChange(code) {
    setForwarderCode(code);
    const f = forwarderCache.find((x) => x.forwarder_code === code);
    if (!f) return;
    if (shippingMode === 'Sea' && f.sea_days != null)  setTransitDays(String(f.sea_days));
    if (shippingMode === 'Air' && f.air_days != null)  setTransitDays(String(f.air_days));
    if (shippingMode === 'Land' && f.land_days != null) setTransitDays(String(f.land_days));
  }

  function onShippingModeChange(mode) {
    setShippingMode(mode);
    const f = forwarderCache.find((x) => x.forwarder_code === forwarderCode);
    if (!f) return;
    if (mode === 'Sea' && f.sea_days != null)   setTransitDays(String(f.sea_days));
    if (mode === 'Air' && f.air_days != null)   setTransitDays(String(f.air_days));
    if (mode === 'Land' && f.land_days != null) setTransitDays(String(f.land_days));
  }

  const computedArrival = useMemo(() => {
    if (!shippingDate || !transitDays) return '';
    return addDays(shippingDate, transitDays);
  }, [shippingDate, transitDays]);

  const productionLeadTime = useMemo(() => {
    if (!readyDate) return 0;
    return daysBetween(todayStr(), readyDate);
  }, [readyDate]);

  // BOM checklist load
  async function loadBomChecklist() {
    if (!bomProduct) { showToast('Select a product', 'error'); return; }
    setBomLoading(true);
    try {
      const data = await garageFetch('getBOM', { product: bomProduct, variant: bomVariant || '' }, session);
      const rows = (Array.isArray(data) ? data : []).map((r) => ({
        part_code: r.part_code,
        part_name: r.part_name,
        category:  r.part_category || '',
        type:      r.part_type || '',
        hsn_code:  r.hsn_code || '',
        bom_qty:   parseFloat(r.qty_per_unit) || 0,
        qty:       String((parseFloat(r.qty_per_unit) || 0) * (parseInt(bomQty, 10) || 1)),
        checked:   true,
      }));
      // Filter by group
      let filtered = rows;
      if (bomGroup && bomGroup !== 'full') {
        const groupCats = {
          car:         ['Car', 'Body'],
          remote:      ['Remote'],
          accessories: ['Accessories'],
          metal:       ['Metal'],
          packaging:   ['Packaging'],
          para:        ['Para', 'License', 'Comic'],
          consumables: ['Consumables', 'Batteries', 'Chemical'],
        }[bomGroup] || [];
        filtered = rows.filter((r) => groupCats.some((c) => (r.category || '').toLowerCase().includes(c.toLowerCase())));
      }
      // A-6: apply selected category's bom_filter on top (cards like Metal/Electronics/
      // Packaging/Para/Stickers narrow the BOM list to their bucket).
      const cardFilter = selectedCategory?.bom_filter;
      if (cardFilter) {
        const want = Array.isArray(cardFilter.value) ? cardFilter.value : [cardFilter.value];
        const wantLc = want.map((v) => String(v).toLowerCase());
        const key = cardFilter.type === 'part_type' ? 'type' : 'category';
        filtered = filtered.filter((r) => wantLc.includes(String(r[key] || '').toLowerCase()));
      }
      setBomChecklist(filtered);
    } catch (e) {
      showToast(e.message || 'BOM load failed', 'error');
    } finally {
      setBomLoading(false);
    }
  }

  function addBomSelected() {
    const picked = bomChecklist.filter((r) => r.checked && parseFloat(r.qty) > 0);
    if (!picked.length) { showToast('No parts selected', 'error'); return; }
    setLineItems((prev) => [
      ...prev,
      ...picked.map((r) => {
        // Part master first — getBOM's hsn_code (bom_register) is empty for every part.
        const hsn = partHsnMap[r.part_code]?.hsn_code || r.hsn_code || '';
        const gst = hsn && hsnMap[hsn] != null ? hsnMap[hsn] : '';
        return {
          part_code:    r.part_code,
          description:  r.part_name,
          item_type:    'Part',
          qty_ordered:  String(r.qty),
          unit:         'pcs',
          unit_price:   '',
          product:      bomProduct,
          variant:      bomVariant || null,
          hsn_code:     hsn,
          gst_percent:  gst === '' ? '' : String(gst),
        };
      }),
    ]);
    setBomChecklist([]);
    setBomGroup(null);
    showToast(`Added ${picked.length} parts`, 'success');
  }

  // Manual mode
  function addManualLine() {
    setLineItems((prev) => [...prev, { part_code: '', description: '', item_type: 'Part', qty_ordered: '', unit: 'pcs', unit_price: '', hsn_code: '', gst_percent: '' }]);
  }
  function updateLine(i, field, value) {
    setLineItems((prev) => prev.map((l, j) => (j === i ? { ...l, [field]: value } : l)));
  }
  function removeLine(i) {
    setLineItems((prev) => prev.filter((_, j) => j !== i));
  }
  async function loadParts() {
    if (partsCache || partsLoading) return;
    setPartsLoading(true);
    try {
      const data = await garageFetch('getProcurementParts', {}, session);
      setPartsCache(Array.isArray(data) ? data : []);
    } catch {
      setPartsCache([]);
    } finally {
      setPartsLoading(false);
    }
  }

  // Mould line kind (order-by-mould / receive-by-part). A mould line carries
  // item_type='Mould' + mould_no; qty_ordered = shots. Receiving explodes it into
  // the constituent part codes at shots × qty_per_shot.
  async function loadMoulds() {
    if (mouldsCache) return;
    try {
      const data = await garageFetch('getMoulds', {}, session);
      setMouldsCache(Array.isArray(data) ? data.filter(m => m.is_active) : []);
    } catch { setMouldsCache([]); }
  }
  function addMouldLine() {
    loadMoulds();
    setLineItems((prev) => [...prev, { part_code: '', description: '', item_type: 'Mould', mould_no: '', qty_ordered: '', unit: 'shots', unit_price: '', hsn_code: '', gst_percent: '' }]);
  }
  async function selectMould(i, mouldNo) {
    const m = (mouldsCache || []).find(x => x.mould_no === mouldNo);
    setLineItems((prev) => prev.map((row, j) => j === i ? {
      ...row, mould_no: mouldNo, item_type: 'Mould',
      description: m ? `Mould ${m.mould_no}${m.description ? ' — ' + m.description : ''}` : row.description,
      unit_price: m && m.default_shot_rate != null && !row.unit_price ? String(m.default_shot_rate) : row.unit_price,
      hsn_code: m && m.hsn_code && !row.hsn_code ? m.hsn_code : row.hsn_code,
      gst_percent: m && m.gst_percent != null && (row.gst_percent === '' || row.gst_percent == null) ? String(m.gst_percent) : row.gst_percent,
    } : row));
    // fetch the part map for the "will receive" preview
    if (mouldNo && !mouldPreview[mouldNo]) {
      try {
        const full = await garageFetch('getMould', { mould_no: mouldNo }, session);
        setMouldPreview((prev) => ({ ...prev, [mouldNo]: full?.parts || [] }));
      } catch {}
    }
  }

  // Units mode (FBU)
  const fbuVariants = useMemo(() => fbuProduct ? (PRODUCT_VARIANTS[fbuProduct] || []) : [], [fbuProduct, PRODUCT_VARIANTS]);
  const fbuColors = useMemo(() => (fbuProduct ? (PRODUCT_COLORS[fbuProduct] || {}) : {}), [fbuProduct, PRODUCT_COLORS]);
  const productHasRemote = !!(fbuProduct && HAS_REMOTE && HAS_REMOTE.has?.(fbuProduct));
  function addUnitRow() {
    // Default receive_format inherits from the previous row when present so
    // operators don't have to reselect for every variant; falls back to 'FBU'
    // (most common case for China procurement).
    setUnitsRows((prev) => {
      const lastFormat = prev.length ? (prev[prev.length - 1].receive_format || 'FBU') : 'FBU';
      return [...prev, { variant: '', color: '', qty: '', remote_qty: '', receive_format: lastFormat }];
    });
  }
  function updateUnitRow(i, field, value) {
    setUnitsRows((prev) => prev.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
  }
  function handleVariantChange(i, variant) {
    setUnitsRows((prev) => prev.map((r, j) => {
      if (j !== i) return r;
      const colours = (PRODUCT_COLORS[fbuProduct]?.[variant]) || [];
      return { ...r, variant, color: colours.length === 1 ? colours[0] : '' };
    }));
  }
  function removeUnitRow(i) {
    setUnitsRows((prev) => prev.filter((_, j) => j !== i));
  }

  // Tax-aware totals: subtotal + (CGST+SGST | IGST) + grand total. Live updates
  // as the user edits qty / unit_price / HSN / GST% on any line. Uses the
  // selected vendor's GSTIN (when known) to decide intra-state vs interstate.
  const selectedVendor = useMemo(() => vendorMatch(vendor), [vendor, vendorCache]);
  const tax = useMemo(
    () => computeTax(lineItems, currency, selectedVendor?.gstin || null),
    [lineItems, currency, selectedVendor]
  );
  const lineTotal = tax.taxable;

  // Submit
  async function handleSubmit(opts = {}) {
    const isSoft = !!opts.soft;
    if (!vendor.trim()) { showToast('Vendor required', 'error'); return; }
    if (isSoft && !chinaMode) { showToast('Soft PO is only valid in China mode', 'error'); return; }

    let lines = [...lineItems];

    // Full Products mode (Session C redesign): each unitsRow emits ONE line
    // (the product) with per-line receive_format + a separate remote_qty number.
    // The remote_qty is stored on the line itself (po_lines.remote_qty) — no
    // longer encoded in description as "+ Remote" suffix.
    if (selectedCategory?.key === 'full_products' && unitsRows.length) {
      unitsRows.forEach((u) => {
        const q = parseInt(u.qty, 10) || 0;
        if (q <= 0) return;
        const rq = parseInt(u.remote_qty, 10) || 0;
        const rf = u.receive_format || 'FBU';
        const remoteLabel = rq > 0 ? ` (+${rq} remote)` : '';
        lines.push({
          item_type:      rf === 'FBU' ? 'FBU Unit' : 'CKD Unit',
          product:        fbuProduct,
          variant:        u.variant || null,
          color:          u.color || null,
          qty_ordered:    q,
          remote_qty:     rq,
          receive_format: rf,
          unit:           'units',
          unit_price:     '',
          description:    `${fbuProduct} ${u.variant || ''} ${u.color || ''} [${rf}]${remoteLabel}`.trim().replace(/\s+/g, ' '),
        });
      });
    }

    if (!lines.length) { showToast('Add at least one line', 'error'); return; }

    const payload = {
      order_type: orderType,
      po_category: selectedCategory?.key || null,
      source,
      ...(isSoft ? { status: 'Soft' } : {}),
      vendor_name: vendor.trim(),
      vendor_code: selectedVendor?.vendor_code || null,
      currency,
      payment_terms: paymentTerms || null,
      incoterms: incoterms || null,
      expected_delivery: computedArrival || null,
      lead_time_days: leadTimeDays ? parseInt(leadTimeDays, 10) : null,
      port_of_loading: portOfLoading || null,
      expected_ready_date: readyDate || null,
      shipping_date: shippingDate || null,
      shipping_mode: shippingMode || null,
      forwarder_code: forwarderCode || null,
      transit_days: transitDays ? parseInt(transitDays, 10) : null,
      delivery_address_id: deliveryAddressId ? parseInt(deliveryAddressId, 10) : null,
      notes: notes || null,
      source_request_no: requestParam || null,
      lines: lines.map((l) => ({
        part_code:      l.part_code || null,
        description:    l.description || null,
        item_type:      l.item_type || 'Part',
        qty_ordered:    parseFloat(l.qty_ordered) || 0,
        unit:           l.unit || 'pcs',
        unit_price:     l.unit_price ? parseFloat(l.unit_price) : null,
        product:        l.product || null,
        variant:        l.variant || null,
        color:          l.color || null,
        receive_format: l.receive_format || null,
        remote_qty:     parseInt(l.remote_qty, 10) || 0,
        hsn_code:       l.hsn_code || null,
        gst_percent:    l.gst_percent !== '' && l.gst_percent != null ? parseFloat(l.gst_percent) : null,
        mould_no:       l.mould_no || null,
      })),
    };

    setSubmitting(true);
    try {
      const res = await workerFetch('postPO', { data: payload }, session);
      const result = res.data || res;
      if (rrParam) {
        try {
          await workerFetch('updateReorderRequest', {
            data: { request_id: rrParam, action: 'convert', po_number: result.po_number },
          }, session);
        } catch {}
      }
      showToast(`${result.po_number} created`, 'success');
      router.push(`/procurement/pos/detail?po_number=${encodeURIComponent(result.po_number)}`);
    } catch (e) {
      showToast(e.message || 'PO creation failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (perms && !perms.procurement_view) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }
  if (perms && !perms.po_create) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>You don&apos;t have permission to create POs.</div>;
  }

  // STEP 1 — Category picker
  if (step === 'category') {
    return (
      <div style={{ color: 'var(--t1)' }}>
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          {chinaMode ? (
            <button style={btnSecondary} onClick={() => setChinaMode(false)}>← Back to standard categories</button>
          ) : (
            <button style={btnSecondary} onClick={() => router.push('/procurement/pos')}>← Back to POs</button>
          )}
          {rrParam && (
            <span style={{ fontSize: 11, color: 'var(--yellow)', fontFamily: 'var(--mono)' }}>
              Linking to {rrParam}
            </span>
          )}
          {chinaMode && (
            <StatusBadge label="🇨🇳 China PO mode" tone="orange" />
          )}
        </div>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontFamily: 'var(--cond)', fontSize: 24, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
            {chinaMode ? 'New China PO — Select Category' : 'New Purchase Order'}
          </h1>
          <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
            {chinaMode
              ? 'Pick the sub-category for this China-sourced PO. Vendor picker will be filtered to Chinese vendors.'
              : 'Pick a category — the PO defaults to source/currency/incoterms below.'}
          </p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, maxWidth: 960 }}>
          {PO_CATEGORIES.map((cat) => (
            <div
              key={cat.key}
              style={hoverCard === cat.key ? { ...cardStyle, ...cardHover } : cardStyle}
              onMouseEnter={() => setHoverCard(cat.key)}
              onMouseLeave={() => setHoverCard(null)}
              onClick={() => applyCategory(cat, chinaMode)}
            >
              <div style={{ color: 'var(--t2)' }}>
                <cat.Icon size={28} strokeWidth={1.75} />
              </div>
              <div style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 14, marginTop: 10, color: 'var(--t1)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{cat.title}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 4, letterSpacing: '0.04em' }}>
                {chinaMode ? 'China · RMB · FOB' : cat.sub}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 8, lineHeight: 1.45 }}>{cat.desc}</div>
            </div>
          ))}
        </div>

        {/* China PO card — visible only to procurement_china holders, on the top-level (not sub) view. */}
        {!chinaMode && perms?.po_china && (
          <div style={{ maxWidth: 960, marginTop: 24 }}>
            <div style={{ ...labelStyle, marginBottom: 8 }}>Restricted Access</div>
            <div
              style={hoverCard === '__china' ? {
                ...cardStyle,
                ...cardHover,
                background: 'rgba(255,140,0,.08)',
                borderColor: '#ffaa33',
                display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
                textAlign: 'left', gap: 16,
              } : {
                ...cardStyle,
                background: 'rgba(255,140,0,.05)',
                borderColor: 'rgba(255,140,0,.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
                textAlign: 'left', gap: 16,
              }}
              onMouseEnter={() => setHoverCard('__china')}
              onMouseLeave={() => setHoverCard(null)}
              onClick={() => setChinaMode(true)}
            >
              <div style={{ fontSize: 40 }}>🇨🇳</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 16 }}>China PO</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: '#ffaa33', marginTop: 2, letterSpacing: '0.04em' }}>
                  Restricted · Financial fields hidden from non-procurement_china
                </div>
                <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 6, lineHeight: 1.4 }}>
                  China-sourced orders. Opens a sub-grid of the standard categories with Chinese vendor filter + Soft PO option for unnamed-product orders.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // STEP 2 — Form
  const allowedModes = ModesByCategory(selectedCategory?.key);

  return (
    <div style={{ color: 'var(--t1)', paddingRight: linkedRequest ? 332 : 0 }}>
      {linkedRequest && (
        <div style={{
          position: 'fixed', top: 64, right: 16, width: 300, maxHeight: 'calc(100dvh - 96px)',
          overflowY: 'auto', zIndex: 40,
          background: 'var(--surface)', border: '1px solid var(--yellow)', borderRadius: 4,
        }}>
          <div style={{ ...panelHeaderStyle, position: 'sticky', top: 0, background: 'var(--surface)' }}>
            <span>📋 Request {linkedRequest.request_no}</span>
          </div>
          <div style={{ padding: '12px 14px', fontSize: 12, lineHeight: 1.5 }}>
            <div style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 14, marginBottom: 8 }}>{linkedRequest.title}</div>
            <div style={{ whiteSpace: 'pre-wrap', color: 'var(--t1)', marginBottom: 10 }}>{linkedRequest.details}</div>
            {[['Category', linkedRequest.category], ['Suggested vendor', linkedRequest.suggested_vendor],
              ['Est. cost', linkedRequest.estimated_cost != null ? `${linkedRequest.currency || ''} ${Number(linkedRequest.estimated_cost).toLocaleString('en-IN')}` : null],
              ['Urgency', linkedRequest.urgency], ['Requested by', linkedRequest.requested_by_name],
              ['Notes', linkedRequest.notes]].filter(([, v]) => v).map(([k, v]) => (
              <div key={k} style={{ marginBottom: 6 }}>
                <span style={{ ...labelStyle, marginBottom: 2 }}>{k}</span>
                <div style={{ color: 'var(--t2)' }}>{v}</div>
              </div>
            ))}
            <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 8, fontStyle: 'italic' }}>
              Copy what you need into the PO. Accepting the PO will mark this request approved.
            </div>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <button style={btnSecondary} onClick={() => setStep('category')}>← Categories</button>
        <span style={{ color: 'var(--t3)' }}>|</span>
        <span style={{ fontFamily: 'var(--cond)', fontSize: 18, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          New Purchase Order
        </span>
        {selectedCategory && <StatusBadge label={selectedCategory.title} tone="blue" />}
        {rrParam && <StatusBadge label={`Linking ${rrParam}`} tone="yellow" />}
        {requestParam && <StatusBadge label={`From ${requestParam}`} tone="yellow" />}
      </div>

      {/* Product selector for Full Products */}
      {selectedCategory?.key === 'full_products' && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Product</span></div>
          <div style={panelBodyStyle}>
            <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 10, alignItems: 'end' }}>
              <div>
                <span style={labelStyle}>Product *</span>
                <Combobox
                  value={fbuProduct}
                  options={PRODUCTS.map((p) => ({ value: p, label: p }))}
                  onChange={(v) => { setFbuProduct(v); setUnitsRows([]); }}
                  placeholder="Search products…"
                  loading={productsLoading}
                />
              </div>
              {fbuProduct && <StatusBadge label={`Product · ${fbuProduct}`} tone="blue" />}
            </div>
          </div>
        </div>
      )}

      {/* Order details */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Order Details</span>
          <button style={btnSecondary} onClick={() => setShowAutoFields((v) => !v)}>
            {showAutoFields ? 'Hide auto-fields' : 'Edit auto-fields ↓'}
          </button>
        </div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: '8px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, marginBottom: 12, fontSize: 11, fontFamily: 'var(--mono)' }}>
            <span><span style={{ color: 'var(--t3)' }}>Type: </span><strong>{orderType || '—'}</strong></span>
            <span><span style={{ color: 'var(--t3)' }}>Source: </span><strong>{source || '—'}</strong></span>
            <span><span style={{ color: 'var(--t3)' }}>Currency: </span><strong>{currency || '—'}</strong></span>
            <span><span style={{ color: 'var(--t3)' }}>Incoterms: </span><strong>{incoterms || '—'}</strong></span>
          </div>

          {showAutoFields && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginBottom: 14 }}>
              <SelectField label="Order Type" value={orderType} onChange={setOrderType} options={['', ...PO_TYPES]} />
              <SelectField label="Source" value={source} onChange={setSource} options={PO_SOURCES} />
              <SelectField label="Currency" value={currency} onChange={setCurrency} options={PO_CURRENCIES} />
              <SelectField label="Incoterms" value={incoterms} onChange={setIncoterms} options={['', ...PO_INCOTERMS]} />
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <span style={labelStyle}>Vendor *</span>
              <Combobox
                value={selectedVendor?.vendor_code || ''}
                options={vendorCache
                  .filter((v) => chinaMode
                    ? v.source_country === 'China'
                    : v.source_country !== 'China')
                  .map((v) => ({ value: v.vendor_code, label: v.vendor_name, hint: v.vendor_code }))}
                onChange={(_, opt) => {
                  const v = opt ? vendorCache.find((x) => x.vendor_code === opt.value) : null;
                  setVendor(v ? v.vendor_name : '');
                  if (v) {
                    if (v.payment_terms) setPaymentTerms(v.payment_terms);
                    if (v.currency) setCurrency(v.currency);
                    if (v.source_country) setSource(v.source_country);
                    if (v.lead_time_days != null) setLeadTimeDays(String(v.lead_time_days));
                  }
                }}
                placeholder="Search vendors…"
                required
              />
            </div>
            <SelectField label="Payment Terms" value={paymentTerms} onChange={setPaymentTerms} options={['', ...PO_PAYMENT_TERMS]} />
            <Field label="Lead Time (days)" type="number" value={leadTimeDays} onChange={setLeadTimeDays} readOnly />
            <Field label="Port of Loading" value={portOfLoading} onChange={setPortOfLoading} />
            <div>
              <span style={labelStyle}>Delivery Address</span>
              <select
                value={deliveryAddressId}
                onChange={(e) => setDeliveryAddressId(e.target.value)}
                style={{ ...selectStyle, width: '100%' }}
              >
                {companyAddresses.length === 0 && <option value="">Loading…</option>}
                {companyAddresses.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <span style={labelStyle}>Notes</span>
              <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
            </div>
          </div>
        </div>
      </div>

      {/* Line items */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Line Items</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {allowedModes.includes('bom') && <button style={modeBtn(lineMode === 'bom')} onClick={() => setLineMode('bom')}>📋 From BOM</button>}
            {allowedModes.includes('manual') && <button style={modeBtn(lineMode === 'manual')} onClick={() => setLineMode('manual')}>✏ Manual</button>}
            {allowedModes.includes('units') && <button style={modeBtn(lineMode === 'units')} onClick={() => setLineMode('units')}>🚗 By Units</button>}
          </div>
        </div>
        <div style={panelBodyStyle}>
          {lineMode === 'bom' && (
            <BomMode
              bomProduct={bomProduct} setBomProduct={setBomProduct}
              bomVariant={bomVariant} setBomVariant={setBomVariant}
              bomQty={bomQty} setBomQty={setBomQty}
              bomGroup={bomGroup} setBomGroup={setBomGroup}
              bomChecklist={bomChecklist} setBomChecklist={setBomChecklist}
              loadBomChecklist={loadBomChecklist}
              addBomSelected={addBomSelected}
              loading={bomLoading}
              cardFilter={selectedCategory?.bom_filter}
            />
          )}

          {lineMode === 'manual' && (
            <ManualMode
              lineItems={lineItems}
              addManualLine={addManualLine}
              updateLine={updateLine}
              removeLine={removeLine}
              currency={currency}
              partsCache={partsCache}
              partsLoading={partsLoading}
              loadParts={loadParts}
              hsnMap={hsnMap}
              setLineItems={setLineItems}
              mouldsCache={mouldsCache}
              addMouldLine={addMouldLine}
              selectMould={selectMould}
              mouldPreview={mouldPreview}
            />
          )}

          {lineMode === 'units' && selectedCategory?.key === 'full_products' && (
            <UnitsMode
              fbuProduct={fbuProduct}
              fbuVariants={fbuVariants}
              fbuColors={fbuColors}
              productHasRemote={productHasRemote}
              unitsRows={unitsRows}
              addUnitRow={addUnitRow}
              updateUnitRow={updateUnitRow}
              handleVariantChange={handleVariantChange}
              removeUnitRow={removeUnitRow}
            />
          )}

          {/* Picked lines summary table */}
          {lineItems.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ ...labelStyle, marginBottom: 6 }}>Lines Added ({lineItems.length})</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={tableThStyle}>Part Code</th>
                    <th style={tableThStyle}>Description</th>
                    <th style={tableThStyle}>Type</th>
                    <th style={tableThStyle}>Qty</th>
                    <th style={tableThStyle}>Unit</th>
                    <th style={tableThStyle}>Unit Price</th>
                    <th style={tableThStyle}>Total</th>
                    <th style={{ ...tableThStyle, width: 30 }}></th>
                  </tr></thead>
                  <tbody>
                    {lineItems.map((l, i) => {
                      const tot = (parseFloat(l.qty_ordered) || 0) * (parseFloat(l.unit_price) || 0);
                      return (
                        <tr key={i}>
                          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{l.part_code || '—'}</td>
                          <td style={{ ...tableTdStyle, whiteSpace: 'normal' }}>{l.description || '—'}</td>
                          <td style={tableTdStyle}>{l.item_type}</td>
                          <td style={tableTdStyle}>
                            <input type="number" min="0" step="0.01" value={l.qty_ordered} onChange={(e) => updateLine(i, 'qty_ordered', e.target.value)} style={{ ...inputStyle, width: 90, fontFamily: 'var(--mono)' }} />
                          </td>
                          <td style={tableTdStyle}>
                            <input type="text" value={l.unit} onChange={(e) => updateLine(i, 'unit', e.target.value)} style={{ ...inputStyle, width: 70 }} />
                          </td>
                          <td style={tableTdStyle}>
                            <input type="number" min="0" step="0.01" value={l.unit_price} onChange={(e) => updateLine(i, 'unit_price', e.target.value)} style={{ ...inputStyle, width: 100, fontFamily: 'var(--mono)' }} />
                          </td>
                          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{tot.toLocaleString('en-IN')}</td>
                          <td style={tableTdStyle}>
                            <button onClick={() => removeLine(i)} style={{ background: 'transparent', border: '1px solid var(--border)', color: '#ff7070', cursor: 'pointer', fontSize: 11, borderRadius: 3, padding: '2px 6px' }}>✕</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', fontFamily: 'var(--mono)', fontSize: 12 }}>
            <div style={{ minWidth: 260 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                <span style={{ color: 'var(--t3)' }}>Subtotal</span>
                <span>{currency} {tax.taxable.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
              {tax.showGst && tax.isCgstSgst && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                    <span style={{ color: 'var(--t3)' }}>CGST {tax.halfRate > 0 ? `@ ${tax.halfRate}%` : ''}</span>
                    <span>₹ {tax.cgst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                    <span style={{ color: 'var(--t3)' }}>SGST {tax.halfRate > 0 ? `@ ${tax.halfRate}%` : ''}</span>
                    <span>₹ {tax.sgst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                </>
              )}
              {tax.showGst && !tax.isCgstSgst && (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                  <span style={{ color: 'var(--t3)' }}>IGST {tax.fullRate > 0 ? `@ ${tax.fullRate}%` : ''}</span>
                  <span>₹ {tax.igst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0 0', borderTop: '1px solid var(--border)', marginTop: 4, fontWeight: 700, color: 'var(--yellow)' }}>
                <span>Grand Total</span>
                <span>{currency} {tax.grand.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Shipping timeline */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Shipping Timeline</span></div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
            <Field label="Order Placed" type="date" value={todayStr()} onChange={() => {}} readOnly />
            <Field label="Expected Ready Date" type="date" value={readyDate} onChange={setReadyDate} />
            <div>
              <span style={labelStyle}>Production Lead Time</span>
              <input type="text" value={productionLeadTime ? `${productionLeadTime}d` : '—'} readOnly style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)', color: 'var(--t2)' }} />
            </div>
            <Field label="Shipping Date" type="date" value={shippingDate} onChange={setShippingDate} />
            <SelectField label="Shipping Mode" value={shippingMode} onChange={onShippingModeChange} options={['', ...PO_SHIP_MODES]} />
            <div>
              <span style={labelStyle}>Forwarder</span>
              <select value={forwarderCode} onChange={(e) => onForwarderChange(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
                <option value="">Select…</option>
                {forwarderCache.map((f) => <option key={f.forwarder_code} value={f.forwarder_code}>{f.company_name} ({f.forwarder_code})</option>)}
              </select>
            </div>
            <Field label="Transit Days" type="number" value={transitDays} onChange={setTransitDays} />
            <div>
              <span style={labelStyle}>Expected Arrival</span>
              <input type="text" value={computedArrival || '—'} readOnly style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)', color: 'var(--yellow)', fontWeight: 700 }} />
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button style={btnSecondary} onClick={() => router.push('/procurement/pos')} disabled={submitting}>Cancel</button>
        {/* Soft PO submit option — only in China mode (gated by procurement_china implicitly). */}
        {chinaMode && (
          <button
            style={{ ...btnSecondary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer', borderColor: '#ffaa33', color: '#ffaa33' }}
            onClick={() => handleSubmit({ soft: true })}
            disabled={submitting}
            title="Save as Soft PO — for unnamed products. Lines can have free-text description without a registered product."
          >
            {submitting ? 'Saving…' : 'Save as Soft PO'}
          </button>
        )}
        <button
          style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
          onClick={() => handleSubmit()}
          disabled={submitting}
        >
          {submitting ? 'Creating…' : 'Create PO'}
        </button>
      </div>
    </div>
  );
}

function BomMode(props) {
  const { bomProduct, setBomProduct, bomVariant, setBomVariant, bomQty, setBomQty, bomGroup, setBomGroup, bomChecklist, setBomChecklist, loadBomChecklist, addBomSelected, loading, cardFilter } = props;
  const { PRODUCTS, PRODUCT_VARIANTS } = useProducts();
  const variants = bomProduct ? (PRODUCT_VARIANTS[bomProduct] || []) : [];

  // When the chosen PO category carries a bom_filter (Metal / Electronics /
  // Packaging / Para / Stickers / Consumables), that card already defines the
  // BOM bucket. Surface it as a locked badge and auto-load on product select —
  // the generic group selector below would only be redundant/confusing here.
  // loadBomChecklist applies cardFilter on top regardless of bomGroup, and with
  // bomGroup left null no extra group narrowing is layered on.
  const cardFilterLabel = cardFilter
    ? (Array.isArray(cardFilter.value) ? cardFilter.value.join(' / ') : cardFilter.value)
    : null;

  function toggleAll(checked) {
    setBomChecklist((rows) => rows.map((r) => ({ ...r, checked })));
  }
  function updateRow(i, field, value) {
    setBomChecklist((rows) => rows.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
  }

  // Auto-load the filtered checklist whenever the product/variant/qty changes
  // on a pre-filtered card. (Re-runs with fresh deps, so no stale-closure risk.)
  useEffect(() => {
    if (cardFilter && bomProduct) {
      const t = setTimeout(loadBomChecklist, 0);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardFilter, bomProduct, bomVariant, bomQty]);

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px auto', gap: 10, alignItems: 'end', marginBottom: 12 }}>
        <div>
          <span style={labelStyle}>Product *</span>
          <Combobox
            value={bomProduct}
            options={PRODUCTS.map((p) => ({ value: p, label: p }))}
            onChange={(v) => { setBomProduct(v); setBomVariant(''); }}
            placeholder="Search products…"
          />
        </div>
        <div>
          <span style={labelStyle}>Variant</span>
          <Combobox
            value={bomVariant}
            options={variants.map((v) => ({ value: v, label: v }))}
            onChange={(v) => setBomVariant(v)}
            placeholder={bomProduct ? 'Search variants…' : 'Pick a product first'}
            disabled={!bomProduct}
          />
        </div>
        <Field label="Units Qty" type="number" value={bomQty} onChange={setBomQty} />
      </div>
      {cardFilterLabel ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t3)' }}>Showing only</span>
          <StatusBadge label={cardFilterLabel} tone="blue" />
          <span style={{ fontSize: 11, color: 'var(--t3)' }}>— set by the selected PO category</span>
          {bomProduct && (
            <button style={modeBtn(false)} onClick={() => setTimeout(loadBomChecklist, 0)}>↻ Reload</button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {BOM_GROUPS.map((g) => (
            <button
              key={g.key}
              style={modeBtn(bomGroup === g.key)}
              onClick={() => { setBomGroup(g.key); setTimeout(loadBomChecklist, 0); }}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}
      {loading ? (
        <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : bomChecklist.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button style={btnSecondary} onClick={() => toggleAll(true)}>Select All</button>
            <button style={btnSecondary} onClick={() => toggleAll(false)}>Clear All</button>
          </div>
          <div style={{ maxHeight: 460, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 3 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...tableThStyle, width: 30 }}></th>
                <th style={tableThStyle}>Part Code</th>
                <th style={tableThStyle}>Name</th>
                <th style={tableThStyle}>Category</th>
                <th style={tableThStyle}>BOM Qty</th>
                <th style={tableThStyle}>Order Qty</th>
              </tr></thead>
              <tbody>
                {bomChecklist.map((r, i) => (
                  <tr key={r.part_code}>
                    <td style={tableTdStyle}>
                      <input type="checkbox" checked={!!r.checked} onChange={(e) => updateRow(i, 'checked', e.target.checked)} />
                    </td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.part_code}</td>
                    <td style={{ ...tableTdStyle, whiteSpace: 'normal' }}>{r.part_name}</td>
                    <td style={tableTdStyle}>{r.category || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.bom_qty}</td>
                    <td style={tableTdStyle}>
                      <input type="number" min="0" step="0.01" value={r.qty} onChange={(e) => updateRow(i, 'qty', e.target.value)} style={{ ...inputStyle, width: 90, fontFamily: 'var(--mono)' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8, textAlign: 'right' }}>
            <button style={btnPrimary} onClick={addBomSelected}>Add Selected →</button>
          </div>
        </>
      )}
    </>
  );
}

function ManualMode({
  lineItems, addManualLine, updateLine, removeLine, currency,
  partsCache, partsLoading, loadParts, hsnMap, setLineItems,
  mouldsCache, addMouldLine, selectMould, mouldPreview,
}) {
  // Load the parts catalogue once so the part-code combobox is ready.
  useEffect(() => { loadParts(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const mouldOptions = useMemo(() => (mouldsCache || []).map((m) => ({
    value: m.mould_no,
    label: `${m.mould_no}${m.description ? ' — ' + m.description : ''}`,
    hint: `${m.parts_count || 0} parts`,
  })), [mouldsCache]);

  // Standardised part-code combobox options (same shape as the Part Journey /
  // stock-adjustments pickers). `hint` carries product · category · type so the
  // multi-token Combobox matches a query by code, name, product, OR category —
  // not just code+name. The raw fields ride along on the option for auto-fill.
  const partOptions = useMemo(() => (partsCache || []).map((p) => ({
    value: p.part_code,
    label: `${p.part_code}${p.part_name ? ' — ' + p.part_name : ''}`,
    hint:  [p.product, p.part_category, p.part_type].filter(Boolean).join(' · '),
    part_name: p.part_name || '',
    issue_uom: p.issue_uom || '',
    hsn_code:  p.hsn_code || '',
  })), [partsCache]);

  return (
    <>
      <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
        <button style={btnSecondary} onClick={addManualLine}>+ Add Line</button>
        <button style={btnSecondary} onClick={addMouldLine}>+ Add Mould Line</button>
      </div>
      {lineItems.length === 0 && (
        <div style={{ color: 'var(--t3)', fontSize: 11, fontStyle: 'italic', textAlign: 'center', padding: 12 }}>
          No lines yet — click + Add Line, or + Add Mould Line to order by mould.
        </div>
      )}
      {lineItems.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Part Code</th>
              <th style={tableThStyle}>Description</th>
              <th style={tableThStyle}>Type</th>
              <th style={tableThStyle}>Qty</th>
              <th style={tableThStyle}>Unit Price</th>
              <th style={tableThStyle}>Unit</th>
              {currency === 'INR' && <th style={tableThStyle}>HSN</th>}
              {currency === 'INR' && <th style={tableThStyle}>GST %</th>}
              <th style={{ ...tableThStyle, width: 30 }}></th>
            </tr></thead>
            <tbody>
              {lineItems.map((l, i) => {
                const selectPart = (opt) => {
                  // Multi-field update — go through setLineItems directly so HSN /
                  // GST auto-fill lands atomically rather than racing per-field
                  // updateLine calls.
                  setLineItems((prev) => prev.map((row, j) => {
                    if (j !== i) return row;
                    if (!opt) return { ...row, part_code: '' };
                    const next = { ...row, part_code: opt.value, description: opt.part_name || '' };
                    if (!row.unit || row.unit === 'pcs') {
                      next.unit = opt.issue_uom === 'EA' ? 'pcs' : (opt.issue_uom || 'pcs');
                    }
                    if (opt.hsn_code) {
                      next.hsn_code = opt.hsn_code;
                      if (hsnMap[opt.hsn_code] != null) next.gst_percent = String(hsnMap[opt.hsn_code]);
                    }
                    return next;
                  }));
                };

                const isMould = l.item_type === 'Mould';
                const preview = isMould && l.mould_no ? (mouldPreview?.[l.mould_no] || null) : null;
                const shots = parseFloat(l.qty_ordered) || 0;
                const colSpan = 7 + (currency === 'INR' ? 2 : 0);
                return (
                <Fragment key={i}>
                <tr>
                  <td style={tableTdStyle}>
                    {isMould ? (
                      /* Mould line — pick the mould; receiving explodes it into part codes. */
                      <div style={{ width: 240 }}>
                        <Combobox
                          value={l.mould_no || ''}
                          options={mouldOptions}
                          onChange={(val) => selectMould(i, val || '')}
                          placeholder="Search mould no / description…"
                          emptyLabel="No mould"
                          inputStyle={{ fontFamily: 'var(--mono)' }}
                          commitOnTab
                          portal
                        />
                      </div>
                    ) : (
                      /* Standardised searchable part picker (query by code / name /
                          product / category). Catalog-backed: selecting auto-fills
                          description + unit + HSN/GST. Custom / unnamed lines leave
                          the code blank and use the free-text Description column. */
                      <div style={{ width: 240 }}>
                        <Combobox
                          value={l.part_code || ''}
                          options={partOptions}
                          onChange={(_, opt) => selectPart(opt)}
                          placeholder="Search part code / name / product…"
                          loading={!partsCache && partsLoading}
                          inputStyle={{ fontFamily: 'var(--mono)' }}
                          commitOnTab
                          portal
                        />
                      </div>
                    )}
                  </td>
                  <td style={tableTdStyle}>
                    <input type="text" value={l.description} onChange={(e) => updateLine(i, 'description', e.target.value)} style={{ ...inputStyle, width: 240 }} />
                  </td>
                  <td style={tableTdStyle}>
                    {isMould ? (
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)' }}>Mould</span>
                    ) : (
                      <select value={l.item_type} onChange={(e) => updateLine(i, 'item_type', e.target.value)} style={{ ...selectStyle, width: 130 }}>
                        {ITEM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    )}
                  </td>
                  <td style={tableTdStyle}>
                    <input type="number" min="0" step="0.01" value={l.qty_ordered} onChange={(e) => updateLine(i, 'qty_ordered', e.target.value)} style={{ ...inputStyle, width: 90, fontFamily: 'var(--mono)' }} />
                  </td>
                  <td style={tableTdStyle}>
                    <input type="number" min="0" step="0.01" value={l.unit_price} onChange={(e) => updateLine(i, 'unit_price', e.target.value)} style={{ ...inputStyle, width: 100, fontFamily: 'var(--mono)' }} />
                  </td>
                  <td style={tableTdStyle}>
                    <input type="text" value={l.unit} onChange={(e) => updateLine(i, 'unit', e.target.value)} style={{ ...inputStyle, width: 70 }} />
                  </td>
                  {currency === 'INR' && (
                    <td style={tableTdStyle}>
                      <input
                        type="text"
                        maxLength={8}
                        placeholder="e.g. 7318"
                        value={l.hsn_code || ''}
                        onChange={(e) => {
                          const hsn = e.target.value;
                          setLineItems((prev) => prev.map((row, j) => {
                            if (j !== i) return row;
                            const next = { ...row, hsn_code: hsn };
                            // Auto-fill GST% when HSN matches a known rate; leave
                            // GST untouched (manual entry) when no match.
                            if (hsn && hsnMap[hsn] != null) next.gst_percent = String(hsnMap[hsn]);
                            return next;
                          }));
                        }}
                        style={{ ...inputStyle, width: 80, fontFamily: 'var(--mono)' }}
                      />
                      {l.hsn_code && hsnMap[l.hsn_code] == null && (
                        <div style={{ fontSize: 9, color: '#fbbf24', marginTop: 3, fontFamily: 'var(--mono)', lineHeight: 1.2, maxWidth: 110 }}>
                          ⚠ no known rate — enter GST manually
                        </div>
                      )}
                    </td>
                  )}
                  {currency === 'INR' && (() => {
                    const locked = !!l.hsn_code && hsnMap[l.hsn_code] != null;
                    return (
                      <td style={tableTdStyle}>
                        <input
                          type="number" min="0" max="28" step="0.1"
                          placeholder="e.g. 18"
                          value={l.gst_percent ?? ''}
                          readOnly={locked}
                          onChange={(e) => updateLine(i, 'gst_percent', e.target.value)}
                          title={locked ? `Locked: HSN ${l.hsn_code} → ${hsnMap[l.hsn_code]}%` : 'Enter GST % manually'}
                          style={{
                            ...inputStyle,
                            width: 70,
                            fontFamily: 'var(--mono)',
                            ...(locked ? { opacity: 0.65, cursor: 'not-allowed', background: 'transparent' } : {}),
                          }}
                        />
                      </td>
                    );
                  })()}
                  <td style={tableTdStyle}>
                    <button onClick={() => removeLine(i)} style={{ background: 'transparent', border: '1px solid var(--border)', color: '#ff7070', cursor: 'pointer', fontSize: 11, borderRadius: 3, padding: '2px 6px' }}>✕</button>
                  </td>
                </tr>
                {isMould && l.mould_no && (
                  <tr>
                    <td colSpan={colSpan} style={{ ...tableTdStyle, background: 'var(--surface-2, rgba(255,255,255,0.02))', padding: '6px 10px' }}>
                      {preview == null ? (
                        <span style={{ fontSize: 11, color: 'var(--t3)' }}>Loading part map…</span>
                      ) : preview.length === 0 ? (
                        <span style={{ fontSize: 11, color: '#fbbf24' }}>⚠ This mould has no parts mapped yet — the store will receive nothing. Map it in Moulds first.</span>
                      ) : (
                        <div style={{ fontSize: 11, color: 'var(--t2)' }}>
                          <span style={{ color: 'var(--t3)' }}>Will receive ({preview.length} part{preview.length > 1 ? 's' : ''}{shots > 0 ? `, ${shots} shots` : ''}): </span>
                          {preview.map((p, k) => (
                            <span key={p.part_code} style={{ fontFamily: 'var(--mono)' }}>
                              {k > 0 ? ', ' : ''}{p.part_code}{shots > 0 ? `×${Math.round(shots * (Number(p.qty_per_shot) || 1))}` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function UnitsMode({ fbuProduct, fbuVariants, fbuColors = {}, productHasRemote = false, unitsRows, addUnitRow, updateUnitRow, handleVariantChange, removeUnitRow }) {
  if (!fbuProduct) {
    return <div style={{ color: 'var(--t3)', fontSize: 11, fontStyle: 'italic' }}>Select a product first.</div>;
  }
  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <button style={btnSecondary} onClick={addUnitRow}>+ Add Variant Row</button>
      </div>
      {unitsRows.length === 0 ? (
        <div style={{ color: 'var(--t3)', fontSize: 11, fontStyle: 'italic', textAlign: 'center', padding: 12 }}>
          No rows yet — add a variant + qty.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={tableThStyle}>Format</th>
            <th style={tableThStyle}>Variant</th>
            <th style={tableThStyle}>Colour</th>
            <th style={tableThStyle}>Product Qty</th>
            {productHasRemote && <th style={tableThStyle}>Remote Qty</th>}
            <th style={{ ...tableThStyle, width: 30 }}></th>
          </tr></thead>
          <tbody>
            {unitsRows.map((r, i) => {
              const variantColors = (r.variant && fbuColors[r.variant]) || [];
              return (
                <tr key={i}>
                  <td style={tableTdStyle}>
                    {/* Per-line receive_format. FBU = assembled units arrive as full
                        product. CKD = arrives as parts; expected BOM is derived at
                        receiving time via store.get_expected_ckd_parts. */}
                    <select
                      value={r.receive_format || 'FBU'}
                      onChange={(e) => updateUnitRow(i, 'receive_format', e.target.value)}
                      style={{ ...selectStyle, width: 90 }}
                    >
                      <option value="FBU">FBU</option>
                      <option value="CKD">CKD</option>
                    </select>
                  </td>
                  <td style={tableTdStyle}>
                    <div style={{ width: 160 }}>
                      <Combobox
                        value={r.variant || ''}
                        options={fbuVariants.map((v) => ({ value: v, label: v }))}
                        onChange={(v) => handleVariantChange(i, v)}
                        placeholder="Select variant…"
                        portal
                      />
                    </div>
                  </td>
                  <td style={tableTdStyle}>
                    {variantColors.length > 0 ? (
                      <div style={{ width: 150 }}>
                        <Combobox
                          value={r.color || ''}
                          options={variantColors.map((c) => ({ value: c, label: c }))}
                          onChange={(v) => updateUnitRow(i, 'color', v)}
                          placeholder="Select colour…"
                          portal
                        />
                      </div>
                    ) : (
                      <span style={{ color: 'var(--t3)', fontSize: 11 }}>—</span>
                    )}
                  </td>
                  <td style={tableTdStyle}>
                    <input type="number" min="0" value={r.qty} onChange={(e) => updateUnitRow(i, 'qty', e.target.value)} style={{ ...inputStyle, width: 100, fontFamily: 'var(--mono)' }} placeholder="0" />
                  </td>
                  {productHasRemote && (
                    <td style={tableTdStyle}>
                      {/* Remote qty per line — replaces the old withRemote boolean.
                          0 = product-only. Different from product qty = mismatched
                          batches (some remotes already in stock, damage, etc.). */}
                      <input
                        type="number"
                        min="0"
                        value={r.remote_qty ?? ''}
                        onChange={(e) => updateUnitRow(i, 'remote_qty', e.target.value)}
                        style={{ ...inputStyle, width: 100, fontFamily: 'var(--mono)' }}
                        placeholder="0"
                      />
                    </td>
                  )}
                  <td style={tableTdStyle}>
                    <button onClick={() => removeUnitRow(i)} style={{ background: 'transparent', border: '1px solid var(--border)', color: '#ff7070', cursor: 'pointer', fontSize: 11, borderRadius: 3, padding: '2px 6px' }}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function Field({ label, value, onChange, type = 'text', readOnly }) {
  return (
    <div>
      <span style={labelStyle}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        readOnly={readOnly}
        style={{
          ...inputStyle, width: '100%',
          fontFamily: type === 'number' || type === 'date' ? 'var(--mono)' : 'inherit',
          color: readOnly ? 'var(--t2)' : 'var(--t1)',
        }}
      />
    </div>
  );
}

function SelectField({ label, value, onChange, options, disabled }) {
  return (
    <div>
      <span style={labelStyle}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={disabled}>
        {options.map((o) => <option key={o} value={o}>{o || '—'}</option>)}
      </select>
    </div>
  );
}
