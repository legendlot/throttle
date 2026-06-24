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
  const [bf, setBf] = useState({ id: '', from: istDaysAgo(90) });   // inline backfill panel

  const load = () => {
    if (!session) return;
    Promise.all([salesGet('getConnectorStatus', {}, session), salesGet('getRuns', {}, session)])
      .then(([s, r]) => { setData(s); setRuns(r?.runs || []); });
  };
  useEffect(load, [session]);

  const refresh = (id) => { setBusy(id); salesPost('refreshNow', { channel_id: id }, session).then(() => { toast?.showToast?.('Refresh started', 'success'); setTimeout(load, 2500); }).catch(e => toast?.showToast?.(e.message, 'error')).finally(() => setTimeout(() => setBusy(''), 2500)); };
  const runBackfill = (id) => { if (!bf.from) return; salesPost('backfill', { channel_id: id, from: bf.from }, session).then(() => { toast?.showToast?.('Backfill started', 'success'); setBf({ id: '', from: bf.from }); setTimeout(load, 3000); }).catch(e => toast?.showToast?.(e.message, 'error')); };
  const toggle = (id, enabled) => salesPost('setConnectorEnabled', { channel_id: id, enabled }, session).then(load).catch(e => toast?.showToast?.(e.message, 'error'));

  if (!data) return <Spinner />;
  const secrets = data.secrets || {};
  const secretFor = (kind) => kind === 'shopify' ? secrets.shopify : kind === 'amazon_spapi' ? secrets.amazon : kind === 'flipkart_v3' ? secrets.flipkart : true;

  const all = (data.connectors || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const active = all.filter(c => c.enabled);
  const inactive = all.filter(c => !c.enabled);

  // ── one compact row per connector ──
  const Row = (c) => {
    const r = c.last_run;
    const cfgKnown = !!c.adapter_kind;
    const secretOk = secretFor(c.adapter_kind);
    return (
      <div key={c.channel_id} style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 70%, transparent)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '11px 16px', flexWrap: 'wrap' }}>
          {/* identity + status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 200, flex: '1 1 240px' }}>
            <span className="so-dot" style={{ background: c.enabled ? 'var(--green)' : 'var(--t3)', flexShrink: 0 }} />
            <span style={{ fontFamily: 'var(--ui)', fontWeight: 600, fontSize: 14, color: c.enabled ? 'var(--t1)' : 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
            <span className="so-pill" style={{ background: 'var(--surface2)', color: 'var(--t3)', flexShrink: 0 }}>{c.adapter_kind || 'unconfigured'}</span>
            {!secretOk && <span className="so-sub" style={{ color: 'var(--amber)', fontSize: 11 }}>secrets missing</span>}
          </div>
          {/* last-run summary */}
          <div style={{ flex: '2 1 220px', minWidth: 0, fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--t3)' }}>
            {r ? (
              <span>Last <span style={{ color: RUN_TONE[r.status] || 'var(--t2)' }}>{r.status}</span> · {r.rows_fetched ?? 0} rows · {r.facts_upserted ?? 0} facts{r.rows_unmapped ? ` · ${r.rows_unmapped} unmapped` : ''}{r.error ? ` · ${String(r.error).slice(0, 60)}` : ''}</span>
            ) : <span>No runs yet</span>}
          </div>
          {/* actions */}
          <div style={{ display: 'flex', gap: 7, flexShrink: 0 }}>
            {canRefresh && c.enabled && <button className="so-btn" style={{ padding: '6px 11px' }} disabled={busy === c.channel_id} onClick={() => refresh(c.channel_id)}>{busy === c.channel_id ? 'Running…' : 'Refresh'}</button>}
            {canManage && c.enabled && <button className="so-btn ghost" style={{ padding: '6px 11px' }} onClick={() => setBf(s => ({ ...s, id: s.id === c.channel_id ? '' : c.channel_id }))}>Backfill</button>}
            {canManage && cfgKnown && <button className="so-btn ghost" style={{ padding: '6px 11px' }} onClick={() => toggle(c.channel_id, !c.enabled)}>{c.enabled ? 'Disable' : 'Enable'}</button>}
          </div>
        </div>
        {bf.id === c.channel_id && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 12px 40px', flexWrap: 'wrap' }}>
            <span className="so-sub" style={{ fontSize: 11 }}>Backfill from</span>
            <input className="so-input" type="date" value={bf.from} onChange={e => setBf(s => ({ ...s, from: e.target.value }))} style={{ padding: '6px 9px' }} />
            <button className="so-btn" style={{ padding: '6px 12px' }} onClick={() => runBackfill(c.channel_id)}>Run</button>
            <button className="so-btn ghost" style={{ padding: '6px 12px' }} onClick={() => setBf(s => ({ ...s, id: '' }))}>Cancel</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="so-page" style={{ gap: 22, maxWidth: 1080 }}>
      <section>
        <h2 className="so-h2" style={{ marginBottom: 10 }}>Active <span style={{ color: 'var(--t3)' }}>({active.length})</span></h2>
        <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
          {active.length === 0
            ? <div style={{ padding: 20, color: 'var(--t3)', fontFamily: 'var(--ui)', fontSize: 13 }}>No connectors enabled.</div>
            : active.map(Row)}
        </div>
      </section>

      <section>
        <h2 className="so-h2" style={{ marginBottom: 10 }}>Inactive <span style={{ color: 'var(--t3)' }}>({inactive.length})</span></h2>
        <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
          {inactive.length === 0
            ? <div style={{ padding: 20, color: 'var(--t3)', fontFamily: 'var(--ui)', fontSize: 13 }}>None — every connector is enabled.</div>
            : inactive.map(Row)}
        </div>
      </section>

      <section>
        <h2 className="so-h2" style={{ marginBottom: 12 }}>Recent runs</h2>
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
