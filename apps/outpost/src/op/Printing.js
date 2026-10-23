'use client';
// Printing: are the print agents and printers alive, and which labels need a person. A job whose outcome is unknown
// (the agent lost contact mid-print) is NEVER reprinted by itself: a supervisor looks at the printer and decides.
import { useRef, useState } from 'react';
import { useToast } from '@throttle/ui/Toast.js';
import { act, say } from './api.js';
import { ago, Badge, BATCH_RE, clean, Confirm, fmtTime, UPC_RE, useAutoEnter, useLoad, useScanCapture } from './ui.js';

const KIND = { batch_label: 'Batch label', ean_label: 'EAN label', ctn_label: 'Carton label', upc_stickers: 'Sticker sheet' };
const kindText = j => (j.kind === 'upc_stickers' && j.parts > 1 ? `${KIND[j.kind]} ${j.part}/${j.parts}` : KIND[j.kind] || j.kind);

const ACTIONS = {
  reprint: { label: 'Reprint', yes: 'Reprint',
    body: j => j.kind === 'upc_stickers'
      ? 'Look at the sticker printer first. If this sheet came out, choose “It printed” instead. A reprint prints only the stickers on it that are not on a unit yet.'
      : 'Look at the printer first. If the label came out, choose “It printed” instead — a reprint gives you a second copy.' },
  printed: { label: 'It printed', yes: 'Yes, it printed', body: () => 'The label is in hand and correct. Nothing is reprinted.' },
  cancel: { label: 'Cancel', yes: 'Cancel job', danger: true, body: () => 'Nothing more prints for this job.' },
  dismiss: { label: 'Thrown away', yes: 'Done', body: () => 'This label printed after it was replaced (an un-pack or a carton change). Confirm it was thrown away.' },
};
function actionsFor(j) {
  if (j.status === 'cancelled' && j.late_print && !j.resolved_at) return ['dismiss'];
  if (j.status === 'outcome_unknown' || j.status === 'failed') return ['reprint', 'printed', 'cancel'];
  return [];
}

