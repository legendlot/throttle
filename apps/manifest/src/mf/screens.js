'use client';
// Manifest "Pit Wall" — all screens, wired to live getBootstrap data.
import React, { useState, useEffect } from 'react';
import { garageFetch, workerFetch } from '@throttle/db';
import { ArrowLeft, ArrowRight, Plus, ChevronDown, FileText, Check, Truck, Ship as ShipIcon, Search, X } from 'lucide-react';
import {
  Card, Table, Badge, Btn, Field, Input, Select, Textarea, Eyebrow, Mono,
  BalanceChart, Sparkline, MONO, DISP, toneVar,
} from './ui.js';
import { Manual } from '@throttle/ui';
import manualData from '../data/manual.json';
import * as D from './data.js';

// in-app System Manual (shared viewer, themed via Manifest's CSS vars)
function ManualScreen() { return <Manual manual={manualData} />; }

const gap = 'var(--gap)';
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDay = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? String(iso) : String(d.getUTCDate()).padStart(2, '0') + ' ' + MON[d.getUTCMonth()]; };

function Kpi({ eyebrow, value, color = 'var(--t1)', sub, size = 29 }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', padding: 'var(--cardpad)' }}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <div style={{ fontFamily: DISP, fontWeight: 700, fontSize: size, letterSpacing: '-.01em', color, whiteSpace: 'nowrap', margin: '8px 0 4px' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--t2)' }}>{sub}</div>
    </div>
  );
}
const Grid = ({ cols, children, style }) => <div style={{ display: 'grid', gridTemplateColumns: cols, gap, ...style }}>{children}</div>;
const Stack = ({ children, style }) => <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>{children}</div>;
const Dot = ({ tone }) => <span style={{ width: 8, height: 8, borderRadius: 999, background: toneVar(tone), flexShrink: 0 }} />;
const PO = (v) => v ? <Mono color="var(--green)" size={11}>{v}</Mono> : <Mono color="var(--t3)" size={11}>—</Mono>;
const Amt = (n) => <Mono color={n < 0 ? 'var(--red)' : 'var(--green)'} weight={600}>{D.signedInr(n)}</Mono>;
const LinkText = ({ children, onClick }) => <span className="mf-link" onClick={onClick} style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 600 }}>{children}</span>;
const FilterChip = ({ children, active, onClick }) => (
  <button className="mf-chip" onClick={onClick} style={{ padding: '8px 12px', borderRadius: 8, fontFamily: MONO, fontSize: 11,
    background: active ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'var(--surface)',
    border: '1px solid ' + (active ? 'color-mix(in srgb, var(--accent) 32%, transparent)' : 'var(--border)'),
    color: active ? 'var(--accent)' : 'var(--t2)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>{children}</button>
);
const BackChip = ({ children, onClick }) => (
  <button className="mf-chip" onClick={onClick} style={{ padding: '7px 12px', borderRadius: 8, fontFamily: MONO, fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--t2)', display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 16 }}>
    <ArrowLeft size={13} />{children}</button>
);
const Dropdown = ({ children }) => (
  <span className="mf-chip" style={{ padding: '8px 12px', borderRadius: 8, fontFamily: MONO, fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--t2)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
    {children}<ChevronDown size={13} color="var(--t3)" /></span>
);
const Empty = ({ children }) => <div style={{ padding: '28px 20px', fontFamily: MONO, fontSize: 11.5, color: 'var(--t3)', textAlign: 'center' }}>{children}</div>;

// searchable combobox — type to filter `items` by `label`, click a match to onPick(item)
function SearchBox({ value, onChange, items, onPick, placeholder, width = 360 }) {
  const [open, setOpen] = useState(false);
  const q = value.trim().toLowerCase();
  const matches = q ? items.filter((it) => it.label.toLowerCase().includes(q)).slice(0, 8) : [];
  return (
    <div style={{ position: 'relative', flex: 1, maxWidth: width }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface2)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '7px 11px', fontFamily: MONO, fontSize: 11.5 }}>
        <Search size={13} color="var(--t3)" style={{ flexShrink: 0 }} />
        <input value={value} placeholder={placeholder || 'Search…'}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 140)}
          onKeyDown={(e) => { if (e.key === 'Escape') { onChange(''); setOpen(false); e.target.blur(); } }}
          style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--t1)', fontFamily: MONO, fontSize: 11.5 }} />
        {value && <button className="mf-icobtn" onMouseDown={(e) => { e.preventDefault(); onChange(''); }}
          style={{ display: 'flex', background: 'transparent', border: 'none', color: 'var(--t3)', cursor: 'pointer', padding: 0 }}><X size={13} /></button>}
      </div>
      {open && q && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 40,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', overflow: 'hidden' }}>
          {matches.length ? matches.map((it) => (
            <div key={it.key} className="mf-tr click" onMouseDown={(e) => { e.preventDefault(); onPick(it); setOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', cursor: 'pointer',
                borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
              <Mono color="var(--t1)" weight={600} size={11.5}>{it.no}</Mono>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--t2)', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>
            </div>
          )) : <div style={{ padding: '12px 13px', fontFamily: MONO, fontSize: 11, color: 'var(--t3)' }}>No match</div>}
        </div>
      )}
    </div>
  );
}
const initials = (name) => (name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

const act = async (action, data, session) => { const r = await workerFetch(action, { data }, session); return r?.data; };

// canonical 10-step pipeline (production half + shipping half)
const PIPELINE = [
  { key: 'placed', label: 'Placed', phase: 'order' },
  { key: 'confirmed', label: 'Confirmed', phase: 'order' },
  { key: 'produced', label: 'Produced', phase: 'order' },
  { key: 'picked_up', label: 'Picked up', phase: 'order' },
  { key: 'loaded', label: 'Loaded', phase: 'ship' },
  { key: 'sailing', label: 'Sailing', phase: 'ship' },
  { key: 'docked', label: 'Docked', phase: 'ship' },
  { key: 'cleared', label: 'Cleared', phase: 'ship' },
  { key: 'local_transport', label: 'Local transit', phase: 'ship' },
  { key: 'received', label: 'Received', phase: 'ship' },
];
const SHIP_STAGES = ['loaded', 'sailing', 'docked', 'cleared', 'local_transport', 'received'];
const PROD_NEXT = { placed: 'confirmed', confirmed: 'produced', produced: 'picked_up' };

// horizontal stepper showing the composed timeline; stampByStage = { stage: isoDate }
function Timeline({ current, stampByStage = {} }) {
  const curIdx = PIPELINE.findIndex((s) => s.key === current);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, overflowX: 'auto', paddingBottom: 4 }}>
      {PIPELINE.map((s, i) => {
        const done = curIdx >= 0 && i < curIdx;
        const here = i === curIdx;
        const c = (done || here) ? 'var(--accent)' : 'var(--surface2)';
        const tc = here ? 'var(--t1)' : (done ? 'var(--t2)' : 'var(--t3)');
        return (
          <div key={s.key} style={{ flex: 1, minWidth: 64, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
            {i > 0 && <div style={{ position: 'absolute', top: 9, right: '50%', width: '100%', height: 2, background: i <= curIdx ? 'var(--accent)' : 'var(--border)' }} />}
            <div style={{ width: 20, height: 20, borderRadius: 999, background: done ? 'var(--accent)' : 'var(--surface)', border: `2px solid ${c}`, zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {done && <Check size={11} color="var(--accent-fg)" strokeWidth={3} />}
              {here && <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent)' }} />}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: '.04em', textTransform: 'uppercase', color: tc, marginTop: 7, textAlign: 'center', lineHeight: 1.3 }}>{s.label}</div>
            {stampByStage[s.key] && <div style={{ fontFamily: MONO, fontSize: 8, color: 'var(--t3)', marginTop: 2 }}>{fmtDay(stampByStage[s.key])}</div>}
          </div>
        );
      })}
    </div>
  );
}

// PO money: schedule + allocations + balance-due + allocate action
function MoneyCard({ order, money, schedule, allocations, payments, run, session }) {
  const [mode, setMode] = useState(null); // 'allocate' | 'schedule'
  const [amt, setAmt] = useState('');
  const [wire, setWire] = useState('');
  const [note, setNote] = useState('');
  const [sched, setSched] = useState(null);
  const total = Number(order.total_inr) || 0;
  const dueNow = money?.scheduledDueNow || 0;

  const allocate = () => {
    const a = Number(amt); if (!(a > 0)) return;
    run(() => act('allocateToPo', { order_id: order.id, amount_inr: a, payment_id: wire || null, note: note || null }, session));
    setMode(null); setAmt(''); setWire(''); setNote('');
  };
  const startSched = () => {
    setSched(schedule.length ? schedule.map((m) => ({ label: m.label, basis: m.pct != null ? 'pct' : 'amount', value: m.pct != null ? m.pct : m.amount_inr, due_stage: m.due_stage }))
      : [{ label: 'Advance', basis: 'pct', value: 30, due_stage: 'placed' }, { label: 'Balance', basis: 'pct', value: 70, due_stage: 'docked' }]);
    setMode('schedule');
  };
  const saveSched = () => {
    run(() => act('setPoSchedule', { order_id: order.id, milestones: sched.map((m, i) => ({ seq: i + 1, label: m.label, due_stage: m.due_stage, pct: m.basis === 'pct' ? m.value : null, amount_inr: m.basis === 'amount' ? m.value : null })) }, session));
    setMode(null);
  };
  const Row = ({ k, v, color, big }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: big ? '12px 0 4px' : '8px 0', borderBottom: big ? 'none' : '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
      <span style={{ fontFamily: big ? MONO : DISP, fontSize: big ? 10 : 12.5, letterSpacing: big ? '.1em' : 0, textTransform: big ? 'uppercase' : 'none', color: big ? 'var(--t3)' : 'var(--t2)' }}>{k}</span>
      <span style={{ fontFamily: big ? DISP : MONO, fontWeight: big ? 700 : 500, fontSize: big ? 20 : 12.5, color: color || 'var(--t1)' }}>{v}</span>
    </div>
  );
  return (
    <Card title="Payments & balance" bodyPad="16px 20px 18px"
      action={<span style={{ display: 'flex', gap: 8 }}>
        <Btn variant="secondary" style={{ padding: '6px 12px', fontSize: 11 }} onClick={startSched}>Schedule</Btn>
        <Btn style={{ padding: '6px 12px', fontSize: 11 }} onClick={() => setMode(mode === 'allocate' ? null : 'allocate')}>Allocate</Btn>
      </span>}>
      <Row k="Landed total" v={D.inr(total)} />
      <Row k="Allocated / paid" v={D.inr(money?.allocated || 0)} color="var(--green)" />
      <Row k="Balance due" v={D.inr(money?.balanceDue ?? total)} color={(money?.balanceDue ?? total) > 0 ? 'var(--red)' : 'var(--green)'} big />
      {dueNow > 0 && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 9, background: 'color-mix(in srgb, var(--accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 28%, transparent)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Mono size={10.5} color="var(--accent)" style={{ letterSpacing: '.08em' }}>DUE NOW (stage reached)</Mono>
          <Mono color="var(--accent)" weight={700}>{D.inr(dueNow)}</Mono>
        </div>
      )}
      {/* schedule */}
      {schedule.length > 0 && mode !== 'schedule' && (
        <div style={{ marginTop: 14 }}>
          <Eyebrow style={{ marginBottom: 8 }}>Schedule</Eyebrow>
          {schedule.map((m) => (
            <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 12 }}>
              <span style={{ color: 'var(--t2)' }}>{m.label} <Mono size={10} color="var(--t3)">@ {D.label(m.due_stage)}</Mono></span>
              <Mono color="var(--t1)">{m.pct != null ? `${m.pct}%` : D.inr(m.amount_inr)}</Mono>
            </div>
          ))}
        </div>
      )}
      {/* schedule editor */}
      {mode === 'schedule' && (
        <div style={{ marginTop: 14 }}>
          <Eyebrow style={{ marginBottom: 8 }}>Set schedule</Eyebrow>
          {sched.map((m, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.9fr 0.7fr 1.1fr', gap: 6, marginBottom: 7, alignItems: 'center' }}>
              <Input value={m.label} onChange={(e) => setSched((s) => s.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} style={{ padding: '7px 9px', fontSize: 12 }} />
              <Input value={m.value} onChange={(e) => setSched((s) => s.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={{ padding: '7px 9px', fontSize: 12 }} />
              <Select value={m.basis} onChange={(e) => setSched((s) => s.map((x, j) => j === i ? { ...x, basis: e.target.value } : x))} options={['pct', 'amount']} style={{ padding: '7px 9px', fontSize: 12 }} />
              <Select value={m.due_stage} onChange={(e) => setSched((s) => s.map((x, j) => j === i ? { ...x, due_stage: e.target.value } : x))} options={['placed', 'confirmed', 'produced', 'picked_up', 'loaded', 'sailing', 'docked', 'cleared', 'local_transport', 'received']} style={{ padding: '7px 9px', fontSize: 12 }} />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <Btn variant="secondary" style={{ padding: '6px 12px', fontSize: 11 }} onClick={() => setMode(null)}>Cancel</Btn>
            <Btn style={{ padding: '6px 12px', fontSize: 11 }} onClick={saveSched}>Save schedule</Btn>
          </div>
        </div>
      )}
      {/* allocate form */}
      {mode === 'allocate' && (() => {
        const balance = Math.round(money?.balanceDue ?? total);
        return (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Amount (₹)"><Input value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0" /></Field>
          {balance > 0 && (
            <button className="mf-chip" onMouseDown={(e) => { e.preventDefault(); setAmt(String(balance)); }}
              style={{ alignSelf: 'flex-start', padding: '6px 11px', borderRadius: 8, fontFamily: MONO, fontSize: 10.5, cursor: 'pointer',
                background: 'color-mix(in srgb, var(--accent) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)', color: 'var(--accent)' }}>
              Allocate full balance · {D.inr(balance)}
            </button>
          )}
          <Field label="Against wire (optional)"><Select value={wire} onChange={(e) => setWire(e.target.value)} options={['', ...(payments || []).map((p) => p.ref)]} /></Field>
          <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" /></Field>
          <Btn onClick={allocate}>Record allocation</Btn>
        </div>
        );
      })()}
      {/* allocations list */}
      {allocations.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Eyebrow style={{ marginBottom: 6 }}>Allocations</Eyebrow>
          {allocations.map((a) => (
            <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
              <span><Mono color="var(--green)" weight={600}>{D.inr(a.amount_inr)}</Mono> <Mono size={10} color="var(--t3)">{fmtDay(a.allocated_date)}{a.note ? ` · ${a.note}` : ''}</Mono></span>
              <button className="mf-icobtn" onClick={() => run(() => act('deleteAllocation', { id: a.id }, session))} style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--t3)', fontSize: 13, lineHeight: 1 }}>×</button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// searchable single-select — value-bound; options [{ value, label, sub }]
function SelectSearch({ value, onChange, options, placeholder }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const sel = options.find((o) => o.value === value);
  const query = q.trim().toLowerCase();
  const matches = query ? options.filter((o) => `${o.value} ${o.label} ${o.sub || ''}`.toLowerCase().includes(query)) : options;
  const pick = (o) => { onChange(o.value); setOpen(false); setQ(''); };
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="mf-input" onClick={() => setOpen((v) => !v)}
        style={{ ...selectBtnStyle }}>
        <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: sel ? 'var(--t1)' : 'var(--t3)' }}>
          {sel ? <>{sel.label}{sel.sub ? <span style={{ color: 'var(--t3)' }}> · {sel.sub}</span> : null}</> : (placeholder || 'Select…')}
        </span>
        <ChevronDown size={14} color="var(--t3)" style={{ flexShrink: 0 }} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 50, maxHeight: 320, overflow: 'hidden',
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px', borderBottom: '1px solid var(--border)' }}>
            <Search size={13} color="var(--t3)" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by ID or title…"
              onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); setQ(''); } }}
              style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--t1)', fontFamily: MONO, fontSize: 11.5 }} />
          </div>
          <div style={{ overflowY: 'auto' }}>
            {matches.length ? matches.map((o) => (
              <div key={o.value} className="mf-tr click" onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', cursor: 'pointer',
                  background: o.value === value ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                  borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
                <Mono color="var(--t1)" weight={600} size={11.5}>{o.label}</Mono>
                {o.sub && <span style={{ flex: 1, minWidth: 0, color: 'var(--t2)', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.sub}</span>}
              </div>
            )) : <div style={{ padding: '12px 13px', fontFamily: MONO, fontSize: 11, color: 'var(--t3)' }}>No match</div>}
          </div>
        </div>
      )}
      {open && <div onMouseDown={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 49 }} />}
    </div>
  );
}
const selectBtnStyle = { width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 8,
  background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--t1)', fontFamily: DISP, fontSize: 13, cursor: 'pointer' };

