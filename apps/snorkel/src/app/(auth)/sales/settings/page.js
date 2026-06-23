'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { labelStyle } from '@/lib/snorkelui';
import { PageHead, Panel, Badge, Btn } from '@/components/ui.js';

// Channel taxonomy — `general_trade`/`modern_trade` are our sell-out signal (feeds Odo);
// quick-commerce / marketplace are sell-in (primary) and stay off the Odo sell-out feed.
const CHANNEL_TYPES = [
  ['', '—'],
  ['general_trade', 'General Trade'],
  ['modern_trade', 'Modern Trade'],
  ['quick_commerce', 'Quick Commerce'],
  ['marketplace', 'Marketplace'],
  ['other', 'Other'],
];
const typeLabel = (t) => (CHANNEL_TYPES.find(([v]) => v === t) || [, t || '—'])[1];

export default function SalesSettingsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [channels, setChannels] = useState([]);
  const [dispatch, setDispatch] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState({
    channel_key: '', label: '', dispatch_channel_id: '', sort_order: 0,
    channel_type: '', collection_type: 'auto', collection_period_days: '', feeds_odo_sellout: false,
  });

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
      const res = await workerFetch('createSalesChannel', { data: {
        ...adding,
        collection_period_days: adding.collection_type === 'auto' && adding.collection_period_days !== ''
          ? Number(adding.collection_period_days) : null,
      } }, session);
      if (!res.ok) throw new Error(res.error || 'Failed');
      showToast('Channel added', 'success');
      setAdding({
        channel_key: '', label: '', dispatch_channel_id: '', sort_order: 0,
        channel_type: '', collection_type: 'auto', collection_period_days: '', feeds_odo_sellout: false,
      });
      await load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div className="pg">
      <PageHead title="Sales Channels" sub="Offline & marketplace channels — which dispatch channel each hands off to, how collections are timed, and whether it counts as a sell-out in Odo." />

      <Panel title="Channels" count={channels.length}
        action={<Btn onClick={load} disabled={loading}>Refresh</Btn>}>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : (
            <table className="dt">
              <thead><tr>
                <th>Key</th><th>Label</th><th>Dispatch channel</th><th>Type</th>
                <th>Collection</th><th>Sell-out</th><th className="num">Sort</th><th>Status</th>
              </tr></thead>
              <tbody>
                {channels.map(c => (
                  <tr key={c.id} style={{ opacity: c.is_active ? 1 : 0.55 }}>
                    <td><Badge label={c.channel_key} tone="blue" /></td>
                    <td>{c.label}</td>
                    <td className="dim">
                      {canManage ? (
                        <select className="sel" value={c.dispatch_channel_id || ''} onChange={e => patchChannel(c.id, { dispatch_channel_id: e.target.value || null })} disabled={busy} style={{ minWidth: 150 }}>
                          <option value="">— none —</option>
                          {dispatch.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      ) : dcName(c.dispatch_channel_id)}
                    </td>
                    <td className="dim">
                      {canManage ? (
                        <select className="sel" value={c.channel_type || ''} onChange={e => patchChannel(c.id, { channel_type: e.target.value || null })} disabled={busy} style={{ minWidth: 130 }}>
                          {CHANNEL_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      ) : typeLabel(c.channel_type)}
                    </td>
                    <td className="dim">
                      {canManage ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <select className="sel" value={c.collection_type || 'auto'} onChange={e => patchChannel(c.id, { collection_type: e.target.value })} disabled={busy} style={{ minWidth: 84 }}>
                            <option value="auto">Auto</option>
                            <option value="manual">Manual</option>
                          </select>
                          {(c.collection_type || 'auto') === 'auto' && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              <input type="number" min={0} className="f-inp mono" style={{ width: 56 }}
                                defaultValue={c.collection_period_days ?? ''}
                                key={`${c.id}-${c.collection_period_days}`}
                                placeholder="—"
                                disabled={busy}
                                onBlur={e => {
                                  const raw = e.target.value.trim();
                                  const next = raw === '' ? null : Number(raw);
                                  const cur = c.collection_period_days ?? null;
                                  if (next !== cur) patchChannel(c.id, { collection_period_days: next });
                                }} />
                              <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>d</span>
                            </span>
                          )}
                        </span>
                      ) : (
                        (c.collection_type || 'auto') === 'auto'
                          ? `Auto${c.collection_period_days != null ? ` · ${c.collection_period_days}d` : ''}`
                          : 'Manual'
                      )}
                    </td>
                    <td title="When on, a confirmed order on this channel counts as a sell-out in Odo. Keep on for GT/MT only — quick-commerce & marketplace are sell-in (primary).">
                      {canManage
                        ? <button className="badge-btn" onClick={() => patchChannel(c.id, { feeds_odo_sellout: !c.feeds_odo_sellout })} disabled={busy}><Badge label={c.feeds_odo_sellout ? 'Sell-out' : 'Sell-in'} tone={c.feeds_odo_sellout ? 'green' : 'gray'} dot /></button>
                        : <Badge label={c.feeds_odo_sellout ? 'Sell-out' : 'Sell-in'} tone={c.feeds_odo_sellout ? 'green' : 'gray'} dot />}
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
            <div><label style={labelStyle}>Label</label><input className="f-inp" style={{ width: 160 }} value={adding.label} onChange={e => setAdding(a => ({ ...a, label: e.target.value }))} placeholder="General Trade" /></div>
            <div><label style={labelStyle}>Dispatch channel</label>
              <select className="sel f-inp" style={{ minWidth: 150 }} value={adding.dispatch_channel_id} onChange={e => setAdding(a => ({ ...a, dispatch_channel_id: e.target.value }))}>
                <option value="">— none —</option>
                {dispatch.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div><label style={labelStyle}>Type</label>
              <select className="sel f-inp" style={{ minWidth: 130 }} value={adding.channel_type} onChange={e => setAdding(a => ({ ...a, channel_type: e.target.value }))}>
                {CHANNEL_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div><label style={labelStyle}>Collection</label>
              <select className="sel f-inp" style={{ minWidth: 90 }} value={adding.collection_type} onChange={e => setAdding(a => ({ ...a, collection_type: e.target.value }))}>
                <option value="auto">Auto</option>
                <option value="manual">Manual</option>
              </select>
            </div>
            {adding.collection_type === 'auto' && (
              <div><label style={labelStyle}>Period (d)</label><input type="number" min={0} className="f-inp mono" style={{ width: 80 }} value={adding.collection_period_days} onChange={e => setAdding(a => ({ ...a, collection_period_days: e.target.value }))} placeholder="30" /></div>
            )}
            <div>
              <label style={labelStyle}>Sell-out</label>
              <button className="badge-btn" onClick={() => setAdding(a => ({ ...a, feeds_odo_sellout: !a.feeds_odo_sellout }))} disabled={busy}>
                <Badge label={adding.feeds_odo_sellout ? 'Sell-out' : 'Sell-in'} tone={adding.feeds_odo_sellout ? 'green' : 'gray'} dot />
              </button>
            </div>
            <Btn kind="primary" onClick={addChannel} disabled={busy}>Add</Btn>
          </div>
        </Panel>
      )}
    </div>
  );
}
