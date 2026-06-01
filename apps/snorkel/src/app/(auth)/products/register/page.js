'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Combobox } from '@throttle/ui';

const COMPONENT_TYPES = [
  { value: 'car',       label: '🚗 Car' },
  { value: 'drone',     label: '🛸 Drone' },
  { value: 'accessory', label: '🧰 Accessory' },
];

const RECEIVE_FORMATS = [
  { value: 'FBU',  label: 'FBU — fully built up' },
  { value: 'CKD',  label: 'CKD — completely knocked down' },
  { value: 'BOTH', label: 'Both — can be ordered either way' },
];

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '14px 16px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '6px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12 };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit', width: '100%' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

const emptyVariant = () => ({ model: '', color: '', sku: '', product_code: '' });

export default function ProductRegisterPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();

  // Mode: 'new' (register new family) or 'extend' (add variants to existing family)
  const [mode, setMode] = useState('new');

  // Base
  const [productName, setProductName] = useState('');
  const [productCodePrefix, setProductCodePrefix] = useState('');
  const [componentType, setComponentType] = useState('car');
  const [receiveFormat, setReceiveFormat] = useState('FBU');
  const [hasRemote, setHasRemote] = useState(false);
  const [commonPackaging, setCommonPackaging] = useState(false);
  const [defaultBatchSize, setDefaultBatchSize] = useState('400');

  // Variants
  const [variants, setVariants] = useState([emptyVariant()]);

  // Remote (only used when hasRemote && mode='new')
  const [remoteSku, setRemoteSku] = useState('');
  const [remoteProductCode, setRemoteProductCode] = useState('');

  // Existing families (for extend mode)
  const [families, setFamilies] = useState([]);
  const [familiesLoading, setFamiliesLoading] = useState(false);
  const [selectedFamily, setSelectedFamily] = useState(null);

  // EAN pool status
  const [poolStatus, setPoolStatus] = useState(null);

  const [submitting, setSubmitting] = useState(false);

  const loadPool = useCallback(async () => {
    if (!session) return;
    try {
      const res = await garageFetch('getEanPoolStatus', {}, session);
      setPoolStatus(res || null);
    } catch (e) {
      setPoolStatus(null);
    }
  }, [session]);

  const loadFamilies = useCallback(async () => {
    if (!session) return;
    setFamiliesLoading(true);
    try {
      const res = await garageFetch('getProductFamilies', {}, session);
      setFamilies(Array.isArray(res) ? res : []);
    } catch (e) {
      showToast(e.message || 'Failed to load families', 'error');
    } finally {
      setFamiliesLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => { loadPool(); }, [loadPool]);
  useEffect(() => { if (mode === 'extend') loadFamilies(); }, [mode, loadFamilies]);

  // When extend mode and a family is selected, pre-fill the base fields so they're consistent.
  useEffect(() => {
    if (mode !== 'extend' || !selectedFamily) return;
    const v0 = selectedFamily.variants?.[0] || {};
    setProductName(selectedFamily.product);
    setComponentType(v0.component_type || 'car');
    setReceiveFormat(v0.receive_format || 'BOTH');
    setHasRemote(!!selectedFamily.has_remote);
    setProductCodePrefix((v0.product_code || '').slice(0, 2));
  }, [mode, selectedFamily]);

  function updateVariant(i, patch) {
    setVariants((rows) => rows.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  }
  function addVariantRow() { setVariants((rows) => [...rows, emptyVariant()]); }
  function removeVariantRow(i) {
    setVariants((rows) => rows.length > 1 ? rows.filter((_, idx) => idx !== i) : rows);
  }

  function validate() {
    if (!productName.trim()) return 'Product name required';
    if (mode === 'new' && !productCodePrefix.trim()) return 'Product code prefix required';
    if (variants.some((v) => !v.model.trim() || !v.color.trim() || !v.sku.trim() || !v.product_code.trim())) {
      return 'Every variant needs model, color, SKU and product code';
    }
    // Uniqueness checks within this submission
    const codes = variants.map((v) => v.product_code.trim().toUpperCase());
    if (new Set(codes).size !== codes.length) return 'Duplicate product codes across variants';
    const skus = variants.map((v) => v.sku.trim().toUpperCase());
    if (new Set(skus).size !== skus.length) return 'Duplicate SKUs across variants';
    if (mode === 'new' && hasRemote && (!remoteSku.trim() || !remoteProductCode.trim())) {
      return 'Remote SKU and product code required when has_remote is checked';
    }
    if (poolStatus && (poolStatus.available_count ?? 0) < variants.length) {
      return `EAN pool has only ${poolStatus.available_count} available — need ${variants.length} for these variants. Bulk-load more.`;
    }
    return null;
  }

  async function submit() {
    const err = validate();
    if (err) { showToast(err, 'error'); return; }
    const payload = {
      mode,
      base: {
        product: productName.trim(),
        product_code_prefix: productCodePrefix.trim().toUpperCase(),
        component_type: componentType,
        receive_format: receiveFormat,
        has_remote: hasRemote,
        common_packaging: commonPackaging,
        default_batch_size: parseInt(defaultBatchSize, 10) || 400,
      },
      variants: variants.map((v) => ({
        model: v.model.trim(),
        color: v.color.trim(),
        sku: v.sku.trim().toUpperCase(),
        product_code: v.product_code.trim().toUpperCase(),
      })),
      ...(mode === 'new' && hasRemote ? {
        remote: {
          sku: remoteSku.trim().toUpperCase(),
          product_code: remoteProductCode.trim().toUpperCase(),
        },
      } : {}),
    };

    setSubmitting(true);
    try {
      const action = mode === 'extend' ? 'addProductVariants' : 'registerProductFamily';
      const res = await workerFetch(action, { data: payload }, session);
      const result = res.data || res;
      const count = result?.created_count || (result?.created_eans?.length || variants.length);
      showToast(`Registered ${count} row${count === 1 ? '' : 's'} for ${productName}`, 'success');
      // Reset for next entry
      setProductName('');
      setProductCodePrefix('');
      setHasRemote(false);
      setCommonPackaging(false);
      setVariants([emptyVariant()]);
      setRemoteSku('');
      setRemoteProductCode('');
      setSelectedFamily(null);
      loadPool();
      if (mode === 'extend') loadFamilies();
    } catch (e) {
      showToast(e.message || 'Registration failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (perms && !perms.po_china) {
    return (
      <div style={{ padding: 24, color: 'var(--t3)' }}>
        Access restricted. Product registration requires the <code style={{ color: 'var(--yellow)' }}>procurement_china</code> permission.
      </div>
    );
  }

  return (
    <div style={{ color: 'var(--t1)', maxWidth: 1100 }}>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button style={btnSecondary} onClick={() => router.back()}>← Back</button>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 24, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          New Product Registration
        </h1>
        {poolStatus && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginLeft: 'auto' }}>
            EAN pool: <strong style={{ color: (poolStatus.available_count ?? 0) > 50 ? '#4ade80' : '#ffaa33' }}>{poolStatus.available_count ?? 0}</strong> available
          </span>
        )}
      </div>

      {/* Mode picker */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Mode</span></div>
        <div style={{ ...panelBodyStyle, display: 'flex', gap: 10 }}>
          {[
            { v: 'new',    label: 'New product family' },
            { v: 'extend', label: 'Add variants to existing family' },
          ].map((opt) => (
            <button
              key={opt.v}
              onClick={() => setMode(opt.v)}
              style={{
                background: mode === opt.v ? 'var(--yellow)' : 'var(--surface2)',
                color: mode === opt.v ? '#000' : 'var(--t2)',
                border: mode === opt.v ? '1px solid var(--yellow)' : '1px solid var(--border)',
                borderRadius: 4, padding: '8px 16px',
                fontFamily: 'var(--cond)', fontSize: 12, textTransform: 'uppercase',
                letterSpacing: 1, cursor: 'pointer', fontWeight: mode === opt.v ? 700 : 500,
              }}
            >{opt.label}</button>
          ))}
        </div>
      </div>

      {/* Family picker — only in extend mode */}
      {mode === 'extend' && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Existing Family</span></div>
          <div style={panelBodyStyle}>
            {familiesLoading ? (
              <div style={{ padding: 20, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : (
              <div style={{ maxWidth: 400 }}>
                <Combobox
                  value={selectedFamily?.product || ''}
                  options={families.map((f) => ({
                    value: f.product,
                    label: f.product,
                    hint: `${f.variants.length} variants${f.has_remote ? ' · has remote' : ''}`,
                  }))}
                  onChange={(v) => setSelectedFamily(families.find((f) => f.product === v) || null)}
                  placeholder="Search existing families…"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Base details */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Base Details</span></div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 10 }}>
            <div>
              <span style={labelStyle}>Product Name *</span>
              <input
                style={inputStyle}
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                placeholder="e.g. Flare 3.0"
                disabled={mode === 'extend' && !!selectedFamily}
              />
            </div>
            <div>
              <span style={labelStyle}>Product Code Prefix *</span>
              <input
                style={inputStyle}
                value={productCodePrefix}
                onChange={(e) => setProductCodePrefix(e.target.value.toUpperCase())}
                placeholder="e.g. F3"
                maxLength={4}
                disabled={mode === 'extend' && !!selectedFamily}
              />
            </div>
            <div>
              <span style={labelStyle}>Component Type *</span>
              <select
                style={selectStyle}
                value={componentType}
                onChange={(e) => setComponentType(e.target.value)}
                disabled={mode === 'extend' && !!selectedFamily}
              >
                {COMPONENT_TYPES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <span style={labelStyle}>Receive Format *</span>
              <select
                style={selectStyle}
                value={receiveFormat}
                onChange={(e) => setReceiveFormat(e.target.value)}
                disabled={mode === 'extend' && !!selectedFamily}
              >
                {RECEIVE_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                id="has_remote"
                checked={hasRemote}
                onChange={(e) => setHasRemote(e.target.checked)}
                disabled={mode === 'extend' && !!selectedFamily}
              />
              <label htmlFor="has_remote" style={{ fontSize: 12, color: 'var(--t1)' }}>Has remote</label>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                id="common_packaging"
                checked={commonPackaging}
                onChange={(e) => setCommonPackaging(e.target.checked)}
                disabled={mode === 'extend' && !!selectedFamily}
              />
              <label htmlFor="common_packaging" style={{ fontSize: 12, color: 'var(--t1)' }}>Common packaging (ships either channel)</label>
            </div>
            <div>
              <span style={labelStyle}>Default Batch Size</span>
              <input
                style={inputStyle}
                type="number"
                value={defaultBatchSize}
                onChange={(e) => setDefaultBatchSize(e.target.value)}
                disabled={mode === 'extend' && !!selectedFamily}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Variants */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Variants ({variants.length})</span>
          <button style={btnSecondary} onClick={addVariantRow}>+ Add Variant</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>#</th>
              <th style={tableThStyle}>Model *</th>
              <th style={tableThStyle}>Color *</th>
              <th style={tableThStyle}>SKU *</th>
              <th style={tableThStyle}>Product Code *</th>
              <th style={tableThStyle}>EAN</th>
              <th style={tableThStyle}></th>
            </tr></thead>
            <tbody>
              {variants.map((v, i) => (
                <tr key={i}>
                  <td style={{ ...tableTdStyle, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>{i + 1}</td>
                  <td style={tableTdStyle}>
                    <input style={{ ...inputStyle, minWidth: 120 }} value={v.model} onChange={(e) => updateVariant(i, { model: e.target.value })} placeholder="e.g. Overdrive" />
                  </td>
                  <td style={tableTdStyle}>
                    <input style={{ ...inputStyle, minWidth: 100 }} value={v.color} onChange={(e) => updateVariant(i, { color: e.target.value })} placeholder="e.g. Black" />
                  </td>
                  <td style={tableTdStyle}>
                    <input style={{ ...inputStyle, minWidth: 100 }} value={v.sku} onChange={(e) => updateVariant(i, { sku: e.target.value.toUpperCase() })} placeholder="e.g. F3OK" />
                  </td>
                  <td style={tableTdStyle}>
                    <input style={{ ...inputStyle, minWidth: 100 }} value={v.product_code} onChange={(e) => updateVariant(i, { product_code: e.target.value.toUpperCase() })} placeholder="e.g. F3OK" />
                  </td>
                  <td style={{ ...tableTdStyle, color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                    auto-assigned from pool
                  </td>
                  <td style={tableTdStyle}>
                    {variants.length > 1 && (
                      <button style={{ ...btnSecondary, color: '#ff7070', borderColor: 'rgba(222,42,42,.3)' }} onClick={() => removeVariantRow(i)}>×</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Remote details — new mode + has_remote */}
      {mode === 'new' && hasRemote && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Remote Row</span></div>
          <div style={panelBodyStyle}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <div>
                <span style={labelStyle}>Remote SKU *</span>
                <input style={inputStyle} value={remoteSku} onChange={(e) => setRemoteSku(e.target.value.toUpperCase())} placeholder="e.g. F3XXR" />
              </div>
              <div>
                <span style={labelStyle}>Remote Product Code *</span>
                <input style={inputStyle} value={remoteProductCode} onChange={(e) => setRemoteProductCode(e.target.value.toUpperCase())} placeholder="e.g. F3XXR" />
              </div>
              <div>
                <span style={labelStyle}>EAN</span>
                <div style={{ ...inputStyle, color: 'var(--t3)', fontStyle: 'italic' }}>
                  synthetic: RMT-{remoteProductCode || '???'}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Submit */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button style={btnSecondary} onClick={() => router.back()} disabled={submitting}>Cancel</button>
        <button
          style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
          onClick={submit}
          disabled={submitting}
        >
          {submitting ? (mode === 'extend' ? 'Adding…' : 'Registering…') : (mode === 'extend' ? 'Add Variants' : 'Register Product Family')}
        </button>
      </div>
    </div>
  );
}
