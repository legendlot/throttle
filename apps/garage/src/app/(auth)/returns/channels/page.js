'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';

const FULFILMENT_MODELS = [
  { value: 'd2c_marketplace', label: 'D2C Marketplace' },
  { value: 'b2b_wholesale',   label: 'B2B Wholesale' },
  { value: 'quick_commerce',  label: 'Quick Commerce' },
  { value: 'direct_website',  label: 'Direct Website' },
  { value: 'offline_gt',      label: 'Offline — General Trade' },
  { value: 'offline_mt',      label: 'Offline — Modern Trade' },
];

const RETURN_BEHAVIOURS = [
  { value: 'unsegregated', label: 'Unsegregated (mixes UDR + CXR)' },
  { value: 'segregated',   label: 'Segregated (identifies type)' },
];

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.2)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.25)' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)' },
};

function StatusBadge({ label, tone = 'gray' }) {
  const s = TONE_STYLES[tone] || TONE_STYLES.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
      textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{label}</span>
  );
}

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '12px 14px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '7px 14px', fontSize: 12, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

function modelLabel(value) {
  return FULFILMENT_MODELS.find((m) => m.value === value)?.label || value || '—';
}

export default function ChannelsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);

  const [editing, setEditing] = useState(null); // null when creating, channel object when editing
  const [channelId, setChannelId] = useState('');
  const [channelName, setChannelName] = useState('');
  const [platform, setPlatform] = useState('');
  const [model, setModel] = useState('d2c_marketplace');
  const [behaviour, setBehaviour] = useState('unsegregated');
  const [isActive, setIsActive] = useState('true');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getChannels', {}, session);
      setChannels(Array.isArray(data) ? data : []);
      setAvailable(true);
    } catch {
      setChannels([]);
      setAvailable(false);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { load(); }, [load]);

  function clearForm() {
    setEditing(null);
    setChannelId('');
    setChannelName('');
    setPlatform('');
    setModel('d2c_marketplace');
    setBehaviour('unsegregated');
    setIsActive('true');
    setNotes('');
  }

  function startEdit(c) {
    setEditing(c);
    setChannelId(c.channel_id || '');
    setChannelName(c.channel_name || '');
    setPlatform(c.platform || '');
    setModel(c.fulfilment_model || 'd2c_marketplace');
    setBehaviour(c.return_behaviour || 'unsegregated');
    setIsActive(c.is_active === false ? 'false' : 'true');
    setNotes(c.notes || '');
  }

  async function handleSave() {
    if (!channelId.trim()) { showToast('Channel ID required', 'error'); return; }
    if (!channelName.trim()) { showToast('Channel name required', 'error'); return; }
    setSubmitting(true);
    try {
      const res = await workerFetch('upsertReturnChannel', {
        data: {
          channel_id:       channelId.trim().toUpperCase(),
          channel_name:     channelName.trim(),
          platform:         platform || null,
          fulfilment_model: model,
          return_behaviour: behaviour,
          is_active:        isActive === 'true',
          notes:            notes || null,
        },
      }, session);
      const result = res.data || res;
      const action = result.action || (editing ? 'updated' : 'created');
      showToast(`Channel ${result.channel_id || channelId} ${action}`, 'success');
      clearForm();
      load();
    } catch (e) {
      const msg = e.message || '';
      if (/Unknown action|not found|404/i.test(msg)) {
        showToast('Not yet available', 'error');
      } else {
        showToast(msg || 'Save failed', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (perms && !perms.returns) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  const canManage = !!perms?.channel_manage;

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Return Channels
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Channel master — drives shipment receive form &amp; reporting buckets.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: canManage ? 'minmax(0, 0.9fr) minmax(0, 1.1fr)' : '1fr', gap: 16, alignItems: 'start' }}>
        {canManage && (
          <div style={panelStyle}>
            <div style={panelHeaderStyle}><span>{editing ? `Edit Channel — ${editing.channel_id}` : 'Add / Update Channel'}</span></div>
            <div style={panelBodyStyle}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <span style={labelStyle}>Channel ID *</span>
                  <input
                    type="text"
                    value={channelId}
                    onChange={(e) => setChannelId(e.target.value.toUpperCase())}
                    placeholder="AMZ-FLEX"
                    style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }}
                    disabled={submitting || !!editing}
                  />
                </div>
                <div>
                  <span style={labelStyle}>Channel Name *</span>
                  <input type="text" value={channelName} onChange={(e) => setChannelName(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
                </div>
                <div>
                  <span style={labelStyle}>Platform</span>
                  <input type="text" value={platform} onChange={(e) => setPlatform(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
                </div>
                <div>
                  <span style={labelStyle}>Fulfilment Model</span>
                  <select value={model} onChange={(e) => setModel(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submitting}>
                    {FULFILMENT_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
                <div>
                  <span style={labelStyle}>Return Behaviour</span>
                  <select value={behaviour} onChange={(e) => setBehaviour(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submitting}>
                    {RETURN_BEHAVIOURS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                  </select>
                </div>
                <div>
                  <span style={labelStyle}>Status</span>
                  <select value={isActive} onChange={(e) => setIsActive(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submitting}>
                    <option value="true">Active</option>
                    <option value="false">Inactive</option>
                  </select>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <span style={labelStyle}>Notes</span>
                  <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
                <button style={btnSecondary} onClick={clearForm} disabled={submitting}>Clear</button>
                <button
                  style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
                  onClick={handleSave}
                  disabled={submitting}
                >
                  {submitting ? 'Saving…' : 'Save Channel'}
                </button>
              </div>
            </div>
          </div>
        )}

        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>All Channels {channels.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({channels.length})</span>}</span>
            <button style={btnSecondary} onClick={load} disabled={loading}>↻</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {loading ? (
              <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : !available ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>(channels unavailable)</div>
            ) : channels.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No channels yet</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={tableThStyle}>ID</th>
                  <th style={tableThStyle}>Name</th>
                  <th style={tableThStyle}>Platform</th>
                  <th style={tableThStyle}>Model</th>
                  <th style={tableThStyle}>Returns</th>
                  <th style={tableThStyle}>Status</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
                </tr></thead>
                <tbody>
                  {channels.map((c) => (
                    <tr key={c.channel_id}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{c.channel_id}</td>
                      <td style={tableTdStyle}>{c.channel_name}</td>
                      <td style={tableTdStyle}>{c.platform || '—'}</td>
                      <td style={tableTdStyle}><StatusBadge label={modelLabel(c.fulfilment_model)} tone="gray" /></td>
                      <td style={tableTdStyle}>
                        <StatusBadge
                          label={c.return_behaviour || '—'}
                          tone={c.return_behaviour === 'segregated' ? 'green' : 'yellow'}
                        />
                      </td>
                      <td style={tableTdStyle}>
                        <StatusBadge label={c.is_active ? 'Active' : 'Inactive'} tone={c.is_active ? 'green' : 'red'} />
                      </td>
                      <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                        {canManage && <button style={btnSecondary} onClick={() => startEdit(c)}>Edit</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
