'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, tableThStyle, tableTdStyle, inputStyle, selectStyle, labelStyle,
  btnPrimary, btnSecondary, pageH1, pageSub, StatusBadge,
} from '@/lib/snorkelui';

export default function SalesSettingsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [channels, setChannels] = useState([]);
  const [dispatch, setDispatch] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState({ channel_key: '', label: '', dispatch_channel_id: '', sort_order: 0 });

  const canManage = !!perms?.sales_partner_manage;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [c, dc] = await Promise.all([
        garageFetch('getSalesChannels', { all: '1' }, session),
        garageFetch('getDispatchChannels', {}, session),
      ]);
      setChannels(Array.isArray(c) ? c : []);
      setDispatch(Array.isArray(dc) ? dc : []);
    } catch (e) { showToast(e.message || 'Failed to load', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  if (perms && !perms.sales_partner_manage) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  const dcName = (id) => dispatch.find(d => d.id === id)?.name || (id ? '(unknown)' : '—');

  async function patchChannel(id, patch) {
    setBusy(true);
    try {
      const res = await workerFetch('updateSalesChannel', { data: { id, ...patch } }, session);
      if (!res.ok) throw new Error(res.error || 'Failed');
      await load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  async function addChannel() {
    if (!adding.channel_key.trim() || !adding.label.trim()) { showToast('Key and label required', 'error'); return; }
    setBusy(true);
    try {
      const res = await workerFetch('createSalesChannel', { data: adding }, session);
      if (!res.ok) throw new Error(res.error || 'Failed');
      showToast('Channel added', 'success');
      setAdding({ channel_key: '', label: '', dispatch_channel_id: '', sort_order: 0 });
      await load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={pageH1}>Sales Channels</h1>
        <p style={pageSub}>Offline channels (GT / MT / …) and which dispatch channel each hands off to.</p>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Channels</span><button style={btnSecondary} onClick={load} disabled={loading}>↻ Refresh</button></div>
        {loading ? (
          <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Key</th><th style={tableThStyle}>Label</th>
              <th style={tableThStyle}>Dispatch channel</th><th style={{ ...tableThStyle, textAlign: 'right' }}>Sort</th><th style={tableThStyle}>Active</th>
            </tr></thead>
            <tbody>
              {channels.map(c => (
                <tr key={c.id}>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{c.channel_key}</td>
                  <td style={tableTdStyle}>{c.label}</td>
                  <td style={tableTdStyle}>
                    {canManage ? (
                      <select style={{ ...selectStyle, minWidth: 160 }} value={c.dispatch_channel_id || ''} onChange={e => patchChannel(c.id, { dispatch_channel_id: e.target.value || null })} disabled={busy}>
                        <option value="">— none —</option>
                        {dispatch.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    ) : dcName(c.dispatch_channel_id)}
                  </td>
                  <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{c.sort_order}</td>
                  <td style={tableTdStyle}>
                    {canManage ? (
                      <button style={btnSecondary} onClick={() => patchChannel(c.id, { is_active: !c.is_active })} disabled={busy}>
                        <StatusBadge label={c.is_active ? 'Active' : 'Inactive'} tone={c.is_active ? 'green' : 'gray'} />
                      </button>
                    ) : <StatusBadge label={c.is_active ? 'Active' : 'Inactive'} tone={c.is_active ? 'green' : 'gray'} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canManage && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Add channel</span></div>
          <div style={{ ...panelBodyStyle, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div><label style={labelStyle}>Key</label><input style={{ ...inputStyle, width: 90, fontFamily: 'var(--mono)' }} value={adding.channel_key} onChange={e => setAdding(a => ({ ...a, channel_key: e.target.value.toUpperCase() }))} placeholder="GT" /></div>
            <div><label style={labelStyle}>Label</label><input style={{ ...inputStyle, width: 180 }} value={adding.label} onChange={e => setAdding(a => ({ ...a, label: e.target.value }))} placeholder="General Trade" /></div>
            <div><label style={labelStyle}>Dispatch channel</label>
              <select style={{ ...selectStyle, minWidth: 160 }} value={adding.dispatch_channel_id} onChange={e => setAdding(a => ({ ...a, dispatch_channel_id: e.target.value }))}>
                <option value="">— none —</option>
                {dispatch.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div><label style={labelStyle}>Sort</label><input type="number" style={{ ...inputStyle, width: 70 }} value={adding.sort_order} onChange={e => setAdding(a => ({ ...a, sort_order: e.target.value }))} /></div>
            <button style={btnPrimary} onClick={addChannel} disabled={busy}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}
