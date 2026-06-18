'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { salesGet, salesPost, istDaysAgo } from '../../../lib/api.js';

const RUN_TONE = { ok: 'var(--green)', partial: 'var(--amber)', error: 'var(--red)', running: 'var(--blue)' };

export default function ConnectorsPage() {
  const { session, perms } = useAuth();
  const canManage = !!(perms?.sales_connector_manage || perms?.salesops_admin);
  const canRefresh = !!(perms?.sales_refresh || perms?.salesops_admin);
  const toast = useToast();
  const [data, setData] = useState(null);
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState('');

  const load = () => {
    if (!session) return;
    Promise.all([salesGet('getConnectorStatus', {}, session), salesGet('getRuns', {}, session)])
      .then(([s, r]) => { setData(s); setRuns(r?.runs || []); });
  };
  useEffect(load, [session]);

  const refresh = (id) => { setBusy(id); salesPost('refreshNow', { channel_id: id }, session).then(() => { toast?.showToast?.('Refresh started', 'success'); setTimeout(load, 2500); }).catch(e => toast?.showToast?.(e.message, 'error')).finally(() => setTimeout(() => setBusy(''), 2500)); };
  const backfill = (id) => { const from = prompt('Backfill from date (YYYY-MM-DD):', istDaysAgo(90)); if (!from) return; salesPost('backfill', { channel_id: id, from }, session).then(() => { toast?.showToast?.('Backfill started', 'success'); setTimeout(load, 3000); }).catch(e => toast?.showToast?.(e.message, 'error')); };
  const toggle = (id, enabled) => salesPost('setConnectorEnabled', { channel_id: id, enabled }, session).then(load).catch(e => toast?.showToast?.(e.message, 'error'));

  if (!data) return <Spinner />;
  const secrets = data.secrets || {};
  const secretFor = (kind) => kind === 'shopify' ? secrets.shopify : kind === 'amazon_spapi' ? secrets.amazon : kind === 'flipkart_v3' ? secrets.flipkart : true;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 1080 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: 14 }}>
        {(data.connectors || []).map(c => {
          const r = c.last_run;
          const cfgKnown = !!c.adapter_kind;
          const secretOk = secretFor(c.adapter_kind);
          return (
            <div key={c.channel_id} className="so-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontFamily: 'var(--cond)', fontWeight: 600, fontSize: 15, color: 'var(--t1)' }}>{c.name}</div>
                <span className="so-pill" style={{ background: 'var(--surface2)', color: 'var(--t2)' }}>{c.adapter_kind || 'unconfigured'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                <span className="so-dot" style={{ background: c.enabled ? 'var(--green)' : 'var(--t3)' }} />
                {c.enabled ? 'Enabled' : 'Disabled'}
                {!secretOk && <span style={{ color: 'var(--amber)' }}>· secrets missing</span>}
              </div>
              {r ? (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>
                  Last: <span style={{ color: RUN_TONE[r.status] || 'var(--t2)' }}>{r.status}</span> · {r.rows_fetched ?? 0} rows · {r.facts_upserted ?? 0} facts{r.rows_unmapped ? ` · ${r.rows_unmapped} unmapped` : ''}
                  {r.error && <div style={{ color: 'var(--red)', marginTop: 3 }}>{String(r.error).slice(0, 120)}</div>}
                </div>
              ) : <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>No runs yet</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                {canRefresh && c.enabled && <button className="so-btn" disabled={busy === c.channel_id} onClick={() => refresh(c.channel_id)}>{busy === c.channel_id ? 'Running…' : 'Refresh now'}</button>}
                {canManage && cfgKnown && <button className="so-btn ghost" onClick={() => toggle(c.channel_id, !c.enabled)}>{c.enabled ? 'Disable' : 'Enable'}</button>}
                {canManage && c.enabled && <button className="so-btn ghost" onClick={() => backfill(c.channel_id)}>Backfill</button>}
              </div>
            </div>
          );
        })}
      </div>

      <section>
        <h2 style={{ fontFamily: 'var(--cond)', fontSize: 15, color: 'var(--t1)', marginBottom: 12 }}>Recent runs</h2>
        <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="so-table">
            <thead><tr><th>Started</th><th>Adapter</th><th>Trigger</th><th>Status</th><th className="so-num">Rows</th><th className="so-num">Facts</th><th className="so-num">Unmapped</th></tr></thead>
            <tbody>
              {runs.slice(0, 60).map(r => (
                <tr key={r.id}>
                  <td>{r.started_at ? new Date(r.started_at).toLocaleString('en-IN') : '—'}</td>
                  <td>{r.adapter_kind}</td>
                  <td>{r.trigger}</td>
                  <td><span style={{ color: RUN_TONE[r.status] || 'var(--t2)' }}>{r.status}</span></td>
                  <td className="so-num">{r.rows_fetched ?? 0}</td>
                  <td className="so-num">{r.facts_upserted ?? 0}</td>
                  <td className="so-num">{r.rows_unmapped ?? 0}</td>
                </tr>
              ))}
              {runs.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--t3)' }}>No runs yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