// ════════════════════════════════════════════════════════════════
function Dashboard({ data, onNav }) {
  const s = data.summary;
  const open = data.orders.filter((o) => o.costState !== 'invoiced');
  return (
    <Stack>
      <Grid cols="repeat(3,1fr)">
        <Kpi eyebrow="NET POSITION" value={D.inr(s.net)} color={s.owes ? 'var(--red)' : 'var(--green)'} sub={s.owes ? 'LOT owes SF' : 'SF holds LOT advance'} />
        <Kpi eyebrow="RESERVED LIEN" value={D.inr(s.reservedLien)} color="var(--accent)" sub="carved out · adjusted in-year" />
        <Kpi eyebrow="OPEN DRAW-DOWNS" value={D.inr(s.openDrawdowns)} color="var(--accent)" sub={`${s.openDrawCount} awaiting payment`} />
        <Kpi eyebrow="COMMISSION PAYABLE" value={D.inr(s.commissionPayable)} color="var(--red)" sub="uninvoiced SF commission" />
        <Kpi eyebrow="OPEN ORDERS" value={s.counts.inFlight} sub={`of ${s.counts.total} total`} />
        <Kpi eyebrow="PAYMENTS · FY" value={D.inr(s.credits)} color="var(--green)" sub={`${data.payments.length} wires`} />
      </Grid>
      <Grid cols="1.55fr 1fr">
        <Card title="Open orders" action={<LinkText onClick={() => onNav('orders')}>View all →</LinkText>}>
          {open.length ? (
            <Table onRowClick={(r) => onNav('orderDetail', r.id)} rows={open.slice(0, 6)} rowKey={(r) => r.no} cols={[
              { label: 'Order', render: (r) => <Mono color="var(--t1)" weight={600}>{r.no}</Mono> },
              { label: 'Title', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.title}</span> },
              { label: 'Value', align: 'right', render: (r) => r.valueRmb ? <Mono>{D.rmb(r.valueRmb)}</Mono> : <Mono color="var(--t3)">{D.inr(r.recognized)}</Mono> },
              { label: 'State', render: (r) => <Badge tone={D.costStateTone(r.costState)}>{D.label(r.costState)}</Badge> },
            ]} />
          ) : <Empty>No open orders</Empty>}
        </Card>
        <Card title="Activity">
          {data.activity.length ? (
            <div style={{ padding: '6px 20px 14px' }}>
              {data.activity.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '11px 0', borderBottom: i < data.activity.length - 1 ? '1px solid color-mix(in srgb, var(--border) 55%, transparent)' : 'none' }}>
                  <div style={{ marginTop: 5 }}><Dot tone={a.tone} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: 'var(--t1)' }}>{a.event} · <span style={{ color: 'var(--t2)' }}>{a.detail}</span></div>
                    <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>{a.who} · {a.when}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : <Empty>No recent activity</Empty>}
        </Card>
      </Grid>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
function Recon({ data, openDrill }) {
  const s = data.summary;
  const ledger = data.ledger;
  const ledgerDesc = [...ledger].reverse();
  const movements = ledgerDesc.filter((e) => ['payment', 'order_cost', 'commission', 'charge'].includes(e.kind)).slice(0, 6);
  const maxAbs = Math.max(1, ...movements.map((e) => Math.abs(e.amt)));
  return (
    <Stack>
      <Grid cols="1.5fr 1fr">
        <Card bodyPad="18px 20px 20px">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
            <div>
              <Eyebrow>RUNNING BALANCE</Eyebrow>
              <div style={{ fontFamily: DISP, fontWeight: 700, fontSize: 42, color: s.owes ? 'var(--red)' : 'var(--green)', letterSpacing: '-.02em', margin: '6px 0 2px' }}>{D.inr(s.net)}</div>
              <div style={{ fontSize: 12, color: 'var(--t2)' }}>{s.owes ? 'LOT owes Solve Factory' : 'Solve Factory holds LOT advance'}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <Eyebrow>RESERVED LIEN</Eyebrow>
              <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 18, color: 'var(--accent)', marginTop: 6 }}>{D.inr(s.reservedLien)}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)' }}>carved out</div>
            </div>
          </div>
          {ledger.length > 1 && (
            <div style={{ marginTop: 16 }}>
              <BalanceChart values={ledger.map((r) => r.balance)} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 9.5, color: 'var(--t3)', marginTop: 8 }}>
                <span>{fmtDay(ledger[0].date)}</span><span>peak {D.inr(s.peak)}</span><span>{fmtDay(ledger[ledger.length - 1].date)}</span>
              </div>
            </div>
          )}
        </Card>
        <Card title="Recent movements">
          {movements.length ? (
            <div style={{ padding: '8px 20px 14px' }}>
              {movements.map((e, i) => (
                <div key={i} style={{ padding: '9px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Mono size={11} color="var(--t3)">{e.ref} · {String(e.date).slice(5)}</Mono>{Amt(e.amt)}
                  </div>
                  <div style={{ height: 4, borderRadius: 999, background: 'var(--surface2)' }}>
                    <div style={{ height: '100%', borderRadius: 999, width: `${(Math.abs(e.amt) / maxAbs) * 100}%`, background: e.amt < 0 ? 'var(--red)' : 'var(--green)' }} />
                  </div>
                </div>
              ))}
            </div>
          ) : <Empty>No movements</Empty>}
        </Card>
      </Grid>
      <Grid cols="repeat(3,1fr)">
        <Kpi eyebrow="CREDITS · PAID IN" value={D.inr(s.credits)} color="var(--green)" size={24} sub={`${data.payments.length} wires`} />
        <Kpi eyebrow="DEBITS · GOODS + COSTS" value={D.inr(s.debits)} color="var(--red)" size={24} sub="goods + charges" />
        <Kpi eyebrow="BUFFER CONSUMED" value={`${s.bufferPct}%`} color="var(--accent)" size={24} sub="debits / credits" />
      </Grid>
      <Card title="Ledger" action={<Mono size={11} color="var(--t3)">full transaction history</Mono>}>
        {ledgerDesc.length ? (
          <Table onRowClick={openDrill} rows={ledgerDesc} rowKey={(r, i) => (r.ref || r.kind) + r.date + r.balance} cols={[
            { label: 'Date', render: (r) => <Mono size={11} color="var(--t3)">{r.date}</Mono> },
            { label: 'Type', render: (r) => <Badge tone={D.kindTone(r.kind)}>{D.label(r.kind)}</Badge> },
            { label: 'Ref', render: (r) => <Mono color="var(--t1)" weight={600}>{r.ref || '—'}</Mono> },
            { label: 'Description', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.desc}</span> },
            { label: 'Amount', align: 'right', render: (r) => Amt(r.amt) },
            { label: 'Balance', align: 'right', render: (r) => <Mono>{D.inr(r.balance)}</Mono> },
          ]} />
        ) : <Empty>No ledger entries</Empty>}
      </Card>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
function Orders({ data, onNav }) {
  const [q, setQ] = useState('');
  const items = data.orders.map((o) => ({ ...o, key: o.no, label: `${o.no} ${o.title || ''}` }));
  const query = q.trim().toLowerCase();
  const rows = query ? items.filter((it) => it.label.toLowerCase().includes(query)) : data.orders;
  return (
    <Stack>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Dropdown>All states</Dropdown>
        <Dropdown>All categories</Dropdown>
        <SearchBox value={q} onChange={setQ} items={items} onPick={(it) => onNav('orderDetail', it.id)} placeholder="Search orders by title or number…" />
        <div style={{ flex: 1 }} />
        <Btn onClick={() => onNav('newOrder')}><Plus size={14} style={{ marginRight: 6, verticalAlign: -2 }} />New Order</Btn>
      </div>
      <Card>
        {rows.length ? (
          <Table onRowClick={(r) => onNav('orderDetail', r.id)} rows={rows} rowKey={(r) => r.no} cols={[
            { label: 'Order', render: (r) => <Mono color="var(--t1)" weight={600}>{r.no}</Mono> },
            { label: 'Title', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.title}</span> },
            { label: 'Category', render: (r) => <Mono size={11} color="var(--t3)">{D.label(r.category)}</Mono> },
            { label: 'Value (RMB)', align: 'right', render: (r) => r.valueRmb ? <Mono>{D.rmb(r.valueRmb)}</Mono> : <Mono color="var(--t3)">—</Mono> },
            { label: 'Snorkel PO', render: (r) => PO(r.po) },
            { label: 'State', render: (r) => <Badge tone={D.costStateTone(r.costState)}>{D.label(r.costState)}</Badge> },
            { label: 'Balance', align: 'right', render: (r) => (r.totalInr > 0
              ? (r.balanceDue > 0 ? <Mono color="var(--red)" weight={600}>{D.inr(r.balanceDue)}</Mono> : <Mono color="var(--green)">paid</Mono>)
              : <Mono color="var(--t3)">—</Mono>) },
            { label: 'Date', align: 'right', render: (r) => <Mono size={11} color="var(--t3)">{r.date}</Mono> },
          ]} />
        ) : <Empty>{query ? `No orders match “${q.trim()}”` : 'No orders yet'}</Empty>}
      </Card>
    </Stack>
  );
}

