'use client';
import { useEffect, useState, useCallback, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Plus, Trash2, ArrowLeft } from 'lucide-react';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, inputStyle, selectStyle, labelStyle,
  btnPrimary, btnSecondary, pageH1, pageSub,
} from '@/lib/snorkelui';
import { getMould, updateMould, setMouldParts } from '@/lib/moulds';

function MouldDetail() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const sp = useSearchParams();
  const mouldNo = sp.get('mould_no');

  const canManage = !!perms?.po_create;
  const [loading, setLoading] = useState(true);
  const [mould, setMould] = useState(null);
  const [vendors, setVendors] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [hdr, setHdr] = useState(null);          // editable header
  const [parts, setParts] = useState([]);        // [{part_code, qty_per_shot}]
  const [savingHdr, setSavingHdr] = useState(false);
  const [savingParts, setSavingParts] = useState(false);

  const load = useCallback(async () => {
    if (!session || !mouldNo) return;
    setLoading(true);
    try {
      const m = await garageFetch('getMould', { mould_no: mouldNo }, session);
      setMould(m);
      setHdr({
        description: m.description || '', vendor_code: m.vendor_code || '',
        hsn_code: m.hsn_code || '', gst_percent: m.gst_percent ?? '',
        default_shot_rate: m.default_shot_rate ?? '', is_active: m.is_active !== false,
      });
      setParts((m.parts || []).map(p => ({ part_code: p.part_code, part_name: p.part_name, qty_per_shot: p.qty_per_shot })));
    } catch (e) {
      showToast(e.message || 'Failed to load mould', 'error');
    } finally { setLoading(false); }
  }, [session, mouldNo, showToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!session) return;
    garageFetch('getVendors', {}, session).then(d => setVendors(Array.isArray(d) ? d : [])).catch(() => {});
    garageFetch('getMaterials', {}, session).then(d => setMaterials(Array.isArray(d) ? d : [])).catch(() => {});
  }, [session]);

  const partOptions = useMemo(() => materials.map(m => ({
    value: m.part_code,
    label: `${m.part_code}${m.part_name ? ' — ' + m.part_name : ''}`,
    hint: [m.product, m.part_category].filter(Boolean).join(' · '),
    part_name: m.part_name,
  })), [materials]);

  if (perms && !perms.procurement_view) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }
  if (loading || !hdr) return <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (!mould) return <div style={{ padding: 24, color: 'var(--t3)' }}>Mould not found.</div>;

  const setH = (k, v) => setHdr(s => ({ ...s, [k]: v }));
  const setPart = (i, k, v) => setParts(rows => rows.map((r, idx) => idx === i ? { ...r, [k]: v } : r));
  const addPart = () => setParts(rows => [...rows, { part_code: '', part_name: '', qty_per_shot: 1 }]);
  const removePart = (i) => setParts(rows => rows.filter((_, idx) => idx !== i));

  async function saveHeader() {
    setSavingHdr(true);
    try {
      const res = await updateMould({
        mould_no: mouldNo, description: hdr.description.trim() || null,
        vendor_code: hdr.vendor_code || null, hsn_code: hdr.hsn_code.trim() || null,
        gst_percent: hdr.gst_percent !== '' ? Number(hdr.gst_percent) : null,
        default_shot_rate: hdr.default_shot_rate !== '' ? Number(hdr.default_shot_rate) : null,
        is_active: hdr.is_active,
      }, session);
      if (!res.ok) throw new Error(res.error || 'Save failed');
      showToast('Mould details saved', 'success');
      load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setSavingHdr(false); }
  }

  async function saveParts() {
    const clean = parts.filter(p => p.part_code);
    const codes = clean.map(p => p.part_code);
    if (new Set(codes).size !== codes.length) { showToast('Duplicate part code in the map', 'error'); return; }
    if (clean.some(p => !(Number(p.qty_per_shot) > 0))) { showToast('Every part needs a per-shot count > 0', 'error'); return; }
    setSavingParts(true);
    try {
      const res = await setMouldParts(mouldNo, clean.map(p => ({ part_code: p.part_code, qty_per_shot: Number(p.qty_per_shot) })), session);
      if (!res.ok) throw new Error(res.error || 'Save failed');
      showToast(`Part map saved (${res.data.count} parts)`, 'success');
      load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setSavingParts(false); }
  }

  const grid = { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 };

  return (
    <div style={{ color: 'var(--t1)', maxWidth: 900 }}>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button style={{ ...btnSecondary, padding: '6px 10px' }} onClick={() => router.push('/moulds')}><ArrowLeft size={14} /></button>
        <div>
          <h1 style={pageH1}>Mould <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{mould.mould_no}</span></h1>
          <p style={pageSub}>{mould.description || 'No description'}</p>
        </div>
      </div>

      {/* Header */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Details</span></div>
        <div style={panelBodyStyle}>
          <div style={grid}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Description</label>
              <input style={{ ...inputStyle, width: '100%' }} value={hdr.description} disabled={!canManage} onChange={e => setH('description', e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Vendor</label>
              <select style={{ ...selectStyle, width: '100%' }} value={hdr.vendor_code} disabled={!canManage} onChange={e => setH('vendor_code', e.target.value)}>
                <option value="">— none —</option>
                {vendors.map(v => <option key={v.vendor_code} value={v.vendor_code}>{v.vendor_name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Status</label>
              <select style={{ ...selectStyle, width: '100%' }} value={hdr.is_active ? '1' : '0'} disabled={!canManage} onChange={e => setH('is_active', e.target.value === '1')}>
                <option value="1">Active</option>
                <option value="0">Inactive</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>HSN code</label>
              <input style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} value={hdr.hsn_code} disabled={!canManage} onChange={e => setH('hsn_code', e.target.value)} placeholder="9503" />
            </div>
            <div>
              <label style={labelStyle}>GST %</label>
              <input type="number" style={{ ...inputStyle, width: '100%' }} value={hdr.gst_percent} disabled={!canManage} onChange={e => setH('gst_percent', e.target.value)} placeholder="18" />
            </div>
            <div>
              <label style={labelStyle}>Default block rate / shot (₹)</label>
              <input type="number" style={{ ...inputStyle, width: '100%' }} value={hdr.default_shot_rate} disabled={!canManage} onChange={e => setH('default_shot_rate', e.target.value)} placeholder="optional" />
            </div>
          </div>
          {canManage && (
            <div style={{ marginTop: 16 }}>
              <button style={btnPrimary} disabled={savingHdr} onClick={saveHeader}>{savingHdr ? 'Saving…' : 'Save details'}</button>
            </div>
          )}
        </div>
      </div>

      {/* Part map */}
      <div style={{ ...panelStyle, marginTop: 18 }}>
        <div style={panelHeaderStyle}>
          <span>Part map <span style={{ color: 'var(--t3)', fontWeight: 400 }}>— what this mould produces per shot</span></span>
        </div>
        <div style={panelBodyStyle}>
          <table className="dt" style={{ width: '100%' }}>
            <thead><tr><th style={{ width: '70%' }}>Part code</th><th className="num">Per shot</th>{canManage && <th style={{ width: 40 }}></th>}</tr></thead>
            <tbody>
              {parts.length === 0 && <tr><td colSpan={canManage ? 3 : 2} style={{ padding: 16, color: 'var(--t3)' }}>No parts mapped yet.</td></tr>}
              {parts.map((p, i) => (
                <tr key={i}>
                  <td>
                    {canManage ? (
                      <Combobox
                        value={p.part_code}
                        options={p.part_code && !partOptions.some(o => o.value === p.part_code)
                          ? [{ value: p.part_code, label: `${p.part_code}${p.part_name ? ' — ' + p.part_name : ''}` }, ...partOptions]
                          : partOptions}
                        onChange={(val, opt) => { setPart(i, 'part_code', val || ''); if (opt) setPart(i, 'part_name', opt.part_name || ''); }}
                        placeholder="Search part code / name…"
                        emptyLabel="No match"
                        inputStyle={{ fontFamily: 'var(--mono)', fontSize: 12 }}
                        maxDropdownHeight={240}
                        portal
                      />
                    ) : (
                      <span className="mono">{p.part_code}{p.part_name ? ` — ${p.part_name}` : ''}</span>
                    )}
                  </td>
                  <td className="num">
                    {canManage
                      ? <input type="number" style={{ ...inputStyle, width: 90, textAlign: 'right' }} value={p.qty_per_shot} onChange={e => setPart(i, 'qty_per_shot', e.target.value)} />
                      : <span className="mono">{p.qty_per_shot}</span>}
                  </td>
                  {canManage && <td className="num"><button style={{ ...btnSecondary, padding: '4px 8px' }} onClick={() => removePart(i)}><Trash2 size={13} /></button></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {canManage && (
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button style={btnSecondary} onClick={addPart}><Plus size={14} /> Add part</button>
              <button style={btnPrimary} disabled={savingParts} onClick={saveParts}>{savingParts ? 'Saving…' : 'Save part map'}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MouldDetailPage() {
  return <Suspense fallback={<div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>}><MouldDetail /></Suspense>;
}
