'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { EmptyState, Modal, Spinner, useToast } from '@throttle/ui';

const DEPT_ORDER  = ['Prep', 'Assembly', 'QC', 'Packaging'];
const DEPT_PREFIX = { Prep: 'PR', Assembly: 'AS', QC: 'QC', Packaging: 'PK' };

function getStationCode(department, position) {
  const prefix = DEPT_PREFIX[department] || department.substring(0, 2).toUpperCase();
  return `${prefix}-${String(position).padStart(2, '0')}`;
}

const istToday = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

function fmtIstDate(d) {
  if (!d) return '—';
  try {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
    });
  } catch { return d; }
}

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Normalise a versions[] entry into editor state: { Prep:[{capacity,notes}], ... }
function buildEditorState(version) {
  const out = { Prep: [], Assembly: [], QC: [], Packaging: [] };
  for (const d of (version?.departments || [])) {
    if (!out[d.department]) out[d.department] = [];
    out[d.department] = (d.stations || []).map(s => ({
      capacity: s.capacity,
      notes: s.notes || null,
    }));
  }
  return out;
}

function countHeadcount(stations) {
  return stations.reduce((sum, s) => sum + (Number(s.capacity) || 0), 0);
}

export default function LineDesignPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const canManageFloor = !!(perms?.users_manage || perms?.production_view || perms?.procurement_approve);

  const [productList, setProductList]       = useState([]);       // [{ product, versions: [...] }]
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [designData, setDesignData]         = useState(null);     // { product, versions: [...] }
  const [loadingList, setLoadingList]       = useState(true);
  const [loadingDesign, setLoadingDesign]   = useState(false);
  const [catalogue, setCatalogue]           = useState([]);

  const [editorState, setEditorState]       = useState(null);     // { Prep, Assembly, QC, Packaging }
  const [editorTemplateId, setEditorTemplateId] = useState(null);
  const [editorDirty, setEditorDirty]       = useState(false);
  const [saving, setSaving]                 = useState(false);

  const [showCreate, setShowCreate]         = useState(false);
  const [showNewVersion, setShowNewVersion] = useState(false);
  const [showHistory, setShowHistory]       = useState(false);
  const [historyVersion, setHistoryVersion] = useState(null);

  const loadList = useCallback(async () => {
    if (!session || !canManageFloor) return;
    setLoadingList(true);
    try {
      const [list, cat] = await Promise.all([
        garageFetch('getLineDesigns', {}, session),
        garageFetch('getProductCatalogue', {}, session),
      ]);
      const rows = Array.isArray(list) ? list : (list?.data || []);
      setProductList(rows);
      setCatalogue(Array.isArray(cat?.products) ? cat.products : []);
    } catch (e) {
      showToast(e.message || 'Failed to load line designs', 'error');
    } finally {
      setLoadingList(false);
    }
  }, [session, canManageFloor, showToast]);

  useEffect(() => { loadList(); }, [loadList]);

  const loadDesign = useCallback(async (product) => {
    if (!session || !product) return;
    setLoadingDesign(true);
    try {
      const res = await garageFetch('getLineDesign', { product }, session);
      const payload = res && res.product ? res : res?.data;
      setDesignData(payload || null);
      const active = (payload?.versions || []).find(v => v.is_active);
      if (active) {
        setEditorTemplateId(active.id);
        setEditorState(buildEditorState(active));
        setEditorDirty(false);
      } else {
        setEditorTemplateId(null);
        setEditorState(null);
      }
    } catch (e) {
      showToast(e.message || 'Failed to load design', 'error');
    } finally {
      setLoadingDesign(false);
    }
  }, [session, showToast]);

  useEffect(() => {
    if (selectedProduct) loadDesign(selectedProduct);
    else { setDesignData(null); setEditorState(null); setEditorTemplateId(null); }
  }, [selectedProduct, loadDesign]);

  const activeVersion = useMemo(
    () => (designData?.versions || []).find(v => v.is_active) || null,
    [designData],
  );
  const historicalVersions = useMemo(
    () => (designData?.versions || []).filter(v => !v.is_active).sort((a, b) => b.version_number - a.version_number),
    [designData],
  );

  const onMutateDept = useCallback((dept, mutator) => {
    setEditorState(prev => {
      if (!prev) return prev;
      const next = { ...prev, [dept]: mutator([...(prev[dept] || [])]) };
      return next;
    });
    setEditorDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!editorTemplateId || !editorState) return;
    const departments = DEPT_ORDER
      .map(dept => ({
        department: dept,
        stations: (editorState[dept] || []).map(s => ({ capacity: s.capacity, notes: s.notes })),
      }))
      .filter(d => d.stations.length > 0);
    if (departments.length === 0) {
      showToast('At least one department must have stations', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await workerFetch('updateLineStations',
        { data: { template_id: editorTemplateId, departments } }, session);
      if (!res?.ok) throw new Error(res?.error || 'Save failed');
      showToast('Line design saved', 'success');
      setEditorDirty(false);
      await loadDesign(selectedProduct);
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }, [editorTemplateId, editorState, session, showToast, loadDesign, selectedProduct]);

  if (perms && !canManageFloor) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState message="Line Design is restricted to floor supervisors." />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100dvh - 110px)', color: 'var(--t1)' }}>
      {/* Left panel — product list */}
      <div style={{
        width: 280, minWidth: 280, background: 'var(--surface)',
        border: '1px solid var(--border)', borderRadius: 4,
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '12px 14px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <h2 style={{
            margin: 0, fontFamily: 'var(--cond)', fontSize: 14, fontWeight: 800,
            textTransform: 'uppercase', letterSpacing: '0.06em',
          }}>Products</h2>
          <button
            onClick={() => setShowCreate(true)}
            style={btnPrimaryStyle('sm')}
          >+ NEW</button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
          {loadingList ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner /></div>
          ) : productList.length === 0 ? (
            <div style={{ padding: 16 }}>
              <EmptyState message="No line designs yet — click '+ NEW' to create the first one." />
            </div>
          ) : (
            productList.map((p) => {
              const active = (p.versions || []).find(v => v.is_active) || p.versions?.[0];
              const isSelected = selectedProduct === p.product;
              return (
                <button
                  key={p.product}
                  onClick={() => setSelectedProduct(p.product)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    background: isSelected ? 'var(--surface2)' : 'transparent',
                    borderLeft: isSelected ? '3px solid var(--yellow)' : '3px solid transparent',
                    border: 'none', borderBottom: '1px solid var(--border)',
                    padding: '10px 14px', cursor: 'pointer', color: 'var(--t1)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{p.product}</span>
                    {active && (
                      <span style={{
                        fontFamily: 'var(--mono)', fontSize: 10,
                        background: 'var(--surface2)', border: '1px solid var(--border)',
                        padding: '1px 6px', borderRadius: 3, color: 'var(--t2)',
                      }}>v{active.version_number}</span>
                    )}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', marginTop: 4 }}>
                    {active ? `from ${fmtIstDate(active.effective_from)}` : 'no versions'}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right panel — editor */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!selectedProduct ? (
          <EmptyState message="Select a product to view or edit its line design." />
        ) : loadingDesign ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
        ) : !activeVersion ? (
          <EmptyState message="No active version for this product." />
        ) : (
          <>
            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
              gap: 16, marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--border)',
            }}>
              <div>
                <h2 style={{
                  margin: 0, fontFamily: 'var(--cond)', fontSize: 24, fontWeight: 900,
                  textTransform: 'uppercase', letterSpacing: '0.03em',
                }}>
                  {selectedProduct}
                  <span style={{
                    marginLeft: 12, fontFamily: 'var(--mono)', fontSize: 11,
                    background: 'var(--surface2)', border: '1px solid var(--border)',
                    padding: '2px 8px', borderRadius: 3, color: 'var(--t2)',
                    verticalAlign: 'middle',
                  }}>VERSION {activeVersion.version_number}</span>
                </h2>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>
                  Effective from {fmtIstDate(activeVersion.effective_from)}
                  {activeVersion.notes ? ` · ${activeVersion.notes}` : ''}
                </div>
              </div>
              <button
                onClick={() => setShowNewVersion(true)}
                style={btnSecondaryStyle()}
              >NEW VERSION</button>
            </div>

            {/* Department sections */}
            {DEPT_ORDER.map((dept) => (
              <DepartmentSection
                key={dept}
                department={dept}
                stations={editorState?.[dept] || []}
                onChange={(mutator) => onMutateDept(dept, mutator)}
              />
            ))}

            {/* Save bar */}
            <div style={{
              position: 'sticky', bottom: 0, background: 'var(--surface)',
              borderTop: '1px solid var(--border)', padding: '12px 16px',
              display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16,
            }}>
              <button
                onClick={handleSave}
                disabled={!editorDirty || saving}
                style={{
                  ...btnPrimaryStyle(),
                  opacity: !editorDirty || saving ? 0.5 : 1,
                  cursor: !editorDirty || saving ? 'not-allowed' : 'pointer',
                }}
              >{saving ? 'SAVING…' : 'SAVE CHANGES'}</button>
            </div>

            {/* Version history */}
            <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              <button
                onClick={() => setShowHistory(s => !s)}
                style={{
                  background: 'transparent', border: 'none', color: 'var(--t2)', cursor: 'pointer',
                  fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.05em', padding: 0,
                }}
              >
                {showHistory ? '▼' : '▶'} VERSION HISTORY ({historicalVersions.length})
              </button>
              {showHistory && historicalVersions.length === 0 && (
                <div style={{ marginTop: 12, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                  No historical versions yet.
                </div>
              )}
              {showHistory && historicalVersions.map(v => (
                <button
                  key={v.id}
                  onClick={() => setHistoryVersion(v)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    borderRadius: 3, padding: '10px 12px', marginTop: 8, cursor: 'pointer',
                    color: 'var(--t1)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700 }}>
                    <span>Version {v.version_number}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                      {fmtIstDate(v.effective_from)} → {fmtIstDate(v.effective_to)}
                    </span>
                  </div>
                  {v.notes && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', marginTop: 4 }}>
                      {v.notes}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Create modal */}
      <CreateDesignModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        catalogue={catalogue}
        existingProducts={productList.map(p => p.product)}
        session={session}
        showToast={showToast}
        onCreated={async (product) => {
          setShowCreate(false);
          await loadList();
          setSelectedProduct(product);
        }}
      />

      {/* New version modal */}
      <NewVersionModal
        open={showNewVersion}
        onClose={() => setShowNewVersion(false)}
        activeVersion={activeVersion}
        product={selectedProduct}
        session={session}
        showToast={showToast}
        onCreated={async () => {
          setShowNewVersion(false);
          await loadList();
          await loadDesign(selectedProduct);
        }}
      />

      {/* History read-only modal */}
      <HistoryVersionModal
        version={historyVersion}
        onClose={() => setHistoryVersion(null)}
      />
    </div>
  );
}

function DepartmentSection({ department, stations, onChange }) {
  const total = countHeadcount(stations);

  const handleDragStart = (e, idx) => {
    e.dataTransfer.setData('text/plain', String(idx));
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const handleDrop = (e, dropIdx) => {
    e.preventDefault();
    const fromIdx = Number(e.dataTransfer.getData('text/plain'));
    if (Number.isNaN(fromIdx) || fromIdx === dropIdx) return;
    onChange(list => {
      const next = [...list];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(dropIdx, 0, moved);
      return next;
    });
  };

  const toggleCapacity = (idx) => {
    onChange(list => list.map((s, i) => i === idx ? { ...s, capacity: s.capacity === 1 ? 2 : 1 } : s));
  };
  const removeStation = (idx) => {
    onChange(list => list.filter((_, i) => i !== idx));
  };
  const addStation = () => {
    onChange(list => [...list, { capacity: 1, notes: null }]);
  };

  return (
    <div style={{ marginBottom: 16, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderBottom: '1px solid var(--border)',
      }}>
        <div style={{
          fontFamily: 'var(--cond)', fontSize: 14, fontWeight: 800,
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>{department}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
          {stations.length} station{stations.length === 1 ? '' : 's'} · {total} worker{total === 1 ? '' : 's'}
        </div>
      </div>
      <div style={{ padding: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
        {stations.map((s, idx) => (
          <StationCard
            key={idx}
            department={department}
            position={idx + 1}
            capacity={s.capacity}
            onDragStart={(e) => handleDragStart(e, idx)}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, idx)}
            onToggle={() => toggleCapacity(idx)}
            onRemove={() => removeStation(idx)}
          />
        ))}
        <button onClick={addStation} style={addStationBtnStyle()}>+ Add station</button>
      </div>
    </div>
  );
}

function StationCard({ department, position, capacity, onDragStart, onDragOver, onDrop, onToggle, onRemove }) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        width: 84, height: 104, background: 'var(--surface2)',
        border: '1px solid var(--border)', borderRadius: 4,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: 6, gap: 4, cursor: 'grab', position: 'relative',
      }}
    >
      <button
        onClick={onRemove}
        title="Remove station"
        style={{
          position: 'absolute', top: 2, right: 4, background: 'none',
          border: 'none', color: 'var(--t3)', fontSize: 14, cursor: 'pointer',
          padding: 0, lineHeight: 1,
        }}
      >×</button>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
        color: 'var(--t2)', letterSpacing: '0.05em',
      }}>{getStationCode(department, position)}</div>
      <button
        onClick={onToggle}
        title={capacity === 2 ? 'Two-worker station (click to switch to single)' : 'Single-worker station (click to switch to double)'}
        style={{
          flex: 1, width: '100%', background: capacity === 2 ? 'var(--yellow-tint, #2a2415)' : '#1d1d1d',
          border: '1px solid ' + (capacity === 2 ? 'var(--yellow)' : 'var(--border)'),
          borderRadius: 3, cursor: 'pointer', color: 'var(--t1)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2,
          fontSize: 18,
        }}
      >
        {capacity === 2 ? '👤👤' : '👤'}
      </button>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)' }}>
        cap {capacity}
      </div>
    </div>
  );
}

function CreateDesignModal({ open, onClose, catalogue, existingProducts, session, showToast, onCreated }) {
  const [product, setProduct]             = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(istToday());
  const [notes, setNotes]                 = useState('');
  const [draft, setDraft]                 = useState({ Prep: [], Assembly: [], QC: [], Packaging: [] });
  const [submitting, setSubmitting]       = useState(false);

  useEffect(() => {
    if (open) {
      setProduct('');
      setEffectiveFrom(istToday());
      setNotes('');
      setDraft({ Prep: [], Assembly: [], QC: [], Packaging: [] });
    }
  }, [open]);

  const existingSet = useMemo(() => new Set(existingProducts || []), [existingProducts]);

  const mutate = (dept, mutator) => setDraft(prev => ({ ...prev, [dept]: mutator([...(prev[dept] || [])]) }));

  const totalStations = DEPT_ORDER.reduce((sum, d) => sum + (draft[d]?.length || 0), 0);

  const handleSubmit = async () => {
    if (!product) { showToast('Product required', 'error'); return; }
    if (!effectiveFrom) { showToast('Effective date required', 'error'); return; }
    if (totalStations === 0) { showToast('Add at least one station', 'error'); return; }
    const departments = DEPT_ORDER
      .map(dept => ({
        department: dept,
        stations: (draft[dept] || []).map(s => ({ capacity: s.capacity, notes: s.notes })),
      }))
      .filter(d => d.stations.length > 0);
    setSubmitting(true);
    try {
      const res = await workerFetch('createLineDesign',
        { data: { product, effective_from: effectiveFrom, notes: notes || null, departments } }, session);
      if (!res?.ok) throw new Error(res?.error || 'Create failed');
      showToast(`Created line design for ${product}`, 'success');
      onCreated(product);
    } catch (e) {
      showToast(e.message || 'Create failed', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title="NEW LINE DESIGN">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={labelStyle()}>
          Product
          <select
            value={product}
            onChange={(e) => setProduct(e.target.value)}
            style={inputStyle()}
          >
            <option value="">— Select a product —</option>
            {(catalogue || []).map(p => (
              <option key={p} value={p} disabled={existingSet.has(p)}>
                {p}{existingSet.has(p) ? ' (design exists)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle()}>
          Effective from
          <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} style={inputStyle()} />
        </label>
        <label style={labelStyle()}>
          Notes (optional)
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle()} />
        </label>

        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          <div style={{
            fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 800,
            textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, color: 'var(--t2)',
          }}>Stations</div>
          {DEPT_ORDER.map((dept) => (
            <DepartmentSection
              key={dept}
              department={dept}
              stations={draft[dept] || []}
              onChange={(m) => mutate(dept, m)}
            />
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button onClick={onClose} disabled={submitting} style={btnSecondaryStyle()}>CANCEL</button>
          <button onClick={handleSubmit} disabled={submitting} style={btnPrimaryStyle()}>
            {submitting ? 'CREATING…' : 'CREATE DESIGN'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function NewVersionModal({ open, onClose, activeVersion, product, session, showToast, onCreated }) {
  const [effectiveFrom, setEffectiveFrom] = useState(tomorrowISO());
  const [notes, setNotes]                 = useState('');
  const [submitting, setSubmitting]       = useState(false);

  useEffect(() => {
    if (open) {
      setEffectiveFrom(tomorrowISO());
      setNotes('');
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!effectiveFrom) { showToast('Effective date required', 'error'); return; }
    if (!notes.trim())  { showToast('Change notes required',   'error'); return; }
    if (activeVersion?.effective_from && effectiveFrom <= activeVersion.effective_from) {
      showToast(`New effective date must be after ${fmtIstDate(activeVersion.effective_from)}`, 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await workerFetch('newLineDesignVersion',
        { data: { product, effective_from: effectiveFrom, notes } }, session);
      if (!res?.ok) throw new Error(res?.error || 'Create version failed');
      showToast(`Version ${res.data?.version_number || ''} created`, 'success');
      onCreated();
    } catch (e) {
      showToast(e.message || 'Create version failed', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="md" title={`NEW VERSION — ${product || ''}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
          Current version: v{activeVersion?.version_number || '?'} (from {fmtIstDate(activeVersion?.effective_from)})
          <br />
          Stations from the current version will be copied as the starting point for the new version.
        </div>
        <label style={labelStyle()}>
          New version effective from
          <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} style={inputStyle()} />
        </label>
        <label style={labelStyle()}>
          Change notes (required)
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle()} placeholder="What changed?" />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button onClick={onClose} disabled={submitting} style={btnSecondaryStyle()}>CANCEL</button>
          <button onClick={handleSubmit} disabled={submitting} style={btnPrimaryStyle()}>
            {submitting ? 'CREATING…' : 'CREATE VERSION'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function HistoryVersionModal({ version, onClose }) {
  if (!version) return null;
  return (
    <Modal
      open={!!version}
      onClose={onClose}
      size="lg"
      title={`VERSION ${version.version_number} (READ-ONLY)`}
    >
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginBottom: 12 }}>
        Effective {fmtIstDate(version.effective_from)} → {fmtIstDate(version.effective_to)}
        {version.notes ? ` · ${version.notes}` : ''}
      </div>
      {DEPT_ORDER.map((dept) => {
        const d = (version.departments || []).find(x => x.department === dept);
        if (!d || d.stations.length === 0) return null;
        return (
          <div key={dept} style={{ marginBottom: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 }}>
            <div style={{
              padding: '8px 12px', borderBottom: '1px solid var(--border)',
              fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 800,
              textTransform: 'uppercase', letterSpacing: '0.06em',
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>{dept}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                {d.stations.length} stations · {d.total_headcount} workers
              </span>
            </div>
            <div style={{ padding: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {d.stations.map((s) => (
                <div key={s.id} style={{
                  width: 70, padding: '4px 6px', background: 'var(--surface2)',
                  border: '1px solid var(--border)', borderRadius: 3,
                  fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'center',
                }}>
                  <div style={{ fontWeight: 700, color: 'var(--t2)' }}>{getStationCode(dept, s.position)}</div>
                  <div style={{ color: 'var(--t3)', marginTop: 2 }}>cap {s.capacity}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </Modal>
  );
}

// ── style helpers ─────────────────────────────────────────────
function btnPrimaryStyle(size) {
  return {
    background: 'var(--yellow)', color: '#000', border: 'none',
    padding: size === 'sm' ? '4px 8px' : '8px 14px',
    borderRadius: 3, cursor: 'pointer',
    fontFamily: 'var(--cond)', fontWeight: 800, fontSize: size === 'sm' ? 10 : 12,
    textTransform: 'uppercase', letterSpacing: '0.06em',
  };
}
function btnSecondaryStyle() {
  return {
    background: 'transparent', color: 'var(--t1)', border: '1px solid var(--border)',
    padding: '6px 12px', borderRadius: 3, cursor: 'pointer',
    fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 11,
    textTransform: 'uppercase', letterSpacing: '0.06em',
  };
}
function addStationBtnStyle() {
  return {
    width: 84, height: 104, background: 'transparent',
    border: '1px dashed var(--border)', borderRadius: 4, cursor: 'pointer',
    color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 10,
  };
}
function labelStyle() {
  return {
    display: 'flex', flexDirection: 'column', gap: 4,
    fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)',
  };
}
function inputStyle() {
  return {
    background: 'var(--surface)', color: 'var(--t1)',
    border: '1px solid var(--border)', borderRadius: 3,
    padding: '6px 8px', fontFamily: 'var(--mono)', fontSize: 12,
  };
}