// invoice & close — line selection + per-line GST + optional commission (payment-driven: only commission hits pool)
function InvoiceCard({ order, lines, suggestedInvoiceNo, fx, run, session }) {
  const billable = (lines || []).filter((l) => !l.invoice_no);
  const billed = (lines || []).filter((l) => l.invoice_no);
  const [sel, setSel] = useState(() => Object.fromEntries(billable.map((l) => [l.id, true])));
  const [gst, setGst] = useState(() => Object.fromEntries(billable.map((l) => [l.id, l.gst_percent ?? 18])));
  const [comm, setComm] = useState(false);
  const rate = Number(fx) || 0;
  const chosen = billable.filter((l) => sel[l.id]);
  let goods = 0, gstTotal = 0;
  chosen.forEach((l) => { const v = (Number(l.qty) || 0) * (Number(l.unit_price_rmb) || 0) * rate; goods += v; gstTotal += v * (Number(gst[l.id]) || 0) / 100; });
  const sub = goods + gstTotal, commission = comm ? sub * 0.025 : 0, total = sub + commission;
  const submit = () => { if (!chosen.length) return; run(() => act('invoiceOrder', { order_id: order.id, line_ids: chosen.map((l) => l.id), gst_by_line: Object.fromEntries(chosen.map((l) => [l.id, Number(gst[l.id]) || 0])), include_commission: comm }, session)); };
  return (
    <Card title="Invoice & close" bodyPad="16px 20px 18px">
      <Eyebrow style={{ marginBottom: 7 }}>SF invoice number · auto-assigned</Eyebrow>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', marginBottom: 12 }}>
        <Mono color="var(--t1)" weight={600} size={13}>{suggestedInvoiceNo || 'VWINV-…'}</Mono>
        <Mono size={9} color="var(--t3)" style={{ letterSpacing: '.1em' }}>NEXT IN SERIES</Mono>
      </div>
      {billed.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <Eyebrow style={{ marginBottom: 6 }}>Already billed</Eyebrow>
          {billed.map((l) => <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12 }}><span style={{ color: 'var(--t2)' }}>{l.product || `Line ${l.line_no}`}</span><Mono size={11} color="var(--green)">{l.invoice_no}</Mono></div>)}
        </div>
      )}
      {billable.length ? <>
        <Eyebrow style={{ marginBottom: 6 }}>Goods lines to bill</Eyebrow>
        {billable.map((l) => (
          <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
            <input type="checkbox" checked={!!sel[l.id]} onChange={(e) => setSel((s) => ({ ...s, [l.id]: e.target.checked }))} />
            <span style={{ flex: 1, color: 'var(--t2)', fontSize: 12 }}>{l.product || `Line ${l.line_no}`} <Mono size={10} color="var(--t3)">×{Number(l.qty) || 0}</Mono></span>
            <Mono size={10} color="var(--t3)">GST%</Mono>
            <Input value={gst[l.id]} onChange={(e) => setGst((g) => ({ ...g, [l.id]: e.target.value }))} style={{ width: 56, padding: '5px 7px', fontSize: 11 }} />
          </div>
        ))}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, color: 'var(--t2)' }}>
          <input type="checkbox" checked={comm} onChange={(e) => setComm(e.target.checked)} /> Add SF commission (2.5%)
        </label>
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 9, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span style={{ color: 'var(--t3)' }}>Goods</span><Mono color="var(--t1)">{D.inr(goods)}</Mono></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 4 }}><span style={{ color: 'var(--t3)' }}>GST</span><Mono color="var(--t1)">{D.inr(gstTotal)}</Mono></div>
          {comm && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 4 }}><span style={{ color: 'var(--t3)' }}>Commission 2.5%</span><Mono color="var(--t1)">{D.inr(commission)}</Mono></div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7, paddingTop: 7, borderTop: '1px solid var(--border)' }}><Mono size={10} color="var(--t3)" style={{ letterSpacing: '.08em' }}>INVOICE TOTAL</Mono><Mono color="var(--t1)" weight={700}>{D.inr(total)}</Mono></div>
        </div>
        <Mono size={9.5} color="var(--t3)" style={{ display: 'block', margin: '8px 0 10px' }}>Line value = ¥ × qty × FX ({rate || '—'}). Only commission hits the pool; GST is a document figure.</Mono>
        <Btn onClick={submit} style={{ width: '100%' }}>{chosen.length === billable.length ? 'Invoice & close' : `Invoice ${chosen.length} line(s)`}</Btn>
      </> : <Empty>All goods lines billed.</Empty>}
    </Card>
  );
}

// vendor payment (advance / pickup balance) — deducts the shared pool on record
function VendorPayCard({ order, fx, run, session }) {
  const [open, setOpen] = useState(false);
  const [ptype, setPtype] = useState('advance');
  const [rmb, setRmb] = useState('');
  const [rate, setRate] = useState(fx || '');
  const inr = (Number(rmb) || 0) * (Number(rate) || 0);
  const submit = () => {
    if (!(Number(rmb) > 0) || !(Number(rate) > 0)) { alert('Enter ¥ amount and bank rate'); return; }
    setOpen(false);
    run(async () => { const r = await act('recordVendorPayment', { order_id: order.id, payment_type: ptype, amount_rmb: Number(rmb), amount_inr_debited: Math.round(inr), vendor_name: order.vendor_name || null }, session); if (r?.shortfall > 0) alert(`Pool is now short by ${D.inr(r.shortfall)} — consider raising a draw-down.`); });
    setRmb('');
  };
  return (
    <Card title="Vendor payment" bodyPad="16px 20px 18px"
      action={<Btn variant="secondary" style={{ padding: '6px 12px', fontSize: 11 }} onClick={() => setOpen((v) => !v)}>{open ? 'Close' : 'Record'}</Btn>}>
      {open ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Type"><Select value={ptype} onChange={(e) => setPtype(e.target.value)} options={['advance', 'pickup_balance', 'other']} /></Field>
          <Field label="Amount (¥)"><Input value={rmb} onChange={(e) => setRmb(e.target.value)} placeholder="0" /></Field>
          <Field label="Bank rate (CNY/INR)"><Input value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span style={{ color: 'var(--t3)' }}>Debits pool</span><Mono color="var(--red)" weight={600}>{D.inr(inr)}</Mono></div>
          <Btn onClick={submit}>Record payment</Btn>
        </div>
      ) : <Mono size={11} color="var(--t3)">Advance (after PI) + pickup balance. Each deducts the shared pool immediately.</Mono>}
    </Card>
  );
}

