'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Cable, ShoppingBag, Package, Truck, Upload, LineChart, CreditCard, Zap } from 'lucide-react';
import { salesGet, salesPost, istDaysAgo, fmtInt } from '../../../lib/api.js';
import { FAMILIES, familyOf } from '../../../lib/families.js';
import { PageHead, PanelHead, Pill } from '../../../components/prism.js';
import { STATUS, rgb } from '../../../lib/hues.js';

// Run status is semantic, never a family hue. `running` keeps the odometer blue it has always
// used here — that one is existing product vocabulary for "in flight", not a UI accent.
const RUN_TONE = { ok: STATUS.good, partial: STATUS.warn, error: STATUS.bad, failed: STATUS.bad, running: '#4C63F0' };
const runTone = (s) => RUN_TONE[s] || 'var(--t3)';

// Adapter kind → icon. Falls back to the generic Cable for anything unconfigured/new, so a new
// adapter never renders blank.
const ICON = [
  [/shopify/i, ShoppingBag],
  [/amazon/i, Package],
  [/flipkart|uniware/i, Truck],
  [/upload|csv/i, Upload],
  [/ga4|analytics/i, LineChart],
  [/razorpay|settle|payment/i, CreditCard],
  [/blinkit|zepto|instamart|swiggy|qc_/i, Zap],
];
const iconFor = (kind) => (ICON.find(([re]) => re.test(kind || ''))?.[1]) || Cable;

