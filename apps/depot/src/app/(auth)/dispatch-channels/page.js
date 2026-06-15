'use client';
/* ════════════════════════════════════════════════════════════
   CHANNELS — Setup › Channels (Pit Wall v2 reskin of the
   Channels tab in redesign-reference/app/setup.jsx). Master list
   of dispatch channels: type · fulfilment · sale flag · active
   toggle, plus the add/edit form. All data actions
   (getDispatchChannels, createChannel, updateChannel) kept
   exactly as before — visual layer only. The row toggle uses the
   same updateChannel action + parameters as the edit form.
   ════════════════════════════════════════════════════════════ */
import { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import {
  Icon, Panel, btnPrimary, btnGhost, inputStyle,
} from '../../../components/kit/index.js';

// ── Helpers ───────────────────────────────────────────────────
function TypeChip({ type }) {
  const t = (type || 'other').toLowerCase();
  const fg = t === 'ecom' ? 'var(--blue-bright)' : t === 'retail' ? 'var(--yellow)' : 'var(--t3)';
  const bg = t === 'ecom' ? 'var(--info-bg)' : t === 'retail' ? 'var(--brand-bg)' : 'var(--surface-2)';
  return (
    <span className="num" style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
      color: fg, background: bg, borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap' }}>
      {type || '—'}
    </span>
  );
}

const selectStyle = {
  background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
  padding: '9px 12px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13,
  outline: 'none', cursor: 'pointer',
};

const COLS = 'minmax(150px,1.4fr) 80px 130px 90px 90px 90px';

// ── Channel Master Page ───────────────────────────────────────
export default function DispatchChannelsPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [channels, setChannels] = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [toggling, setToggling] = useState({});   // { [channel_id]: true }

  const [formMode,    setFormMode]    = useState(null);   // null | 'new' | channel object
  const [name,        setName]        = useState('');
  const [type,        setType]        = useState('ecom');
  const [fulfillment, setFulfillment] = useState('unit');
  const [isSale,      setIsSale]      = useState(true);
  const [isActive,    setIsActive]    = useState(true);
  const [formError,   setFormError]   = useState('');
  const [saving,      setSaving]      = useState(false);

  async function loadChannels() {
    if (!session) return;
    setLoading(true);
    setRefreshing(true);
    try {
      const data = await garageFetch('getDispatchChannels', {}, session);
      setChannels(Array.isArray(data) ? data : []);
    } catch (_) {
      setChannels([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(new Date());
    }
  }

  useEffect(() => { loadChannels(); /* eslint-disable-next-line */ }, [session]);

  function openNew() {
    setFormMode('new');
    setName(''); setType('ecom'); setFulfillment('unit');
    setIsSale(true); setIsActive(true); setFormError('');
  }

  function openEdit(c) {
    setFormMode(c);
    setName(c.name || '');
    setType(c.type || 'ecom');
    setFulfillment(c.fulfillment_model || 'unit');
    setIsSale(!!c.is_sale);
    setIsActive(c.is_active !== false);
    setFormError('');
  }

  async function submitForm() {
    if (!name.trim()) { setFormError('Name is required'); return; }
    setSaving(true); setFormError('');
    try {
      if (formMode === 'new') {
        await workerFetch('createChannel', {
          name: name.trim(), type, fulfillment_model: fulfillment, is_sale: isSale,
        }, session);
        showToast('Channel added', 'success');
      } else {
        await workerFetch('updateChannel', {
          channel_id: formMode.id,
          name: name.trim(), type, fulfillment_model: fulfillment,
          is_sale: isSale, is_active: isActive,
        }, session);
        showToast('Channel updated', 'success');
      }
      setFormMode(null);
      await loadChannels();
    } catch (e) {
      setFormError(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  // Row-level active toggle — same updateChannel action + parameter set as
  // the edit form, just flipping is_active for one channel.
  async function toggleActive(c) {
    const next = c.is_active === false;
    setToggling(prev => ({ ...prev, [c.id]: true }));
    try {
      await workerFetch('updateChannel', {
        channel_id: c.id,
        name: c.name, type: c.type, fulfillment_model: c.fulfillment_model,
        is_sale: !!c.is_sale, is_active: next,
      }, session);
      showToast(`${c.name} ${next ? 'activated' : 'deactivated'}`, 'success');
      await loadChannels();
    } catch (e) {
      showToast(e.message || 'Failed to update channel', 'error');
    } finally {
      setToggling(prev => ({ ...prev, [c.id]: false }));
    }
  }

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <style>{`.rl-ch-row:hover { background: var(--surface-2); }`}</style>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)' }}>
          Channel master · feeds dispatch + reporting. Done-once setup, out of the daily flow.
        </span>
        <div style={{ flex: 1 }} />
        {!formMode && (
          <button style={btnPrimary} onClick={openNew}>
            <Icon name="plus" size={15} /> Add Channel
          </button>
        )}
      </div>

      {/* Inline form */}
      {formMode && (
        <Panel
          title={formMode === 'new' ? 'New channel' : `Edit · ${formMode.name}`}
          icon="send" pad={18}
          style={{ marginBottom: 18, borderColor: 'var(--yellow)' }}
          action={
            <button onClick={() => setFormMode(null)} style={{ ...btnGhost, padding: '5px 11px', fontSize: 12 }} disabled={saving}>
              <Icon name="x" size={13} /> Cancel
            </button>
          }
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 7 }}>Name <span style={{ color: 'var(--bad-fg)' }}>*</span></div>
              <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Amazon, Flipkart, BOM Bulk" />
            </div>
            <div>
              <div className="eyebrow" style={{ marginBottom: 7 }}>Type</div>
              <select style={{ ...selectStyle, width: '100%' }} value={type} onChange={e => setType(e.target.value)}>
                <option value="ecom">Ecom</option>
                <option value="retail">Retail</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 7 }}>Fulfilment model</div>
              <select style={{ ...selectStyle, width: '100%' }} value={fulfillment} onChange={e => setFulfillment(e.target.value)}>
                <option value="unit">Unit (per-unit dispatch)</option>
                <option value="bulk">Bulk (warehouse transfer)</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', cursor: 'pointer' }}>
                <input type="checkbox" checked={isSale} onChange={e => setIsSale(e.target.checked)} />
                Generates revenue (sale channel)
              </label>
              {formMode !== 'new' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
                  Active
                </label>
              )}
            </div>
          </div>

          {formError && (
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--bad-fg)', marginBottom: 14 }}>{formError}</div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button onClick={() => setFormMode(null)} style={btnGhost} disabled={saving}>Cancel</button>
            <button
              onClick={submitForm}
              disabled={saving}
              style={{ ...btnPrimary, opacity: saving ? 0.5 : 1 }}
            >
              {saving ? 'Saving…' : (formMode === 'new' ? 'Add Channel' : 'Save Changes')}
            </button>
          </div>
        </Panel>
      )}

      {/* Channel list */}
      <Panel pad={8}>
        {loading && channels.length === 0 ? (
          <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : channels.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)' }}>
            No channels yet.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, padding: '4px 12px 9px',
              borderBottom: '1px solid var(--border)', minWidth: 700 }}>
              {['Channel', 'Type', 'Fulfilment', 'Sale', 'Active', 'Actions'].map(h => (
                <div key={h} className="eyebrow">{h}</div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {channels.map((c, i) => {
                const inactive = c.is_active === false;
                return (
                  <div key={c.id} className="rl-ch-row" style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12,
                    alignItems: 'center', padding: '11px 12px', borderTop: i ? '1px solid var(--border)' : 'none',
                    minWidth: 700, opacity: inactive ? 0.55 : 1, transition: 'background var(--fast) var(--ease)' }}>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--t1)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                    <span style={{ justifySelf: 'start' }}><TypeChip type={c.type} /></span>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>{c.fulfillment_model || '—'}</span>
                    <span className="num" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                      color: c.is_sale ? 'var(--ok-fg)' : 'var(--t3)' }}>
                      {c.is_sale ? 'Sale' : 'Cost'}
                    </span>
                    <button
                      onClick={() => toggleActive(c)}
                      disabled={!!toggling[c.id]}
                      title={inactive ? 'Activate channel' : 'Deactivate channel'}
                      style={{ justifySelf: 'start', width: 38, height: 22, borderRadius: 'var(--r-full)', border: 'none',
                        cursor: toggling[c.id] ? 'default' : 'pointer', position: 'relative',
                        background: !inactive ? 'var(--ok-fg)' : 'var(--surface-3)',
                        opacity: toggling[c.id] ? 0.6 : 1, transition: 'background var(--fast)' }}
                    >
                      <span style={{ position: 'absolute', top: 2, left: !inactive ? 18 : 2, width: 18, height: 18,
                        borderRadius: '50%', background: '#fff', transition: 'left var(--fast)' }} />
                    </button>
                    <span>
                      <button onClick={() => openEdit(c)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
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
