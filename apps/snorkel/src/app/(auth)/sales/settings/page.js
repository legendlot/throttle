'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { labelStyle } from '@/lib/snorkelui';
import { PageHead, Panel, Badge, Btn } from '@/components/ui.js';

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
    return <div style={{ padding: 24, color: 'var(--text-3)' }}>Access restricted.</div>;
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
    <div className="pg">
      <PageHead title="Sales Channels" sub="Offline channels (GT / MT and more) and which dispatch channel each hands off to." />

      <Panel title="Channels" count={channels.length}
        action={<Btn onClick={load} disabled={loading}>Refresh</Btn>}>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : (
            <table className="dt">
              <thead><tr><th>Key</th><th>Label</th><th>Dispatch channel</th><th className="num">Sort</th><th>Status</th></tr></thead>
              <tbody>
                {channels.map(c => (
                  <tr key={c.id} style={{ opacity: c.is_active ? 1 : 0.55 }}>
                    <td><Badge label={c.channel_key} tone="blue" /></td>
                    <td>{c.label}</td>
                    <td className="dim">
                      {canManage ? (
                        <select className="sel" value={c.dispatch_channel_id || ''} onChange={e => patchChannel(c.id, { dispatch_channel_id: e.target.value || null })} disabled={busy} style={{ minWidth: 160 }}>
                          <option value="">— none —</option>
                          {dispatch.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      ) : dcName(c.dispatch_channel_id)}
                    </td>
                    <td className="num mono">{c.sort_order}</td>
                    <td>
                      {canManage
                        ? <button className="badge-btn" onClick={() => patchChannel(c.id, { is_active: !c.is_active })} disabled={busy}><Badge label={c.is_active ? 'Active' : 'Inactive'} tone={c.is_active ? 'green' : 'gray'} dot /></button>
                        : <Badge label={c.is_active ? 'Active' : 'Inactive'} tone={c.is_active ? 'green' : 'gray'} dot />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Panel>

      {canManage && (
        <Panel title="Add channel" pad>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div><label style={labelStyle}>Key</label><input className="f-inp mono" style={{ width: 90 }} value={adding.channel_key} onChange={e => setAdding(a => ({ ...a, channel_key: e.target.value.toUpperCase() }))} placeholder="GT" /></div>
            <div><label style={labelStyle}>Label</label><input className="f-inp" style={{ width: 180 }} value={adding.label} onChange={e => setAdding(a => ({ ...a, label: e.target.value }))} placeholder="General Trade" /></div>
            <div><label style={labelStyle}>Dispatch channel</label>
              <select className="sel f-inp" style={{ minWidth: 160 }} value={adding.dispatch_channel_id} onChange={e => setAdding(a => ({ ...a, dispatch_channel_id: e.target.value }))}>
                <option value="">— none —</option>
                {dispatch.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div><label style={labelStyle}>Sort</label><input type="number" className="f-inp mono" style={{ width: 70 }} value={adding.sort_order} onChange={e => setAdding(a => ({ ...a, sort_order: e.target.value }))} /></div>
            <Btn kind="primary" onClick={addChannel} disabled={busy}>Add</Btn>
          </div>
        </Panel>
      )}
    </div>
  );
}
