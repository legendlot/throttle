'use client';
import { Suspense, useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, supabase } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, inputStyle, selectStyle, labelStyle,
  tableThStyle, tableTdStyle, btnPrimary, btnSecondary, btnDanger, pageH1, pageSub,
  StatusBadge, fmtDate,
} from '@/lib/snorkelui';
import {
  ASSET_STATUSES, ACQ_TYPES, RENTAL_PERIODS, DOC_TYPES,
  statusLabel, statusTone, acqLabel, docTypeLabel, HISTORY_LABELS,
  assetExpiry, printAssetLabel,
} from '@/lib/assets';

const ASSET_BUCKET = 'snorkel-asset-docs';
const CURRENCIES = ['INR', 'USD', 'RMB', 'EUR', 'GBP'];
const OTHER = '__other__';
const grid = { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 };

function Field({ label, children, span }) {
  return (
    <div style={{ gridColumn: span ? '1 / -1' : 'auto' }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}
function Read({ label, value, span }) {
  return (
    <div style={{ gridColumn: span ? '1 / -1' : 'auto' }}>
      <div style={labelStyle}>{label}</div>
      <div style={{ fontSize: 13, color: 'var(--t1)' }}>{value || <span style={{ color: 'var(--t3)' }}>—</span>}</div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>}>
      <AssetDetail />
    </Suspense>
  );
}

function AssetDetail() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const id = params?.get('id') || '';
  const canManage = !!perms?.asset_manage;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cats, setCats] = useState([]);
  const [locs, setLocs] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [users, setUsers] = useState([]);
  const [ef, setEf] = useState(null); // edit form state
  // doc upload
  const [docFile, setDocFile] = useState(null);
  const [docType, setDocType] = useState('photo');
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    if (!session || !id) return;
    setLoading(true);
    try {
      const res = await garageFetch('getAsset', { id }, session);
      setData(res);
    } catch (e) {
      showToast(e.message || 'Failed to load asset', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, id, showToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!session || !canManage) return;
    garageFetch('getAssetCategories', { all: 1 }, session).then(d => setCats(Array.isArray(d) ? d : [])).catch(() => {});
    garageFetch('getAssetLocations', { all: 1 }, session).then(d => setLocs(Array.isArray(d) ? d : [])).catch(() => {});
    garageFetch('getVendors', {}, session).then(d => setVendors(Array.isArray(d) ? d : [])).catch(() => {});
    garageFetch('getAssetUsers', {}, session).then(d => setUsers(Array.isArray(d) ? d : [])).catch(() => {});
  }, [session, canManage]);

  function startEdit() {
    const a = data.asset;
    setEf({
      name: a.name || '', description: a.description || '', category_id: a.category_id || '',
      status: a.status, acquisition_type: a.acquisition_type, location_id: a.location_id || '',
      custodian_pick: a.custodian_user_id || (a.custodian_name ? OTHER : ''),
      custodian_name_other: a.custodian_user_id ? '' : (a.custodian_name || ''),
      serial_no: a.serial_no || '', model_no: a.model_no || '', secondary_ref: a.secondary_ref || '',
      vendor_pick: a.vendor_code || (a.vendor_name ? OTHER : ''),
      vendor_name_other: a.vendor_code ? '' : (a.vendor_name || ''),
      currency: a.currency || 'INR',
      source_po_number: a.source_po_number || '', purchase_cost: a.purchase_cost ?? '', acquired_date: a.acquired_date || '',
      rental_cost: a.rental_cost ?? '', rental_period: a.rental_period || '',
      rental_start_date: a.rental_start_date || '', rental_end_date: a.rental_end_date || '',
      warranty_expiry: a.warranty_expiry || '', amc_renewal: a.amc_renewal || '',
    });
    setEditing(true);
  }
  const setE = (k, v) => setEf(s => ({ ...s, [k]: v }));

  async function saveEdit() {
    if (!ef.name.trim()) { showToast('Name is required', 'error'); return; }
    setSaving(true);
    try {
      let vendor_code = null, vendor_name = null;
      if (ef.vendor_pick && ef.vendor_pick !== OTHER) {
        const v = vendors.find(x => x.vendor_code === ef.vendor_pick);
        vendor_code = v?.vendor_code || ef.vendor_pick; vendor_name = v?.vendor_name || null;
      } else if (ef.vendor_pick === OTHER) { vendor_name = ef.vendor_name_other.trim() || null; }
      let custodian_user_id = null, custodian_name = null;
      if (ef.custodian_pick && ef.custodian_pick !== OTHER) {
        const u = users.find(x => x.id === ef.custodian_pick);
        custodian_user_id = ef.custodian_pick; custodian_name = u?.full_name || null;
      } else if (ef.custodian_pick === OTHER) { custodian_name = ef.custodian_name_other.trim() || null; }

      const isRental = ef.acquisition_type === 'rented';
      const data2 = {
        id, name: ef.name.trim(), description: ef.description.trim() || null,
        category_id: ef.category_id || null, status: ef.status, acquisition_type: ef.acquisition_type,
        location_id: ef.location_id || null, custodian_user_id, custodian_name,
        serial_no: ef.serial_no.trim() || null, model_no: ef.model_no.trim() || null,
        secondary_ref: ef.secondary_ref.trim() || null, vendor_code, vendor_name, currency: ef.currency,
        warranty_expiry: ef.warranty_expiry || null, amc_renewal: ef.amc_renewal || null,
        source_po_number: isRental ? null : (ef.source_po_number.trim() || null),
        purchase_cost: isRental ? null : (ef.purchase_cost || null),
        acquired_date: isRental ? null : (ef.acquired_date || null),
        rental_cost: isRental ? (ef.rental_cost || null) : null,
        rental_period: isRental ? (ef.rental_period || null) : null,
        rental_start_date: isRental ? (ef.rental_start_date || null) : null,
        rental_end_date: isRental ? (ef.rental_end_date || null) : null,
      };
      const res = await workerFetch('updateAsset', { data: data2 }, session);
      if (!res.ok) throw new Error(res.error || 'Save failed');
      showToast('Saved', 'success');
      setEditing(false);
      await load();
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
    } finally { setSaving(false); }
  }

  async function retire() {
    const reason = window.prompt('Retire this asset — reason (optional):', '');
    if (reason === null) return;
    try {
      const res = await workerFetch('retireAsset', { data: { id, reason } }, session);
      if (!res.ok) throw new Error(res.error || 'Retire failed');
      showToast('Asset retired', 'success');
      await load();
    } catch (e) { showToast(e.message || 'Retire failed', 'error'); }
  }

  async function uploadDoc() {
    if (!docFile) { showToast('Choose a file first', 'error'); return; }
    setUploading(true);
    try {
      const r1 = await workerFetch('createAssetDocumentUploadUrl', { data: { asset_id: id, doc_type: docType, file_name: docFile.name } }, session);
      if (!r1.ok || !r1.data?.token) throw new Error(r1.error || 'No upload token');
      const { storage_path, token } = r1.data;
      const up = await supabase.storage.from(ASSET_BUCKET).uploadToSignedUrl(storage_path, token, docFile);
      if (up.error) throw up.error;
      const r2 = await workerFetch('recordAssetDocument', { data: {
        asset_id: id, doc_type: docType, file_name: docFile.name, storage_path, mime_type: docFile.type || null,
      } }, session);
      if (!r2.ok) throw new Error(r2.error || 'Record failed');
      showToast('Document uploaded', 'success');
      setDocFile(null);
      await load();
    } catch (e) { showToast(e.message || 'Upload failed', 'error'); }
    finally { setUploading(false); }
  }

  async function viewDoc(docId) {
    try {
      const res = await garageFetch('getAssetDocumentDownloadUrl', { document_id: docId }, session);
      if (res?.url) window.open(res.url, '_blank');
      else showToast('Could not open document', 'error');
    } catch (e) { showToast(e.message || 'Could not open document', 'error'); }
  }

  async function deleteDoc(docId) {
    if (!window.confirm('Delete this document?')) return;
    try {
      const res = await workerFetch('deleteAssetDocument', { data: { document_id: docId } }, session);
      if (!res.ok) throw new Error(res.error || 'Delete failed');
      showToast('Document deleted', 'success');
      await load();
    } catch (e) { showToast(e.message || 'Delete failed', 'error'); }
  }

  // Never swap an open edit form for the spinner — a background reload (a real token
  // refresh re-keys any effect on `session`) must not discard unsaved input.
  if (loading && !editing) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (!data?.asset) return <div style={{ padding: 24, color: 'var(--t3)' }}>Asset not found. <button style={btnSecondary} onClick={() => router.push('/assets')}>Back</button></div>;

  const a = data.asset;
  const isRental = (editing ? ef.acquisition_type : a.acquisition_type) === 'rented';

  return (
    <div style={{ color: 'var(--t1)', maxWidth: 920 }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={pageH1}><span style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{a.asset_code}</span> · {a.name}</h1>
          <p style={pageSub}>
            <StatusBadge label={statusLabel(a.status)} tone={statusTone(a.status)} /> · {acqLabel(a.acquisition_type)}
            {a.category_name ? ` · ${a.category_name}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnSecondary} onClick={() => router.push('/assets')}>← Back</button>
          {!editing && <button style={btnSecondary} onClick={() => printAssetLabel(a)}>🏷 Print Label</button>}
          {canManage && !editing && <button style={btnPrimary} onClick={startEdit}>Edit</button>}
          {canManage && !editing && a.status !== 'retired' && <button style={btnDanger} onClick={retire}>Retire</button>}
        </div>
      </div>

      {/* DETAILS */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Details</span></div>
        <div style={panelBodyStyle}>
          {!editing ? (
            <div style={grid}>
              <Read label="Name" value={a.name} />
              <Read label="Category" value={a.category_name} />
              <Read label="Status" value={statusLabel(a.status)} />
              <Read label="Acquisition type" value={acqLabel(a.acquisition_type)} />
              <Read label="Location" value={a.location_name} />
              <Read label="Custodian" value={a.custodian_name} />
              <Read label="Serial no." value={a.serial_no} />
              <Read label="Model / vendor no." value={a.model_no} />
              <Read label="Secondary ref" value={a.secondary_ref} />
              <Read label="Description" value={a.description} span />
            </div>
          ) : (
            <div style={grid}>
              <Field label="Name *" span><input style={{ ...inputStyle, width: '100%' }} value={ef.name} onChange={e => setE('name', e.target.value)} /></Field>
              <Field label="Category"><select style={{ ...selectStyle, width: '100%' }} value={ef.category_id} onChange={e => setE('category_id', e.target.value)}><option value="">— none —</option>{cats.map(c => <option key={c.id} value={c.id}>{c.name}{c.is_active === false ? ' (inactive)' : ''}</option>)}</select></Field>
              <Field label="Status"><select style={{ ...selectStyle, width: '100%' }} value={ef.status} onChange={e => setE('status', e.target.value)}>{ASSET_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
              <Field label="Acquisition type"><select style={{ ...selectStyle, width: '100%' }} value={ef.acquisition_type} onChange={e => setE('acquisition_type', e.target.value)}>{ACQ_TYPES.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
              <Field label="Location"><select style={{ ...selectStyle, width: '100%' }} value={ef.location_id} onChange={e => setE('location_id', e.target.value)}><option value="">— none —</option>{locs.map(l => <option key={l.id} value={l.id}>{l.name}{l.is_active === false ? ' (inactive)' : ''}</option>)}</select></Field>
              <Field label="Custodian"><select style={{ ...selectStyle, width: '100%' }} value={ef.custodian_pick} onChange={e => setE('custodian_pick', e.target.value)}><option value="">— unassigned —</option>{users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}<option value={OTHER}>Other (no login)…</option></select></Field>
              {ef.custodian_pick === OTHER && <Field label="Custodian name"><input style={{ ...inputStyle, width: '100%' }} value={ef.custodian_name_other} onChange={e => setE('custodian_name_other', e.target.value)} /></Field>}
              <Field label="Serial no."><input style={{ ...inputStyle, width: '100%' }} value={ef.serial_no} onChange={e => setE('serial_no', e.target.value)} /></Field>
              <Field label="Model / vendor no."><input style={{ ...inputStyle, width: '100%' }} value={ef.model_no} onChange={e => setE('model_no', e.target.value)} /></Field>
              <Field label="Secondary ref"><input style={{ ...inputStyle, width: '100%' }} value={ef.secondary_ref} onChange={e => setE('secondary_ref', e.target.value)} /></Field>
              <Field label="Description" span><textarea style={{ ...inputStyle, width: '100%', minHeight: 56, fontFamily: 'inherit' }} value={ef.description} onChange={e => setE('description', e.target.value)} /></Field>
            </div>
          )}
        </div>
      </div>

      {/* ACQUISITION */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>{isRental ? 'Rental' : 'Purchase'} &amp; vendor</span></div>
        <div style={panelBodyStyle}>
          {!editing ? (
            <div style={grid}>
              <Read label="Vendor" value={a.vendor_name} />
              <Read label="Currency" value={a.currency} />
              {a.acquisition_type === 'rented' ? <>
                <Read label="Rental cost" value={a.rental_cost != null ? `${a.currency || ''} ${Number(a.rental_cost).toLocaleString('en-IN')}` : null} />
                <Read label="Rental period" value={a.rental_period} />
                <Read label="Rental start" value={fmtDate(a.rental_start_date)} />
                <Read label="Rental end" value={fmtDate(a.rental_end_date)} />
              </> : <>
                <Read label="Purchase cost" value={a.purchase_cost != null ? `${a.currency || ''} ${Number(a.purchase_cost).toLocaleString('en-IN')}` : null} />
                <Read label="Acquired date" value={fmtDate(a.acquired_date)} />
                <div>
                  <div style={labelStyle}>Source PO</div>
                  <div style={{ fontSize: 13 }}>
                    {a.source_po_number
                      ? <a href={`/procurement/pos/print?po_number=${encodeURIComponent(a.source_po_number)}`} target="_blank" rel="noopener noreferrer" style={{ color: '#7b93ff', textDecoration: 'none' }}>{a.source_po_number} ↗</a>
                      : <span style={{ color: 'var(--t3)' }}>—</span>}
                  </div>
                </div>
              </>}
            </div>
          ) : (
            <div style={grid}>
              <Field label="Vendor"><select style={{ ...selectStyle, width: '100%' }} value={ef.vendor_pick} onChange={e => setE('vendor_pick', e.target.value)}><option value="">— none —</option>{vendors.map(v => <option key={v.vendor_code} value={v.vendor_code}>{v.vendor_name}</option>)}<option value={OTHER}>Other (not listed)…</option></select></Field>
              {ef.vendor_pick === OTHER && <Field label="Vendor name"><input style={{ ...inputStyle, width: '100%' }} value={ef.vendor_name_other} onChange={e => setE('vendor_name_other', e.target.value)} /></Field>}
              <Field label="Currency"><select style={{ ...selectStyle, width: '100%' }} value={ef.currency} onChange={e => setE('currency', e.target.value)}>{CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}</select></Field>
              {!isRental ? <>
                <Field label="Purchase cost"><input type="number" style={{ ...inputStyle, width: '100%' }} value={ef.purchase_cost} onChange={e => setE('purchase_cost', e.target.value)} /></Field>
                <Field label="Acquired date"><input type="date" style={{ ...inputStyle, width: '100%' }} value={ef.acquired_date} onChange={e => setE('acquired_date', e.target.value)} /></Field>
                <Field label="Source PO number"><input style={{ ...inputStyle, width: '100%' }} value={ef.source_po_number} onChange={e => setE('source_po_number', e.target.value)} /></Field>
              </> : <>
                <Field label="Rental cost"><input type="number" style={{ ...inputStyle, width: '100%' }} value={ef.rental_cost} onChange={e => setE('rental_cost', e.target.value)} /></Field>
                <Field label="Rental period"><select style={{ ...selectStyle, width: '100%' }} value={ef.rental_period} onChange={e => setE('rental_period', e.target.value)}><option value="">— select —</option>{RENTAL_PERIODS.map(p => <option key={p} value={p}>{p}</option>)}</select></Field>
                <Field label="Rental start"><input type="date" style={{ ...inputStyle, width: '100%' }} value={ef.rental_start_date} onChange={e => setE('rental_start_date', e.target.value)} /></Field>
                <Field label="Rental end"><input type="date" style={{ ...inputStyle, width: '100%' }} value={ef.rental_end_date} onChange={e => setE('rental_end_date', e.target.value)} /></Field>
              </>}
            </div>
          )}
        </div>
      </div>

      {/* WARRANTY */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Warranty / AMC</span></div>
        <div style={panelBodyStyle}>
          {!editing ? (
            <div style={grid}>
              <Read label="Warranty expiry" value={fmtDate(a.warranty_expiry)} />
              <Read label="AMC renewal" value={fmtDate(a.amc_renewal)} />
              {assetExpiry(a) && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <StatusBadge
                    label={assetExpiry(a).level === 'expired'
                      ? `${assetExpiry(a).what} expired ${Math.abs(assetExpiry(a).days)}d ago`
                      : `${assetExpiry(a).what} expires in ${assetExpiry(a).days}d`}
                    tone={assetExpiry(a).tone}
                  />
                </div>
              )}
            </div>
          ) : (
            <div style={grid}>
              <Field label="Warranty expiry"><input type="date" style={{ ...inputStyle, width: '100%' }} value={ef.warranty_expiry} onChange={e => setE('warranty_expiry', e.target.value)} /></Field>
              <Field label="AMC renewal"><input type="date" style={{ ...inputStyle, width: '100%' }} value={ef.amc_renewal} onChange={e => setE('amc_renewal', e.target.value)} /></Field>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button style={btnPrimary} onClick={saveEdit} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          <button style={btnSecondary} onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
        </div>
      )}

      {/* DOCUMENTS */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Documents ({data.documents.length})</span></div>
        <div style={panelBodyStyle}>
          {canManage && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
              <select style={selectStyle} value={docType} onChange={e => setDocType(e.target.value)}>
                {DOC_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
              <input type="file" onChange={e => setDocFile(e.target.files?.[0] || null)} style={{ fontSize: 12, color: 'var(--t2)' }} />
              <button style={btnSecondary} onClick={uploadDoc} disabled={uploading || !docFile}>{uploading ? 'Uploading…' : 'Upload'}</button>
            </div>
          )}
          {data.documents.length === 0 ? (
            <div style={{ color: 'var(--t3)', fontSize: 12 }}>No documents.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Type</th><th style={tableThStyle}>File</th>
                <th style={tableThStyle}>Uploaded by</th><th style={tableThStyle}>When</th>
                <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
              </tr></thead>
              <tbody>
                {data.documents.map(d => (
                  <tr key={d.id}>
                    <td style={tableTdStyle}>{docTypeLabel(d.doc_type)}</td>
                    <td style={tableTdStyle}>{d.file_name || '—'}</td>
                    <td style={tableTdStyle}>{d.uploaded_by_name || '—'}</td>
                    <td style={tableTdStyle}>{fmtDate(d.created_at)}</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                      <button style={btnSecondary} onClick={() => viewDoc(d.id)}>View</button>
                      {canManage && <button style={{ ...btnDanger, marginLeft: 6 }} onClick={() => deleteDoc(d.id)}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* HISTORY */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>History</span></div>
        <div style={panelBodyStyle}>
          {data.history.length === 0 ? (
            <div style={{ color: 'var(--t3)', fontSize: 12 }}>No history.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.history.map(h => (
                <div key={h.id} style={{ display: 'flex', gap: 10, fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.5)', paddingBottom: 8 }}>
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--t3)', whiteSpace: 'nowrap', minWidth: 130 }}>{fmtDate(h.created_at)}</span>
                  <span style={{ flex: 1 }}>
                    <strong style={{ color: 'var(--t1)' }}>{HISTORY_LABELS[h.event_type] || h.event_type}</strong>
                    {(h.from_value || h.to_value) && <span style={{ color: 'var(--t2)' }}> · {h.from_value || '—'} → {h.to_value || '—'}</span>}
                    {h.note && <span style={{ color: 'var(--t3)' }}> · {h.note}</span>}
                    {h.changed_by_name && <span style={{ color: 'var(--t3)' }}> · {h.changed_by_name}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