// per-leg shipment costs (shipping/customs/other/last-mile) + last-mile partner + vehicle
function LegCosts({ leg, forwarders, run, session }) {
  const [tab, setTab] = useState(null); // 'cost' | 'lastmile'
  const [ctype, setCtype] = useState('shipping');
  const [amt, setAmt] = useState('');
  const [fwd, setFwd] = useState(leg.last_mile_forwarder_code || '');
  const [veh, setVeh] = useState(leg.last_mile_vehicle_no || '');
  const recordCost = () => { if (!(Number(amt) > 0)) { alert('Enter amount'); return; } run(async () => { const r = await act('recordShipmentCost', { shipment_id: leg.shipment_id, charge_type: ctype, amount_inr: Number(amt) }, session); if (r?.shortfall > 0) alert(`Pool is now short by ${D.inr(r.shortfall)} — consider raising a draw-down.`); }); setAmt(''); setTab(null); };
  const saveLastMile = () => { const f = forwarders.find((x) => x.forwarder_code === fwd); run(() => act('updateShipment', { id: leg.shipment_id, last_mile_forwarder_code: fwd || null, last_mile_forwarder_name: f ? f.company_name : null, last_mile_vehicle_no: veh || null }, session)); setTab(null); };
  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="mf-chip" onClick={() => setTab(tab === 'cost' ? null : 'cost')} style={{ padding: '5px 10px', borderRadius: 7, fontFamily: MONO, fontSize: 10, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--t2)' }}>+ Record cost</button>
        <button className="mf-chip" onClick={() => setTab(tab === 'lastmile' ? null : 'lastmile')} style={{ padding: '5px 10px', borderRadius: 7, fontFamily: MONO, fontSize: 10, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--t2)' }}>Last-mile</button>
      </div>
      {tab === 'cost' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr auto', gap: 6, marginTop: 8, alignItems: 'center' }}>
          <Select value={ctype} onChange={(e) => setCtype(e.target.value)} options={['shipping', 'customs', 'other_fees', 'last_mile']} style={{ padding: '6px 8px', fontSize: 11 }} />
          <Input value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="₹ amount" style={{ padding: '6px 8px', fontSize: 11 }} />
          <Btn style={{ padding: '6px 12px', fontSize: 11 }} onClick={recordCost}>Pay</Btn>
        </div>
      )}
      {tab === 'lastmile' && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <Select value={fwd} onChange={(e) => setFwd(e.target.value)} options={[{ value: '', label: '— none —' }, ...forwarders.map((x) => ({ value: x.forwarder_code, label: `${x.forwarder_code} · ${x.company_name}` }))]} style={{ padding: '6px 8px', fontSize: 11 }} />
          <Input value={veh} onChange={(e) => setVeh(e.target.value)} placeholder="Vehicle number (for the store team)" style={{ padding: '6px 8px', fontSize: 11 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn style={{ padding: '6px 12px', fontSize: 11 }} onClick={saveLastMile}>Save</Btn>
            <Mono size={9.5} color="var(--t3)" style={{ alignSelf: 'center' }}>No partner? Add it in Admin → Logistics partners.</Mono>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
function OrderDetail({ detailId, session, onNav, reload, data }) {
  const [resp, setResp] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState(null);
  const [lines, setLines] = useState([]);
  const [moveTo, setMoveTo] = useState('');
  const [legMode, setLegMode] = useState('sea');
  const [forwarders, setForwarders] = useState([]);

  const load = () => {
    if (!detailId) { setErr('No order selected'); return; }
    garageFetch('getOrder', { id: detailId }, session).then((d) => { setResp(d); setErr(''); }).catch((e) => setErr(e?.message || 'Load failed'));
  };
  useEffect(() => { setResp(null); setEdit(false); load(); /* eslint-disable-next-line */ }, [detailId, session]);
  useEffect(() => { garageFetch('getForwarders', {}, session).then(setForwarders).catch(() => setForwarders([])); /* eslint-disable-next-line */ }, [session]);
  const run = async (fn) => { if (busy) return; setBusy(true); try { await fn(); load(); reload && reload(); } catch (e) { alert(e?.message || 'Action failed'); } finally { setBusy(false); } };

  if (err) return <div><BackChip onClick={() => onNav('orders')}>Orders</BackChip><Empty>{err}</Empty></div>;
  if (!resp) return <div><BackChip onClick={() => onNav('orders')}>Orders</BackChip><Empty>Loading…</Empty></div>;
  const o = resp.order, eff = resp.effectiveStage, editable = resp.editable;
  const legIds = (resp.legs || []).map((l) => l.shipment_id);
  const moveTargets = (data?.shipments || []).filter((s) => !legIds.includes(s.id));

  const stamps = {};
  (resp.orderEvents || []).forEach((e) => { stamps[e.stage] = e.occurred_at; });
  (resp.legs || []).forEach((l) => (l.events || []).forEach((e) => { stamps[e.stage] = e.occurred_at; }));
  // real-date fallbacks for seeded/historical orders that carry no stage_events
  if (!stamps.placed && o.created_at) stamps.placed = o.created_at;
  if (o.cost_state === 'invoiced' && o.invoice_date && !stamps.received) stamps.received = o.invoice_date;

  const startEdit = () => {
    setForm({ purchase_inr: o.purchase_inr ?? '', shipping_inr: o.shipping_inr ?? '', customs_inr: o.customs_inr ?? '', gst_percent: o.gst_percent ?? 18 });
    setLines((resp.lines || []).map((l) => ({ ...l }))); setEdit(true);
  };
  const saveEdit = () => run(async () => {
    await act('updateOrder', { id: o.id, ...form }, session);
    await act('saveOrderLines', { order_id: o.id, lines: lines.map((l, i) => ({ line_no: i + 1, product: l.product, variant: l.variant, color: l.color, item_type: l.item_type || 'product', qty: Number(l.qty) || 0, unit: l.unit, unit_price_rmb: l.unit_price_rmb === '' ? null : Number(l.unit_price_rmb), receive_format: l.receive_format })) }, session);
    setEdit(false);
  });
  const createLeg = () => run(async () => {
    const sh = await act('createShipment', { mode: legMode }, session);
    await act('setShipmentLines', { shipment_id: sh.id, lines: (resp.lines || []).map((l) => ({ order_line_id: l.id, qty_in_shipment: Number(l.qty) || 0 })) }, session);
  });
  const convert = () => run(() => act('convertToPo', { order_id: o.id }, session));
  const cancelOrder = () => { const reason = window.prompt('Cancel this order — reason?'); if (reason && reason.trim()) run(() => act('cancelOrder', { order_id: o.id, reason: reason.trim() }, session)); };
  const cancellable = ['requested', 'draft', 'placed', 'confirmed', 'produced'].includes(o.status);
  const nextShip = (st) => st === 'planned' ? 'loaded' : SHIP_STAGES[SHIP_STAGES.indexOf(st) + 1];

  return (
    <div>
      <BackChip onClick={() => onNav('orders')}>Orders</BackChip>
      <Card bodyPad="20px 24px 22px" style={{ marginBottom: gap }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, marginBottom: o.status === 'draft' ? 14 : 20 }}>
          <div>
            <div style={{ fontFamily: DISP, fontWeight: 700, fontSize: 24, color: 'var(--t1)' }}>{o.order_no}</div>
            <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 4 }}>{o.title} · {o.vendor_name || 'Solve Factory'}{o.order_label ? ` · ${o.order_label}` : ''}</div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
              <Badge tone={D.costStateTone(o.cost_state)}>{D.label(o.cost_state)}</Badge>
              {!editable && <Mono size={9.5} color="var(--t3)" style={{ letterSpacing: '.1em' }}>LOCKED</Mono>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
            {o.status === 'requested' && <Btn onClick={convert}>Convert to PO</Btn>}
            {o.status === 'draft' && <Btn onClick={() => run(() => act('advanceOrderStage', { order_id: o.id, stage: 'placed' }, session))}>Place order</Btn>}
            {PROD_NEXT[o.status] && <Btn onClick={() => run(() => act('advanceOrderStage', { order_id: o.id, stage: PROD_NEXT[o.status] }, session))}>Advance → {D.label(PROD_NEXT[o.status])}</Btn>}
            {o.status === 'picked_up' && <>
              <Select value={legMode} onChange={(e) => setLegMode(e.target.value)} options={['sea', 'air']} style={{ width: 84, padding: '7px 9px', fontSize: 11 }} />
              <Btn onClick={createLeg}><ShipIcon size={13} style={{ marginRight: 6, verticalAlign: -2 }} />Create {legMode} leg</Btn>
            </>}
            {cancellable && <Btn variant="secondary" onClick={cancelOrder}>Cancel</Btn>}
          </div>
        </div>
        {o.status === 'requested'
          ? <Mono size={11} color="var(--t3)">Requested by LOT — SF reviews and converts this to a PO (vendor + ¥ pricing), then places it.</Mono>
          : o.status === 'draft'
          ? <Mono size={11} color="var(--t3)">Draft — fill in line items and costs below, then Place to start the timeline.</Mono>
          : o.status === 'cancelled'
          ? <Mono size={11} color="var(--red)">This order was cancelled.</Mono>
          : <Timeline current={eff} stampByStage={stamps} />}
      </Card>

      <Grid cols="1.5fr 1fr" style={{ alignItems: 'start' }}>
        <Stack>
          <Card bodyPad="13px 20px">
            <span style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--t2)' }}>
              {o.linked_po_number ? <>Linked Snorkel China PO: <span style={{ color: 'var(--green)', fontWeight: 600 }}>{o.linked_po_number}</span></> : 'Not yet projected to Snorkel'}
            </span>
          </Card>
          {(resp.legs || []).length > 0 && (
            <Card title={`Shipment legs · ${resp.legs.length}`}>
              <div style={{ padding: '4px 20px 12px' }}>
                {resp.legs.map((l) => {
                  const next = nextShip(l.status);
                  return (
                    <div key={l.shipment_id} style={{ padding: '11px 0', borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <Truck size={15} color="var(--t3)" />
                          <Mono color="var(--t1)" weight={600}>{l.shipment_no || `SHM #${l.shipment_id}`}</Mono>
                          <Badge tone={D.shipTone(l.status)}>{D.label(l.status)}</Badge>
                        </div>
                        {next && <Btn variant="secondary" style={{ padding: '6px 12px', fontSize: 11 }} onClick={() => run(() => act('advanceShipmentStage', { shipment_id: l.shipment_id, stage: next }, session))}>Advance → {D.label(next)}</Btn>}
                      </div>
                      <LegCosts leg={l} forwarders={forwarders} run={run} session={session} />
                    </div>
                  );
                })}
                {moveTargets.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 12, marginTop: 4, borderTop: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
                    <Mono size={10} color="var(--t3)" style={{ flex: 1 }}>Move this PO to another container</Mono>
                    <Select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} options={['', ...moveTargets.map((t) => t.no)]} style={{ width: 150, padding: '6px 9px', fontSize: 11 }} />
                    <Btn variant="secondary" style={{ padding: '6px 12px', fontSize: 11 }} onClick={() => { const t = moveTargets.find((x) => x.no === moveTo); if (t) run(() => act('moveOrderToShipment', { order_id: o.id, to_shipment_id: t.id }, session)); }}>Move</Btn>
                  </div>
                )}
              </div>
            </Card>
          )}
          <Card title={`Line items · ${resp.lines.length}`} action={editable ? (edit
            ? <span style={{ display: 'flex', gap: 8 }}><Btn variant="secondary" style={{ padding: '6px 12px', fontSize: 11 }} onClick={() => setEdit(false)}>Cancel</Btn><Btn style={{ padding: '6px 12px', fontSize: 11 }} onClick={saveEdit}>Save</Btn></span>
            : <Btn variant="secondary" style={{ padding: '6px 12px', fontSize: 11 }} onClick={startEdit}>Edit</Btn>) : null}>
            {edit ? (
              <div style={{ padding: '12px 20px 16px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                  {['Product', 'Qty', 'Unit ¥'].map((h) => <div key={h} style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>{h}</div>)}
                </div>
                {lines.map((l, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                    <Input value={l.product || ''} onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, product: e.target.value } : x))} />
                    <Input value={l.qty ?? ''} onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} />
                    <Input value={l.unit_price_rmb ?? ''} onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, unit_price_rmb: e.target.value } : x))} />
                  </div>
                ))}
                <button className="mf-chip" onClick={() => setLines((ls) => [...ls, { product: '', qty: '', unit_price_rmb: '', item_type: 'product' }])} style={{ width: '100%', padding: '8px 0', borderRadius: 8, fontFamily: MONO, fontSize: 11, background: 'transparent', border: '1px dashed var(--border-strong)', color: 'var(--t3)' }}>+ Add line</button>
              </div>
            ) : resp.lines.length ? (
              <Table rows={resp.lines} rowKey={(r) => r.line_no} cols={[
                { label: '#', render: (r) => <Mono size={11} color="var(--t3)">{r.line_no}</Mono> },
                { label: 'Product', render: (r) => <span style={{ color: 'var(--t1)' }}>{r.product || '—'}</span> },
                { label: 'Variant', render: (r) => <Mono size={11} color="var(--t3)">{r.variant || '—'}</Mono> },
                { label: 'Colour', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.color || '—'}</span> },
                { label: 'Qty', align: 'right', render: (r) => <Mono>{Number(r.qty || 0).toLocaleString('en-US')}</Mono> },
                { label: 'Unit ¥', align: 'right', render: (r) => <Mono>{r.unit_price_rmb ?? '—'}</Mono> },
                { label: 'Format', render: (r) => <Mono size={11} color="var(--t3)">{r.receive_format || r.item_type || '—'}</Mono> },
              ]} />
            ) : <Empty>No line items</Empty>}
          </Card>
        </Stack>

        <Stack>
          <Card title="Cost breakdown" bodyPad="18px 20px 20px">
            {edit ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[['Goods value (₹)', 'purchase_inr'], ['Shipping (₹)', 'shipping_inr'], ['Customs (₹)', 'customs_inr'], ['GST %', 'gst_percent']].map(([lbl, key]) => (
                  <Field key={key} label={lbl}><Input value={form[key] ?? ''} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} /></Field>
                ))}
                <Mono size={10} color="var(--t3)">Base + GST total recomputes on save.</Mono>
              </div>
            ) : <>
              {resp.costRows.map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--t2)' }}>{r.label}</span><Mono color="var(--t1)">{D.inr(r.amt)}</Mono>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0 4px' }}>
                <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>{o.cost_state === 'in_flight' ? 'Purchase (in-flight)' : 'Landed total'}</span>
                <span style={{ fontFamily: DISP, fontWeight: 700, fontSize: 20, color: 'var(--t1)' }}>{D.inr(o.cost_state === 'in_flight' ? o.purchase_inr : resp.landed)}</span>
              </div>
            </>}
            {resp.drawdown && (
              <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
                <Eyebrow style={{ marginBottom: 8 }}>Draw-down against this order</Eyebrow>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Mono color="var(--t1)" weight={600}>{resp.drawdown.no} · {D.inr(resp.drawdown.amt)}</Mono>
                  <Badge tone={D.ddTone(resp.drawdown.status)}>{D.label(resp.drawdown.status)}</Badge>
                </div>
              </div>
            )}
          </Card>
          {!['draft', 'requested', 'cancelled'].includes(o.status) && <VendorPayCard order={o} fx={data?.fx?.current} run={run} session={session} />}
          {o.cost_state === 'invoiced'
            ? <Card title="Invoiced" bodyPad="16px 20px 18px">
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><Mono size={11} color="var(--t3)">Invoice</Mono><Mono color="var(--t1)">{o.invoice_no}</Mono></div>
                {resp.commission && <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}><Mono size={11} color="var(--t3)">Commission · {resp.commission.rate}%</Mono><Mono color="var(--t1)">{D.inr(resp.commission.inr)}</Mono></div>}
              </Card>
            : editable && !edit && !['draft', 'requested'].includes(o.status) &&
                <InvoiceCard order={o} lines={resp.lines} suggestedInvoiceNo={resp.suggestedInvoiceNo} fx={data?.fx?.current} run={run} session={session} />}
          {!['draft', 'requested', 'cancelled'].includes(o.status) && <MoneyCard order={o} money={resp.money} schedule={resp.schedule || []} allocations={resp.allocations || []} payments={data?.payments || []} run={run} session={session} />}
        </Stack>
      </Grid>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
