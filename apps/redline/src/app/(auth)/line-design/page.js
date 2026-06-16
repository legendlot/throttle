'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { EmptyState, Modal, Spinner, useToast, Panel, Chip, StatusBadge } from '@throttle/ui';
import { Icon as KitIcon } from '../../../components/kit/index.js';

const DEPT_ORDER  = ['Prep', 'Assembly', 'QC', 'Packaging', 'Workshop'];
const DEPT_PREFIX = { Prep: 'PR', Assembly: 'AS', QC: 'QC', Packaging: 'PK', Workshop: 'WS' };

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

// Normalise a versions[] entry into editor state: { Prep:[{capacity,notes,unit_type}], ... }
function buildEditorState(version) {
  const out = { Prep: [], Assembly: [], QC: [], Packaging: [], Workshop: [] };
  for (const d of (version?.departments || [])) {
    if (!out[d.department]) out[d.department] = [];
    out[d.department] = (d.stations || []).map(s => ({
      capacity: s.capacity,
      notes: s.notes || null,
      unit_type: s.unit_type || null,
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
        stations: (editorState[dept] || []).map(s => ({
          capacity: s.capacity,
          notes: s.notes,
          unit_type: s.unit_type ?? null,
        })),
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
          <LineDesignLanding
            productList={productList}
            loading={loadingList}
            onSelect={setSelectedProduct}
            onNew={() => setShowCreate(true)}
          />
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

            {/* Summary bar — derived from editorState capacities */}
            {editorState && <LineDesignSummaryBar editorState={editorState} />}

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

function LineDesignLanding({ productList, loading, onSelect, onNew }) {
  const rows = (productList || []).map(p => {
    const active = (p.versions || []).find(v => v.is_active) || (p.versions || [])[0] || null;
    return { product: p.product, active };
  });

  const tagged = rows.filter(r => r.active).length;

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>;
  }

  // Per DESIGN.md Table spec:
  //   - Header row: JetBrains Mono 12px, 600, uppercase, 0.08em, --t3
  //   - Data row:   JetBrains Mono 14px, --t1, 10×12px padding
  // The Tomorrow-on-data treatment violated the "Tomorrow vs Mono Rule"
  // (Tomorrow speaks for headings/brand; Mono shows for data/tables).
  const thStyle = (align = 'center') => ({
    textAlign: align,
    padding: '10px 12px',
    fontFamily: 'var(--mono)',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--t3)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
    position: 'sticky',
    top: 0,
  });
  const tdStyle = (align = 'center') => ({
    textAlign: align,
    padding: '10px 12px',
    borderBottom: '1px solid var(--border)',
    fontFamily: 'var(--mono)',
    fontSize: 14,
    color: 'var(--t1)',
  });
  // Chips kept Tomorrow because they're brand/state badges, not data.
  // 11px is the floor for any text — bumped from the previous 9px.
  const chip = (bg, fg) => ({
    fontSize: 11,
    fontWeight: 700,
    fontFamily: 'var(--cond)',
    background: bg,
    color: fg,
    borderRadius: 3,
    padding: '2px 6px',
    letterSpacing: '0.05em',
  });

  return (
    <div style={{ padding: '4px 4px 24px' }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid var(--border)',
      }}>
        <div>
          <h2 style={{
            margin: 0,
            fontFamily: 'var(--cond)', fontSize: 22, fontWeight: 900,
            textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--t1)',
          }}>
            Line Designs
          </h2>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>
            {tagged} product{tagged === 1 ? '' : 's'} configured · pick a row or use the left list to edit
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState message="No line designs yet — click + NEW on the left to create the first one." />
      ) : (
        <Panel padding={0}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle('left')}>Product</th>
                <th style={thStyle()}>Version</th>
                <th style={thStyle()}>Effective</th>
                {DEPT_ORDER.map(d => <th key={d} style={thStyle()}>{d}</th>)}
                <th style={thStyle()}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ product, active }) => {
                const s = active?.dept_summary || {};
                return (
                  <tr
                    key={product}
                    onClick={() => onSelect(product)}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface2)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    style={{ cursor: 'pointer', transition: 'background 0.1s' }}
                  >
                    <td style={{ ...tdStyle('left'), fontWeight: 600 }}>
                      {product}
                    </td>
                    <td style={tdStyle()}>
                      {active ? (
                        <span style={{
                          fontFamily: 'var(--mono)', fontSize: 11,
                          background: 'var(--surface-2)', border: '1px solid var(--border)',
                          padding: '2px 7px', borderRadius: 3, color: 'var(--t2)',
                        }}>v{active.version_number}</span>
                      ) : <span style={{ color: 'var(--t3)' }}>—</span>}
                    </td>
                    <td style={{ ...tdStyle(), color: 'var(--t3)' }}>
                      {active ? fmtIstDate(active.effective_from) : '—'}
                    </td>
                    {DEPT_ORDER.map(dept => {
                      const info = s[dept] || { stations: 0, workers: 0, car_workers: 0, remote_workers: 0 };
                      const hasBreakdown = (info.car_workers || 0) > 0 || (info.remote_workers || 0) > 0;
                      return (
                        <td key={dept} style={tdStyle()}>
                          <div style={{
                            fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700,
                            color: info.workers > 0 ? 'var(--t1)' : 'var(--t3)',
                          }}>
                            {info.workers}
                          </div>
                          {hasBreakdown && (dept === 'Assembly' || dept === 'Prep') && (
                            <div style={{ display: 'flex', gap: 4, justifyContent: 'center', marginTop: 3 }}>
                              {info.car_workers > 0 && (
                                <span style={chip('#213CE2', '#fff')}>{info.car_workers}C</span>
                              )}
                              {info.remote_workers > 0 && (
                                <span style={chip('#9333ea', '#fff')}>{info.remote_workers}R</span>
                              )}
                            </div>
                          )}
                        </td>
                      );
                    })}
                    <td style={tdStyle()}>
                      <span style={{
                        fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700,
                        color: 'var(--yellow)',
                      }}>
                        {active?.total_workers || 0}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}