export default function Printing({ sup, printStatus }) {
  const { showToast } = useToast();
  const [view, setView] = useState('attention');
  const jobs = useLoad(`/v/print_jobs?view=${view}`, { every: 15_000 });
  const [ask, setAsk] = useState(null);         // { job, action }
  const s = printStatus.data;
  const c = s?.counts || {};

  return (
    <div className="stack">
      <div className="card">
        <div className="spread" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Print agents</h2>
          <button className="btn sm" onClick={printStatus.reload}>Refresh</button>
        </div>
        {printStatus.error && <div className="err">{printStatus.error}</div>}
        {s && !s.agents.length && <div className="warn">No print agent is enrolled. Labels will wait in the queue until one runs.</div>}
        <div className="grid4">
          {(s?.agents || []).map(a => {
            const st = a.agent_status || {};
            return (
              <div key={a.id} className="kpi">
                <div className="spread"><b>{a.label || `Agent ${a.id}`}</b><span><span className={`dot ${a.online ? 'on' : 'off'}`} /> {a.online ? 'online' : 'OFFLINE'}</span></div>
                <div className="dim" style={{ fontSize: 13 }}>{a.bench_no ? `Bench ${a.bench_no} labels` : 'Sticker sheets'} · seen {ago(a.agent_status_at)}</div>
                {(st.printers || []).map(p => (
                  <div key={p.role + p.name} style={{ fontSize: 13, marginTop: 4 }}>
                    <span className={`dot ${p.ok === false ? 'off' : p.ok ? 'on' : ''}`} /> {p.role}: {p.name}{p.detail ? <span className="dim"> · {p.detail}</span> : null}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <div className="grid4" style={{ marginTop: 12 }}>
          <div className="kpi"><div className="n">{c.pending ?? '—'}</div><div className="l">waiting</div></div>
          <div className="kpi"><div className="n">{c.leased ?? '—'}</div><div className="l">printing now</div></div>
          <div className="kpi"><div className={`n ${c.outcome_unknown ? 'warn' : ''}`}>{c.outcome_unknown ?? '—'}</div><div className="l">outcome unknown</div></div>
          <div className="kpi"><div className={`n ${c.failed ? 'bad' : ''}`}>{c.failed ?? '—'}</div><div className="l">failed</div></div>
          <div className="kpi"><div className={`n ${c.late_print ? 'warn' : ''}`}>{c.late_print ?? '—'}</div><div className="l">printed after replaced</div></div>
        </div>
      </div>

      {sup && <UnitLabels />}

      <div className="card">
        <div className="spread" style={{ marginBottom: 12 }}>
          <div className="row">
            <button className={`btn sm ${view === 'attention' ? 'primary' : ''}`} onClick={() => setView('attention')}>Needs a person</button>
            <button className={`btn sm ${view === 'recent' ? 'primary' : ''}`} onClick={() => setView('recent')}>Recent 100</button>
          </div>
          {!sup && <span className="dim">A supervisor resolves these.</span>}
        </div>
        {jobs.error && <div className="err">{jobs.error}</div>}
        {jobs.loading ? <div className="empty">Loading…</div> : !(jobs.data || []).length ? (
          <div className="empty">{view === 'attention' ? 'Nothing needs a person. All labels printed or are on their way.' : 'No print jobs yet.'}</div>
        ) : (
          <table className="t">
            <thead><tr><th>What</th><th>For</th><th>Bench</th><th>Status</th><th className="n">Tries</th><th>Queued</th><th></th></tr></thead>
            <tbody>{jobs.data.map(j => (
              <tr key={j.id}>
                <td>{kindText(j)}</td>
                <td className="mono">{j.batch_label || j.ref}</td>
                <td>{j.device?.bench_no ?? (j.kind === 'upc_stickers' ? 'stickers' : '—')}</td>
                <td>
                  <Badge s={j.status}>{j.status === 'cancelled' && j.late_print ? 'printed after replaced' : null}</Badge>
                  {j.error && <div className="dim" style={{ fontSize: 12, maxWidth: 260 }}>{j.error}</div>}
                </td>
                <td className="n">{j.attempts}{j.reprints ? <span className="dim"> · {j.reprints} reprint{j.reprints > 1 ? 's' : ''}</span> : null}</td>
                <td className="dim">{fmtTime(j.created_at)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {sup && actionsFor(j).map(a => (
                    <button key={a} className={`btn sm ${a === 'cancel' ? 'danger' : ''}`} style={{ marginLeft: 6 }} onClick={() => setAsk({ job: j, action: a })}>{ACTIONS[a].label}</button>
                  ))}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      {ask && (
        <Confirm title={`${ACTIONS[ask.action].label}: ${kindText(ask.job)} ${ask.job.batch_label || ask.job.ref}`} yes={ACTIONS[ask.action].yes}
          danger={ACTIONS[ask.action].danger} body={ACTIONS[ask.action].body(ask.job)} onClose={() => setAsk(null)}
          onYes={async () => {
            // expected_status = what this screen showed: if the job moved meanwhile (its late report landed), the worker refuses.
            const r = await act('print_resolve', { job_id: Number(ask.job.id), action: ask.action, expected_status: ask.job.status });
            if (!r.ok) { jobs.reload(); return `${say(r)} The list has been refreshed.`; }
            setAsk(null); jobs.reload(); printStatus.reload();
            showToast(ask.action === 'reprint' ? 'Sent to print again' : 'Done', 'success');
            return null;
          }} />
      )}
    </div>
  );
}

// A faded or torn EAN / batch (UPC) label on a unit still packed here (Joseph, #bugs 1792739680.571429): scan the unit,
// reprint its own label. The jobs table above only offers a reprint on a failed or unknown job, and a printed unit
// label falls off "Recent 100" within the hour. The car's LOT sticker is not reprinted here — that is the A3 sheet's.
function UnitLabels() {
  const [q, setQ] = useState('');
  const [look, setLook] = useState(null);         // { upc, n }: n remounts the result, so scanning the same unit reloads it
  const [bad, setBad] = useState(null);
  const input = useRef(null);
  // A scan lands here, not on a focused Reprint button (whose click an Enter suffix would repeat). Off under a dialog.
  useScanCapture(input, true, 0);
  const take = v => {
    const c = clean(v);
    setQ('');
    if (UPC_RE.test(c) || BATCH_RE.test(c)) { setBad(null); setLook(l => ({ upc: c, n: (l?.n || 0) + 1 })); }
    else if (c) setBad(`${c} is not a car, remote or batch label.`);
  };
  useAutoEnter(q, take);
  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Reprint a unit’s labels</h2>
        <form onSubmit={e => { e.preventDefault(); take(q); }} className="row">
          <input ref={input} autoFocus className="in mono" style={{ width: 260 }} placeholder="Scan the car, remote or batch label" value={q} onChange={e => setQ(e.target.value)} />
          <button className="btn sm" type="submit">Find</button>
        </form>
      </div>
      {bad && <div className="err">{bad}</div>}
      {look ? <UnitLabelJobs key={`${look.upc}#${look.n}`} upc={look.upc} done={() => input.current?.focus()} />
        : <div className="dim">For a faded or torn EAN or UPC label on a packed unit’s box. It prints on the bench’s label printer. The LOT sticker on the toy itself is not reprinted here.</div>}
    </div>
  );
}

const LABELS = [['ean_job', 'EAN label'], ['batch_job', 'UPC label']];
// Why a label has no Reprint button. A failed or unknown one is the list below's call (look at the printer first).
const NO_REPRINT = { pending: 'waiting to print', leased: 'printing now', outcome_unknown: 'see the list below',
  failed: 'see the list below', cancelled: 'no label is queued — tell LOT' };
function UnitLabelJobs({ upc, done }) {
  const { showToast } = useToast();
  const d = useLoad(`/v/unit_labels?upc=${encodeURIComponent(upc)}`);
  const [ask, setAsk] = useState(null);           // the job as it was when the dialog opened: { id, status, name, bench }
  const u = d.data;
  if (d.loading) return <div className="empty">Loading…</div>;
  if (d.error) return <div className="err">{d.error === 'Not found.' ? `${upc} is not a unit packed here.` : d.error}</div>;
  const packed = u.current_status === 'vendor_packed';
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <b className="mono">{u.upc}</b>
        <span>{[u.product, u.model, u.color].filter(Boolean).join(' · ')}</span>
        {u.batch_label && <span className="dim mono">{u.batch_label}</span>}
        <Badge s={u.current_status} />
      </div>
      {!packed && <div className="warn">This unit is no longer packed here, so its labels cannot be reprinted.</div>}
      <table className="t">
        <thead><tr><th>Label</th><th>Bench</th><th>Status</th><th>Printed</th><th></th></tr></thead>
        <tbody>{LABELS.map(([k, name]) => {
          const j = u[k];
          return (
            <tr key={k}>
              <td>{name}</td>
              <td>{j?.device?.bench_no ?? '—'}</td>
              <td>{j ? <Badge s={j.status} /> : <span className="dim">none</span>}{j?.reprints ? <span className="dim"> · {j.reprints} reprint{j.reprints > 1 ? 's' : ''}</span> : null}</td>
              <td className="dim">{fmtTime(j?.printed_at)}</td>
              <td style={{ textAlign: 'right' }}>
                {packed && j?.status === 'printed' && (
                  <button className="btn sm" onClick={() => setAsk({ id: Number(j.id), status: j.status, name, bench: j.device?.bench_no })}>Reprint</button>
                )}
                {packed && j && NO_REPRINT[j.status] && <span className="dim">{NO_REPRINT[j.status]}</span>}
                {packed && !j && <span className="dim">no label printed — tell LOT</span>}
              </td>
            </tr>
          );
        })}</tbody>
      </table>
      {ask && (
        <Confirm title={`Reprint the ${ask.name} for ${u.upc}?`} yes="Reprint" onClose={() => { setAsk(null); done(); }}
          body={`Use this when the label is faded or torn. It prints on bench ${ask.bench ?? '—'}'s printer. Peel the old label off and stick the new one in its place — never leave two on one unit.`}
          onYes={async () => {
            // The job as it was when the dialog opened: one that moved meanwhile is refused, and the dialog closes so a
            // second Yes cannot reprint a label whose outcome is now unknown.
            const r = await act('print_resolve', { job_id: ask.id, action: 'reprint', expected_status: ask.status });
            setAsk(null); d.reload(); done();
            if (!r.ok) { showToast(`${say(r)} The unit has been refreshed.`, 'error'); return null; }
            showToast(`${ask.name} for ${u.upc} sent to print`, 'success');
            return null;
          }} />
      )}
    </>
  );
}
