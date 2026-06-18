'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, istToday, istDaysAgo, downloadCsv } from '../../lib/api.js';

const GROUPS = [
  { key: 'variant', label: 'By Variant' },
  { key: 'date',    label: 'By Day' },
  { key: 'channel', label: 'By Channel' },
];

export default function Dashboard() {
  const { session } = useAuth();
  const [channels, setChannels] = useState([]);
  const [sel, setSel] = useState([]);            // selected channel ids ([] = all)
  const [from, setFrom] = useState(istDaysAgo(29));
  const [to, setTo] = useState(istToday());
  const [group, setGroup] = useState('variant');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!session) return;
    // getBootstrap.channels carry `.id`; normalise to `.channel_id` (what the rest of this page + the rollup rows use).
    salesGet('getBootstrap', {}, session).then(b => setChannels((b?.channels || []).map(c => ({ channel_id: c.channel_id || c.id, name: c.name, type: c.type })))).catch(() => {});
  }, [session]);

  const chName = useMemo(() => Object.fromEntries(channels.map(c => [c.channel_id, c.name])), [channels]);

  const load = () => {
    if (!session) return;
    setLoading(true); setErr('');
    salesGet('getSales', { from, to, group, channel_id: sel.join(',') }, session)
      .then(r => setRows(r?.rows || []))
      .catch(e => setErr(e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [session, from, to, group, sel]);

  // KPIs over the raw fact rows (each row is sale_date×channel×product_code)
  const kpis = useMemo(() => {
    let units = 0, gross = 0; const byCh = {};
    for (const r of rows) {
      const u = Number(r.units) || 0, g = Number(r.gross_value) || 0;
      units += u; gross += g;
      byCh[r.channel_id] = (byCh[r.channel_id] || 0) + g;
    }
    const top = Object.entries(byCh).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return { units, gross, top };
  }, [rows]);

  // Roll the fact rows up to the chosen group axis for the table.
  const table = useMemo(() => {
    const agg = {};
    for (const r of rows) {
      const key = group === 'date' ? r.sale_date : group === 'channel' ? r.channel_id : r.product_code;
      const label = group === 'date' ? r.sale_date : group === 'channel' ? (chName[r.channel_id] || r.channel_id) : (r.grp_label || r.product_code);
      const a = agg[key] || (agg[key] = { key, label, units: 0, gross: 0 });
      a.units += Number(r.units) || 0; a.gross += Number(r.gross_value) || 0;
    }
    return Object.values(agg).sort((a, b) => b.gross - a.gross);
  }, [rows, group, chName]);

  const exportCsv = () => {
    salesGet('getSalesExport', { from, to, group, channel_id: sel.join(',') }, session)
      .then(r => downloadCsv(r?.rows || [], `odo_${group}_${from}_${to}.csv`))
      .catch(() => {});
  };
  const toggleCh = (id) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 1180 }}>
      {/* filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <input className="so-input" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} />
        <span style={{ color: 'var(--t3)' }}>→</span>
        <input className="so-input" type="date" value={to} min={from} max={istToday()} onChange={e => setTo(e.target.value)} />
        <div style={{ display: 'flex', gap: 6, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
          {GROUPS.map(g => (
            <button key={g.key} onClick={() => setGroup(g.key)}
              style={{ background: group === g.key ? 'var(--accent)' : 'transparent', color: group === g.key ? 'var(--accent-fg)' : 'var(--t2)', border: 'none', borderRadius: 6, padding: '7px 12px', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>
              {g.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="so-btn ghost" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
      </div>

      {/* channel chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        <span className={`so-chip${sel.length === 0 ? ' on' : ''}`} onClick={() => setSel([])}>All channels</span>
        {channels.map(c => (
          <span key={c.channel_id} className={`so-chip${sel.includes(c.channel_id) ? ' on' : ''}`} onClick={() => toggleCh(c.channel_id)}>{c.name}</span>
        ))}
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}>
        <div className="so-card"><div className="so-kpi-lbl">Units sold</div><div className="so-kpi-val">{fmtInt(kpis.units)}</div></div>
        <div className="so-card"><div className="so-kpi-lbl">Gross sales</div><div className="so-kpi-val">{inr(kpis.gross)}</div></div>
        <div className="so-card" style={{ gridColumn: 'span 2', minWidth: 280 }}>
          <div className="so-kpi-lbl">Gross by channel</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {kpis.top.length === 0 && <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No sales in range</div>}
            {kpis.top.map(([id, g]) => {
              const pct = kpis.gross ? (g / kpis.gross) * 100 : 0;
              return (
                <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 96, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chName[id] || '—'}</div>
                  <div style={{ flex: 1, height: 7, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
                  </div>
                  <div style={{ width: 86, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t1)' }}>{inr(g)}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* table */}
      <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? <div style={{ padding: 40, textAlign: 'center' }}><Spinner /></div> : err ? (
          <div style={{ padding: 28, color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>
        ) : table.length === 0 ? (
          <div style={{ padding: 36, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
            No sales for this range yet. Pull a channel from <b style={{ color: 'var(--t2)' }}>Connectors</b> or upload a report from <b style={{ color: 'var(--t2)' }}>Uploads</b>.
          </div>
        ) : (
          <table className="so-table">
            <thead><tr>
              <th>{group === 'date' ? 'Day' : group === 'channel' ? 'Channel' : 'Variant'}</th>
              <th className="so-num">Units</th>
              <th className="so-num">Gross ₹</th>
            </tr></thead>
            <tbody>
              {table.map(r => (
                <tr key={r.key}>
                  <td style={{ color: 'var(--t1)' }}>{r.label}</td>
                  <td className="so-num">{fmtInt(r.units)}</td>
                  <td className="so-num">{inr(r.gross)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