function LineDesignSummaryBar({ editorState }) {
  const deptTotals = DEPT_ORDER.reduce((acc, dept) => {
    acc[dept] = (editorState?.[dept] || []).reduce((sum, s) => sum + (Number(s.capacity) || 0), 0);
    return acc;
  }, {});
  const totalWorkers = Object.values(deptTotals).reduce((a, b) => a + b, 0);

  const carWorkers = DEPT_ORDER.reduce((sum, dept) => sum +
    (editorState?.[dept] || []).filter(s => s.unit_type === 'car').reduce((a, s) => a + (Number(s.capacity) || 0), 0), 0);
  const remoteWorkers = DEPT_ORDER.reduce((sum, dept) => sum +
    (editorState?.[dept] || []).filter(s => s.unit_type === 'remote').reduce((a, s) => a + (Number(s.capacity) || 0), 0), 0);
  const untaggedWorkers = ['Assembly', 'Prep'].reduce((sum, dept) => sum +
    (editorState?.[dept] || []).filter(s => !s.unit_type).reduce((a, s) => a + (Number(s.capacity) || 0), 0), 0);
  const hasAnyTag = carWorkers > 0 || remoteWorkers > 0;

  const cellStyle = {
    flex: 1,
    padding: '10px 16px',
    textAlign: 'center',
  };
  const labelStyleS = {
    fontSize: 11,
    color: 'var(--t2)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: 4,
    fontFamily: 'var(--cond)',
    fontWeight: 700,
  };
  const numStyle = (color) => ({
    fontSize: 22,
    fontWeight: 800,
    color,
    fontFamily: 'var(--cond)',
    lineHeight: 1,
  });
  const subStyle = { fontSize: 10, color: 'var(--t3)', marginTop: 4, fontFamily: 'var(--mono)' };

  const chipStyle = (bg, fg) => ({
    background: bg,
    color: fg,
    fontSize: 10,
    fontWeight: 800,
    padding: '2px 7px',
    borderRadius: 3,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    fontFamily: 'var(--cond)',
  });

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 4,
      marginBottom: 16,
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {DEPT_ORDER.map((dept) => (
          <div
            key={dept}
            style={{ ...cellStyle, borderRight: '1px solid var(--border)' }}
          >
            <div style={labelStyleS}>{dept}</div>
            <div style={numStyle('var(--t1)')}>{deptTotals[dept]}</div>
            <div style={subStyle}>{deptTotals[dept] === 1 ? 'worker' : 'workers'}</div>
          </div>
        ))}
        <div style={{
          ...cellStyle,
          background: 'var(--surface2)',
          minWidth: 110,
        }}>
          <div style={labelStyleS}>Total</div>
          <div style={numStyle('var(--yellow)')}>{totalWorkers}</div>
          <div style={subStyle}>{totalWorkers === 1 ? 'worker' : 'workers'}</div>
        </div>
      </div>
      {hasAnyTag && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          padding: '8px 16px',
          borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
        }}>
          <span style={{
            fontSize: 10,
            color: 'var(--t2)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontFamily: 'var(--cond)',
            fontWeight: 700,
          }}>
            Breakdown
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={chipStyle('#213CE2', '#fff')}>Car</span>
            <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)', fontFamily: 'var(--cond)' }}>{carWorkers}</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={chipStyle('#9333ea', '#fff')}>Rem</span>
            <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)', fontFamily: 'var(--cond)' }}>{remoteWorkers}</span>
          </span>
          {untaggedWorkers > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={chipStyle('var(--surface2)', 'var(--t2)')}>Untagged</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--t2)', fontFamily: 'var(--cond)' }}>{untaggedWorkers}</span>
            </span>
          )}
        </div>
      )}
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
    onChange(list => [...list, { capacity: 1, notes: null, unit_type: null }]);
  };
  const setUnitType = (idx, type) => {
    onChange(list => list.map((s, i) =>
      i === idx ? { ...s, unit_type: s.unit_type === type ? null : type } : s,
    ));
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <Panel
        header={department}
        headerAction={`${stations.length} station${stations.length === 1 ? '' : 's'} · ${total} worker${total === 1 ? '' : 's'}`}
        padding={12}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
          {stations.map((s, idx) => (
            <StationCard
              key={idx}
              department={department}
              position={idx + 1}
              capacity={s.capacity}
              unitType={s.unit_type || null}
              onDragStart={(e) => handleDragStart(e, idx)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, idx)}
              onToggle={() => toggleCapacity(idx)}
              onRemove={() => removeStation(idx)}
              onSetUnitType={(type) => setUnitType(idx, type)}
            />
          ))}
          <button onClick={addStation} style={addStationBtnStyle()}>+ Add station</button>
        </div>
      </Panel>
    </div>
  );
}