const SHIP_PIPE = ['planned', 'loaded', 'sailing', 'docked', 'cleared', 'local_transport', 'received'];
function Shipments({ data, onNav, session, reload }) {
  const [forwarders, setForwarders] = useState([]);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const blank = { mode: 'sea', forwarder_code: '', loading_date: '', etd: '', container_type: '', container_no: '', bl_awb_no: '' };
  const [f, setF] = useState(blank);
  useEffect(() => { garageFetch('getForwarders', {}, session).then(setForwarders).catch(() => setForwarders([])); /* eslint-disable-next-line */ }, [session]);
  const fwdOpts = [{ value: '', label: '— none —' }, ...forwarders.filter((x) => (x.modes_supported || []).map((m) => String(m).toLowerCase()).includes(f.mode)).map((x) => ({ value: x.forwarder_code, label: `${x.forwarder_code} · ${x.company_name}` }))];
  const create = async () => {
    if (busy) return; setBusy(true);
    try {
      const fwd = forwarders.find((x) => x.forwarder_code === f.forwarder_code);
      const sh = await act('createShipment', { mode: f.mode, forwarder_code: f.forwarder_code || null, forwarder_name: fwd ? fwd.company_name : null, loading_date: f.loading_date || null, etd: f.etd || null, container_type: f.container_type || null, container_no: f.container_no || null, bl_awb_no: f.bl_awb_no || null }, session);
      setF(blank); setShow(false); reload && reload();
      if (sh && sh.id) onNav('shipmentDetail', sh.id);
    } catch (e) { alert(e?.message || 'Create failed'); } finally { setBusy(false); }
  };
  const blAwbLbl = f.mode === 'air' ? 'Air Waybill (AWB)' : 'Bill of Lading (BL)';
  const sailLbl = f.mode === 'air' ? 'Departure date (flight leaves)' : 'Sailing date (leaves port)';
  return (
    <Stack>
      {show && (
        <Card title="New shipment" bodyPad="18px 20px 20px" action={<Btn variant="secondary" style={{ padding: '6px 12px', fontSize: 11 }} onClick={() => setShow(false)}>Cancel</Btn>}>
          <Grid cols="repeat(3,1fr)">
            <Field label="Mode"><Select value={f.mode} onChange={(e) => setF((x) => ({ ...x, mode: e.target.value, forwarder_code: '' }))} options={['sea', 'air']} /></Field>
            <Field label="Carrier / forwarder"><Select value={f.forwarder_code} onChange={(e) => setF((x) => ({ ...x, forwarder_code: e.target.value }))} options={fwdOpts} /></Field>
            <Field label={blAwbLbl}><Input value={f.bl_awb_no} onChange={(e) => setF((x) => ({ ...x, bl_awb_no: e.target.value }))} /></Field>
            <Field label="Loading date"><Input type="date" value={f.loading_date} onChange={(e) => setF((x) => ({ ...x, loading_date: e.target.value }))} /></Field>
            <Field label={sailLbl}><Input type="date" value={f.etd} onChange={(e) => setF((x) => ({ ...x, etd: e.target.value }))} /></Field>
            <Field label="Container type"><Input value={f.container_type} onChange={(e) => setF((x) => ({ ...x, container_type: e.target.value }))} placeholder={f.mode === 'air' ? 'ULD / loose' : 'FCL / LCL / 40ft'} /></Field>
            <Field label="Container no."><Input value={f.container_no} onChange={(e) => setF((x) => ({ ...x, container_no: e.target.value }))} /></Field>
          </Grid>
          <Mono size={10} color="var(--t3)" style={{ display: 'block', marginTop: 10 }}>No carrier listed? Add it in Admin → Logistics partners. Downstream ETAs (arrival, customs, delivery) pre-fill forward from the {sailLbl.includes('Departure') ? 'departure' : 'sailing'} date using the {f.mode} timeline defaults — all editable after.</Mono>
          <Btn onClick={create} style={{ marginTop: 14 }}>{busy ? 'Creating…' : 'Create shipment'}</Btn>
        </Card>
      )}
      <Card title="Shipments" action={<Btn variant="secondary" style={{ padding: '7px 12px', fontSize: 11 }} onClick={() => setShow((v) => !v)}><Plus size={13} style={{ marginRight: 5, verticalAlign: -2 }} />New shipment</Btn>}>
        {data.shipments.length ? (
          <Table onRowClick={(r) => onNav('shipmentDetail', r.id)} rows={data.shipments} rowKey={(r) => r.no} cols={[
            { label: 'Shipment', render: (r) => <Mono color="var(--t1)" weight={600}>{r.no}</Mono> },
            { label: 'Mode', render: (r) => <Badge tone={r.mode === 'air' ? 'blue' : 'gray'}>{r.mode}</Badge> },
            { label: 'BL · AWB', render: (r) => <Mono size={11} color="var(--t3)">{r.blAwb}</Mono> },
            { label: 'Order', render: (r) => <Mono size={11} color="var(--t3)">{r.order}</Mono> },
            { label: 'ETA', align: 'right', render: (r) => <Mono size={11} color="var(--t3)">{r.eta}</Mono> },
            { label: 'Status', render: (r) => <Badge tone={D.shipTone(r.status)}>{D.label(r.status)}</Badge> },
          ]} />
        ) : <Empty>No shipments yet — create one above.</Empty>}
      </Card>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
function ShipmentDetail({ detailId, session, onNav, reload, data }) {
  const [resp, setResp] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState(null);
  const [forwarders, setForwarders] = useState([]);
  const [attach, setAttach] = useState('');
  const load = () => { if (!detailId) { setErr('No shipment selected'); return; } garageFetch('getShipment', { id: detailId }, session).then((d) => { setResp(d); setErr(''); }).catch((e) => setErr(e?.message || 'Load failed')); };
  useEffect(() => { setResp(null); setEdit(false); load(); /* eslint-disable-next-line */ }, [detailId, session]);
  useEffect(() => { garageFetch('getForwarders', {}, session).then(setForwarders).catch(() => setForwarders([])); /* eslint-disable-next-line */ }, [session]);
  const run = async (fn) => { if (busy) return; setBusy(true); try { await fn(); load(); reload && reload(); } catch (e) { alert(e?.message || 'Action failed'); } finally { setBusy(false); } };
  if (err) return <div><BackChip onClick={() => onNav('shipments')}>Shipments</BackChip><Empty>{err}</Empty></div>;
  if (!resp) return <div><BackChip onClick={() => onNav('shipments')}>Shipments</BackChip><Empty>Loading…</Empty></div>;
  const s = resp.shipment;
  const labels = resp.stageLabels || {};
  const lbl = (st) => st === 'planned' ? 'Planned' : (labels[st] || D.label(st));
  const idx = SHIP_PIPE.indexOf(s.status);
  const nextStage = idx >= 0 && idx < SHIP_PIPE.length - 1 ? SHIP_PIPE[idx + 1] : null;
  const departed = ['sailing', 'docked', 'cleared', 'local_transport', 'received'].includes(s.status);
  const fwdOpts = [{ value: '', label: '— none —' }, ...forwarders.filter((x) => (x.modes_supported || []).map((m) => String(m).toLowerCase()).includes(s.mode)).map((x) => ({ value: x.forwarder_code, label: `${x.forwarder_code} · ${x.company_name}` }))];
  const attachable = (data?.orders || []).filter((o) => ['confirmed', 'produced', 'picked_up'].includes(o.status));
  const startEdit = () => { setForm({ mode: s.mode, forwarder_code: s.forwarder_code || '', container_type: s.container_type || '', container_no: s.container_no || '', bl_awb_no: s.bl_awb_no || '', etd: s.etd || '', eta: s.eta || '', loading_date: s.loading_date || '', port_arrival_date: s.port_arrival_date || '', clearance_date: s.clearance_date || '', local_dispatch_date: s.local_dispatch_date || '', warehouse_delivery_date: s.warehouse_delivery_date || '' }); setEdit(true); };
  const saveEdit = () => run(async () => { const fwd = forwarders.find((x) => x.forwarder_code === form.forwarder_code); await act('updateShipment', { id: s.id, ...form, forwarder_name: fwd ? fwd.company_name : null }, session); setEdit(false); });
  const attachOrder = () => { const o = attachable.find((x) => x.no === attach); if (!o) return; run(async () => { const od = await garageFetch('getOrder', { id: o.id }, session); const items = (od.lines || []).map((l) => ({ order_line_id: l.id, qty: Number(l.qty) || 0 })); if (items.length) await act('allocateItemsToShipment', { shipment_id: s.id, items }, session); }); setAttach(''); };
  const dateFields = [['etd', 'ETD'], ['eta', 'ETA'], ['loading_date', 'Loaded'], ['port_arrival_date', 'Arrived'], ['clearance_date', 'Cleared'], ['local_dispatch_date', 'Local dispatch'], ['warehouse_delivery_date', 'Delivered']];

  return (
    <div>
      <BackChip onClick={() => onNav('shipments')}>Shipments</BackChip>
      <Card bodyPad="20px 24px 22px" style={{ marginBottom: gap }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, marginBottom: 18 }}>
          <div>
            <div style={{ fontFamily: DISP, fontWeight: 700, fontSize: 24, color: 'var(--t1)' }}>{s.shipment_no}</div>
            <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 4 }}>{resp.blAwbLabel}: {s.bl_awb_no || '—'} · {s.forwarder_name || 'no carrier'}{s.container_no ? ` · ${s.container_no}` : ''}</div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
              <Badge tone={s.mode === 'air' ? 'blue' : 'gray'}>{s.mode}</Badge>
              <Badge tone={D.shipTone(s.status)}>{lbl(s.status)}</Badge>
              {departed && <Mono size={9.5} color="var(--t3)" style={{ letterSpacing: '.1em' }}>CONTENTS LOCKED</Mono>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {nextStage && <Btn onClick={() => run(() => act('advanceShipmentStage', { shipment_id: s.id, stage: nextStage }, session))}>Advance → {lbl(nextStage)}</Btn>}
            {edit ? <span style={{ display: 'flex', gap: 8 }}><Btn variant="secondary" style={{ padding: '8px 14px' }} onClick={() => setEdit(false)}>Cancel</Btn><Btn onClick={saveEdit}>Save</Btn></span>
                  : <Btn variant="secondary" onClick={startEdit}>Edit</Btn>}
          </div>
        </div>
        {/* stage strip */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {SHIP_PIPE.map((st, i) => (
            <span key={st} style={{ padding: '5px 10px', borderRadius: 7, fontFamily: MONO, fontSize: 10,
              background: i <= idx ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'var(--surface2)',
              border: '1px solid ' + (i <= idx ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'var(--border)'),
              color: i <= idx ? 'var(--accent)' : 'var(--t3)' }}>{lbl(st)}</span>
          ))}
        </div>
      </Card>

      <Grid cols="1.5fr 1fr" style={{ alignItems: 'start' }}>
        <Stack>
          {edit && (
            <Card title="Edit shipment" bodyPad="18px 20px 20px">
              <Grid cols="repeat(2,1fr)">
                <Field label="Mode"><Select value={form.mode} onChange={(e) => setForm((x) => ({ ...x, mode: e.target.value }))} options={['sea', 'air']} /></Field>
                <Field label="Carrier"><Select value={form.forwarder_code} onChange={(e) => setForm((x) => ({ ...x, forwarder_code: e.target.value }))} options={fwdOpts} /></Field>
                <Field label="Container type"><Input value={form.container_type} onChange={(e) => setForm((x) => ({ ...x, container_type: e.target.value }))} /></Field>
                <Field label="Container no."><Input value={form.container_no} onChange={(e) => setForm((x) => ({ ...x, container_no: e.target.value }))} /></Field>
                <div style={{ gridColumn: '1 / -1' }}><Field label={resp.blAwbLabel}><Input value={form.bl_awb_no} onChange={(e) => setForm((x) => ({ ...x, bl_awb_no: e.target.value }))} /></Field></div>
              </Grid>
              <Eyebrow style={{ margin: '14px 0 8px' }}>Expected dates (revisions are logged)</Eyebrow>
              <Grid cols="repeat(3,1fr)">
                {dateFields.map(([k, l]) => <Field key={k} label={l}><Input type="date" value={form[k]} onChange={(e) => setForm((x) => ({ ...x, [k]: e.target.value }))} /></Field>)}
              </Grid>
            </Card>
          )}
          <Card title={`Allocated items · ${resp.lines.length}`} action={!departed ? (
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Select value={attach} onChange={(e) => setAttach(e.target.value)} options={['', ...attachable.map((o) => o.no)]} style={{ width: 150, padding: '6px 9px', fontSize: 11 }} />
              <Btn variant="secondary" style={{ padding: '6px 12px', fontSize: 11 }} onClick={attachOrder}>Add order</Btn>
            </span>) : <Mono size={10} color="var(--t3)">locked — departed</Mono>}>
            {resp.lines.length ? (
              <Table rows={resp.lines} rowKey={(r) => r.id} cols={[
                { label: 'Order', render: (r) => <Mono size={11} color="var(--t3)">{r.order_lines?.orders?.order_no || '—'}</Mono> },
                { label: 'Product', render: (r) => <span style={{ color: 'var(--t1)' }}>{r.order_lines?.product || r.order_lines?.description || '—'}</span> },
                { label: 'Vendor code', render: (r) => <Mono size={11} color="var(--t3)">{r.order_lines?.vendor_item_code || '—'}</Mono> },
                { label: 'Qty', align: 'right', render: (r) => <Mono>{Number(r.qty_in_shipment || 0).toLocaleString('en-US')}</Mono> },
              ]} />
            ) : <Empty>No items allocated — add an order above.</Empty>}
          </Card>
        </Stack>
        <Stack>
          <Card title="Logistics costs & last-mile" bodyPad="16px 20px 18px">
            <Mono size={11} color="var(--t3)" style={{ display: 'block', marginBottom: 6 }}>Record shipping / customs / fees (deducts the pool), and the last-mile partner + vehicle for the store team.</Mono>
            <LegCosts leg={{ shipment_id: s.id, last_mile_forwarder_code: s.last_mile_forwarder_code, last_mile_vehicle_no: s.last_mile_vehicle_no }} forwarders={forwarders} run={run} session={session} />
            {(s.last_mile_forwarder_name || s.last_mile_vehicle_no) && (
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
                <Eyebrow style={{ marginBottom: 6 }}>Last-mile</Eyebrow>
                <Mono size={12} color="var(--t1)">{s.last_mile_forwarder_name || s.last_mile_forwarder_code || '—'}{s.last_mile_vehicle_no ? ` · ${s.last_mile_vehicle_no}` : ''}</Mono>
              </div>
            )}
          </Card>
          {(resp.events || []).length > 0 && (
            <Card title="Timeline" bodyPad="12px 20px 16px">
              {resp.events.map((e, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: i < resp.events.length - 1 ? '1px solid color-mix(in srgb, var(--border) 55%, transparent)' : 'none' }}>
                  <span style={{ fontSize: 12, color: 'var(--t2)' }}>{D.label(e.stage)}{e.note ? <Mono size={10} color="var(--t3)"> · {String(e.note).slice(0, 40)}</Mono> : ''}</span>
                  <Mono size={10} color="var(--t3)">{fmtDay(e.occurred_at)}</Mono>
                </div>
              ))}
            </Card>
          )}
        </Stack>
      </Grid>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
function Drawdowns({ data, onNav }) {
  return (
    <Stack>
      <div style={{ display: 'flex' }}><div style={{ flex: 1 }} />
        <Btn onClick={() => onNav('newDrawdown')}><Plus size={14} style={{ marginRight: 6, verticalAlign: -2 }} />Raise Draw-down</Btn>
      </div>
      <Card>
        {data.drawdowns.length ? (
          <Table rows={data.drawdowns} rowKey={(r) => r.no} cols={[
            { label: 'No.', render: (r) => <Mono color="var(--t1)" weight={600}>{r.no}</Mono> },
            { label: 'Phase', render: (r) => <Mono size={11} color="var(--t3)">{D.label(r.phase)}</Mono> },
            { label: 'Order', render: (r) => PO(r.order) },
            { label: 'Est. INR', align: 'right', render: (r) => <Mono color="var(--t1)">{D.inr(r.estInr)}</Mono> },
            { label: 'Rate', align: 'right', render: (r) => <Mono>{r.rate ?? '—'}</Mono> },
            { label: 'Requested by', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.by}</span> },
            { label: 'Date', align: 'right', render: (r) => <Mono size={11} color="var(--t3)">{r.date}</Mono> },
            { label: 'Status', render: (r) => <Badge tone={D.ddTone(r.status)}>{D.label(r.status)}</Badge> },
          ]} />
        ) : <Empty>No draw-downs yet</Empty>}
      </Card>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
function Payments({ data, session, reload }) {
  const s = data.summary;
  const rated = data.payments.filter((p) => p.rate);
  const avg = rated.length ? (rated.reduce((a, p) => a + p.rate * p.inr, 0) / rated.reduce((a, p) => a + p.inr, 0)).toFixed(2) : '—';
  const channels = (data.subentities || []).map((x) => x.subentity_code).filter(Boolean);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const blank = { amount_inr: '', utr: '', paid_date: '', subentity_code: channels[0] || 'SF', method: 'bank_transfer', fx_rate_used: '', note: '' };
  const [f, setF] = useState(blank);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    if (busy) return;
    if (!(Number(f.amount_inr) > 0)) { alert('Enter the wire amount (INR)'); return; }
    if (!f.utr.trim()) { alert('Bank UTR is required for every wire'); return; }
    setBusy(true);
    try {
      await act('recordPayment', {
        amount_inr: Number(f.amount_inr), utr: f.utr.trim(), paid_date: f.paid_date || null,
        subentity_code: f.subentity_code, method: f.method || null,
        fx_rate_used: f.fx_rate_used === '' ? null : Number(f.fx_rate_used), note: f.note || null,
      }, session);
      setF(blank); setShow(false); reload && reload();
    } catch (e) { alert(e?.message || 'Record failed'); } finally { setBusy(false); }
  };
  return (
    <Stack>
      <Grid cols="repeat(3,1fr)">
        <Kpi eyebrow="TOTAL WIRED → SF" value={D.inr(s.credits)} color="var(--green)" sub={`${data.payments.length} wires`} size={24} />
        <Kpi eyebrow="SUB-ENTITIES" value={data.subentities.length} sub="payout channels" size={24} />
        <Kpi eyebrow="AVG. RATE PAID" value={avg} color="var(--t1)" sub="CNY/INR · weighted" size={24} />
      </Grid>
      {show && (
        <Card title="Record a wire → Solve Factory" bodyPad="18px 20px 20px"
          action={<Btn variant="secondary" style={{ padding: '6px 12px', fontSize: 11 }} onClick={() => setShow(false)}>Cancel</Btn>}>
          <Grid cols="repeat(3,1fr)">
            <Field label="Amount (₹)"><Input value={f.amount_inr} onChange={(e) => set('amount_inr', e.target.value)} placeholder="0" /></Field>
            <Field label="Bank UTR *"><Input value={f.utr} onChange={(e) => set('utr', e.target.value)} placeholder="UTR / bank ref" /></Field>
            <Field label="Paid date"><Input type="date" value={f.paid_date} onChange={(e) => set('paid_date', e.target.value)} /></Field>
            <Field label="Channel"><Select value={f.subentity_code} onChange={(e) => set('subentity_code', e.target.value)} options={channels.length ? channels : ['SF']} /></Field>
            <Field label="Method"><Select value={f.method} onChange={(e) => set('method', e.target.value)} options={['bank_transfer', 'alipay', 'cash', 'other']} /></Field>
            <Field label="Rate (CNY/INR, optional)"><Input value={f.fx_rate_used} onChange={(e) => set('fx_rate_used', e.target.value)} placeholder="—" /></Field>
          </Grid>
          <div style={{ marginTop: 12 }}><Field label="Note"><Input value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="optional" /></Field></div>
          <Btn onClick={submit} style={{ marginTop: 14 }}>{busy ? 'Recording…' : 'Record wire'}</Btn>
        </Card>
      )}
      <Card title="Outgoing wires" action={<Btn variant="secondary" style={{ padding: '7px 12px', fontSize: 11 }} onClick={() => setShow((v) => !v)}><Plus size={13} style={{ marginRight: 5, verticalAlign: -2 }} />Record Wire</Btn>}>
        {data.payments.length ? (
          <Table rows={data.payments} rowKey={(r) => r.ref} cols={[
            { label: 'Ref', render: (r) => <Mono color="var(--t1)" weight={600}>{r.ref}</Mono> },
            { label: 'Date', render: (r) => <Mono size={11} color="var(--t3)">{r.date}</Mono> },
            { label: 'Amount INR', align: 'right', render: (r) => <Mono color="var(--green)" weight={600}>{D.inr(r.inr)}</Mono> },
            { label: 'UTR', render: (r) => r.utr ? <Mono size={11} color="var(--t2)">{r.utr}</Mono> : <Mono size={11} color="var(--t3)">—</Mono> },
            { label: 'Rate', align: 'right', render: (r) => <Mono>{r.rate ?? '—'}</Mono> },
            { label: 'Method', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.method}</span> },
            { label: 'Channel', render: (r) => <Mono size={11} color="var(--t3)">{r.against}</Mono> },
            { label: 'Status', render: (r) => <Badge tone="green">{r.status}</Badge> },
          ]} />
        ) : <Empty>No payments yet</Empty>}
      </Card>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
function Fx({ data }) {
  const fx = data.fx;
  const spark = fx.spark || [];
  return (
    <Stack>
      <Grid cols="1fr 1.5fr">
        <Card bodyPad="18px 20px 20px">
          <Eyebrow>CURRENT · CNY / INR</Eyebrow>
          <div style={{ fontFamily: DISP, fontWeight: 700, fontSize: 46, color: 'var(--t1)', letterSpacing: '-.02em', margin: '6px 0 4px' }}>{fx.current ?? '—'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--t3)', fontFamily: MONO }}>Reference rate · actual bank rate set per vendor payment</div>
          {spark.length >= 2 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              <Mono size={10} color="var(--t3)">range</Mono><Mono size={12} color="var(--t1)">{Math.min(...spark)} – {Math.max(...spark)}</Mono>
            </div>
          )}
        </Card>
        <Card title="Rate trend">
          {spark.length >= 2
            ? <div style={{ padding: '16px 20px 18px' }}>
                <Sparkline values={spark} min={Math.min(...spark) - 0.05} max={Math.max(...spark) + 0.05} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 9.5, color: 'var(--t3)', marginTop: 8 }}>
                  <span>{Math.min(...spark)}</span><span>{Math.max(...spark)}</span>
                </div>
              </div>
            : <Empty>Not enough rate history to chart</Empty>}
        </Card>
      </Grid>
      <Card title="Rate history">
        {fx.history.length ? (
          <Table rows={fx.history} rowKey={(r, i) => r.date + r.rate} cols={[
            { label: 'Date', render: (r) => <Mono size={11} color="var(--t3)">{r.date}</Mono> },
            { label: 'CNY · INR', render: (r) => <Mono color="var(--t1)" weight={600}>{r.rate}</Mono> },
            { label: 'Δ', render: (r) => r.delta == null ? <Mono size={11} color="var(--t3)">—</Mono> : <Mono size={11} color={r.delta > 0 ? 'var(--green)' : 'var(--t3)'}>{r.delta > 0 ? '+' : ''}{r.delta.toFixed(2)}</Mono> },
            { label: 'Source', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.by}</span> },
            { label: 'Note', align: 'right', render: (r) => <Mono size={11} color="var(--t3)">{r.applied}</Mono> },
          ]} />
        ) : <Empty>No rate history yet</Empty>}
      </Card>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
