'use client';
// Printing: are the print agents and printers alive, and which labels need a person. A job whose outcome is unknown
// (the agent lost contact mid-print) is NEVER reprinted by itself: a supervisor looks at the printer and decides.
import { useState } from 'react';
import { useToast } from '@throttle/ui/Toast.js';
import { act, say } from './api.js';
import { ago, Badge, Confirm, fmtTime, useLoad } from './ui.js';

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
