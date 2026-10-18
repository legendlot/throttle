'use client';
/* ════════════════════════════════════════════════════════════
   OUTPOST › MONITOR — where every vendor unit is, and the vendor's
   reports (O10, S426).

   Overview: units by stage (at the vendor → on the road → in QC →
   LOT stock), the leakage flags (stickers left unused, packed units
   not dispatched, packing past the PO line) and the print agents.
   Units: every car the vendor packed — date, UPC, remote, batch label,
   carton, consignment, operator, status — searchable, CSV export.
   Reports: sticker reconciliation (minted = applied + void + damaged +
   outstanding), output per day from the immutable pack history,
   consignments sent → received → accepted with the PO value payable,
   and defects against the vendor's tolerance.
   ════════════════════════════════════════════════════════════ */
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import { Panel, FilterChip, ToneBadge, KpiTile, istTodayISO } from '../../../components/kit/index.js';
import { opGet, fmtIST } from '../../../lib/outpost.js';
import { ErrorPanel, Input, OwnerGate, Select, label, mono, smallBtn, text, useOutpostVendors } from '../../../components/outpost/OutpostKit.js';

const num = v => Number(v || 0).toLocaleString('en-IN');
const rupees = v => (v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const td = { padding: 8 };
const th = { ...label, textAlign: 'left', padding: '6px 8px' };
const TABS = [['overview', 'Overview'], ['units', 'Units'], ['reports', 'Reports']];
// Unit stages, in the order a unit walks them.
const STAGES = [
  ['vendor_packed', 'Packed at vendor', 'At the vendor, in a carton', 'mute'],
  ['vendor_in_transit', 'On the road', 'Dispatched on a consignment (or short at receipt)', 'warn'],
  ['vendor_received', 'In QC at LOT', 'Received, waiting for the audit', 'warn'],
  ['lot', 'LOT stock and beyond', 'Accepted — dispatchable, allocated or shipped', 'ok'],
  ['vendor_rejected', 'Rejected', 'Failed QC, waiting for a disposition', 'bad'],
  ['vendor_unpacked', 'Back with the vendor', 'Un-packed, returned or released — stickers to re-pack', 'mute'],
];
const STATUS_WORD = {
  vendor_packed: 'packed at vendor', vendor_in_transit: 'on the road', vendor_received: 'in QC', vendor_rejected: 'rejected',
  vendor_unpacked: 'back with vendor', handed_over: 'LOT stock', allocated: 'allocated', packed_dispatch: 'packed for dispatch',
  shipped: 'shipped', qc_fail: 'rework at LOT',
};
const statusTone = s => (s === 'vendor_rejected' || s === 'qc_fail' ? 'bad' : s?.startsWith('vendor_') ? 'warn' : 'ok');
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export default function OutpostMonitorPage() {
  return <OwnerGate><MonitorInner /></OwnerGate>;
}

function MonitorInner() {
  const { session, userId } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const V = useOutpostVendors(session, userId);
  const [tab, setTab] = useState('overview');
  const today = istTodayISO();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [sum, setSum] = useState(null);
  const [err, setErr] = useState(null);

  const load = async () => {
    if (!V.vendorId) return;
    setRefreshing(true);
    try { setSum(await opGet('getSummary', { vendor_id: V.vendorId, from, to }, session)); setErr(null); }
    catch (e) { setErr(e.message); } finally { setRefreshing(false); setLastRefreshed(new Date()); }
  };
  useEffect(() => { setSum(null); load(); /* eslint-disable-next-line */ }, [V.vendorId, from, to]);

  if (V.loading) return <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (V.error) return <ErrorPanel error={V.error} onRetry={V.reload} />;
  if (!V.vendors.length) return <Panel pad={24}><div style={text}>No vendor is set up in Outpost yet — add one under Outpost › Vendors &amp; Devices.</div></Panel>;
  const preset = n => { setTo(today); setFrom(addDays(today, -n)); };

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ width: 260, maxWidth: '100%' }}>
          <Select value={V.vendorId || ''} onChange={e => V.setVendorId(Number(e.target.value))}>
            {V.vendors.map(v => <option key={v.vendor_id} value={v.vendor_id}>{v.vendor_name || `Vendor ${v.vendor_id}`}</option>)}
          </Select>
        </div>
        {TABS.map(([k, n]) => <FilterChip key={k} active={tab === k} onClick={() => setTab(k)}>{n}</FilterChip>)}
        {tab !== 'overview' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto' }}>
            <Input type="date" value={from} max={to} onChange={e => e.target.value && setFrom(e.target.value)} style={{ width: 150 }} aria-label="From" />
            <span style={text}>to</span>
            <Input type="date" value={to} min={from} max={today} onChange={e => e.target.value && setTo(e.target.value)} style={{ width: 150 }} aria-label="To" />
            <button style={smallBtn} onClick={() => preset(0)}>Today</button>
            <button style={smallBtn} onClick={() => preset(6)}>7 days</button>
            <button style={smallBtn} onClick={() => preset(29)}>30 days</button>
          </div>
        )}
      </div>
      {tab === 'units' ? <Units key={V.vendorId} vendorId={V.vendorId} from={from} to={to} />
        : err && !sum ? <ErrorPanel error={err} onRetry={load} />
        : !sum ? <Spinner />
        : tab === 'overview' ? <Overview s={sum} /> : <Reports s={sum} />}
    </div>
  );
}