function Documents({ data }) {
  const chips = ['All', 'PI', 'Packing', 'BL', 'Invoice', 'Receipts'];
  const [f, setF] = useState('All');
  const map = { PI: 'PI', Packing: 'Packing List', BL: 'Bill of Lading', Invoice: 'Commercial Invoice', Receipts: 'Wire Receipt' };
  const docs = data.documents.filter((d) => f === 'All' || d.type === map[f]);
  return (
    <Stack>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {chips.map((c) => <FilterChip key={c} active={f === c} onClick={() => setF(c)}>{c}</FilterChip>)}
        <div style={{ flex: 1 }} /><Btn><Plus size={14} style={{ marginRight: 6, verticalAlign: -2 }} />Upload</Btn>
      </div>
      {docs.length ? (
        <Grid cols="repeat(3,1fr)">
          {docs.map((doc) => {
            const c = toneVar(D.docTone(doc.type));
            return (
              <div key={doc.filename} className="mf-doccard" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 'var(--cardpad)', boxShadow: 'var(--shadow)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                  <div style={{ width: 38, height: 46, borderRadius: 7, background: 'var(--surface2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <FileText size={19} color={c} strokeWidth={1.7} />
                  </div>
                  <Badge tone={D.docTone(doc.type)}>{doc.type}</Badge>
                </div>
                <div style={{ fontFamily: MONO, fontSize: 12, color: 'var(--t1)', wordBreak: 'break-all', marginBottom: 5 }}>{doc.filename}</div>
                <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--t3)' }}>{doc.ref} · {doc.date}</div>
              </div>
            );
          })}
        </Grid>
      ) : <Card><Empty>No documents yet</Empty></Card>}
    </Stack>
  );
}