// relative freshness for "synced Xm ago"
function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return 'never';
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 172800) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

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

  // ── one hue-tinted card per live connector ──
  const Card = (c) => {
    const r = c.last_run;
    const cfgKnown = !!c.adapter_kind;
    const secretOk = secretFor(c.adapter_kind);
    const hue = FAMILIES[familyOf(c.name || '')].color;
    const Icon = iconFor(c.adapter_kind);
    // Status is what the operator actually needs: a live error outranks the last run's verdict,
    // and a connector that has never produced a run reads "never", not "ok".
    const statusKey = c.last_error ? 'error' : (r?.status || (c.last_ok_at ? 'ok' : 'never'));
    const sc = statusKey === 'never' ? 'var(--t3)' : runTone(statusKey);
    const unmapped = Number(r?.rows_unmapped) || 0;
    return (
      <div key={c.channel_id} style={{
        background: `linear-gradient(160deg, rgba(${rgb(hue)},.09), #101218 74%)`,
        border: `1px solid rgba(${rgb(hue)},.24)`, borderRadius: 'var(--r-2xl)', padding: '15px 16px',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
          <Icon size={20} strokeWidth={1.75} color={hue} style={{ flex: 'none', marginTop: 1 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="so-h2" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--t4)', marginTop: 3 }}>{c.adapter_kind || 'unconfigured'}</div>
          </div>
          <Pill color={sc} dot style={{ borderRadius: 'var(--r-pill)', flex: 'none' }}>{statusKey}</Pill>
        </div>

        {/* divider row — freshness / volume / the queue this feed is filling */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, paddingTop: 11,
          borderTop: '1px solid rgba(255,255,255,.07)', fontFamily: 'var(--mono)', fontSize: 10.5 }}>
          <span style={{ color: 'var(--t4)' }}>synced <b style={{ color: 'var(--t1-cell)', fontWeight: 500 }}>{ago(c.last_ok_at)}</b></span>
          <span style={{ color: 'var(--t4)' }}>{r ? `${fmtInt(r.rows_fetched ?? 0)} rows` : 'no runs yet'}</span>
          <span style={{ color: unmapped ? 'var(--amber)' : 'var(--t5)' }}>{fmtInt(unmapped)} unmapped</span>
        </div>

        {(!secretOk || (r?.error)) && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--amber)', wordBreak: 'break-word' }}>
            {!secretOk ? 'secrets missing' : String(r.error).slice(0, 60)}
          </div>
        )}

        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {canRefresh && c.enabled && <button className="so-btn" style={{ padding: '6px 11px' }} disabled={busy === c.channel_id} onClick={() => refresh(c.channel_id)}>{busy === c.channel_id ? 'Running…' : 'Refresh'}</button>}
          {canManage && c.enabled && <button className="so-btn ghost" style={{ padding: '6px 11px' }} onClick={() => setBf(s => ({ ...s, id: s.id === c.channel_id ? '' : c.channel_id }))}>Backfill</button>}
          {canManage && cfgKnown && <button className="so-btn ghost" style={{ padding: '6px 11px' }} onClick={() => toggle(c.channel_id, !c.enabled)}>{c.enabled ? 'Disable' : 'Enable'}</button>}
        </div>

        {bf.id === c.channel_id && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="so-eyebrow">Backfill from</span>
            <input className="so-input" type="date" value={bf.from} onChange={e => setBf(s => ({ ...s, from: e.target.value }))} style={{ padding: '6px 9px' }} />
            <button className="so-btn" style={{ padding: '6px 12px' }} onClick={() => runBackfill(c.channel_id)}>Run</button>
            <button className="so-btn ghost" style={{ padding: '6px 12px' }} onClick={() => setBf(s => ({ ...s, id: '' }))}>Cancel</button>
          </div>
        )}
      </div>
    );
  };

  // ── dormant feed: dashed, unlit, one way back in ──
  const IdleCard = (c) => {
    const cfgKnown = !!c.adapter_kind;
    // Same derivation the live cards use — an operator must not be able to press Connect on an
    // adapter whose credential is unset without seeing why it will fail. HEAD showed this warning
    // on inactive rows too and never disabled the toggle; keep both halves of that behaviour.
    const secretOk = secretFor(c.adapter_kind);
    const Icon = iconFor(c.adapter_kind);
    return (
      <div key={c.channel_id} style={{
        background: 'rgba(20,21,26,.45)', border: '1px dashed var(--border-ctl)', borderRadius: 'var(--r-2xl)',
        padding: '15px 16px', display: 'flex', alignItems: 'center', gap: 11,
      }}>
        <Icon size={20} strokeWidth={1.75} color="var(--t5)" style={{ flex: 'none' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="so-h2" style={{ color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--t5)', marginTop: 3 }}>
            {cfgKnown ? `${c.adapter_kind} · disabled` : 'not configured'}
          </div>
        </div>
        {!secretOk && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--amber)', flex: 'none' }}>secrets missing</span>
        )}
        {canManage && cfgKnown && (
          <button className="so-btn ghost" style={{ padding: '5px 11px', flex: 'none' }} onClick={() => toggle(c.channel_id, true)}>Connect</button>
        )}
      </div>
    );
  };

  const GRID = { display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 14 };

  return (
    <div className="so-page" style={{ maxWidth: 1180 }}>
      <PageHead title="Connectors" sub="Every feed into Odo, its freshness, and what the last run produced" />

      <section>
        <div className="so-eyebrow" style={{ marginBottom: 11 }}>Active <span style={{ color: active.length ? 'var(--green-fg)' : 'var(--t5)' }}>({active.length})</span></div>
        {active.length === 0
          ? <div className="so-card" style={{ color: 'var(--t3)', fontFamily: 'var(--ui)', fontSize: 13 }}>No connectors enabled.</div>
          : <div style={GRID}>{active.map(Card)}</div>}
      </section>

      <section>
        <div className="so-eyebrow" style={{ marginBottom: 11 }}>Inactive <span style={{ color: 'var(--t5)' }}>({inactive.length})</span></div>
        {inactive.length === 0
          ? <div className="so-card" style={{ color: 'var(--t3)', fontFamily: 'var(--ui)', fontSize: 13 }}>None — every connector is enabled.</div>
          : <div style={GRID}>{inactive.map(IdleCard)}</div>}
      </section>

      <div className="so-card flush">
        <PanelHead title="Recent runs" style={{ marginBottom: 0 }} />
        <div style={{ overflowX: 'auto' }}>
          <table className="so-table">
            <thead><tr><th>Started</th><th>Adapter</th><th>Trigger</th><th>Status</th><th className="so-num">Rows</th><th className="so-num">Facts</th><th className="so-num">Unmapped</th></tr></thead>
            <tbody>
              {runs.slice(0, 60).map(r => {
                const unmapped = Number(r.rows_unmapped) || 0;
                return (
                  <tr key={r.id}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t2-cell)', whiteSpace: 'nowrap' }}>{r.started_at ? new Date(r.started_at).toLocaleString('en-IN') : '—'}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t1)' }}>{r.adapter_kind}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{r.trigger}</td>
                    <td><Pill color={runTone(r.status)} dot style={{ borderRadius: 'var(--r-pill)' }}>{r.status}</Pill></td>
                    <td className="so-num">{r.rows_fetched ?? 0}</td>
                    <td className="so-num">{r.facts_upserted ?? 0}</td>
                    <td className="so-num" style={{ color: unmapped ? 'var(--amber)' : 'var(--t5)' }}>{r.rows_unmapped ?? 0}</td>
                  </tr>
                );
              })}
              {runs.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--t3)' }}>No runs yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
