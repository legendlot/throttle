'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, pageH1, pageSub, tableThStyle, tableTdStyle,
  inputStyle, labelStyle, btnPrimary, btnSecondary, StatusBadge, fmtDate,
} from '../../../../lib/manifestui.js';

export default function FxPage() {
  const { session, perms } = useAuth();
  const toast = useToast();
  const [data, setData] = useState({ rates: [], latest: null });
  const [loading, setLoading] = useState(true);
  const [f, setF] = useState({ rate: '', rate_date: '', note: '' });
  const canManage = perms?.fx_manage;

  async function load() { const d = await garageFetch('getFxRates', {}, session); setData(d || { rates: [], latest: null }); setLoading(false); }
  useEffect(() => { if (session) load(); }, [session]);

  async function setManual() {
    if (!f.rate) { toast.error('Rate required'); return; }
    const r = await workerFetch('setManualFxRate', { data: { rate: Number(f.rate), rate_date: f.rate_date || null, note: f.note } }, session);
    if (r.ok) { toast.success('Manual rate saved'); setF({ rate: '', rate_date: '', note: '' }); load(); } else toast.error(r.error);
  }
  async function refresh() {
    const r = await workerFetch('refreshFxRate', {}, session);
    if (r.ok) { toast.success(`Auto rate ${Number(r.data.rate).toFixed(3)}`); load(); } else toast.error(r.error);
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}><h1 style={pageH1}>Exchange Rates</h1><div style={pageSub}>CNY → INR · auto reference (daily) + manual bank-rate overrides</div></div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16, alignItems: 'stretch' }}>
        <div style={{ ...panelStyle, marginBottom: 0, minWidth: 220, padding: 16 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--t3)' }}>Latest rate ¥→₹</div>
          <div style={{ fontFamily: 'var(--cond)', fontSize: 30, fontWeight: 900, marginTop: 6 }}>{data.latest ? Number(data.latest).toFixed(4) : '—'}</div>
          {canManage && <button style={{ ...btnSecondary, marginTop: 10 }} onClick={refresh}>Refresh auto rate now</button>}
        </div>
        {canManage && (
          <div style={{ ...panelStyle, marginBottom: 0, flex: 1, minWidth: 320 }}>
            <div style={panelHeaderStyle}><span>Set a manual rate</span></div>
            <div style={{ ...panelBodyStyle, display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, alignItems: 'end' }}>
              <div><label style={labelStyle}>Rate ¥→₹</label><input type="number" style={{ ...inputStyle, width: '100%' }} value={f.rate} onChange={e => setF(s => ({ ...s, rate: e.target.value }))} /></div>
              <div><label style={labelStyle}>Date</label><input type="date" style={{ ...inputStyle, width: '100%' }} value={f.rate_date} onChange={e => setF(s => ({ ...s, rate_date: e.target.value }))} /></div>
              <div><button style={btnPrimary} onClick={setManual}>Save</button></div>
              <div style={{ gridColumn: '1 / 4' }}><label style={labelStyle}>Note</label><input style={{ ...inputStyle, width: '100%' }} value={f.note} onChange={e => setF(s => ({ ...s, note: e.target.value }))} /></div>
            </div>
          </div>
        )}
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Rate history</span></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={tableThStyle}>Date</th><th style={tableThStyle}>Pair</th><th style={{ ...tableThStyle, textAlign: 'right' }}>Rate</th><th style={tableThStyle}>Source</th><th style={tableThStyle}>Note</th></tr></thead>
            <tbody>
              {loading && <tr><td style={tableTdStyle} colSpan={5}>Loading…</td></tr>}
              {!loading && data.rates.length === 0 && <tr><td style={{ ...tableTdStyle, color: 'var(--t3)' }} colSpan={5}>No rates yet — refresh or set one</td></tr>}
              {data.rates.map(r => (
                <tr key={r.id}>
                  <td style={tableTdStyle}>{fmtDate(r.rate_date)}</td>
                  <td style={tableTdStyle}>{r.base}→{r.quote}</td>
                  <td style={{ ...tableTdStyle, textAlign: 'right' }}>{Number(r.rate).toFixed(4)}</td>
                  <td style={tableTdStyle}><StatusBadge label={r.source} tone={r.source === 'manual' ? 'yellow' : 'gray'} /></td>
                  <td style={tableTdStyle}>{r.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
