'use client';
/* ════════════════════════════════════════════════════════════
   BOX TYPES — Setup › Box Types. The carton library the floor
   picks from when it seals a bulk box.

   Padmajit (2026-08-12): operators are asked for box dimensions
   every time a consignment is raised with the courier partner.
   Capturing it at box close removes that back-and-forth.

   THE RULES THAT SHAPE THIS PAGE (Afshaan, 2026-08-14):
   • A box type is a NAME plus three NUMBERS (L/W/H in cm). Nothing
     else. There is no free-text dimension anywhere in the system,
     so there is nothing to parse and no unit to get wrong.
   • NO CAPACITY. How many units a carton holds depends on the size
     of the inner box going into it, so it cannot be a property of
     the carton. Per-shipment capacity stays on the shipment.
   • CREATION IS A DEPOT ACTION, adherence is the scanner's. The
     floor selects from this list and can never add to it — which
     makes this page's completeness load-bearing. An unlisted
     carton leaves the packer with only "skip", so add sizes here
     the moment they appear on the floor.
   • Retire, never delete. A retired type drops off the floor
     picker but shipments already packed in it still read correctly.
   ════════════════════════════════════════════════════════════ */
import { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import {
  Icon, Panel, btnPrimary, btnGhost, inputStyle,
} from '../../../components/kit/index.js';

const COLS = 'minmax(140px,1.3fr) 90px 90px 90px 130px 90px 90px';

function num(v) {
  const n = parseFloat(v);
  return (isFinite(n) && n > 0) ? n : null;
}

export default function BoxTypesPage() {
  const { userId, session } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [types,    setTypes]    = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [toggling, setToggling] = useState({});

  const [formMode,  setFormMode]  = useState(null);   // null | 'new' | type object
  const [name,      setName]      = useState('');
  const [len,       setLen]       = useState('');
  const [wid,       setWid]       = useState('');
  const [hgt,       setHgt]       = useState('');
  const [formError, setFormError] = useState('');
  const [saving,    setSaving]    = useState(false);

  async function loadTypes() {
    setLoading(true);
    setRefreshing(true);
    try {
      const data = await garageFetch('getBoxTypes', {}, session);
      setTypes(Array.isArray(data) ? data : []);
    } catch (_) {
      setTypes([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(new Date());
    }
  }

  // Keyed on userId, never the session object: a token refresh lands roughly
  // hourly and would otherwise reload the list out from under an open form.
  useEffect(() => { loadTypes(); /* eslint-disable-next-line */ }, [userId]);

  function openNew() {
    setFormMode('new');
    setName(''); setLen(''); setWid(''); setHgt(''); setFormError('');
  }

  function openEdit(t) {
    setFormMode(t);
    setName(t.name || '');
    setLen(String(t.length_cm ?? ''));
    setWid(String(t.width_cm ?? ''));
    setHgt(String(t.height_cm ?? ''));
    setFormError('');
  }

  async function submitForm() {
    if (!name.trim()) { setFormError('Name is required'); return; }
    const l = num(len), w = num(wid), h = num(hgt);
    if (l === null || w === null || h === null) {
      setFormError('Length, width and height must each be a number greater than zero');
      return;
    }
    setSaving(true); setFormError('');
    try {
      if (formMode === 'new') {
        await workerFetch('createBoxType', {
          name: name.trim(), length_cm: l, width_cm: w, height_cm: h,
        }, session);
        showToast('Box type added', 'success');
      } else {
        await workerFetch('updateBoxType', {
          box_type_id: formMode.id,
          name: name.trim(), length_cm: l, width_cm: w, height_cm: h,
        }, session);
        showToast('Box type updated', 'success');
      }
      setFormMode(null);
      await loadTypes();
    } catch (e) {
      setFormError(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(t) {
    const next = t.is_active === false;
    setToggling(prev => ({ ...prev, [t.id]: true }));
    try {
      await workerFetch('setBoxTypeActive', { box_type_id: t.id, is_active: next }, session);
      showToast(`${t.name} ${next ? 'back in use' : 'retired'}`, 'success');
      await loadTypes();
    } catch (e) {
      showToast(e.message || 'Failed to update box type', 'error');
    } finally {
      setToggling(prev => ({ ...prev, [t.id]: false }));
    }
  }

  const liveCount = types.filter(t => t.is_active !== false).length;

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <style>{`.rl-bt-row:hover { background: var(--surface-2); }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)' }}>
          Carton library · the floor picks from this list when it seals a bulk box. Sizes in cm.
        </span>
        <div style={{ flex: 1 }} />
        {!formMode && (
          <button style={btnPrimary} onClick={openNew}>
            <Icon name="plus" size={15} /> Add Box Type
          </button>
        )}
      </div>

      {/* The one thing that can quietly break this feature. */}
      {!loading && liveCount === 0 && (
        <Panel pad={16} style={{ marginBottom: 18, borderColor: 'var(--bad-fg)' }}>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t1)', lineHeight: 1.7 }}>
            <strong>No box types are in use.</strong> The floor has nothing to pick from, so every
            bulk box will close without dimensions and the courier team will keep asking. Add the
            cartons in use to fix it.
          </div>
        </Panel>
      )}

      {formMode && (
        <Panel
          title={formMode === 'new' ? 'New box type' : `Edit · ${formMode.name}`}
          icon="box" pad={18}
          style={{ marginBottom: 18, borderColor: 'var(--yellow)' }}
          action={
            <button onClick={() => setFormMode(null)} style={{ ...btnGhost, padding: '5px 11px', fontSize: 12 }} disabled={saving}>
              <Icon name="x" size={13} /> Cancel
            </button>
          }
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 7 }}>Name <span style={{ color: 'var(--bad-fg)' }}>*</span></div>
              <input style={inputStyle} value={name} onChange={e => setName(e.target.value)}
                placeholder="e.g. N1135U, Master Carton" />
            </div>
            {[['Length', len, setLen], ['Width', wid, setWid], ['Height', hgt, setHgt]].map(([label, val, set]) => (
              <div key={label}>
                <div className="eyebrow" style={{ marginBottom: 7 }}>{label} (cm) <span style={{ color: 'var(--bad-fg)' }}>*</span></div>
                <input style={inputStyle} value={val} inputMode="decimal"
                  onChange={e => set(e.target.value)} placeholder="0.0" />
              </div>
            ))}
          </div>

          {formMode !== 'new' && (
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)', marginBottom: 14, lineHeight: 1.6 }}>
              Boxes already packed in this carton keep the dimensions recorded at the time — correcting
              a size here never rewrites what was already declared to a courier.
            </div>
          )}

          {formError && (
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--bad-fg)', marginBottom: 14 }}>{formError}</div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button onClick={() => setFormMode(null)} style={btnGhost} disabled={saving}>Cancel</button>
            <button onClick={submitForm} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.5 : 1 }}>
              {saving ? 'Saving…' : (formMode === 'new' ? 'Add Box Type' : 'Save Changes')}
            </button>
          </div>
        </Panel>
      )}

      <Panel pad={8}>
        {loading && types.length === 0 ? (
          <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : types.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)' }}>
            No box types yet.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, padding: '4px 12px 9px',
              borderBottom: '1px solid var(--border)', minWidth: 760 }}>
              {['Box', 'Length', 'Width', 'Height', 'L×W×H', 'In use', 'Actions'].map(h => (
                <div key={h} className="eyebrow">{h}</div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {types.map((t, i) => {
                const retired = t.is_active === false;
                return (
                  <div key={t.id} className="rl-bt-row" style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12,
                    alignItems: 'center', padding: '11px 12px', borderTop: i ? '1px solid var(--border)' : 'none',
                    minWidth: 760, opacity: retired ? 0.55 : 1, transition: 'background var(--fast) var(--ease)' }}>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--t1)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.name}{retired && <span style={{ color: 'var(--t3)', fontWeight: 400 }}> · retired</span>}
                    </span>
                    {['length_cm', 'width_cm', 'height_cm'].map(k => (
                      <span key={k} className="num" style={{ fontSize: 12.5, color: 'var(--t2)' }}>{t[k]}</span>
                    ))}
                    <span className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>
                      {t.length_cm}×{t.width_cm}×{t.height_cm}
                    </span>
                    <button
                      onClick={() => toggleActive(t)}
                      disabled={!!toggling[t.id]}
                      title={retired ? 'Put back in use' : 'Retire — hides it from the floor picker, keeps the history'}
                      style={{ justifySelf: 'start', width: 38, height: 22, borderRadius: 'var(--r-full)', border: 'none',
                        cursor: toggling[t.id] ? 'default' : 'pointer', position: 'relative',
                        background: !retired ? 'var(--ok-fg)' : 'var(--surface-3)',
                        opacity: toggling[t.id] ? 0.6 : 1, transition: 'background var(--fast)' }}
                    >
                      <span style={{ position: 'absolute', top: 2, left: !retired ? 18 : 2, width: 18, height: 18,
                        borderRadius: '50%', background: '#fff', transition: 'left var(--fast)' }} />
                    </button>
                    <span>
                      <button onClick={() => openEdit(t)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
                        background: 'transparent', border: '1px solid var(--yellow)', color: 'var(--yellow)',
                        borderRadius: 'var(--r-xs)', padding: '4px 11px', fontFamily: 'var(--font-ui)',
                        fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
                        <Icon name="edit" size={12} /> Edit
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