// ── Overview ────────────────────────────────────────────────
function Overview({ s }) {
  const st = s.status || {};
  const lot = Object.entries(st).filter(([k]) => !k.startsWith('vendor_')).reduce((a, [, n]) => a + Number(n), 0);
  const count = k => (k === 'lot' ? lot : Number(st[k] || 0));
  const L = s.leaks || {};
  const t = s.thresholds || {};
  const flags = [
    { on: Number(L.unused_stickers?.count) > 0, tone: 'warn', title: `Stickers unused for more than ${t.unused_sticker_days} days`,
      body: <>{num(L.unused_stickers?.count)} sticker{Number(L.unused_stickers?.count) === 1 ? '' : 's'} minted and not on a unit — oldest {fmtIST(L.unused_stickers?.oldest)}. Ask the vendor to use, void or return them.</> },
    { on: Number(L.packed_undispatched?.count) > 0, tone: 'warn', title: `Packed but not dispatched for more than ${t.packed_undispatched_days} days`,
      body: <>{num(L.packed_undispatched?.count)} unit{Number(L.packed_undispatched?.count) === 1 ? '' : 's'} — oldest {fmtIST(L.packed_undispatched?.oldest)}.
        {!!L.packed_undispatched?.cartons?.length && <> Cartons: <span style={mono}>{L.packed_undispatched.cartons.join(', ')}</span></>}</> },
    ...(L.over_po || []).map(o => ({ on: true, tone: 'bad', title: `Packing past the PO — ${o.po_number}`,
      body: <>{[o.product, o.variant, o.color].filter(Boolean).join(' · ')}: {num(o.packed)} packed against {num(o.ordered)} ordered (+{o.over_pct}%, limit {t.over_po_pct}%).</> })),
  ].filter(f => f.on);
  const agents = (s.devices || []).filter(d => d.kind === 'agent');
  const benches = (s.devices || []).filter(d => d.kind === 'bench');
  const P = s.print || {};
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
        {STAGES.map(([k, name, sub, tone]) => <KpiTile key={k} label={name} value={num(count(k))} sub={sub} tone={count(k) ? tone : undefined} />)}
      </div>
      <Panel title={`Leakage flags (${flags.length})`} pad={12}>
        {!flags.length ? <div style={text}>Nothing flagged. Limits for this vendor: stickers unused {t.unused_sticker_days} days ·
          packed not dispatched {t.packed_undispatched_days} days · packed {t.over_po_pct}% past the PO line (set under Vendors &amp; Devices).</div>
          : flags.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <ToneBadge tone={f.tone}>flag</ToneBadge>
              <div><div style={{ ...text, color: 'var(--t1)', fontWeight: 600 }}>{f.title}</div><div style={text}>{f.body}</div></div>
            </div>
          ))}
      </Panel>
      <Panel title="Printing at the vendor" pad={12}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
          {!agents.length && <div style={text}>No print agent is enrolled — labels cannot print at the vendor.</div>}
          {agents.map(a => {
            const pr = Array.isArray(a.agent_status?.printers) ? a.agent_status.printers : [];
            return (
              <div key={a.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ ...text, color: 'var(--t1)', fontWeight: 600 }}>{a.label || `Agent ${a.id}`}{a.bench_no ? ` · bench ${a.bench_no}` : ''}</span>
                  <ToneBadge tone={!a.online ? 'bad' : a.printers_ok ? 'ok' : 'warn'}>{!a.online ? 'offline' : a.printers_ok ? 'online' : 'printer problem'}</ToneBadge>
                </div>
                <div style={{ ...text, fontSize: 12 }}>Last heartbeat {fmtIST(a.agent_status_at)}{a.agent_status?.version ? ` · v${a.agent_status.version}` : ''}
                  {a.agent_status?.queue != null ? ` · queue ${a.agent_status.queue}` : ''}</div>
                {pr.map((p, i) => <div key={i} style={{ ...text, fontSize: 12 }}>
                  <ToneBadge tone={p.ok ? 'ok' : 'bad'}>{p.ok ? 'ok' : 'down'}</ToneBadge> {p.role}: <span style={mono}>{p.name || '—'}</span>{p.detail ? ` — ${p.detail}` : ''}</div>)}
              </div>
            );
          })}
        </div>
        <div style={{ ...text, marginTop: 10 }}>Jobs: {num(P.pending)} waiting · {num(P.leased)} printing ·{' '}
          <span style={{ color: Number(P.outcome_unknown) ? 'var(--warn-fg)' : undefined }}>{num(P.outcome_unknown)} outcome unknown</span> ·{' '}
          <span style={{ color: Number(P.failed) ? 'var(--bad-fg)' : undefined }}>{num(P.failed)} failed</span> · {num(P.late_print)} late prints to throw away.
          Benches: {benches.filter(b => b.online).length} of {benches.length} seen in the last 5 minutes.</div>
      </Panel>
    </div>
  );
}

