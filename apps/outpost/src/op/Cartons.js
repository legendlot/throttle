'use client';
// Cartons still at the vendor: open (filling at a bench) and closed (ready for a consignment, or already in a draft one).
import { useState } from 'react';
import { useToast } from '@throttle/ui/Toast.js';
import { act, say } from './api.js';
import { Badge, clean, Confirm, CTN_RE, fmtTime, Modal, useAutoEnter, useLoad } from './ui.js';

const FILTERS = [
  ['all', 'All', () => true],
  ['open', 'Filling', c => c.status === 'open'],
  ['ready', 'Ready to ship', c => c.status === 'closed' && !c.consignment],
  ['csg', 'In a consignment', c => !!c.consignment],
];

export default function Cartons({ me, sup }) {
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
    if (CTN_RE.test(v)) { setOpen(v); setQ(''); }
  };
  // A scanner with no Enter: a whole CTN in the box opens it; the box is cleared so closing the carton doesn't reopen it.
  useAutoEnter(q, v => { const c = clean(v); if (CTN_RE.test(c)) { setOpen(c); setQ(''); } });

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
      {open && <CartonDetail ctn={open} me={me} sup={sup} onClose={() => setOpen(null)} onCloseCarton={c => { setOpen(null); setClosing(c); }} />}
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

function CartonDetail({ ctn, me, sup, onClose, onCloseCarton }) {
  const { showToast } = useToast();
  const d = useLoad(`/v/carton?ctn_no=${encodeURIComponent(ctn)}`);
  const c = d.data;
  const [reprint, setReprint] = useState(null);   // the job as it was when the dialog opened: { id, status, bench }
  // The worker says whether THIS device opened it: close_carton matches the device, not the bench number.
  const mine = c && c.status === 'open' && c.mine === true;
  // A faded or torn CTN label on a carton still here: reprint its CURRENT label. Only a printed one — a failed or
  // unknown job is the Printing tab's call (look at the printer first), and an older version's label is not this carton's.
  const lj = c?.label_job;
  const canReprint = sup && c?.status === 'closed' && lj?.status === 'printed' && Number(lj.manifest_version) === c.manifest_version;
  // The job prints on whichever bench its device is on NOW (agent_claim routes by devices.bench_no), not the carton's.
  const labelBench = lj?.device?.bench_no ?? c?.bench_no;
  const HINT = { outcome_unknown: 'Its label may not have printed — see the Printing tab.', failed: 'Its label failed to print — see the Printing tab.',
    pending: 'Its label is waiting to print.', leased: 'Its label is printing now.', cancelled: 'No label is queued for it — tell LOT.' };
  return (
    <>
    <Modal title={ctn} onClose={reprint ? undefined : onClose} wide>
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
            {c.status === 'closed' && lj && HINT[lj.status] && <span className="dim">{HINT[lj.status]}</span>}
            {canReprint && <button className="btn" onClick={() => setReprint({ id: Number(lj.id), status: lj.status, bench: labelBench })}>Reprint carton label</button>}
            <button className="btn" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </Modal>
      {reprint && (
        <Confirm title={`Reprint the label for ${ctn}?`} yes="Reprint" onClose={() => setReprint(null)}
          body={`Use this when the label is faded or torn. It prints on bench ${reprint.bench ?? '—'}'s printer. Peel the old label off and stick the new one in its place — never leave two labels on one carton.`}
          onYes={async () => {
            // The job as it was when the dialog opened, never a reloaded one: a job that moved meanwhile is refused, and
            // the dialog closes so a second Yes cannot reprint a label whose outcome is now unknown.
            const r = await act('print_resolve', { job_id: reprint.id, action: 'reprint', expected_status: reprint.status });
            setReprint(null); d.reload();
            if (!r.ok) { showToast(`${say(r)} The carton has been refreshed.`, 'error'); return null; }
            showToast(`${ctn} label sent to print`, 'success');
            return null;
          }} />
      )}
    </>
  );
}

