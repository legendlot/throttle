'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, EmptyState, useToast } from '@throttle/ui';

const REASONS = [
  { id: 'orders_cancelled', label: 'Orders Cancelled' },
  { id: 'unsold_inventory', label: 'Unsold Inventory' },
  { id: 'sample_return',    label: 'Sample Return' },
  { id: 'other',            label: 'Other' },
];
const reasonLabel = id => (REASONS.find(r => r.id === id) || { label: id }).label;

const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const phdr  = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const pbody = { padding: '12px 14px' };
const th    = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td    = { padding: '8px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, verticalAlign: 'top', fontFamily: 'var(--mono)' };
const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const btnP  = { background: '#f2cd1a', border: 'none', borderRadius: 3, padding: '9px 16px', fontSize: 13, color: '#0a0a0a', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 11px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.05em', textTransform: 'uppercase' };
const chip  = { padding: '6px 12px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', border: '1px solid var(--border)', background: 'transparent', color: 'var(--t2)', cursor: 'pointer' };
const chipA = { ...chip, background: '#f2cd1a', color: '#0a0a0a', border: '1px solid #f2cd1a', fontWeight: 700 };
const tile  = { flex: '1 1 120px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: '10px 12px' };

function fmtTs(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return ts; }
}
function fmtISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function downloadCsv(filename, rows, cols) {
  if (!rows || !rows.length) return false;
  const lines = [cols.map(c => c.label).join(',')];
  for (const r of rows) lines.push(cols.map(c => JSON.stringify(r[c.key] ?? '')).join(','));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  return true;
}

// ── Bulk restock tab ──────────────────────────────────────────────
function BulkTab({ session, toast }) {
  const [text, setText]   = useState('');
  const [reason, setReason] = useState('orders_cancelled');
  const [note, setNote]   = useState('');
  const [busy, setBusy]   = useState(false);
  const [result, setResult] = useState(null);

  const upcs = useMemo(() => [...new Set(text.split(/[\s,]+/).map(s => s.trim()).filter(Boolean))], [text]);

  async function submit() {
    if (!upcs.length) { toast('Paste at least one UPC', 'error'); return; }
    if (reason === 'other' && !note.trim()) { toast('Note required for "Other"', 'error'); return; }
    if (!confirm(`Restock ${upcs.length} unit(s)? This flips them back to qc_pass and clears their packing.`)) return;
    setBusy(true); setResult(null);
    try {
      const r = await workerFetch('bulkRestock', { data: { upcs, reason, reason_note: note.trim() || null } }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); return; }
      setResult(r.data);
      toast(`${r.data.restocked} restocked, ${r.data.skipped} skipped`, r.data.restocked ? 'success' : 'error');
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div style={panel}>
        <div style={phdr}>Bulk Restock · paste UPC list</div>
        <div style={pbody}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {REASONS.map(rs => (
              <button key={rs.id} style={reason === rs.id ? chipA : chip} onClick={() => setReason(rs.id)}>{rs.label}</button>
            ))}
          </div>
          {reason === 'other' && (
            <input style={{ ...input, width: '100%', marginBottom: 12 }} placeholder="Reason note (required for Other)" value={note} onChange={e => setNote(e.target.value)} />
          )}
          <textarea
            style={{ ...input, width: '100%', minHeight: 160, fontFamily: 'var(--mono)', resize: 'vertical' }}
            placeholder={'Paste car UPCs — one per line, or comma/space separated\nLOT-00012345\nLOT-00012346'}
            value={text} onChange={e => setText(e.target.value)}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
            <button style={{ ...btnP, opacity: busy || !upcs.length ? 0.5 : 1 }} disabled={busy || !upcs.length} onClick={submit}>
              {busy ? 'Restocking…' : `Restock ${upcs.length} unit${upcs.length === 1 ? '' : 's'}`}
            </button>
            {text && <button style={btnS} onClick={() => { setText(''); setResult(null); }}>Clear</button>}
            <span style={{ fontSize: 11, color: 'var(--t3)' }}>{upcs.length} distinct UPC{upcs.length === 1 ? '' : 's'} · max 300/batch</span>
          </div>
        </div>
      </div>

      {result && (
        <div style={panel}>
          <div style={phdr}>
            <span>Result — {result.restocked} restocked · {result.skipped} skipped</span>
          </div>
          <div style={{ ...pbody, padding: 0 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>UPC</th><th style={th}>Outcome</th><th style={th}>Detail</th></tr></thead>
              <tbody>
                {result.results.map((r, i) => (
                  <tr key={i}>
                    <td style={{ ...td, color: '#f2cd1a' }}>{r.upc}</td>
                    <td style={{ ...td, color: r.status === 'restocked' ? '#4ade80' : '#ff9a9a' }}>{r.status}</td>
                    <td style={{ ...td, fontFamily: 'inherit', color: 'var(--t2)' }}>
                      {r.status === 'restocked'
                        ? `was ${r.status_before}${r.paired_remote_upc ? ` · remote ${r.paired_remote_upc}` : ''}`
                        : (r.detail || '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ── Report tab ────────────────────────────────────────────────────
function ReportTab({ session, toast }) {
  const today = useMemo(() => new Date(), []);
  const [reasonF, setReasonF] = useState('');
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 29); return fmtISO(d); });
  const [to, setTo]     = useState(fmtISO(today));
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!session) return;
    setLoading(true);
    try {
      const body = {};
      if (reasonF) body.reason = reasonF;
      if (from) body.from = from;
      if (to)   body.to = to;
      if (search.trim()) body.search = search.trim();
      const r = await workerFetch('getRestocks', { data: body }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); setData(null); return; }
      setData(r.data);
    } catch (e) { toast(e.message || 'Failed', 'error'); setData(null); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [session, reasonF, from, to]);

  const rows = data?.rows || [];
  const csvCols = [
    { key: 'car_upc', label: 'Car UPC' },
    { key: 'paired_remote_upc', label: 'Remote UPC' },
    { key: 'product', label: 'Product' },
    { key: 'model', label: 'Model' },
    { key: 'colour', label: 'Colour' },
    { key: 'reason', label: 'Reason' },
    { key: 'reason_note', label: 'Note' },
    { key: 'status_before', label: 'Status Before' },
    { key: 'channel_name', label: 'Channel' },
    { key: 'batch_label', label: 'Batch' },
    { key: 'operator_name', label: 'Operator' },
    { key: 'restocked_at', label: 'Restocked At' },
  ];

  return (
    <>
      <div style={panel}>
        <div style={phdr}>Restock Report</div>
        <div style={{ ...pbody, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select style={input} value={reasonF} onChange={e => setReasonF(e.target.value)}>
            <option value="">All reasons</option>
            {REASONS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <input type="date" style={input} value={from} onChange={e => setFrom(e.target.value)} />
          <span style={{ color: 'var(--t3)' }}>→</span>
          <input type="date" style={input} value={to} onChange={e => setTo(e.target.value)} />
          <input style={{ ...input, flex: '1 1 160px' }} placeholder="Search UPC…" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()} />
          <button style={btnS} onClick={load}>Apply</button>
          {rows.length > 0 && <button style={btnS} onClick={() => downloadCsv(`restocks-${from}-${to}.csv`, rows, csvCols)}>CSV</button>}
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : !data || rows.length === 0 ? (
        <EmptyState icon="🔄" message="No restocks in this range." />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            <div style={tile}><div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)', fontFamily: 'var(--mono)' }}>{data.total}</div><div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--t3)' }}>Total restocks</div></div>
            {data.byReason.map(b => (
              <div key={b.reason} style={tile}><div style={{ fontSize: 22, fontWeight: 800, color: '#f2cd1a', fontFamily: 'var(--mono)' }}>{b.count}</div><div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--t3)' }}>{reasonLabel(b.reason)}</div></div>
            ))}
            {data.byChannel.map(b => (
              <div key={b.channel} style={tile}><div style={{ fontSize: 22, fontWeight: 800, color: '#7b93ff', fontFamily: 'var(--mono)' }}>{b.count}</div><div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--t3)' }}>{b.channel}</div></div>
            ))}
          </div>

          <div style={panel}>
            <div style={{ ...pbody, padding: 0, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>Car UPC</th><th style={th}>Product</th><th style={th}>Colour</th>
                  <th style={th}>Reason</th><th style={th}>Was</th><th style={th}>Channel</th>
                  <th style={th}>Operator</th><th style={th}>When</th>
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td style={{ ...td, color: '#f2cd1a' }}>{r.car_upc}</td>
                      <td style={{ ...td, fontFamily: 'inherit' }}>{r.product || '—'}{r.model ? ` ${r.model}` : ''}</td>
                      <td style={{ ...td, fontFamily: 'inherit' }}>{r.colour || '—'}</td>
                      <td style={{ ...td, fontFamily: 'inherit' }}>{reasonLabel(r.reason)}</td>
                      <td style={td}>{r.status_before}</td>
                      <td style={{ ...td, fontFamily: 'inherit' }}>{r.channel_name || '—'}</td>
                      <td style={{ ...td, fontFamily: 'inherit' }}>{r.operator_name || '—'}</td>
                      <td style={{ ...td, fontSize: 11, color: 'var(--t3)' }}>{fmtTs(r.restocked_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default function RestockPage() {
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const allowed = hasPermission(perms, 'dispatch_restock') || hasPermission(perms, 'users_manage');
  const [tab, setTab] = useState('bulk');

  if (!allowed) {
    return <div style={{ padding: 16 }}><EmptyState icon="🔒" message="Access denied — you need dispatch_restock permission." /></div>;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <button style={tab === 'bulk' ? chipA : chip} onClick={() => setTab('bulk')}>Bulk Restock</button>
        <button style={tab === 'report' ? chipA : chip} onClick={() => setTab('report')}>Report</button>
      </div>
      {tab === 'bulk'   && <BulkTab session={session} toast={toast} />}
      {tab === 'report' && <ReportTab session={session} toast={toast} />}
    </div>
  );
}
