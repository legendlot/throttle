'use client';
// Cartons still at the vendor: open (filling at a bench) and closed (ready for a consignment, or already in a draft one).
import { useState } from 'react';
import { useToast } from '@throttle/ui/Toast.js';
import { act, say } from './api.js';
import { Badge, clean, Confirm, CTN_RE, fmtTime, Modal, useLoad } from './ui.js';

const FILTERS = [
  ['all', 'All', () => true],
  ['open', 'Filling', c => c.status === 'open'],
  ['ready', 'Ready to ship', c => c.status === 'closed' && !c.consignment],
  ['csg', 'In a consignment', c => !!c.consignment],
];

export default function Cartons({ me }) {
  const { showToast } = useToast();
  const cartons = useLoad('/v/cartons');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [closing, setClosing] = useState(null);
  const fn = FILTERS.find(f => f[0] === filter)[2];
  const term = clean(q);
  const rows = (cartons.data || []).filter(fn).filter(c => !term || c.ctn_no.includes(term) || c.sku.includes(term));

  const lookup = e => {
    e.preventDefault();
    const v = clean(q);
    if (CTN_RE.test(v)) setOpen(v);
  };

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <div className="row">
          {FILTERS.map(([id, label, f]) => (
            <button key={id} className={`btn sm ${filter === id ? 'primary' : ''}`} onClick={() => setFilter(id)}>
              {label} <span className="mono">{(cartons.data || []).filter(f).length}</span>
            </button>
          ))}
        </div>
        <form onSubmit={lookup} className="row">
          <input className="in mono" style={{ width: 230 }} placeholder="CTN or SKU (scan to open)" value={q} onChange={e => setQ(e.target.value)} />
          <button className="btn sm" type="button" onClick={cartons.reload}>Refresh</button>
        </form>
      </div>
      {cartons.error && <div className="err">{cartons.error}</div>}
      {cartons.loading ? <div className="empty">Loading…</div> : !rows.length ? <div className="empty">No cartons here.</div> : (
        <table className="t">
          <thead><tr><th>Carton</th><th>SKU</th><th>Channel</th><th className="n">Units</th><th>Status</th><th>Bench</th><th>Order</th><th>Consignment</th><th>Closed</th></tr></thead>
          <tbody>
            {rows.map(c => (
              <tr key={c.ctn_no} className="click" onClick={() => setOpen(c.ctn_no)}>
                <td className="mono">{c.ctn_no}{c.manifest_version > 1 && <span className="dim"> · v{c.manifest_version}</span>}</td>
                <td className="mono">{c.sku}</td><td>{c.channel}</td>
                <td className="n">{c.unit_count}/{c.capacity}</td>
                <td><Badge s={c.status}>{c.status === 'open' ? 'filling' : c.status}</Badge></td>
                <td>{c.bench_no ?? '—'}</td>
                <td className="mono dim">{c.work_orders?.wo_no || '—'}</td>
                <td className="mono">{c.consignment ? <>{c.consignment.csg_no} <Badge s={c.consignment.status} /></> : '—'}</td>
                <td className="dim">{fmtTime(c.closed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <CartonDetail ctn={open} me={me} onClose={() => setOpen(null)} onCloseCarton={c => { setOpen(null); setClosing(c); }} />}
      {closing && (
        <Confirm title={`Close ${closing.ctn_no}?`} yes="Close carton" onClose={() => setClosing(null)}
          body={`It has ${closing.unit_count} of ${closing.capacity} units. Its CTN label prints on bench ${closing.bench_no}.`}
          onYes={async () => {
            const r = await act('close_carton', { ctn_no: closing.ctn_no });
            if (!r.ok) return say(r);
            setClosing(null); cartons.reload();
            showToast(`${closing.ctn_no} closed — CTN label printing`, 'success');
            return null;
          }} />
      )}
    </div>
  );
}

function CartonDetail({ ctn, me, onClose, onCloseCarton }) {
  const d = useLoad(`/v/carton?ctn_no=${encodeURIComponent(ctn)}`);
  const c = d.data;
  // The worker says whether THIS device opened it: close_carton matches the device, not the bench number.
  const mine = c && c.status === 'open' && c.mine === true;
  return (
    <Modal title={ctn} onClose={onClose} wide>
      {d.loading ? <div className="empty">Loading…</div> : d.error ? <div className="err">{d.error}</div> : (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <Badge s={c.status}>{c.status === 'open' ? 'filling' : c.status}</Badge>
            <span className="mono">{c.sku}</span><span className="muted">{c.channel}</span>
            <span className="mono">{c.unit_count}/{c.capacity}</span>
            <span className="dim">bench {c.bench_no ?? '—'} · {c.work_orders?.wo_no || `no order · ${c.pack_type}`} · label v{c.manifest_version}</span>
          </div>
          <table className="t">
            <thead><tr><th>Batch label</th><th>Car</th><th>Remote</th><th>Added</th></tr></thead>
            <tbody>
              {(c.carton_units || []).sort((a, b) => String(a.added_at).localeCompare(String(b.added_at))).map(u => (
                <tr key={u.car_upc}><td className="mono">{u.batch_label}</td><td className="mono">{u.car_upc}</td><td className="mono">{u.remote_upc}</td><td className="dim">{fmtTime(u.added_at)}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="row end" style={{ marginTop: 16 }}>
            {mine && c.unit_count > 0 && <button className="btn" onClick={() => onCloseCarton(c)}>Close carton short</button>}
            {c.status === 'open' && !mine && <span className="dim">Only the laptop that opened it (bench {c.bench_no}) can close this carton.</span>}
            <button className="btn" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </Modal>
  );
}

