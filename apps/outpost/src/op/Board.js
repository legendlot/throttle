'use client';
// Floor board (supervisor): today's output per bench (IST day), open orders against target, cartons by stage, minted
// stickers not yet on a unit, printing health. Refreshes every 30 s.
import { ago, useLoad } from './ui.js';


export default function Board({ printStatus, goto }) {
  const s = useLoad('/v/floor_summary', { every: 30_000 });
  const d = s.data;
  const c = printStatus.data?.counts || {};
  const attention = Number(c.outcome_unknown || 0) + Number(c.failed || 0) + Number(c.late_print || 0);
  const offline = (printStatus.data?.agents || []).filter(a => !a.online);
  if (s.loading) return <div className="empty">Loading…</div>;
  if (s.error) return <div className="card err">{s.error}</div>;
  return (
    <div className="stack">
      {(attention > 0 || offline.length > 0) && (
        <div className="result bad" style={{ marginTop: 0 }}>
          <div className="big">Printing needs attention</div>
          {offline.length > 0 && <div>Offline: {offline.map(a => a.label || `Agent ${a.id}`).join(', ')}</div>}
          {attention > 0 && <div>{attention} label job{attention > 1 ? 's' : ''} need a decision.</div>}
          <button className="btn sm" style={{ marginTop: 8 }} onClick={() => goto('printing')}>Open printing</button>
        </div>
      )}
      <div className="card">
        <h3>Today</h3>
        <div className="grid4">
          <div className="kpi"><div className="n">{d.today.packed}</div><div className="l">units packed</div></div>
          <div className="kpi"><div className={`n ${d.today.unpacked ? 'warn' : ''}`}>{d.today.unpacked}</div><div className="l">un-packed</div></div>
          {d.today.by_bench.map(b => (
            <div key={String(b.bench_no)} className="kpi"><div className="n">{b.packed}</div><div className="l">bench {b.bench_no ?? '—'}{b.unpacked ? ` · ${b.unpacked} un-packed` : ''}</div></div>
          ))}
        </div>
      </div>
      <div className="grid2">
        <div className="card">
          <h3>Open orders</h3>
          {!d.orders.length ? <div className="dim">No open orders.</div> : d.orders.map(o => {
            const pct = Math.min(100, (100 * o.packed) / o.target_qty);
            return (
              <div key={o.wo_no} style={{ marginBottom: 12 }}>
                <div className="spread"><span><span className="mono">{o.wo_no}</span> · <span className="mono">{o.sku}</span> · {o.channel}</span>
                  <span className="mono">{o.packed} / {o.target_qty}</span></div>
                <div className="bar" style={{ marginTop: 4 }}><i style={{ width: `${pct}%` }} /></div>
              </div>
            );
          })}
        </div>
        <div className="card">
          <h3>Cartons</h3>
          <div className="grid4">
            <div className="kpi"><div className="n">{d.cartons.open}</div><div className="l">filling</div></div>
            <div className="kpi"><div className="n">{d.cartons.closed_ready}</div><div className="l">ready to ship</div></div>
            <div className="kpi"><div className="n">{d.cartons.in_draft}</div><div className="l">in a draft consignment</div></div>
          </div>
          <h3 style={{ marginTop: 18 }}>Stickers not yet on a unit</h3>
          {!d.stickers.length ? <div className="dim">None.</div> : (
            <table className="t"><tbody>{d.stickers.map(x => {
              // The vendor's own leakage threshold (vendor_config.leak_unused_sticker_days, set by LOT).
              const old = x.oldest && d.sticker_stale_days && Date.now() - Date.parse(x.oldest) > d.sticker_stale_days * 86_400_000;
              return <tr key={x.product_code}><td className="mono">{x.product_code}</td><td className="n">{Number(x.unapplied).toLocaleString('en-IN')}</td>
                <td className={old ? 'warn' : 'dim'}>oldest {ago(x.oldest)}</td></tr>;
            })}</tbody></table>
          )}
        </div>
      </div>
    </div>
  );
}
