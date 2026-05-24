'use client';
import { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel, Chip, StatusBadge, useToast } from '@throttle/ui';

// ── Helpers ───────────────────────────────────────────────────
const CHANNEL_TYPE_STYLE = {
  ecom:   { color: 'var(--blue)',   bg: 'rgba(33,60,226,.15)'  },
  retail: { color: 'var(--yellow)', bg: 'rgba(242,205,26,.1)'  },
  other:  { color: 'var(--t2)',     bg: 'rgba(255,255,255,.06)' },
};

function ChannelTypeBadge({ type }) {
  const t = (type || 'other').toLowerCase();
  const variant = t === 'ecom' ? 'info' : t === 'retail' ? 'brand' : 'neutral';
  return <StatusBadge variant={variant}>{type || '—'}</StatusBadge>;
}

// ── Channel Master Page ───────────────────────────────────────
export default function DispatchChannelsPage() {
  const { session } = useAuth();
  const { showToast } = useToast();

  const [channels, setChannels] = useState([]);
  const [loading,  setLoading]  = useState(false);

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
    try {
      const data = await garageFetch('getDispatchChannels', {}, session);
      setChannels(Array.isArray(data) ? data : []);
    } catch (_) {
      setChannels([]);
    } finally {
      setLoading(false);
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

  // ── Style constants ───────────────────────────────────────
  const inputStyle = { background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '8px 12px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 13, outline: 'none' };
  const selectStyle = { background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--t1)', fontFamily: 'var(--mono)', fontSize: 13, padding: '8px 12px', borderRadius: 3, outline: 'none', cursor: 'pointer' };
  const labelStyle = { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase', display: 'block', marginBottom: 8 };
  const sectionLabel = { margin: 0, fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)' };
  const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
  const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap', color: 'var(--t1)' };

  const primaryBtnStyle = {
    padding: '8px 14px', background: 'var(--yellow)', color: '#0a0a0a',
    border: '1px solid var(--yellow)', borderRadius: 3,
    fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700,
    letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
  };
  const secondaryBtnStyle = {
    padding: '8px 14px', background: 'transparent', border: '1px solid var(--border)',
    borderRadius: 3, color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer',
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <h2 style={sectionLabel}>Channel Master</h2>
        <div style={{ flex: 1 }} />
        {!formMode && (
          <button style={primaryBtnStyle} onClick={openNew}>+ Add Channel</button>
        )}
      </div>

      {/* Inline form */}
      {formMode && (
        <div style={{ background: 'var(--surface2)', border: '1px solid var(--yellow)', borderRadius: 4, padding: 18, marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ ...sectionLabel, color: 'var(--yellow)' }}>
              {formMode === 'new' ? 'New Channel' : `Edit ${formMode.name}`}
            </h3>
            <div style={{ flex: 1 }} />
            <button onClick={() => setFormMode(null)} style={secondaryBtnStyle}>× Cancel</button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={labelStyle}>Name <span style={{ color: 'var(--red)' }}>*</span></label>
              <input style={{ ...inputStyle, width: '100%' }} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Amazon, Flipkart, BOM Bulk" />
            </div>
            <div>
              <label style={labelStyle}>Type</label>
              <select style={{ ...selectStyle, width: '100%' }} value={type} onChange={e => setType(e.target.value)}>
                <option value="ecom">Ecom</option>
                <option value="retail">Retail</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={labelStyle}>Fulfillment Model</label>
              <select style={{ ...selectStyle, width: '100%' }} value={fulfillment} onChange={e => setFulfillment(e.target.value)}>
                <option value="unit">Unit (per-unit dispatch)</option>
                <option value="bulk">Bulk (warehouse transfer)</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)', fontFamily: 'var(--mono)', cursor: 'pointer' }}>
                <input type="checkbox" checked={isSale} onChange={e => setIsSale(e.target.checked)} />
                Generates revenue (sale channel)
              </label>
              {formMode !== 'new' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)', fontFamily: 'var(--mono)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
                  Active
                </label>
              )}
            </div>
          </div>

          {formError && (
            <div style={{ color: '#ff7070', fontFamily: 'var(--mono)', fontSize: 12, marginBottom: 12 }}>{formError}</div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => setFormMode(null)} style={secondaryBtnStyle} disabled={saving}>Cancel</button>
            <button
              onClick={submitForm}
              disabled={saving}
              style={{ ...primaryBtnStyle, opacity: saving ? 0.5 : 1 }}
            >
              {saving ? 'Saving…' : (formMode === 'new' ? 'Add Channel' : 'Save Changes')}
            </button>
          </div>
        </div>
      )}

      {/* Channel list */}
      <Panel padding={0}>
        {loading && channels.length === 0 ? (
          <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : channels.length === 0 ? (
          <EmptyState icon="📡" message="No channels yet" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Channel','Type','Fulfillment','Is Sale','Active','Actions'].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {channels.map(c => {
                  const inactive = c.is_active === false;
                  return (
                    <tr key={c.id} style={{ opacity: inactive ? 0.45 : 1 }}>
                      <td style={{ ...tdStyle, fontFamily: 'var(--cond)', fontWeight: 700, color: 'var(--t1)', letterSpacing: '0.04em' }}>{c.name}</td>
                      <td style={tdStyle}><ChannelTypeBadge type={c.type} /></td>
                      <td style={{ ...tdStyle, color: 'var(--t2)' }}>{c.fulfillment_model || '—'}</td>
                      <td style={tdStyle}>
                        {c.is_sale
                          ? <StatusBadge variant="success" icon="●">Sale</StatusBadge>
                          : <StatusBadge variant="neutral" icon="●">Cost</StatusBadge>}
                      </td>
                      <td style={tdStyle}>
                        {!inactive
                          ? <StatusBadge variant="success">Active</StatusBadge>
                          : <StatusBadge variant="neutral">Inactive</StatusBadge>}
                      </td>
                      <td style={tdStyle}>
                        <button
                          onClick={() => openEdit(c)}
                          style={{
                            padding: '5px 11px', background: 'transparent',
                            border: '1px solid var(--yellow)', borderRadius: 3,
                            color: 'var(--yellow)', fontFamily: 'var(--mono)',
                            fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
                            textTransform: 'uppercase', cursor: 'pointer',
                          }}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