// editable per-mode shipment timeline defaults (suggest-not-lock)
function ShipmentDefaults({ session, reload }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const STAGES = ['loaded', 'sailing', 'docked', 'cleared', 'local_transport', 'received'];
  useEffect(() => { garageFetch('getStageDefaults', {}, session).then(setRows).catch(() => setRows([])); /* eslint-disable-next-line */ }, [session]);
  const byMode = (m) => STAGES.map((st) => (rows || []).find((r) => r.mode === m && r.stage === st) || { mode: m, stage: st, offset_days: 0 });
  const setVal = (m, st, v) => setRows((rs) => { const out = (rs || []).slice(); const i = out.findIndex((r) => r.mode === m && r.stage === st); if (i >= 0) out[i] = { ...out[i], offset_days: v }; else out.push({ mode: m, stage: st, offset_days: v }); return out; });
  const stLabel = (m, st) => (m === 'air' && st === 'sailing') ? 'In flight' : (m === 'air' && st === 'docked') ? 'Landed' : D.label(st);
  const save = async () => { setBusy(true); try { await act('setStageDefaults', { rows: (rows || []).map((r) => ({ mode: r.mode, stage: r.stage, offset_days: Number(r.offset_days) || 0 })) }, session); reload && reload(); } catch (e) { alert(e?.message || 'Save failed'); } finally { setBusy(false); } };
  if (!rows) return <Card title="Shipment timeline defaults"><Empty>Loading…</Empty></Card>;
  return (
    <Card title="Shipment timeline defaults" bodyPad="16px 20px 18px" action={<Btn style={{ padding: '6px 12px', fontSize: 11 }} onClick={save}>{busy ? 'Saving…' : 'Save'}</Btn>}>
      <Mono size={10.5} color="var(--t3)" style={{ display: 'block', marginBottom: 12 }}>Days after the previous milestone. These pre-fill a new shipment's expected dates per mode — suggestions only, editable on each shipment.</Mono>
      {['sea', 'air'].map((m) => (
        <div key={m} style={{ marginBottom: 14 }}>
          <Eyebrow style={{ marginBottom: 8 }}>{m === 'air' ? 'Air' : 'Sea'} · offset days</Eyebrow>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
            {byMode(m).map((r) => (
              <div key={r.stage}>
                <div style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 4 }}>{stLabel(m, r.stage)}</div>
                <Input value={r.offset_days} onChange={(e) => setVal(m, r.stage, e.target.value)} style={{ padding: '7px 8px', fontSize: 12 }} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </Card>
  );
}

// logistics partners master (store.forwarders) — list + inline create (no free-text partners)
function Forwarders({ session }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ company_name: '', country: 'China', country_iso: 'CN', modes: { sea: true, air: false, land: false }, iata_code: '', scac_code: '', tracking_url: '' });
  const load = () => garageFetch('getForwarders', {}, session).then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [session]);
  const create = async () => {
    if (!f.company_name.trim()) { alert('Company name required'); return; }
    const modes = Object.entries(f.modes).filter(([, v]) => v).map(([k]) => k);
    if (!modes.length) { alert('Pick at least one mode'); return; }
    setBusy(true);
    try { await act('createForwarder', { company_name: f.company_name.trim(), country: f.country, country_iso: f.country_iso, modes_supported: modes, iata_code: f.iata_code || null, scac_code: f.scac_code || null, tracking_url: f.tracking_url || null }, session); setOpen(false); setF((x) => ({ ...x, company_name: '', iata_code: '', scac_code: '', tracking_url: '' })); load(); }
    catch (e) { alert(e?.message || 'Create failed'); } finally { setBusy(false); }
  };
  return (
    <Card title="Logistics partners" action={<Btn variant="secondary" style={{ padding: '6px 12px', fontSize: 11 }} onClick={() => setOpen((v) => !v)}><Plus size={13} style={{ marginRight: 5, verticalAlign: -2 }} />Add partner</Btn>}>
      {open && (
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <Field label="Company"><Input value={f.company_name} onChange={(e) => setF((x) => ({ ...x, company_name: e.target.value }))} /></Field>
          <Field label="Country"><Input value={f.country} onChange={(e) => setF((x) => ({ ...x, country: e.target.value }))} /></Field>
          <Field label="ISO"><Input value={f.country_iso} onChange={(e) => setF((x) => ({ ...x, country_iso: e.target.value }))} /></Field>
          <Field label="IATA (air)"><Input value={f.iata_code} onChange={(e) => setF((x) => ({ ...x, iata_code: e.target.value }))} /></Field>
          <Field label="SCAC (sea)"><Input value={f.scac_code} onChange={(e) => setF((x) => ({ ...x, scac_code: e.target.value }))} /></Field>
          <Field label="Tracking URL"><Input value={f.tracking_url} onChange={(e) => setF((x) => ({ ...x, tracking_url: e.target.value }))} /></Field>
          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 14 }}>
            {['sea', 'air', 'land'].map((m) => <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)' }}><input type="checkbox" checked={f.modes[m]} onChange={(e) => setF((x) => ({ ...x, modes: { ...x.modes, [m]: e.target.checked } }))} />{m}</label>)}
            <div style={{ flex: 1 }} />
            <Btn style={{ padding: '6px 12px', fontSize: 11 }} onClick={create}>{busy ? 'Creating…' : 'Create partner'}</Btn>
          </div>
        </div>
      )}
      {!rows ? <Empty>Loading…</Empty> : rows.length ? (
        <Table rows={rows} rowKey={(r) => r.forwarder_code} cols={[
          { label: 'Code', render: (r) => <Mono color="var(--t1)" weight={600} size={11}>{r.forwarder_code}</Mono> },
          { label: 'Company', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.company_name}</span> },
          { label: 'Modes', render: (r) => <Mono size={11} color="var(--t3)">{(r.modes_supported || []).join(', ')}</Mono> },
          { label: 'Country', render: (r) => <Mono size={11} color="var(--t3)">{r.country}</Mono> },
        ]} />
      ) : <Empty>No partners yet</Empty>}
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════
// Permission-key catalog for the builder — labels grouped per party. Keys are the worker's fixed
// capability vocabulary; the builder composes roles from them (it does not invent capabilities).
const PERMISSION_KEYS = {
  LOT: [
    { group: 'Manifest',   keys: [['manifest_view', 'View Manifest']] },
    { group: 'Orders',     keys: [['order_manage', 'Manage orders'], ['china_po_sync', 'Project to Snorkel']] },
    { group: 'Shipping',   keys: [['shipment_manage', 'Manage shipments']] },
    { group: 'Finance',    keys: [['charge_manage', 'Manage charges'], ['payment_record', 'Record payments'], ['drawdown_manage', 'Manage draw-downs'], ['fx_manage', 'Manage FX'], ['cost_view', 'View cost / margin']] },
    { group: 'Documents',  keys: [['doc_manage', 'Manage documents']] },
    { group: 'Governance', keys: [['manifest_admin', 'Operational admin'], ['manifest_super_admin', 'Super admin (access + roles)']] },
  ],
  SF: [
    { group: 'Manifest',   keys: [['manifest_view', 'View Manifest']] },
    { group: 'Orders',     keys: [['sf_order_update', 'Update orders'], ['sf_po_manage', 'Manage POs'], ['sf_invoice_create', 'Create invoices']] },
    { group: 'Finance',    keys: [['sf_drawdown_raise', 'Raise draw-downs'], ['sf_vendor_payment_record', 'Record vendor payments'], ['sf_running_account_view', 'View running account']] },
    { group: 'Documents',  keys: [['sf_evidence_upload', 'Upload evidence']] },
  ],
};

// Btn doesn't support `disabled`; small local button that does (for guarded admin controls).
function AdminBtn({ children, onClick, disabled, danger }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      style={{ fontFamily: DISP, fontWeight: 700, fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase',
        borderRadius: 8, padding: '7px 12px', cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
        background: 'var(--surface2)', border: '1px solid var(--border)',
        color: danger ? 'var(--red)' : 'var(--t2)', opacity: disabled ? 0.4 : 1 }}>{children}</button>
  );
}

function Admin({ data, session, reload }) {
  const P = data?.me?.permissions || {};
  const isSuper = !!P.manifest_super_admin;
  const isAdmin = !!P.manifest_admin;
  const TABS = [
    isSuper && ['access', 'Access Control'],
    isSuper && ['roles', 'Roles'],
    isAdmin && ['ops', 'Operations'],
  ].filter(Boolean);
  const [tab, setTab] = useState(TABS[0] ? TABS[0][0] : 'none');
  if (!TABS.length) return <Card><Empty>Admin access required.</Empty></Card>;
  const active = TABS.some((t) => t[0] === tab) ? tab : TABS[0][0];
  return (
    <Stack>
      <div style={{ display: 'flex', gap: 8 }}>
        {TABS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className="mf-chip"
            style={{ padding: '8px 14px', borderRadius: 8, fontFamily: MONO, fontSize: 11, cursor: 'pointer',
              border: '1px solid ' + (active === id ? 'color-mix(in srgb, var(--accent) 32%, transparent)' : 'var(--border)'),
              background: active === id ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'var(--surface)',
              color: active === id ? 'var(--accent)' : 'var(--t2)' }}>{label}</button>
        ))}
      </div>
      {active === 'access' && <AccessControl data={data} session={session} reload={reload} />}
      {active === 'roles'  && <RolesBuilder  data={data} session={session} reload={reload} />}
      {active === 'ops'    && (
        <Grid cols="1fr 1fr" style={{ alignItems: 'start' }}>
          <ShipmentDefaults session={session} reload={reload} />
          <Forwarders session={session} />
        </Grid>
      )}
    </Stack>
  );
}

function AccessControl({ data, session, reload }) {
  const users = data.accessUsers || [];
  const roles = data.roles || [];
  const meId = data.me?.id;
  const roleMap = {}; roles.forEach((r) => { roleMap[r.role_key] = r; });
  const superHolders = users.filter((u) => u.active && roleMap[u.role_key]?.permissions?.manifest_super_admin);
  const lastSuper = superHolders.length === 1 ? superHolders[0].user_id : null;
  const [busy, setBusy] = useState('');
  const [grant, setGrant] = useState({ email: '', role_key: roles[0]?.role_key || '' });
  const act = async (action, body) => {
    setBusy(body.user_id || 'grant');
    try { await workerFetch(action, body, session); await reload(); }
    catch (e) { alert(e?.message || 'Failed'); }
    setBusy('');
  };
  const roleOpts = roles.map((r) => ({ value: r.role_key, label: `${r.label} (${r.party})` }));
  return (
    <Stack>
      <Card title="Grant access">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Input placeholder="email@…" value={grant.email} onChange={(e) => setGrant((g) => ({ ...g, email: e.target.value }))} style={{ flex: 1, minWidth: 200, width: 'auto' }} />
          <Select options={roleOpts} value={grant.role_key} onChange={(e) => setGrant((g) => ({ ...g, role_key: e.target.value }))} style={{ width: 'auto', minWidth: 180 }} />
          <AdminBtn disabled={!grant.email || !grant.role_key || !!busy} onClick={() => act('grantAccess', { email: grant.email.trim(), role_key: grant.role_key }).then(() => setGrant((g) => ({ ...g, email: '' })))}>Grant</AdminBtn>
        </div>
        <Mono size={10} color="var(--t3)" style={{ display: 'block', marginTop: 8 }}>The person must have signed in at least once (Google for LOT, email link for SF) before access can be granted.</Mono>
      </Card>
      <Card title="People with Manifest access">
        <Table rows={users} rowKey={(u) => u.user_id} cols={[
          { label: 'Name', render: (u) => <span style={{ color: u.active ? 'var(--t1)' : 'var(--t3)' }}>{u.full_name}{u.user_id === meId ? <Mono size={9} color="var(--t3)"> (you)</Mono> : null}</span> },
          { label: 'Party', render: (u) => <Badge tone={u.party === 'SF' ? 'blue' : 'yellow'}>{u.party}</Badge> },
          { label: 'Role', render: (u) => (
            <Select options={roleOpts} value={u.role_key} disabled={busy === u.user_id || u.user_id === lastSuper}
              onChange={(e) => act('setUserRole', { user_id: u.user_id, role_key: e.target.value })}
              style={{ width: 'auto', minWidth: 150, padding: '5px 8px', fontSize: 11, fontFamily: MONO }} />) },
          { label: 'Status', render: (u) => <Badge tone={u.active ? 'green' : 'red'}>{u.active ? 'active' : 'disabled'}</Badge> },
          { label: '', align: 'right', render: (u) => {
            const guarded = u.user_id === meId || u.user_id === lastSuper;
            return (
              <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                <AdminBtn disabled={guarded || busy === u.user_id} onClick={() => act('setUserActive', { user_id: u.user_id, active: !u.active })}>{u.active ? 'Disable' : 'Enable'}</AdminBtn>
                <AdminBtn danger disabled={guarded || busy === u.user_id} onClick={() => { if (confirm(`Remove ${u.full_name}'s access?`)) act('setUserRole', { user_id: u.user_id, role_key: null }); }}>Remove</AdminBtn>
              </span>);
          } },
        ]} />
      </Card>
    </Stack>
  );
}