function StationCard({ department, position, capacity, unitType, onDragStart, onDragOver, onDrop, onToggle, onRemove, onSetUnitType }) {
  const showUnitToggle = department === 'Assembly' || department === 'Prep';
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        width: 84, minHeight: 104, background: 'var(--surface2)',
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
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
          fontSize: 18,
        }}
      >
        <KitIcon name="users" size={16} />
        <span className="num" style={{ fontSize: 12 }}>×{capacity === 2 ? 2 : 1}</span>
      </button>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)' }}>
        cap {capacity}
      </div>
      {showUnitToggle && (
        <div style={{
          display: 'flex', gap: 3, marginTop: 2, justifyContent: 'center', width: '100%',
        }}>
          {['car', 'remote'].map(type => {
            const selected = unitType === type;
            const accent = type === 'car' ? '#213CE2' : '#9333ea';
            return (
              <button
                key={type}
                onClick={(e) => { e.stopPropagation(); onSetUnitType && onSetUnitType(type); }}
                title={selected ? `Click to clear ${type === 'car' ? 'Car' : 'Remote'} tag` : `Tag as ${type === 'car' ? 'Car' : 'Remote'}`}
                style={{
                  flex: 1,
                  padding: '2px 0',
                  fontSize: 9,
                  fontWeight: 800,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  borderRadius: 3,
                  border: '1px solid ' + (selected ? accent : 'var(--border)'),
                  cursor: 'pointer',
                  background: selected ? accent : 'transparent',
                  color: selected ? '#fff' : 'var(--t3)',
                  fontFamily: 'var(--cond)',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {type === 'car' ? 'CAR' : 'REM'}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CreateDesignModal({ open, onClose, catalogue, existingProducts, session, showToast, onCreated }) {
  const [product, setProduct]             = useState('');
  const [productQuery, setProductQuery]   = useState('');
  const [productDropOpen, setProductDropOpen] = useState(false);
  const [productHighlight, setProductHighlight] = useState(-1);
  const highlightedProductRef = useRef(null);
  const [effectiveFrom, setEffectiveFrom] = useState(istToday());
  const [notes, setNotes]                 = useState('');
  const [copyFrom, setCopyFrom]           = useState('');
  const [draft, setDraft]                 = useState({ Prep: [], Assembly: [], QC: [], Packaging: [], Workshop: [] });
  const [submitting, setSubmitting]       = useState(false);

  useEffect(() => {
    if (open) {
      setProduct('');
      setProductQuery('');
      setProductDropOpen(false);
      setProductHighlight(-1);
      setEffectiveFrom(istToday());
      setNotes('');
      setCopyFrom('');
      setDraft({ Prep: [], Assembly: [], QC: [], Packaging: [], Workshop: [] });
    }
  }, [open]);

  useEffect(() => {
    if (highlightedProductRef.current) {
      highlightedProductRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [productHighlight]);

  const selectProductOption = (p) => {
    setProduct(p);
    setProductQuery(p);
    setProductDropOpen(false);
    setProductHighlight(-1);
  };

  const existingSet = useMemo(() => new Set(existingProducts || []), [existingProducts]);
  const availableProducts = useMemo(
    () => (catalogue || []).filter(p => !existingSet.has(p)),
    [catalogue, existingSet],
  );
  const filteredProducts = useMemo(
    () => availableProducts.filter(p => p.toLowerCase().includes(productQuery.toLowerCase())),
    [availableProducts, productQuery],
  );
  const copyCandidates = useMemo(
    () => (existingProducts || []).filter(p => p !== product),
    [existingProducts, product],
  );

  const mutate = (dept, mutator) => setDraft(prev => ({ ...prev, [dept]: mutator([...(prev[dept] || [])]) }));

  const totalStations = DEPT_ORDER.reduce((sum, d) => sum + (draft[d]?.length || 0), 0);

  const handleSubmit = async () => {
    if (!product) { showToast('Product required', 'error'); return; }
    if (!effectiveFrom) { showToast('Effective date required', 'error'); return; }
    setSubmitting(true);
    try {
      let res;
      if (copyFrom) {
        if (copyFrom === product) {
          showToast('Source and target must be different products', 'error');
          setSubmitting(false);
          return;
        }
        res = await workerFetch('copyLineDesign',
          { data: { source_product: copyFrom, target_product: product, effective_from: effectiveFrom, notes: notes || null } }, session);
      } else {
        if (totalStations === 0) {
          showToast('Add at least one station or pick a product to copy from', 'error');
          setSubmitting(false);
          return;
        }
        const departments = DEPT_ORDER
          .map(dept => ({
            department: dept,
            stations: (draft[dept] || []).map(s => ({
              capacity: s.capacity,
              notes: s.notes,
              unit_type: s.unit_type ?? null,
            })),
          }))
          .filter(d => d.stations.length > 0);
        res = await workerFetch('createLineDesign',
          { data: { product, effective_from: effectiveFrom, notes: notes || null, departments } }, session);
      }
      if (!res?.ok) throw new Error(res?.error || 'Create failed');
      const copiedCount = copyFrom ? (res.data?.stations_copied ?? 0) : null;
      showToast(
        copyFrom
          ? `Created ${product} by copying ${copiedCount} station${copiedCount === 1 ? '' : 's'} from ${copyFrom}`
          : `Created line design for ${product}`,
        'success',
      );
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
          <div style={{ position: 'relative' }}>
            <input
              type="text"
              placeholder={availableProducts.length === 0 ? 'No products available' : 'Search products…'}
              value={productQuery}
              autoComplete="off"
              disabled={availableProducts.length === 0}
              onChange={(e) => { setProductQuery(e.target.value); setProductDropOpen(true); setProduct(''); setProductHighlight(-1); }}
              onFocus={() => setProductDropOpen(true)}
              onBlur={() => setTimeout(() => { setProductDropOpen(false); setProductHighlight(-1); }, 150)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setProductDropOpen(true);
                  setProductHighlight((i) => Math.min((i < 0 ? -1 : i) + 1, filteredProducts.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setProductHighlight((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter') {
                  if (productDropOpen && productHighlight >= 0 && filteredProducts[productHighlight]) {
                    e.preventDefault();
                    selectProductOption(filteredProducts[productHighlight]);
                  }
                } else if (e.key === 'Escape') {
                  setProductDropOpen(false);
                  setProductHighlight(-1);
                }
              }}
              style={{
                ...inputStyle(),
                borderRadius: productDropOpen ? '4px 4px 0 0' : 4,
              }}
            />
            {productDropOpen && availableProducts.length > 0 && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                background: 'var(--surface2)', border: '1px solid var(--border)', borderTop: 'none',
                borderRadius: '0 0 4px 4px', maxHeight: 220, overflowY: 'auto',
              }}>
                {filteredProducts.length === 0 ? (
                  <div style={{ padding: '8px 10px', color: 'var(--t3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
                    No products found
                  </div>
                ) : filteredProducts.map((p, idx) => {
                  const highlighted = idx === productHighlight;
                  return (
                    <div
                      key={p}
                      ref={highlighted ? highlightedProductRef : null}
                      onMouseDown={() => selectProductOption(p)}
                      onMouseEnter={() => setProductHighlight(idx)}
                      style={{
                        padding: '8px 10px',
                        cursor: 'pointer',
                        fontSize: 13,
                        color: 'var(--t1)',
                        background: highlighted ? 'var(--surface)' : 'transparent',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      {p}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </label>
        <label style={labelStyle()}>
          Effective from
          <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} style={inputStyle()} />
        </label>
        <label style={labelStyle()}>
          Copy stations from (optional)
          <select
            value={copyFrom}
            onChange={(e) => setCopyFrom(e.target.value)}
            disabled={copyCandidates.length === 0}
            style={inputStyle()}
          >
            <option value="">— Start blank —</option>
            {copyCandidates.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label style={labelStyle()}>
          Notes (optional)
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle()} />
        </label>

        {copyFrom ? (
          <div style={{
            marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)',
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)',
          }}>
            Stations will be copied from <strong style={{ color: 'var(--t1)' }}>{copyFrom}</strong>{"'"}s active version.
            Clear the dropdown above to build stations manually.
          </div>
        ) : (
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
        )}

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
          <div key={dept} style={{ marginBottom: 12 }}>
            <Panel
              header={dept}
              headerAction={`${d.stations.length} stations · ${d.total_headcount} workers`}
              padding={10}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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
            </Panel>
          </div>
        );
      })}
    </Modal>
  );
}

// ── style helpers ─────────────────────────────────────────────
function btnPrimaryStyle(size) {
  return {
    background: 'var(--yellow)', color: '#0a0a0a', border: '1px solid var(--yellow)',
    padding: size === 'sm' ? '5px 10px' : '8px 14px',
    borderRadius: 3, cursor: 'pointer',
    fontFamily: 'var(--cond)', fontWeight: 700, fontSize: size === 'sm' ? 11 : 13,
    textTransform: 'uppercase', letterSpacing: '0.06em',
  };
}
function btnSecondaryStyle() {
  return {
    background: 'transparent', color: 'var(--t2)', border: '1px solid var(--border)',
    padding: '8px 14px', borderRadius: 3, cursor: 'pointer',
    fontFamily: 'var(--mono)', fontWeight: 400, fontSize: 13,
    textTransform: 'uppercase', letterSpacing: '0.06em',
  };
}
function addStationBtnStyle() {
  return {
    width: 84, height: 104, background: 'transparent',
    border: '1px dashed var(--border)', borderRadius: 4, cursor: 'pointer',
    color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11,
  };
}
function labelStyle() {
  return {
    display: 'flex', flexDirection: 'column', gap: 6,
    fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)',
    letterSpacing: '0.08em', textTransform: 'uppercase',
  };
}
function inputStyle() {
  return {
    background: 'var(--surface)', color: 'var(--t1)',
    border: '1px solid var(--border)', borderRadius: 3,
    padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 13, outline: 'none',
    textTransform: 'none', letterSpacing: 'normal',
  };
}
