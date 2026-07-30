'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, EmptyState } from '@throttle/ui';
import { DIRECTION_LABEL, purposeLabel, returnState } from '../../../lib/gatePass.js';
import { todayStr } from '@throttle/domain';

const TONE = {
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.25)'  },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.3)'   },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.35)'  },
  orange: { bg: 'rgba(245,158,11,.15)', fg: '#fbbf24', border: 'rgba(245,158,11,.3)'  },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)'    },
};
const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const phdr  = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const th    = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td    = { padding: '8px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, verticalAlign: 'middle' };
const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnP  = { background: 'var(--accent, #213ce2)', border: 'none', borderRadius: 3, padding: '8px 14px', fontSize: 12, color: '#fff', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

function Badge({ tone, children }) {
  const s = TONE[tone] || TONE.gray;
  return <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase', background: s.bg, color: s.fg, border: `1px solid ${s.border}`, whiteSpace: 'nowrap' }}>{children}</span>;
}
function fmtTs(ts) { if (!ts) return '—'; try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ts; } }

function ReturnBadge({ gp }) {
  const st = returnState(gp);
  if (!st) return <span style={{ color: 'var(--t3)' }}>—</span>;
  if (st === 'returned') return <Badge tone="green">Returned</Badge>;
  if (st === 'overdue')  return <Badge tone="red">Overdue</Badge>;
  return <Badge tone="orange">Pending</Badge>;
}

export default function GatePassListPage() {
  const { session, perms } = useAuth();
  const router = useRouter();
  const canUse = hasPermission(perms || {}, 'gate_pass');

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [direction, setDirection] = useState('all');
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [overdue, setOverdue] = useState(false);

  async function load() {
    if (!session || !canUse) return;
    setLoading(true);
    try {
      const params = {};
      if (direction !== 'all') params.direction = direction;
      if (status !== 'all') params.status = status;
      if (q.trim()) params.q = q.trim();
      if (from) params.date_from = from;
      if (to) params.date_to = to;
      if (overdue) params.overdue_returnable = '1';
      const data = await garageFetch('getGatePasses', params, session);
      setRows(Array.isArray(data) ? data : []);
    } catch { setRows([]); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [session, direction, status, overdue]);

  const counts = useMemo(() => {
    const o = rows.filter((r) => returnState(r) === 'overdue').length;
    return { total: rows.length, overdue: o };
  }, [rows]);

  function exportCsv() {
    const cols = ['gate_pass_no','direction','gate_datetime','status','vehicle_no','person_name','person_phone','transporter_name','box_count','purpose','party_name','reference_no','material_description','is_returnable','expected_return_date','returned_at','remarks','created_by_name'];
    const head = cols.join(',');
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const body = rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\n');
    const blob = new Blob([head + '\n' + body], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gate-passes-${todayStr()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (!canUse) return <div style={{ padding: 24, color: 'var(--t3)' }}>You don&apos;t have access to Gate Pass.</div>;

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontFamily: 'var(--cond)', letterSpacing: '.02em' }}>Gate Pass</h1>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
            Store entry / exit log · {counts.total} shown{counts.overdue ? ` · ${counts.overdue} overdue returnable` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnS} onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
          <button style={btnP} onClick={() => router.push('/gate-pass/new')}>+ New Gate Pass</button>
        </div>
      </div>

      <div style={panel}>
        <div style={{ padding: '12px 14px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={lbl}>Direction</label>
            <select style={input} value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="all">All</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </select>
          </div>
          <div>
            <label style={lbl}>Status</label>
            <select style={input} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active</option>
              <option value="void">Void</option>
              <option value="all">All</option>
            </select>
          </div>
          <div>
            <label style={lbl}>From</label>
            <input style={input} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label style={lbl}>To</label>
            <input style={input} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={lbl}>Search (GP / vehicle / party)</label>
            <input style={{ ...input, width: '100%' }} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(); }} placeholder="GP-12, KA01…, vendor name" />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)', cursor: 'pointer', paddingBottom: 6 }}>
            <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />
            Overdue returnables
          </label>
          <button style={btnS} onClick={load}>Apply</button>
        </div>
      </div>

      <div style={panel}>
        <div style={phdr}><span>Gate Passes</span></div>
        {loading ? (
          <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : !rows.length ? (
          <EmptyState title="No gate passes" subtitle="Create one with + New Gate Pass." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>GP No</th>
                  <th style={th}>Dir</th>
                  <th style={th}>Date</th>
                  <th style={th}>Vehicle</th>
                  <th style={th}>Party</th>
                  <th style={th}>Purpose</th>
                  <th style={{ ...th, textAlign: 'right' }}>Boxes</th>
                  <th style={th}>Returnable</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/gate-pass/detail?id=${r.id}`)}>
                    <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow, #f2cd1a)' }}>{r.gate_pass_no}</td>
                    <td style={td}><Badge tone={r.direction === 'inbound' ? 'blue' : 'orange'}>{DIRECTION_LABEL[r.direction] || r.direction}</Badge></td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtTs(r.gate_datetime)}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)' }}>{r.vehicle_no || '—'}</td>
                    <td style={td}>{r.party_name || '—'}</td>
                    <td style={td}>{purposeLabel(r.direction, r.purpose)}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)' }}>{r.box_count ?? '—'}</td>
                    <td style={td}><ReturnBadge gp={r} /></td>
                    <td style={td}>{r.status === 'void' ? <Badge tone="red">Void</Badge> : <Badge tone="green">Active</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