function RolesBuilder({ data, session, reload }) {
  const roles = data.roles || [];
  const users = data.accessUsers || [];
  const [sel, setSel] = useState(null);     // role_key being edited, or '__new__'
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const assignedCount = (rk) => users.filter((u) => u.role_key === rk).length;
  const openNew = () => { setSel('__new__'); setDraft({ role_key: '', label: '', description: '', party: 'LOT', permissions: {}, is_system: false }); };
  const openEdit = (r) => { setSel(r.role_key); setDraft({ ...r, permissions: { ...(r.permissions || {}) } }); };
  const save = async () => { setBusy(true); try { await workerFetch('saveRole', draft, session); await reload(); setSel(null); setDraft(null); } catch (e) { alert(e?.message || 'Failed'); } setBusy(false); };
  const remove = async (rk) => { if (!confirm(`Delete role ${rk}?`)) return; setBusy(true); try { await workerFetch('deleteRole', { role_key: rk }, session); await reload(); setSel(null); setDraft(null); } catch (e) { alert(e?.message || 'Failed'); } setBusy(false); };
  const toggleKey = (k) => setDraft((d) => ({ ...d, permissions: { ...d.permissions, [k]: !d.permissions[k] } }));
  const cat = draft ? (PERMISSION_KEYS[draft.party] || PERMISSION_KEYS.LOT) : [];
  const locked = !!draft?.is_system;
  return (
    <Grid cols="300px 1fr" style={{ alignItems: 'start' }}>
      <Card title={<span style={{ display: 'inline-flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>Roles <AdminBtn onClick={openNew}><Plus size={12} style={{ verticalAlign: -2 }} /> New</AdminBtn></span>}>
        <Table rows={roles} rowKey={(r) => r.role_key} cols={[
          { label: 'Role', render: (r) => (
            <button type="button" onClick={() => openEdit(r)} style={{ background: 'none', border: 0, cursor: 'pointer', textAlign: 'left', padding: 0 }}>
              <span style={{ color: 'var(--t1)', fontFamily: MONO, fontSize: 11.5 }}>{r.label}</span>
              <Mono size={9} color="var(--t3)" style={{ display: 'block' }}>{r.role_key}</Mono>
            </button>) },
          { label: '', align: 'right', render: (r) => r.is_system ? <Badge tone="gray">System</Badge> : <Badge tone={r.party === 'SF' ? 'blue' : 'yellow'}>{r.party}</Badge> },
        ]} />
      </Card>
      {draft ? (
        <Card title={sel === '__new__' ? 'New role' : (locked ? `${draft.label} · system · locked` : `Edit ${draft.label}`)}>
          <Stack>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Input placeholder="role_key" value={draft.role_key} disabled={sel !== '__new__'} onChange={(e) => setDraft((d) => ({ ...d, role_key: e.target.value.trim() }))} style={{ width: 'auto', flex: 1, minWidth: 140 }} />
              <Input placeholder="Label" value={draft.label} disabled={locked} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} style={{ width: 'auto', flex: 1, minWidth: 140 }} />
              <Select options={['LOT', 'SF']} value={draft.party} disabled={sel !== '__new__'} onChange={(e) => setDraft((d) => ({ ...d, party: e.target.value }))} style={{ width: 'auto', minWidth: 90 }} />
            </div>
            <Input placeholder="Description" value={draft.description || ''} disabled={locked} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
            {cat.map((grp) => (
              <div key={grp.group}>
                <Mono size={10} color="var(--t3)">{grp.group}</Mono>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 5 }}>
                  {grp.keys.map(([k, label]) => (
                    <label key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 11, color: 'var(--t2)', opacity: locked ? 0.6 : 1, cursor: locked ? 'default' : 'pointer' }}>
                      <input type="checkbox" checked={!!draft.permissions[k]} disabled={locked} onChange={() => toggleKey(k)} />{label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            {!locked && (
              <div style={{ display: 'flex', gap: 8 }}>
                <AdminBtn disabled={busy || !draft.role_key} onClick={save}>Save role</AdminBtn>
                {sel !== '__new__' && <AdminBtn danger disabled={busy || assignedCount(draft.role_key) > 0} onClick={() => remove(draft.role_key)}>Delete{assignedCount(draft.role_key) > 0 ? ` (${assignedCount(draft.role_key)} assigned)` : ''}</AdminBtn>}
              </div>
            )}
          </Stack>
        </Card>
      ) : <Card><Empty>Select a role to view, or create a new one.</Empty></Card>}
    </Grid>
  );
}

// ════════════════════════════════════════════════════════════════
const CAT_MAP = { Product: 'product', Part: 'part', 'Sub-part': 'sub_part', Mould: 'mould', Sample: 'sample', Other: 'other' };
function NewOrder({ onNav, session, reload }) {
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ title: '', category: 'Product', expected: '', kind: 'request' });
  const [lines, setLines] = useState([{ product: '', qty: '', unit_price_rmb: '' }]);
  const setLine = (i, k, v) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, [k]: v } : x));

  const create = async (goDetail) => {
    if (busy) return;
    if (!f.title.trim()) { alert('Title is required'); return; }
    setBusy(true);
    try {
      const order = await act('createOrder', {
        title: f.title.trim(), category: CAT_MAP[f.category] || 'product',
        status: f.kind === 'request' ? 'requested' : 'draft',
        vendor_name: 'Solve Factory', currency: 'CNY', placed_via: 'SF',
        lines: lines.filter((l) => l.product.trim()).map((l, i) => ({
          line_no: i + 1, product: l.product.trim(), qty: Number(l.qty) || 0,
          unit_price_rmb: l.unit_price_rmb === '' ? null : Number(l.unit_price_rmb), item_type: 'product',
        })),
      }, session);
      reload && reload();
      onNav(goDetail ? 'orderDetail' : 'orders', goDetail ? order.id : undefined);
    } catch (e) { alert(e?.message || 'Create failed'); } finally { setBusy(false); }
  };

  return (
    <div>
      <BackChip onClick={() => onNav('orders')}>Orders</BackChip>
      <Grid cols="1.5fr 1fr" style={{ alignItems: 'start' }}>
        <Stack>
          <Card title="Order details" bodyPad="20px">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1 / -1' }}><Field label="Title"><Input value={f.title} onChange={(e) => setF((x) => ({ ...x, title: e.target.value }))} placeholder="e.g. Night Wolf RC — full build" /></Field></div>
              <Field label="Category"><Select value={f.category} onChange={(e) => setF((x) => ({ ...x, category: e.target.value }))} options={['Product', 'Part', 'Sub-part', 'Mould', 'Sample', 'Other']} /></Field>
              <Field label="Vendor"><Select options={['Solve Factory · Shenzhen']} /></Field>
              <Field label="Currency"><Select options={['RMB (¥)']} /></Field>
              <Field label="Expected ready date"><Input value={f.expected} onChange={(e) => setF((x) => ({ ...x, expected: e.target.value }))} placeholder="e.g. 18 Jan" /></Field>
            </div>
          </Card>
          <Card title="Line items" bodyPad="16px 20px 20px">
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
              {['Product', 'Qty', 'Unit ¥'].map((l) => <div key={l} style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>{l}</div>)}
            </div>
            {lines.map((l, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                <Input value={l.product} onChange={(e) => setLine(i, 'product', e.target.value)} placeholder="Product" />
                <Input value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} placeholder="0" />
                <Input value={l.unit_price_rmb} onChange={(e) => setLine(i, 'unit_price_rmb', e.target.value)} placeholder="0" />
              </div>
            ))}
            <button className="mf-chip" onClick={() => setLines((ls) => [...ls, { product: '', qty: '', unit_price_rmb: '' }])} style={{ width: '100%', padding: '9px 0', borderRadius: 8, fontFamily: MONO, fontSize: 11, background: 'transparent', border: '1px dashed var(--border-strong)', color: 'var(--t3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <Plus size={13} />Add line</button>
          </Card>
        </Stack>
        <Card title="Create" bodyPad="18px 20px 20px">
          <Field label="Create as">
            <Select value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value }))} options={['request', 'draft']} />
          </Field>
          <div style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.6, marginTop: 12 }}>
            {f.kind === 'request'
              ? <><span style={{ color: 'var(--t1)' }}>Request</span> (LOT) — records what LOT needs. SF then converts it to a PO (vendor + ¥ pricing) and drives the lifecycle.</>
              : <><span style={{ color: 'var(--t1)' }}>Draft PO</span> (SF) — fill costs + shipping on the detail page, then Place to start the timeline.</>}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <Btn onClick={() => create(true)} style={{ flex: 1 }}>{busy ? 'Creating…' : (f.kind === 'request' ? 'Create request' : 'Create order')}</Btn>
            <Btn variant="secondary" onClick={() => create(false)}>Save</Btn>
          </div>
        </Card>
      </Grid>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
const PHASE_MAP = { 'Goods advance': 'goods_advance', 'Shipping & customs': 'shipping_customs', 'Local': 'local', 'Other': 'other' };
function NewDrawdown({ data, onNav, session, reload }) {
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ phase: 'Goods advance', order: '— none —', amount: '', rate: data.fx.current ?? '', notes: '' });
  const amtNum = Number(String(f.amount).replace(/,/g, '')) || 0;
  const rateNum = Number(f.rate) || 0;
  const rmb = rateNum ? Math.round(amtNum / rateNum) : 0;
  const submit = async () => {
    if (busy) return;
    if (!(amtNum > 0)) { alert('Enter an amount'); return; }
    setBusy(true);
    try {
      const ord = data.orders.find((o) => o.no === f.order);
      await act('createDrawdown', { phase: PHASE_MAP[f.phase] || 'other', order_id: ord ? ord.id : null, est_amount_inr: amtNum, est_fx_rate: rateNum || null, note: f.notes || null }, session);
      reload && reload();
      onNav('drawdowns');
    } catch (e) { alert(e?.message || 'Request failed'); } finally { setBusy(false); }
  };
  return (
    <div>
      <BackChip onClick={() => onNav('drawdowns')}>Draw-downs</BackChip>
      <Grid cols="1.5fr 1fr" style={{ alignItems: 'start' }}>
        <Card title="Draw-down request" bodyPad="20px">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Phase"><Select value={f.phase} onChange={(e) => setF((x) => ({ ...x, phase: e.target.value }))} options={['Goods advance', 'Shipping & customs', 'Local', 'Other']} /></Field>
            <Field label="Against order"><SelectSearch value={f.order} onChange={(v) => setF((x) => ({ ...x, order: v }))} options={[{ value: '— none —', label: '— none —' }, ...data.orders.map((o) => ({ value: o.no, label: o.no, sub: o.title }))]} /></Field>
            <Field label="Amount (INR)"><Input value={f.amount} onChange={(e) => setF((x) => ({ ...x, amount: e.target.value }))} placeholder="0" /></Field>
            <Field label="Rate (CNY/INR)"><Input value={f.rate} onChange={(e) => setF((x) => ({ ...x, rate: e.target.value }))} /></Field>
            <div style={{ gridColumn: '1 / -1' }}><Field label="Notes"><Textarea value={f.notes} onChange={(e) => setF((x) => ({ ...x, notes: e.target.value }))} placeholder="Add context for this request…" /></Field></div>
          </div>
        </Card>
        <Card title="Conversion preview" bodyPad="18px 20px 20px">
          <Eyebrow>Amount requested</Eyebrow>
          <div style={{ fontFamily: DISP, fontWeight: 700, fontSize: 30, color: 'var(--t1)', margin: '6px 0 12px' }}>{D.inr(amtNum)}</div>
          {rmb > 0 && <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: MONO, fontSize: 14, color: 'var(--t2)', marginBottom: 12 }}><ArrowRight size={16} color="var(--t3)" /><span style={{ color: 'var(--t1)' }}>{D.rmb(rmb)}</span><span style={{ fontSize: 11, color: 'var(--t3)' }}>at {f.rate}</span></div>}
          <div style={{ marginTop: 4, padding: 14, borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--t2)', lineHeight: 1.5 }}>
            Raised against the pool{f.order !== '— none —' ? <> · earmarked for <span style={{ color: 'var(--t1)', fontFamily: MONO }}>{f.order}</span></> : ''}. Settle with wire allocations on the PO.
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <Btn onClick={submit} style={{ flex: 1 }}>{busy ? 'Submitting…' : 'Submit Request'}</Btn>
            <Btn variant="secondary" onClick={() => onNav('drawdowns')}>Cancel</Btn>
          </div>
        </Card>
      </Grid>
    </div>
  );
}

export const SCREENS = {
  dashboard: Dashboard, recon: Recon, orders: Orders, orderDetail: OrderDetail,
  shipments: Shipments, shipmentDetail: ShipmentDetail, drawdowns: Drawdowns, payments: Payments, fx: Fx,
  documents: Documents, manual: ManualScreen, admin: Admin, newOrder: NewOrder, newDrawdown: NewDrawdown,
};
