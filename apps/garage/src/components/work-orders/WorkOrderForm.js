'use client';
import { useEffect, useMemo, useState } from 'react';
import { useToast, Combobox } from '@throttle/ui';
import { garageFetch, workerFetch } from '@throttle/db';
import { useProducts } from '../../hooks/useProducts.js';

const panel = { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 };
const panelHdr = {
  padding: '10px 16px', borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13,
  textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t2)',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
};
const inp = {
  background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)',
  borderRadius: 4, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 12, width: '100%',
};
const sel = {
  background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)',
  borderRadius: 4, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 12, width: '100%',
};
const lbl = {
  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)',
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block',
};
const fieldErr = { fontSize: 11, color: 'var(--state-error-fg)', marginTop: 2 };
const btnPri = {
  background: 'var(--yellow)', color: '#000', border: 'none', borderRadius: 4,
  padding: '7px 16px', fontFamily: 'var(--mono)', fontSize: 12,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: 700,
};
const btnSec = {
  background: 'var(--surface2)', color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 4,
  padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer',
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function modeBtnStyle(active) {
  return {
    background: active ? 'var(--yellow)' : 'var(--surface2)',
    color: active ? '#000' : 'var(--t3)',
    border: active ? '1px solid var(--yellow)' : '1px solid var(--border)',
    borderRadius: 4, padding: '5px 12px',
    fontFamily: 'var(--mono)', fontSize: 11,
    textTransform: 'uppercase', letterSpacing: 1,
    cursor: 'pointer', fontWeight: active ? 700 : 500,
  };
}

function newId() {
  return Math.random().toString(36).slice(2, 9);
}

export function WorkOrderForm({ onSuccess, session }) {
  const { showToast } = useToast();
  const { PRODUCTS, loading } = useProducts();
  const [mode, setMode] = useState('bom');
  const [bomProduct, setBomProduct] = useState('');
  const [bomCategory, setBomCategory] = useState('');
  const [bomCache, setBomCache] = useState({});
  const [bomLoading, setBomLoading] = useState(false);
  const [partLines, setPartLines] = useState([]);
  const [line, setLine] = useState('L1');
  const [shift, setShift] = useState('Morning');
  const [date, setDate] = useState(todayISO());
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState({});
  const [matCache, setMatCache] = useState(null);
  const [matLoading, setMatLoading] = useState(false);

  // When switching modes: clear partLines and BOM-side selections to avoid stale state.
  useEffect(() => {
    setPartLines([]);
    setBomCategory('');
    setErrors({});
  }, [mode]);

  // Load BOM when product selected
  useEffect(() => {
    if (mode !== 'bom' || !bomProduct || !session) return;
    if (bomCache[bomProduct]) return;
    let cancelled = false;
    setBomLoading(true);
    garageFetch('getBOM', { product: bomProduct }, session)
      .then((data) => {
        if (cancelled) return;
        const rows = Array.isArray(data) ? data : [];
        setBomCache((prev) => ({ ...prev, [bomProduct]: rows }));
      })
      .catch((e) => {
        if (!cancelled) showToast(`Failed to load BOM: ${e.message}`, 'error');
      })
      .finally(() => {
        if (!cancelled) setBomLoading(false);
      });
    return () => { cancelled = true; };
  }, [mode, bomProduct, session]); // eslint-disable-line react-hooks/exhaustive-deps

  const bomCategories = useMemo(() => {
    const rows = bomCache[bomProduct] || [];
    const cats = [...new Set(rows.map((r) => r.part_category).filter(Boolean))];
    cats.sort();
    return cats;
  }, [bomCache, bomProduct]);

  function ensureMaterials() {
    if (matCache || matLoading || !session) return Promise.resolve(matCache || {});
    setMatLoading(true);
    return garageFetch('getMaterials', {}, session)
      .then((data) => {
        const cache = {};
        (data || []).forEach((m) => {
          if (m.part_code) cache[m.part_code.toUpperCase()] = m;
        });
        setMatCache(cache);
        return cache;
      })
      .catch(() => {
        setMatCache({});
        return {};
      })
      .finally(() => setMatLoading(false));
  }

  function addCategoryToRequest() {
    if (!bomProduct || !bomCategory) return;
    const rows = bomCache[bomProduct] || [];
    const inCat = rows.filter((r) => r.part_category === bomCategory);
    if (!inCat.length) {
      showToast('No parts in this category', 'info');
      return;
    }
    const existingCodes = new Set(partLines.filter((p) => p.type !== 'header').map((p) => p.partCode));
    const fresh = inCat.filter((r) => !existingCodes.has(r.part_code));
    if (!fresh.length) {
      showToast('All parts from this category are already added', 'info');
      return;
    }
    const headerRow = { id: newId(), type: 'header', label: bomCategory };
    const partRows = fresh.map((r) => ({
      id: newId(),
      type: 'part',
      partCode: r.part_code,
      partName: r.part_name,
      qty: '',
    }));
    setPartLines((prev) => [...prev, headerRow, ...partRows]);
  }

  function addManualPart() {
    ensureMaterials();
    setPartLines((prev) => [
      ...prev,
      { id: newId(), type: 'part', partCode: '', partName: '', qty: '' },
    ]);
  }

  function removeLine(id) {
    setPartLines((prev) => prev.filter((p) => p.id !== id));
  }

  function updateLine(id, patch) {
    setPartLines((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  async function handlePartCodeBlur(id, value) {
    const code = (value || '').trim().toUpperCase();
    if (!code) return;
    const cache = matCache || (await ensureMaterials());
    const match = cache[code];
    if (match?.part_name) {
      updateLine(id, { partCode: code, partName: match.part_name });
    } else {
      updateLine(id, { partCode: code });
    }
  }

  function validate() {
    const next = {};
    if (!date) next.date = 'Date is required';
    const partRows = partLines.filter((p) => p.type === 'part' && (parseInt(p.qty) || 0) > 0);
    if (!partRows.length) next.parts = 'Add at least one part with qty > 0';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit() {
    if (!validate()) return;
    const parts = partLines
      .filter((p) => p.type === 'part' && (parseInt(p.qty) || 0) > 0)
      .map((p) => ({
        part_code: (p.partCode || '').toUpperCase(),
        part_name: p.partName || '',
        qty_requested: parseInt(p.qty) || 0,
      }));
    setSubmitting(true);
    try {
      const res = await workerFetch(
        'postWorkOrder',
        { data: { wo_type: 'Parts Request', line_no: line, shift, date, parts } },
        session,
      );
      const woNo = res?.data?.wo_no || '?';
      showToast(`✅ ${woNo} created — Ad Hoc Request · ${parts.length} parts`, 'success');
      setPartLines([]);
      setBomProduct('');
      setBomCategory('');
      setErrors({});
      onSuccess();
    } catch (e) {
      showToast(e.message || 'Failed to create work order', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={panel}>
      <div style={panelHdr}>
        <span>New Ad Hoc Request</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={modeBtnStyle(mode === 'bom')} onClick={() => setMode('bom')}>BOM-Based</button>
          <button style={modeBtnStyle(mode === 'manual')} onClick={() => setMode('manual')}>Manual</button>
        </div>
      </div>

      <div style={{ padding: 16 }}>
        {mode === 'bom' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'end', marginBottom: 12 }}>
              <div>
                <span style={lbl}>Product</span>
                <Combobox
                  value={bomProduct}
                  options={PRODUCTS.map((p) => ({ value: p, label: p }))}
                  onChange={(v) => { setBomProduct(v); setBomCategory(''); }}
                  placeholder="Search products…"
                  loading={loading}
                  disabled={submitting}
                />
              </div>
              <div>
                <span style={lbl}>Category</span>
                <select
                  style={sel}
                  value={bomCategory}
                  onChange={(e) => setBomCategory(e.target.value)}
                  disabled={submitting || !bomProduct || bomLoading}
                >
                  <option value="">{bomLoading ? 'Loading…' : 'Select category…'}</option>
                  {bomCategories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <button
                style={btnSec}
                onClick={addCategoryToRequest}
                disabled={submitting || !bomProduct || !bomCategory || bomLoading}
              >
                + Add Category to Request
              </button>
            </div>
          </>
        )}

        {mode === 'manual' && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={lbl}>Parts Requested</span>
              <button style={btnSec} onClick={addManualPart} disabled={submitting}>+ Add Part</button>
            </div>
          </div>
        )}

        <div
          style={{
            border: '1px solid var(--border)', borderRadius: 4,
            maxHeight: 400, overflowY: 'auto', marginBottom: 12,
          }}
        >
          {partLines.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--t3)' }}>
              {mode === 'bom'
                ? 'Select a product and category, then click + Add Category to Request.'
                : 'Click + Add Part to begin.'}
            </div>
          ) : (
            <div>
              {partLines.map((p) => {
                if (p.type === 'header') {
                  return (
                    <div
                      key={p.id}
                      style={{
                        padding: '6px 12px',
                        background: 'var(--surface2)',
                        borderBottom: '1px solid var(--border)',
                        fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em',
                        textTransform: 'uppercase', color: 'var(--t2)',
                      }}
                    >
                      {p.label}
                    </div>
                  );
                }
                if (mode === 'bom') {
                  return (
                    <div
                      key={p.id}
                      style={{
                        display: 'grid', gridTemplateColumns: '120px 1fr 80px 28px',
                        gap: 8, padding: '6px 12px', alignItems: 'center',
                        borderBottom: '1px solid rgba(42,42,42,.6)',
                      }}
                    >
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--yellow)' }}>{p.partCode}</span>
                      <span style={{ fontSize: 12 }}>{p.partName}</span>
                      <input
                        style={{ ...inp, textAlign: 'right', padding: '4px 6px' }}
                        type="number"
                        min="0"
                        value={p.qty}
                        onChange={(e) => updateLine(p.id, { qty: e.target.value })}
                        disabled={submitting}
                      />
                      <button
                        style={{ background: 'transparent', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 16 }}
                        onClick={() => removeLine(p.id)}
                        disabled={submitting}
                      >
                        ×
                      </button>
                    </div>
                  );
                }
                // manual
                return (
                  <div
                    key={p.id}
                    style={{
                      display: 'grid', gridTemplateColumns: '120px 1fr 80px 28px',
                      gap: 8, padding: '6px 12px', alignItems: 'center',
                      borderBottom: '1px solid rgba(42,42,42,.6)',
                    }}
                  >
                    <input
                      style={{ ...inp, textTransform: 'uppercase', fontSize: 11, padding: '4px 6px' }}
                      value={p.partCode}
                      onChange={(e) => updateLine(p.id, { partCode: e.target.value.toUpperCase() })}
                      onBlur={(e) => handlePartCodeBlur(p.id, e.target.value)}
                      placeholder="Part code"
                      disabled={submitting}
                    />
                    <input
                      style={{ ...inp, padding: '4px 6px' }}
                      value={p.partName}
                      readOnly
                      placeholder={matLoading ? 'Looking up…' : 'Auto-fills from master'}
                    />
                    <input
                      style={{ ...inp, textAlign: 'right', padding: '4px 6px' }}
                      type="number"
                      min="0"
                      value={p.qty}
                      onChange={(e) => updateLine(p.id, { qty: e.target.value })}
                      disabled={submitting}
                    />
                    <button
                      style={{ background: 'transparent', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 16 }}
                      onClick={() => removeLine(p.id)}
                      disabled={submitting}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {errors.parts && <div style={fieldErr}>{errors.parts}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <span style={lbl}>Line</span>
            <select style={sel} value={line} onChange={(e) => setLine(e.target.value)} disabled={submitting}>
              <option value="L1">L1</option>
              <option value="L2">L2</option>
              <option value="L3">L3</option>
            </select>
          </div>
          <div>
            <span style={lbl}>Shift</span>
            <select style={sel} value={shift} onChange={(e) => setShift(e.target.value)} disabled={submitting}>
              <option value="Morning">Morning</option>
              <option value="Afternoon">Afternoon</option>
              <option value="Night">Night</option>
            </select>
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <span style={lbl}>Date *</span>
          <input style={inp} type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={submitting} />
          {errors.date && <div style={fieldErr}>{errors.date}</div>}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnPri} onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'CREATING…' : 'Create Request'}
          </button>
        </div>

        <div
          style={{
            marginTop: 16, padding: '8px 12px', fontSize: 11,
            background: 'rgba(33,60,226,.08)', border: '1px solid rgba(33,60,226,.25)',
            color: '#7b93ff', borderRadius: 4,
          }}
        >
          ℹ Store will issue these parts from the Issue Queue.
        </div>
      </div>
    </div>
  );
}
