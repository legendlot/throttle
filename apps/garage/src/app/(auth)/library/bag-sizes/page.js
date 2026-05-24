'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Modal, Spinner, useToast, EmptyState } from '@throttle/ui';

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '12px 14px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--accent, #213ce2)', border: 'none', borderRadius: 3, padding: '8px 14px', fontSize: 12, color: '#fff', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

function fmtTs(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return ts; }
}

export default function BagSizesPage() {
  const { session, perms } = useAuth();
  const { toast } = useToast();
  const canEdit = hasPermission(perms, 'users_manage');

  const [defaults, setDefaults] = useState([]);   // store.part_bag_sizes rows
  const [partsCat, setPartsCat] = useState([]);   // procurement parts (enrichment)
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');

  const [editTarget, setEditTarget] = useState(null);   // { part_code, ... }
  const [editForm,   setEditForm]   = useState(null);   // local form state
  const [saving,     setSaving]     = useState(false);

  const [historyTarget, setHistoryTarget] = useState(null);   // part_code
  const [history,       setHistory]       = useState([]);
  const [histLoading,   setHistLoading]   = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ part_code: '', size: '', notes: '' });

  async function loadAll() {
    if (!session) return;
    setLoading(true);
    try {
      const [bagsRes, partsRes] = await Promise.all([
        workerFetch('getPartBagSizes', {}, session).catch(() => ({ ok: false })),
        garageFetch('getProcurementParts', {}, session).catch(() => []),
      ]);
      const bagsRows  = bagsRes?.ok ? (bagsRes.data || []) : [];
      const partsRows = Array.isArray(partsRes) ? partsRes : [];
      setDefaults(bagsRows);
      setPartsCat(partsRows);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { loadAll(); /* eslint-disable-next-line */ }, [session]);

  // Merge part_bag_sizes with procurement parts catalogue. Surface every part
  // that appears in EITHER source so admins can also set a size for parts not
  // yet in the central table.
  const rows = useMemo(() => {
    const map = new Map();
    partsCat.forEach(p => {
      if (!p.part_code) return;
      map.set(p.part_code, {
        part_code:        p.part_code,
        part_name:        p.part_name || '',
        part_category:    p.part_category || '',
        product:          '',          // procurement parts catalogue has no product
        default_bag_size: null,
        updated_at:       null,
      });
    });
    defaults.forEach(d => {
      const prev = map.get(d.part_code) || { part_code: d.part_code, part_name: '', part_category: '', product: '' };
      map.set(d.part_code, {
        ...prev,
        default_bag_size: d.default_bag_size,
        updated_at:       d.updated_at,
        notes:            d.notes,
        updated_by:       d.updated_by,
      });
    });
    return [...map.values()].sort((a, b) => a.part_code.localeCompare(b.part_code));
  }, [defaults, partsCat]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    const tokens = q.split(/\s+/).filter(Boolean);
    return rows.filter(r =>
      tokens.every(t =>
        (r.part_code || '').toLowerCase().includes(t) ||
        (r.part_name || '').toLowerCase().includes(t) ||
        (r.part_category || '').toLowerCase().includes(t)
      )
    );
  }, [rows, search]);

  const stats = useMemo(() => ({
    total:       rows.length,
    with_size:   rows.filter(r => r.default_bag_size != null).length,
    without:     rows.filter(r => r.default_bag_size == null).length,
    matched:     filtered.length,
  }), [rows, filtered]);

  function openEdit(row) {
    if (!canEdit) return;
    setEditTarget(row);
    setEditForm({
      size:   row.default_bag_size != null ? String(row.default_bag_size) : '',
      reason: '',
      notes:  row.notes || '',
    });
  }
  async function saveEdit() {
    if (!editTarget || !editForm) return;
    const newSize = Math.round(Number(editForm.size) || 0);
    if (newSize <= 0) { toast('Bag size must be > 0', 'err'); return; }
    const isChange = editTarget.default_bag_size != null && editTarget.default_bag_size !== newSize;
    if (isChange && !editForm.reason.trim()) {
      toast('Reason required when changing an existing default', 'err');
      return;
    }
    setSaving(true);
    try {
      const r = await workerFetch('setPartBagSize', {
        data: {
          part_code: editTarget.part_code,
          new_size:  newSize,
          reason:    editForm.reason.trim(),
          notes:     editForm.notes.trim() || null,
          source:    'library',
        },
      }, session);
      if (!r.ok) { toast(r.data?.error || 'Save failed', 'err'); return; }
      toast(r.data?.unchanged ? 'No change' : 'Saved', 'ok');
      setEditTarget(null);
      setEditForm(null);
      loadAll();
    } finally {
      setSaving(false);
    }
  }

  async function openHistory(partCode) {
    setHistoryTarget(partCode);
    setHistLoading(true);
    setHistory([]);
    try {
      const r = await workerFetch('getPartBagSizeHistory', { data: { part_code: partCode } }, session);
      setHistory(r?.ok ? (r.data || []) : []);
    } finally {
      setHistLoading(false);
    }
  }

  async function saveAdd() {
    const partCode = (addForm.part_code || '').trim();
    const size     = Math.round(Number(addForm.size) || 0);
    if (!partCode) { toast('Part code required', 'err'); return; }
    if (size <= 0) { toast('Bag size must be > 0', 'err'); return; }
    setSaving(true);
    try {
      const r = await workerFetch('setPartBagSize', {
        data: {
          part_code: partCode,
          new_size:  size,
          reason:    '',
          notes:     addForm.notes.trim() || null,
          source:    'library',
        },
      }, session);
      if (!r.ok) { toast(r.data?.error || 'Save failed', 'err'); return; }
      toast('Added', 'ok');
      setAddOpen(false);
      setAddForm({ part_code: '', size: '', notes: '' });
      loadAll();
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner label="Loading bag-size catalogue…" />;

  return (
    <div style={{ padding: 16 }}>
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Part Bag Sizes</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', letterSpacing: '0.06em' }}>
              {stats.matched} of {stats.total} · {stats.with_size} with default · {stats.without} unset
            </span>
            {canEdit && (
              <button onClick={() => setAddOpen(true)} style={btnSecondary}>+ ADD PART</button>
            )}
          </div>
        </div>
        <div style={panelBodyStyle}>
          {!canEdit && (
            <div style={{ marginBottom: 10, padding: '8px 10px', background: 'rgba(242,205,26,.08)', border: '1px solid rgba(242,205,26,.2)', borderRadius: 3, fontSize: 11, color: 'var(--t2)' }}>
              View-only · Admin access required to edit bag sizes.
            </div>
          )}
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Search</label>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="part code / name / category…"
              style={{ ...inputStyle, width: '100%', maxWidth: 480 }}
            />
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={tableThStyle}>Part Code</th>
                  <th style={tableThStyle}>Part Name</th>
                  <th style={tableThStyle}>Category</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}>Default Qty/Bag</th>
                  <th style={tableThStyle}>Last Updated</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={6} style={{ ...tableTdStyle, textAlign: 'center', color: 'var(--t3)' }}>No matches</td></tr>
                ) : filtered.map(r => (
                  <tr key={r.part_code} style={{ cursor: canEdit ? 'pointer' : 'default' }} onClick={() => openEdit(r)}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.part_code}</td>
                    <td style={tableTdStyle}>{r.part_name || '—'}</td>
                    <td style={{ ...tableTdStyle, color: 'var(--t3)' }}>{r.part_category || '—'}</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: r.default_bag_size != null ? 700 : 400, color: r.default_bag_size != null ? 'var(--t1)' : 'var(--t3)' }}>
                      {r.default_bag_size != null ? r.default_bag_size : '—'}
                    </td>
                    <td style={{ ...tableTdStyle, color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 10 }}>
                      {fmtTs(r.updated_at)}
                    </td>
                    <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                      <button onClick={(e) => { e.stopPropagation(); openHistory(r.part_code); }} style={btnSecondary}>
                        HISTORY
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Edit modal */}
      {editTarget && (
        <Modal open onClose={() => { setEditTarget(null); setEditForm(null); }} size="md" title={`Bag size · ${editTarget.part_code}`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--t2)' }}>
              {editTarget.part_name || '—'}
              {editTarget.part_category ? <span style={{ color: 'var(--t3)' }}> · {editTarget.part_category}</span> : null}
            </div>
            <div>
              <label style={labelStyle}>Default Qty per Bag</label>
              <input
                type="number" min={1}
                value={editForm.size}
                onChange={e => setEditForm({ ...editForm, size: e.target.value })}
                style={{ ...inputStyle, width: 160 }}
                autoFocus
              />
              {editTarget.default_bag_size != null && (
                <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--t3)' }}>
                  current: <strong style={{ color: 'var(--t2)' }}>{editTarget.default_bag_size}</strong>
                </span>
              )}
            </div>
            <div>
              <label style={labelStyle}>
                Reason {editTarget.default_bag_size != null ? <span style={{ color: '#ff7070' }}>*</span> : <span style={{ color: 'var(--t3)' }}>(optional on first set)</span>}
              </label>
              <input
                type="text"
                value={editForm.reason}
                onChange={e => setEditForm({ ...editForm, reason: e.target.value })}
                placeholder="e.g. supplier changed packaging…"
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>
            <div>
              <label style={labelStyle}>Notes (optional)</label>
              <textarea
                rows={2}
                value={editForm.notes}
                onChange={e => setEditForm({ ...editForm, notes: e.target.value })}
                style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
              <button onClick={() => { setEditTarget(null); setEditForm(null); }} style={btnSecondary} disabled={saving}>CANCEL</button>
              <button onClick={saveEdit} style={btnPrimary} disabled={saving}>{saving ? 'SAVING…' : 'SAVE'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Add modal */}
      {addOpen && (
        <Modal open onClose={() => setAddOpen(false)} size="md" title="Add bag-size default">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={labelStyle}>Part Code</label>
              <input
                type="text"
                value={addForm.part_code}
                onChange={e => setAddForm({ ...addForm, part_code: e.target.value })}
                placeholder="e.g. UNV-PP-NEW-01"
                style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }}
                autoFocus
              />
            </div>
            <div>
              <label style={labelStyle}>Default Qty per Bag</label>
              <input
                type="number" min={1}
                value={addForm.size}
                onChange={e => setAddForm({ ...addForm, size: e.target.value })}
                style={{ ...inputStyle, width: 160 }}
              />
            </div>
            <div>
              <label style={labelStyle}>Notes (optional)</label>
              <textarea
                rows={2}
                value={addForm.notes}
                onChange={e => setAddForm({ ...addForm, notes: e.target.value })}
                style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
              <button onClick={() => setAddOpen(false)} style={btnSecondary} disabled={saving}>CANCEL</button>
              <button onClick={saveAdd} style={btnPrimary} disabled={saving}>{saving ? 'SAVING…' : 'ADD'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* History modal */}
      {historyTarget && (
        <Modal open onClose={() => { setHistoryTarget(null); setHistory([]); }} size="lg" title={`History · ${historyTarget}`}>
          {histLoading ? <Spinner /> : history.length === 0 ? (
            <EmptyState title="No history" message="This part has no change history yet." />
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={tableThStyle}>When</th>
                  <th style={tableThStyle}>Source</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}>From</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}>To</th>
                  <th style={tableThStyle}>By</th>
                  <th style={tableThStyle}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.id}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10 }}>{fmtTs(h.changed_at)}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>{h.source}</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{h.old_size != null ? h.old_size : '—'}</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 700 }}>{h.new_size}</td>
                    <td style={{ ...tableTdStyle, fontSize: 11 }}>{h.changed_by_name || (h.changed_by ? h.changed_by.slice(0, 8) : '—')}</td>
                    <td style={{ ...tableTdStyle, color: 'var(--t2)' }}>{h.change_reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </div>
  );
}
