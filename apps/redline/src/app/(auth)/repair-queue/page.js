'use client';
/* ════════════════════════════════════════════════════════════
   REPAIR — Inbox stream (Pit Wall v2). Units awaiting a repair
   run, grouped by product. Read-only (getRepairUnitsQueue);
   repair runs are created in the Store system. Restyled to the
   inbox prototype look (redesign-reference/app/inbox.jsx).
   ════════════════════════════════════════════════════════════ */
import { Fragment, useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import {
  Icon, KpiTile, Panel, ToneBadge, InboxTabs, fmt, btnGhost,
} from '../../../components/kit/index.js';

const STATUS_TONE = {
  qc_fail:         { tone: 'bad',  label: 'QC Fail' },
  rto_in:          { tone: 'warn', label: 'RTO In' },
  scrapped_repair: { tone: 'mute', label: 'Scrapped' },
};
function StatusBadge({ status }) {
  const meta = STATUS_TONE[status] || { tone: 'mute', label: status || '—' };
  return <ToneBadge tone={meta.tone}>{meta.label}</ToneBadge>;
}

const thStyle = { padding: '0 14px 9px', textAlign: 'left', whiteSpace: 'nowrap' };
const tdBase = { padding: '10px 14px', borderTop: '1px solid var(--border)', whiteSpace: 'nowrap', verticalAlign: 'middle' };

export default function RepairQueuePage() {
  const { session } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!session) return;
    setRefreshing(true); setError(null);
    try {
      const data = await garageFetch('getRepairUnitsQueue', {}, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || 'Failed to load repair queue');
      setRows([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(new Date());
    }
  }, [session, setRefreshing, setLastRefreshed]);

  useEffect(() => { load(); }, [load]);

  const byProduct = {};
  for (const row of rows) {
    const p = row.product || '—';
    (byProduct[p] = byProduct[p] || []).push(row);
  }
  const products = Object.keys(byProduct).sort();
  const grandTotal = rows.reduce((s, r) => s + (Number(r.count) || 0), 0);
  const failTotal = rows.filter(r => r.status === 'qc_fail').reduce((s, r) => s + (Number(r.count) || 0), 0);
  const rtoTotal = rows.filter(r => r.status === 'rto_in').reduce((s, r) => s + (Number(r.count) || 0), 0);

  return (
    <div style={{ fontFamily: 'var(--font-ui)' }}>
      <InboxTabs counts={{ repair: grandTotal }} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 18 }}>
        <KpiTile label="Awaiting Repair" value={fmt(grandTotal)} sub={`${products.length} product${products.length === 1 ? '' : 's'}`} tone="warn" />
        <KpiTile label="QC Fail" value={fmt(failTotal)} sub="Failed at inspection" tone="bad" />
        <KpiTile label="RTO In" value={fmt(rtoTotal)} sub="Returned to origin" tone="warn" />
      </div>

      {error && (
        <div style={{ background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)', borderRadius: 'var(--r-sm)',
          padding: '12px 14px', fontSize: 13, color: 'var(--bad-fg)', marginBottom: 16 }}>{error}</div>
      )}

      <Panel title="Repair queue · awaiting repair run" icon="wrench" pad={0}
        action={<button onClick={load} style={{ ...btnGhost, padding: '6px 11px' }}><Icon name="activity" size={13} /> Refresh</button>}>
        {loading && rows.length === 0 ? (
          <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : products.length === 0 ? (
          <div style={{ padding: '48px 0', textAlign: 'center' }}>
            <div style={{ display: 'inline-grid', placeItems: 'center', width: 46, height: 46, borderRadius: '50%',
              background: 'var(--ok-bg)', color: 'var(--ok-fg)', border: '1px solid var(--ok-bd)', marginBottom: 12 }}>
              <Icon name="shield" size={22} /></div>
            <div style={{ fontSize: 14, color: 'var(--t1)', fontWeight: 600 }}>No units awaiting repair</div>
            <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>The repair queue is clear.</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th className="eyebrow" style={thStyle}>Product / Model</th>
                  <th className="eyebrow" style={thStyle}>Color</th>
                  <th className="eyebrow" style={thStyle}>Status</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'right' }}>Count</th>
                </tr>
              </thead>
              <tbody>
                {products.map(p => {
                  const productRows = byProduct[p];
                  const productTotal = productRows.reduce((s, r) => s + (Number(r.count) || 0), 0);
                  return (
                    <Fragment key={p}>
                      <tr style={{ background: 'var(--surface-2)' }}>
                        <td colSpan={3} style={{ padding: '9px 14px', borderTop: '1px solid var(--border)' }}>
                          <span className="font-display" style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--t1)' }}>{p}</span>
                        </td>
                        <td className="num" style={{ padding: '9px 14px', borderTop: '1px solid var(--border)', fontSize: 13, color: 'var(--yellow)', fontWeight: 700, textAlign: 'right' }}>
                          {fmt(productTotal)}
                        </td>
                      </tr>
                      {productRows.map((r, i) => (
                        <tr key={`${p}-${i}`}>
                          <td style={{ ...tdBase, paddingLeft: 30, color: 'var(--t2)' }}>{r.model || '—'}</td>
                          <td style={{ ...tdBase, color: 'var(--t2)' }}>{r.color || '—'}</td>
                          <td style={tdBase}><StatusBadge status={r.status} /></td>
                          <td className="num" style={{ ...tdBase, textAlign: 'right', color: 'var(--t1)', fontWeight: 600 }}>{fmt(r.count)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div style={{ marginTop: 14, fontSize: 12, color: 'var(--t3)' }}>
        Units available for repair — grouped by product. Create repair runs in the Store system.
      </div>
    </div>
  );
}