// ── Units ───────────────────────────────────────────────────
const UNIT_FILTERS = [['', 'All'], ['vendor_packed', 'At vendor'], ['vendor_in_transit', 'On the road'], ['vendor_received', 'In QC'],
  ['lot', 'LOT stock+'], ['vendor_rejected', 'Rejected'], ['vendor_unpacked', 'Back with vendor']];
const CSV_HEAD = ['Packed (IST)', 'Car UPC', 'Remote UPC', 'Batch label', 'Product', 'Model', 'Colour', 'Work order', 'Channel', 'Carton',
  'Carton status', 'Consignment', 'Consignment status', 'Dispatched (IST)', 'Operator', 'Bench', 'Status', 'Reject reason', 'Disposition'];
const istStamp = ts => (ts ? new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }) : '');
const csvRow = u => [istStamp(u.packed_at), u.upc, u.remote_upc, u.batch_label, u.product, u.model, u.color, u.wo_no, u.channel, u.ctn_no,
  u.ctn_status, u.csg_no, u.csg_status, istStamp(u.dispatched_at), [u.op_code, u.op_name].filter(Boolean).join(' '), u.bench_no, u.status,
  u.reject_reason, u.disposition];
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function Units({ vendorId, from, to }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [allDates, setAllDates] = useState(true);
  const [rows, setRows] = useState(null);
  const [next, setNext] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(null);
  const params = { vendor_id: vendorId, status, q: qApplied, ...(allDates ? {} : { from, to }) };

  const load = async (before) => {
    setBusy(true);
    try {
      const d = await opGet('getUnits', { ...params, before, limit: 200 }, session);
      setRows(p => (before ? [...(p || []), ...d.rows] : d.rows)); setNext(d.next); setErr(d.q_matched === false ? 'Nothing matches that code.' : null);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { setRows(null); load(null); /* eslint-disable-next-line */ }, [vendorId, status, qApplied, allDates, from, to]);

  const exportCsv = async () => {
    setExporting(0);
    try {
      const out = []; let before = null;
      // every page until the last (no silent cap); a stuck cursor is an error, never a short file
      for (;;) {
        const d = await opGet('getUnits', { ...params, before, limit: 1000 }, session);
        out.push(...d.rows); setExporting(out.length);
        if (!d.next) break;
        if (d.next === before) throw new Error('Export stopped: the unit list did not advance. Try again.');
        before = d.next;
      }
      const csv = [CSV_HEAD, ...out.map(csvRow)].map(r => r.map(csvCell).join(',')).join('\r\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `outpost-units-${vendorId}-${istTodayISO()}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      showToast(`${num(out.length)} units exported`, 'success');
    } catch (e) { showToast(e.message, 'error'); } finally { setExporting(null); }
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {UNIT_FILTERS.map(([k, n]) => <FilterChip key={k || 'all'} active={status === k} onClick={() => setStatus(k)}>{n}</FilterChip>)}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <form onSubmit={e => { e.preventDefault(); setQApplied(q.trim()); }} style={{ display: 'flex', gap: 6, flex: '1 1 320px' }}>
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="UPC, remote, batch label, CTN-…, CSG-… or OWO-…" style={{ ...mono }} />
          <button type="submit" style={smallBtn}>Find</button>
          {qApplied && <button type="button" style={smallBtn} onClick={() => { setQ(''); setQApplied(''); }}>Clear</button>}
        </form>
        <label style={{ ...text, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={!allDates} onChange={() => setAllDates(v => !v)} />packed in the date range only</label>
        <button style={smallBtn} disabled={exporting !== null || !rows?.length} onClick={exportCsv}>
          {exporting !== null ? `Exporting… ${num(exporting)}` : 'Export CSV'}</button>
      </div>
      {err && rows && !rows.length ? <Panel pad={16}><div style={text}>{err}</div></Panel>
        : err && !rows ? <ErrorPanel error={err} onRetry={() => load(null)} />
        : !rows ? <Spinner /> : (
        <Panel pad={8}>
          {!rows.length ? <div style={{ ...text, padding: 24, textAlign: 'center' }}>No units.</div> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1100 }}>
                <thead><tr>{['Packed', 'Car UPC', 'Remote', 'Batch label', 'Product', 'Order', 'Carton', 'Consignment', 'Operator', 'Status'].map(h =>
                  <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>{rows.map(u => (
                  <tr key={u.upc} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...text, ...td, whiteSpace: 'nowrap' }}>{fmtIST(u.packed_at)}</td>
                    <td style={{ ...mono, ...td, color: 'var(--t1)' }}>{u.upc}</td>
                    <td style={{ ...mono, ...td }}>{u.remote_upc || '—'}</td>
                    <td style={{ ...mono, ...td }}>{u.batch_label || '—'}</td>
                    <td style={{ ...text, ...td }}>{[u.product, u.model, u.color].filter(Boolean).join(' · ')}</td>
                    <td style={{ ...text, ...td }}><span style={mono}>{u.wo_no || '—'}</span>{u.channel && <span style={{ color: 'var(--t3)' }}> · {u.channel}</span>}</td>
                    <td style={{ ...mono, ...td }}>{u.ctn_no || '—'}{u.ctn_status && <span style={{ color: 'var(--t3)' }}> · {u.ctn_status}</span>}</td>
                    <td style={{ ...mono, ...td }}>{u.csg_no || '—'}{u.csg_status && <span style={{ color: 'var(--t3)' }}> · {u.csg_status}</span>}</td>
                    <td style={{ ...text, ...td }}>{u.op_code ? `${u.op_code} ${u.op_name || ''}` : '—'}{u.bench_no ? <span style={{ color: 'var(--t3)' }}> · b{u.bench_no}</span> : null}</td>
                    <td style={td} title={u.reject_reason || undefined}><ToneBadge tone={statusTone(u.status)}>{STATUS_WORD[u.status] || u.status}</ToneBadge></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {next && <div style={{ padding: 10, textAlign: 'center' }}>
            <button style={smallBtn} disabled={busy} onClick={() => load(next)}>{busy ? 'Loading…' : `Show more (${num(rows.length)} shown)`}</button></div>}
        </Panel>
      )}
    </div>
  );
}

// ── Reports ─────────────────────────────────────────────────
function Reports({ s }) {
  const out = s.output || [];
  const tot = out.reduce((a, d) => ({ packs: a.packs + Number(d.packs), unpacks: a.unpacks + Number(d.unpacks), new_units: a.new_units + Number(d.new_units) }),
    { packs: 0, unpacks: 0, new_units: 0 });
  const D = s.defects || {};
  const over = D.pct != null && Number(D.pct) > Number(D.tolerance_pct);
  const cs = s.consignments || [];
  const pay = cs.reduce((a, c) => a + Number(c.payable || 0), 0);
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Panel title="Stickers — minted = applied + void + damaged + outstanding" pad={8}>
        {!(s.stickers || []).length ? <div style={{ ...text, padding: 12 }}>No stickers minted yet.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead><tr>{['Code', 'Minted (all time)', 'Minted in range', 'Applied', 'Voided', 'Damaged', 'Outstanding', `Stale (> ${s.thresholds?.unused_sticker_days} d)`, 'Check'].map(h =>
                <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{s.stickers.map(x => (
                <tr key={x.product_code} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...mono, ...td, color: 'var(--t1)' }}>{x.product_code}</td>
                  {['minted', 'minted_in_range', 'applied', 'voided', 'damaged', 'outstanding'].map(k => <td key={k} className="num" style={td}>{num(x[k])}</td>)}
                  <td className="num" style={{ ...td, color: Number(x.stale) ? 'var(--warn-fg)' : undefined }}>{num(x.stale)}</td>
                  <td style={td}>{Number(x.other) ? <ToneBadge tone="bad">{num(x.other)} unaccounted</ToneBadge> : <ToneBadge tone="ok">balances</ToneBadge>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title={`Output — ${num(tot.new_units)} new units, ${num(tot.packs)} packs, ${num(tot.unpacks)} un-packs`} pad={8}>
        {!out.length ? <div style={{ ...text, padding: 12 }}>Nothing packed in this range.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
              <thead><tr>{['Day (IST)', 'New units', 'Packs', 'Un-packs'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{out.map(d => (
                <tr key={d.day} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...text, ...td }}>{d.day}</td>
                  <td className="num" style={{ ...td, color: 'var(--t1)', fontWeight: 600 }}>{num(d.new_units)}</td>
                  <td className="num" style={td}>{num(d.packs)}</td>
                  <td className="num" style={td}>{num(d.unpacks)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <div style={{ ...text, fontSize: 12, padding: '6px 8px' }}>New units = a car's first-ever pack. A re-pack after an un-pack or a return counts as a pack, not a new unit.</div>
      </Panel>
      <Panel title={`Consignments dispatched in range (${cs.length}) — payable ${rupees(pay)}`} pad={8}>
        {!cs.length ? <div style={{ ...text, padding: 12 }}>No consignment dispatched in this range.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
              <thead><tr>{['Consignment', 'Dispatched', 'Status', 'Sent', 'Received', 'Short open', 'Accepted', 'Rejected', 'GRN', 'Payable (PO price, ex-GST)'].map(h =>
                <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{cs.map(c => (
                <tr key={c.csg_no} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...mono, ...td, color: 'var(--t1)' }}>{c.csg_no}</td>
                  <td style={{ ...text, ...td }}>{fmtIST(c.dispatched_at)}</td>
                  <td style={td}><ToneBadge tone={c.status === 'accepted' ? 'ok' : c.status === 'hold' ? 'bad' : 'warn'}>{c.status}</ToneBadge></td>
                  <td className="num" style={td}>{num(c.sent)}</td>
                  <td className="num" style={td}>{c.received == null ? '—' : num(c.received)}</td>
                  <td className="num" style={{ ...td, color: Number(c.short_open) ? 'var(--warn-fg)' : undefined }}>{num(c.short_open)}</td>
                  <td className="num" style={td}>{c.accepted == null ? '—' : num(c.accepted)}</td>
                  <td className="num" style={td}>{c.rejected == null ? '—' : num(c.rejected)}</td>
                  <td style={{ ...mono, ...td }}>{[c.grn_no, ...(c.late_grns || [])].filter(Boolean).join(', ') || '—'}</td>
                  <td className="num" style={td}>{c.status !== 'accepted' ? '—' : <>{rupees(c.payable)}{Number(c.unpriced) > 0 &&
                    <span style={{ color: 'var(--warn-fg)' }}> · {num(c.unpriced)} without a PO line</span>}</>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Defects — consignments decided in range" pad={12}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10, marginBottom: 10 }}>
          <KpiTile label="Accepted" value={num(D.accepted)} />
          <KpiTile label="Rejected" value={num(D.rejected)} tone={Number(D.rejected) ? 'warn' : undefined} />
          <KpiTile label="Defect rate" value={D.pct == null ? '—' : `${D.pct}%`} sub={`of what QC checked · tolerance ${D.tolerance_pct}%`} tone={D.pct == null ? undefined : over ? 'bad' : 'ok'} />
        </div>
        <div style={{ ...text, fontSize: 12, marginBottom: 8 }}>Rate per consignment = fails in the audit sample (plus units found late and checked)
          ÷ units checked; a consignment on hold = rejected ÷ received. Weighted by units received. Accepted / rejected above are unit counts.</div>
        {over && <div style={{ ...text, color: 'var(--bad-fg)', marginBottom: 8 }}>Above the vendor's tolerance — an SLA breach for this period.</div>}
        {!!(D.reasons || []).length && <>
          <div style={label}>Top reasons</div>
          {D.reasons.map(r => <div key={r.reason} style={text}><span className="num" style={{ color: 'var(--t1)' }}>{num(r.n)}</span> · {r.reason}</div>)}
        </>}
      </Panel>
    </div>
  );
}
