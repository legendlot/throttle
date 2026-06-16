'use client';
// Manifest "Pit Wall" — all screens, wired to live getBootstrap data.
import React, { useState, useEffect } from 'react';
import { garageFetch, workerFetch } from '@throttle/db';
import { ArrowLeft, ArrowRight, Plus, ChevronDown, FileText, Check, Truck, Ship as ShipIcon, Search, X } from 'lucide-react';
import {
  Card, Table, Badge, Btn, Field, Input, Select, Textarea, Eyebrow, Mono,
  BalanceChart, Sparkline, MONO, DISP, toneVar,
} from './ui.js';
import * as D from './data.js';

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

// ════════════════════════════════════════════════════════════════
function OrderDetail({ detailId, session, onNav, reload, data }) {
  const [resp, setResp] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState(null);
  const [lines, setLines] = useState([]);
  const [invNo, setInvNo] = useState('');
  const [moveTo, setMoveTo] = useState('');

  const load = () => {
    if (!detailId) { setErr('No order selected'); return; }
    garageFetch('getOrder', { id: detailId }, session).then((d) => { setResp(d); setErr(''); }).catch((e) => setErr(e?.message || 'Load failed'));
  };
  useEffect(() => { setResp(null); setEdit(false); load(); /* eslint-disable-next-line */ }, [detailId, session]);
  const run = async (fn) => { if (busy) return; setBusy(true); try { await fn(); load(); reload && reload(); } catch (e) { alert(e?.message || 'Action failed'); } finally { setBusy(false); } };

  if (err) return <div><BackChip onClick={() => onNav('orders')}>Orders</BackChip><Empty>{err}</Empty></div>;
  if (!resp) return <div><BackChip onClick={() => onNav('orders')}>Orders</BackChip><Empty>Loading…</Empty></div>;
  const o = resp.order, eff = resp.effectiveStage, editable = resp.editable;
  const legIds = (resp.legs || []).map((l) => l.shipment_id);
  const moveTargets = (data?.shipments || []).filter((s) => !legIds.includes(s.id));

  const stamps = {};
  (resp.orderEvents || []).forEach((e) => { stamps[e.stage] = e.occurred_at; });
  (resp.legs || []).forEach((l) => (l.events || []).forEach((e) => { stamps[e.stage] = e.occurred_at; }));

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
    const sh = await act('createShipment', { mode: 'Sea FCL' }, session);
    await act('setShipmentLines', { shipment_id: sh.id, lines: (resp.lines || []).map((l) => ({ order_line_id: l.id, qty_in_shipment: Number(l.qty) || 0 })) }, session);
  });
  const nextShip = (st) => st === 'planned' ? 'loaded' : SHIP_STAGES[SHIP_STAGES.indexOf(st) + 1];
  const commPreview = Math.round((Number(o.total_inr) || 0) * 0.025);

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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {o.status === 'draft' && <Btn onClick={() => run(() => act('advanceOrderStage', { order_id: o.id, stage: 'placed' }, session))}>Place order</Btn>}
            {PROD_NEXT[o.status] && <Btn onClick={() => run(() => act('advanceOrderStage', { order_id: o.id, stage: PROD_NEXT[o.status] }, session))}>Advance → {D.label(PROD_NEXT[o.status])}</Btn>}
            {o.status === 'picked_up' && <Btn onClick={createLeg}><ShipIcon size={13} style={{ marginRight: 6, verticalAlign: -2 }} />Create shipment leg</Btn>}
          </div>
        </div>
        {o.status === 'draft'
          ? <Mono size={11} color="var(--t3)">Draft — fill in line items and costs below, then Place to start the timeline.</Mono>
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
                    <div key={l.shipment_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 0', borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Truck size={15} color="var(--t3)" />
                        <Mono color="var(--t1)" weight={600}>{l.shipment_no || `SHM #${l.shipment_id}`}</Mono>
                        <Badge tone={D.shipTone(l.status)}>{D.label(l.status)}</Badge>
                      </div>
                      {next && <Btn variant="secondary" style={{ padding: '6px 12px', fontSize: 11 }} onClick={() => run(() => act('advanceShipmentStage', { shipment_id: l.shipment_id, stage: next }, session))}>Advance → {D.label(next)}</Btn>}
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
          {o.cost_state === 'invoiced'
            ? <Card title="Invoiced" bodyPad="16px 20px 18px">
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><Mono size={11} color="var(--t3)">Invoice</Mono><Mono color="var(--t1)">{o.invoice_no}</Mono></div>
                {resp.commission && <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}><Mono size={11} color="var(--t3)">Commission · {resp.commission.rate}%</Mono><Mono color="var(--t1)">{D.inr(resp.commission.inr)}</Mono></div>}
              </Card>
            : editable && !edit && <Card title="Invoice" bodyPad="16px 20px 18px">
                <Field label="SF invoice number"><Input value={invNo} onChange={(e) => setInvNo(e.target.value)} placeholder="VWINV-…" /></Field>
                <Mono size={10} color="var(--t3)" style={{ display: 'block', margin: '8px 0 12px' }}>Locks edits + accrues 2.5% commission (~{D.inr(commPreview)}).</Mono>
                <Btn onClick={() => { if (invNo.trim()) run(() => act('invoiceOrder', { order_id: o.id, invoice_no: invNo.trim() }, session)); }} style={{ width: '100%' }}>Mark invoiced</Btn>
              </Card>}
          {o.status !== 'draft' && <MoneyCard order={o} money={resp.money} schedule={resp.schedule || []} allocations={resp.allocations || []} payments={data?.payments || []} run={run} session={session} />}
        </Stack>
      </Grid>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
function Shipments({ data }) {
  return (
    <Card>
      {data.shipments.length ? (
        <Table rows={data.shipments} rowKey={(r) => r.no} cols={[
          { label: 'Shipment', render: (r) => <Mono color="var(--t1)" weight={600}>{r.no}</Mono> },
          { label: 'Mode', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.mode}</span> },
          { label: 'BL · AWB', render: (r) => <Mono size={11} color="var(--t3)">{r.blAwb}</Mono> },
          { label: 'Order', render: (r) => <Mono size={11} color="var(--t3)">{r.order}</Mono> },
          { label: 'ETA', align: 'right', render: (r) => <Mono size={11} color="var(--t3)">{r.eta}</Mono> },
          { label: 'Status', render: (r) => <Badge tone={D.shipTone(r.status)}>{D.label(r.status)}</Badge> },
        ]} />
      ) : <Empty>No shipments yet</Empty>}
    </Card>
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
function Payments({ data }) {
  const s = data.summary;
  const rated = data.payments.filter((p) => p.rate);
  const avg = rated.length ? (rated.reduce((a, p) => a + p.rate * p.inr, 0) / rated.reduce((a, p) => a + p.inr, 0)).toFixed(2) : '—';
  return (
    <Stack>
      <Grid cols="repeat(3,1fr)">
        <Kpi eyebrow="TOTAL WIRED → SF" value={D.inr(s.credits)} color="var(--green)" sub={`${data.payments.length} wires`} size={24} />
        <Kpi eyebrow="SUB-ENTITIES" value={data.subentities.length} sub="payout channels" size={24} />
        <Kpi eyebrow="AVG. RATE PAID" value={avg} color="var(--t1)" sub="CNY/INR · weighted" size={24} />
      </Grid>
      <Card title="Outgoing wires" action={<Btn variant="secondary" style={{ padding: '7px 12px', fontSize: 11 }}><Plus size={13} style={{ marginRight: 5, verticalAlign: -2 }} />Record Wire</Btn>}>
        {data.payments.length ? (
          <Table rows={data.payments} rowKey={(r) => r.ref} cols={[
            { label: 'Ref', render: (r) => <Mono color="var(--t1)" weight={600}>{r.ref}</Mono> },
            { label: 'Date', render: (r) => <Mono size={11} color="var(--t3)">{r.date}</Mono> },
            { label: 'Amount INR', align: 'right', render: (r) => <Mono color="var(--green)" weight={600}>{D.inr(r.inr)}</Mono> },
            { label: 'Amount RMB', align: 'right', render: (r) => <Mono>{r.rmb != null ? D.rmb(r.rmb) : '—'}</Mono> },
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

// ════════════════════════════════════════════════════════════════
function Admin({ data }) {
  const groups = (data.orgGroups || []).filter((g) => g.members.length);
  return (
    <Stack>
      <div style={{ display: 'flex' }}><div style={{ flex: 1 }} /><Btn><Plus size={14} style={{ marginRight: 6, verticalAlign: -2 }} />Invite User</Btn></div>
      {groups.length ? groups.map((g) => (
        <Card key={g.org} title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 24, height: 24, borderRadius: 6, background: `color-mix(in srgb, ${toneVar(g.tagTone)} 16%, transparent)`, color: toneVar(g.tagTone), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: DISP, fontWeight: 700, fontSize: 12 }}>{g.tag}</span>
            {g.org}<Mono size={10} color="var(--t3)" style={{ marginLeft: 4 }}>{g.members.length} members</Mono>
          </span>}>
          <Table rows={g.members} rowKey={(m, i) => m.name + i} cols={[
            { label: 'Name', render: (m) => (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 28, height: 28, borderRadius: 999, background: 'var(--surface2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 10, fontWeight: 600, color: 'var(--t2)' }}>{initials(m.name)}</span>
                <span style={{ color: 'var(--t1)' }}>{m.name}</span>
              </span>) },
            { label: 'Role', render: (m) => <Badge tone={g.tagTone}>{m.role}</Badge> },
            { label: 'Status', align: 'right', render: (m) => <Badge tone={D.userStatusTone(m.status)}>{m.status}</Badge> },
          ]} />
        </Card>
      )) : <Card><Empty>Admin access required, or no users assigned a Manifest role.</Empty></Card>}
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
const CAT_MAP = { Product: 'product', Part: 'part', 'Sub-part': 'sub_part', Mould: 'mould', Sample: 'sample', Other: 'other' };
function NewOrder({ onNav, session, reload }) {
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ title: '', category: 'Product', expected: '' });
  const [lines, setLines] = useState([{ product: '', qty: '', unit_price_rmb: '' }]);
  const setLine = (i, k, v) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, [k]: v } : x));

  const create = async (goDetail) => {
    if (busy) return;
    if (!f.title.trim()) { alert('Title is required'); return; }
    setBusy(true);
    try {
      const order = await act('createOrder', {
        title: f.title.trim(), category: CAT_MAP[f.category] || 'product',
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
          <div style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.6 }}>
            Creates a <span style={{ color: 'var(--t1)' }}>draft</span>. Fill costs + shipping on the detail page, then Place it to start the timeline. Goods priced in ¥; landed cost (shipping/customs/GST) added as it ships.
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <Btn onClick={() => create(true)} style={{ flex: 1 }}>{busy ? 'Creating…' : 'Create Order'}</Btn>
            <Btn variant="secondary" onClick={() => create(false)}>Save draft</Btn>
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
            <Field label="Against order"><Select value={f.order} onChange={(e) => setF((x) => ({ ...x, order: e.target.value }))} options={['— none —', ...data.orders.map((o) => o.no)]} /></Field>
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
  shipments: Shipments, drawdowns: Drawdowns, payments: Payments, fx: Fx,
  documents: Documents, admin: Admin, newOrder: NewOrder, newDrawdown: NewDrawdown,
};
