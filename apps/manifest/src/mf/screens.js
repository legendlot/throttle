'use client';
// Manifest "Pit Wall" — all screens + the two form flows.
import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, Plus, ChevronDown, FileText, TriangleAlert } from 'lucide-react';
import {
  Card, Table, Badge, Btn, Field, Input, Select, Textarea, Eyebrow, Mono,
  BalanceChart, Sparkline, MONO, DISP, toneVar,
} from './ui.js';
import * as D from './data.js';

const gap = 'var(--gap)';

// ── small shared bits ────────────────────────────────────────────
function Kpi({ eyebrow, value, color = 'var(--t1)', sub, size = 29 }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      boxShadow: 'var(--shadow)', padding: 'var(--cardpad)' }}>
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
  <button className="mf-chip" onClick={onClick} style={{ padding: '7px 12px', borderRadius: 8, fontFamily: MONO, fontSize: 11,
    background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--t2)', display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 16 }}>
    <ArrowLeft size={13} />{children}</button>
);
const Dropdown = ({ children }) => (
  <span className="mf-chip" style={{ padding: '8px 12px', borderRadius: 8, fontFamily: MONO, fontSize: 11, background: 'var(--surface)',
    border: '1px solid var(--border)', color: 'var(--t2)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
    {children}<ChevronDown size={13} color="var(--t3)" /></span>
);
const initials = (name) => name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

// ════════════════════════════════════════════════════════════════
// 1. DASHBOARD
function Dashboard({ onNav }) {
  const d = D.derive();
  const open = D.openOrders();
  return (
    <Stack>
      <Grid cols="repeat(3,1fr)">
        <Kpi eyebrow="NET POSITION" value={D.inr(d.balance)} color="var(--green)" sub={d.owes ? 'LOT owes SF' : 'SF holds LOT advance'} />
        <Kpi eyebrow="PROVISIONAL" value={D.inr(d.provisional)} color="var(--red)" sub="after pending costs" />
        <Kpi eyebrow="OPEN DRAW-DOWNS" value={D.inr(D.OPEN_DRAW)} color="var(--accent)" sub="2 awaiting payment" />
        <Kpi eyebrow="PENDING COSTS" value={D.inr(D.PENDING_COSTS)} sub="not yet finalised" />
        <Kpi eyebrow="OPEN ORDERS" value={open.length} sub="of 8 total" />
        <Kpi eyebrow="IN TRANSIT" value="2" color="var(--blue)" sub="shipments moving" />
      </Grid>
      <Grid cols="1.55fr 1fr">
        <Card title="Open orders" action={<LinkText onClick={() => onNav('orders')}>View all →</LinkText>}>
          <Table onRowClick={() => onNav('orderDetail')} rows={open.slice(0, 6)} cols={[
            { label: 'Order', render: (r) => <Mono color="var(--t1)" weight={600}>{r.no}</Mono> },
            { label: 'Title', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.title}</span> },
            { label: 'Value', align: 'right', render: (r) => <Mono>{D.rmb(r.valueRmb)}</Mono> },
            { label: 'Status', render: (r) => <Badge tone={D.orderTone(r.status)}>{D.label(r.status)}</Badge> },
          ]} />
        </Card>
        <Card title="Activity">
          <div style={{ padding: '6px 20px 14px' }}>
            {D.ACTIVITY.map((a, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '11px 0', borderBottom: i < D.ACTIVITY.length - 1 ? '1px solid color-mix(in srgb, var(--border) 55%, transparent)' : 'none' }}>
                <div style={{ marginTop: 5 }}><Dot tone={a.tone} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--t1)' }}>{a.event} · <span style={{ color: 'var(--t2)' }}>{a.detail}</span></div>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>{a.who} · {a.when}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </Grid>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
// 2. RUNNING ACCOUNT (recon)
function Recon({ onNav, openDrill }) {
  const d = D.derive();
  const ledgerDesc = [...d.rows].reverse();
  const recent = ledgerDesc.slice(0, 6);
  const maxAbs = Math.max(...recent.map((e) => Math.abs(e.amt)));
  return (
    <Stack>
      <Grid cols="1.5fr 1fr">
        <Card bodyPad="18px 20px 20px">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
            <div>
              <Eyebrow>RUNNING BALANCE · SEP → DEC</Eyebrow>
              <div style={{ fontFamily: DISP, fontWeight: 700, fontSize: 42, color: 'var(--green)', letterSpacing: '-.02em', margin: '6px 0 2px' }}>{D.inr(d.balance)}</div>
              <div style={{ fontSize: 12, color: 'var(--t2)' }}>Solve Factory holds LOT advance</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <Eyebrow>PROVISIONAL</Eyebrow>
              <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 18, color: 'var(--red)', marginTop: 6 }}>{D.inr(d.provisional)}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)' }}>after pending</div>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <BalanceChart values={d.rows.map((r) => r.balance)} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 9.5, color: 'var(--t3)', marginTop: 8 }}>
              <span>02 Sep</span><span>peak {D.inr(d.peak)}</span><span>01 Dec</span>
            </div>
          </div>
        </Card>
        <Card title="Recent movements">
          <div style={{ padding: '8px 20px 14px' }}>
            {recent.map((e, i) => (
              <div key={i} style={{ padding: '9px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <Mono size={11} color="var(--t3)">{e.ref} · {e.date.slice(5)}</Mono>
                  {Amt(e.amt)}
                </div>
                <div style={{ height: 4, borderRadius: 999, background: 'var(--surface2)' }}>
                  <div style={{ height: '100%', borderRadius: 999, width: `${(Math.abs(e.amt) / maxAbs) * 100}%`, background: e.amt < 0 ? 'var(--red)' : 'var(--green)' }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </Grid>
      <Grid cols="repeat(3,1fr)">
        <Kpi eyebrow="CREDITS · PAID IN" value={D.inr(d.credits)} color="var(--green)" size={24} sub="3 wires" />
        <Kpi eyebrow="DEBITS · GOODS + COSTS" value={D.inr(d.debits)} color="var(--red)" size={24} sub="goods + charges" />
        <Kpi eyebrow="BUFFER CONSUMED" value={`${d.bufferPct}%`} color="var(--accent)" size={24} sub="debits / credits" />
      </Grid>
      <Card title="Ledger" action={<Mono size={11} color="var(--t3)">full transaction history</Mono>}>
        <Table onRowClick={openDrill} rows={ledgerDesc} rowKey={(r) => r.ref + r.date} cols={[
          { label: 'Date', render: (r) => <Mono size={11} color="var(--t3)">{r.date}</Mono> },
          { label: 'Type', render: (r) => <Badge tone={D.ledgerTone(r.kind)}>{D.label(r.kind)}</Badge> },
          { label: 'Ref', render: (r) => <Mono color="var(--t1)" weight={600}>{r.ref}</Mono> },
          { label: 'Description', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.desc}</span> },
          { label: 'Amount', align: 'right', render: (r) => Amt(r.amt) },
          { label: 'Balance', align: 'right', render: (r) => <Mono>{D.inr(r.balance)}</Mono> },
        ]} />
      </Card>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
// 3. CHINA ORDERS
function Orders({ onNav }) {
  return (
    <Stack>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Dropdown>All statuses</Dropdown>
        <Dropdown>All categories</Dropdown>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => onNav('newOrder')}><Plus size={14} style={{ marginRight: 6, verticalAlign: -2 }} />New Order</Btn>
      </div>
      <Card>
        <Table onRowClick={() => onNav('orderDetail')} rows={D.ORDERS} rowKey={(r) => r.no} cols={[
          { label: 'Order', render: (r) => <Mono color="var(--t1)" weight={600}>{r.no}</Mono> },
          { label: 'Title', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.title}</span> },
          { label: 'Category', render: (r) => <Mono size={11} color="var(--t3)">{D.label(r.category)}</Mono> },
          { label: 'Value (RMB)', align: 'right', render: (r) => <Mono>{D.rmb(r.valueRmb)}</Mono> },
          { label: 'Snorkel PO', render: (r) => PO(r.po) },
          { label: 'Status', render: (r) => <Badge tone={D.orderTone(r.status)}>{D.label(r.status)}</Badge> },
          { label: 'Created', align: 'right', render: (r) => <Mono size={11} color="var(--t3)">{r.created}</Mono> },
        ]} />
      </Card>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
// 4. ORDER DETAIL
function OrderDetail({ onNav }) {
  const o = D.ORDER_DETAIL;
  return (
    <div>
      <BackChip onClick={() => onNav('orders')}>Orders</BackChip>
      <Grid cols="1.5fr 1fr" style={{ alignItems: 'start' }}>
        <Stack>
          <Card bodyPad="20px">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 }}>
              <div>
                <div style={{ fontFamily: DISP, fontWeight: 700, fontSize: 24, color: 'var(--t1)' }}>{o.no}</div>
                <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 4 }}>{o.subtitle}</div>
                <div style={{ marginTop: 10 }}><Badge tone={D.orderTone(o.status)}>{D.label(o.status)}</Badge></div>
              </div>
              <Btn variant="secondary">Re-sync {o.po}</Btn>
            </div>
            <div style={{ marginTop: 16, padding: '11px 14px', borderRadius: 9, fontFamily: MONO, fontSize: 11.5,
              background: 'color-mix(in srgb, var(--green) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--green) 28%, transparent)', color: 'var(--t2)' }}>
              Linked Snorkel China PO: <span style={{ color: 'var(--green)', fontWeight: 600 }}>{o.po}</span> · projected {o.projected}
            </div>
          </Card>
          <Card title={`Line items · ${D.ORDER_LINES.length}`}>
            <Table rows={D.ORDER_LINES} rowKey={(r) => r.n} cols={[
              { label: '#', render: (r) => <Mono size={11} color="var(--t3)">{r.n}</Mono> },
              { label: 'Product', render: (r) => <span style={{ color: 'var(--t1)' }}>{r.product}</span> },
              { label: 'Variant', render: (r) => <Mono size={11} color="var(--t3)">{r.variant}</Mono> },
              { label: 'Colour', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.colour}</span> },
              { label: 'Type', render: (r) => <Mono size={11} color="var(--t3)">{D.label(r.type)}</Mono> },
              { label: 'Qty', align: 'right', render: (r) => <Mono>{r.qty.toLocaleString('en-US')}</Mono> },
              { label: 'Unit ¥', align: 'right', render: (r) => <Mono>{r.unit}</Mono> },
              { label: 'Format', render: (r) => <Mono size={11} color="var(--t3)">{r.format}</Mono> },
            ]} />
          </Card>
        </Stack>
        <Card title="Cost breakdown" bodyPad="18px 20px 20px">
          {o.costRows.map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
              <span style={{ fontSize: 12.5, color: 'var(--t2)' }}>{r.label}</span>
              <Mono color="var(--t1)">{D.inr(r.amt)}</Mono>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0 4px' }}>
            <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>Landed total</span>
            <span style={{ fontFamily: DISP, fontWeight: 700, fontSize: 20, color: 'var(--t1)' }}>{D.inr(o.landed)}</span>
          </div>
          <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
            <Eyebrow style={{ marginBottom: 8 }}>Draw-down against this order</Eyebrow>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Mono color="var(--t1)" weight={600}>{o.drawdown.no} · {D.inr(o.drawdown.amt)}</Mono>
              <Badge tone={D.ddTone(o.drawdown.status)}>{D.label(o.drawdown.status)}</Badge>
            </div>
          </div>
        </Card>
      </Grid>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// 5. SHIPMENTS
function Shipments() {
  return (
    <Card>
      <Table rows={D.SHIPMENTS} rowKey={(r) => r.no} cols={[
        { label: 'Shipment', render: (r) => <Mono color="var(--t1)" weight={600}>{r.no}</Mono> },
        { label: 'Mode', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.mode}</span> },
        { label: 'BL · AWB', render: (r) => <Mono size={11} color="var(--t3)">{r.blAwb}</Mono> },
        { label: 'Order', render: (r) => PO(r.order) },
        { label: 'ETA', align: 'right', render: (r) => <Mono size={11} color="var(--t3)">{r.eta}</Mono> },
        { label: 'Status', render: (r) => <Badge tone={D.shipTone(r.status)}>{D.label(r.status)}</Badge> },
      ]} />
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════
// 6. DRAW-DOWNS
function Drawdowns({ onNav }) {
  return (
    <Stack>
      <div style={{ display: 'flex' }}>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => onNav('newDrawdown')}><Plus size={14} style={{ marginRight: 6, verticalAlign: -2 }} />Raise Draw-down</Btn>
      </div>
      <Card>
        <Table rows={D.DRAWDOWNS} rowKey={(r) => r.no} cols={[
          { label: 'No.', render: (r) => <Mono color="var(--t1)" weight={600}>{r.no}</Mono> },
          { label: 'Phase', render: (r) => <Mono size={11} color="var(--t3)">{D.label(r.phase)}</Mono> },
          { label: 'Order', render: (r) => PO(r.order) },
          { label: 'Est. INR', align: 'right', render: (r) => <Mono color="var(--t1)">{D.inr(r.estInr)}</Mono> },
          { label: 'Rate', align: 'right', render: (r) => <Mono>{r.rate}</Mono> },
          { label: 'Requested by', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.by}</span> },
          { label: 'Date', align: 'right', render: (r) => <Mono size={11} color="var(--t3)">{r.date}</Mono> },
          { label: 'Status', render: (r) => <Badge tone={D.ddTone(r.status)}>{D.label(r.status)}</Badge> },
        ]} />
      </Card>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
// 7. PAYMENTS
function Payments() {
  const d = D.derive();
  return (
    <Stack>
      <Grid cols="repeat(3,1fr)">
        <Kpi eyebrow="TOTAL WIRED → SF" value={D.inr(d.credits)} color="var(--green)" sub="3 wires · all cleared" size={24} />
        <Kpi eyebrow="THIS QUARTER" value={D.inr(5500000)} sub="Oct–Dec · 2 wires" size={24} />
        <Kpi eyebrow="AVG. RATE PAID" value="11.72" color="var(--t1)" sub="CNY/INR · weighted" size={24} />
      </Grid>
      <Card title="Outgoing wires" action={<Btn variant="secondary" style={{ padding: '7px 12px', fontSize: 11 }}><Plus size={13} style={{ marginRight: 5, verticalAlign: -2 }} />Record Wire</Btn>}>
        <Table rows={D.PAYMENTS} rowKey={(r) => r.ref} cols={[
          { label: 'Ref', render: (r) => <Mono color="var(--t1)" weight={600}>{r.ref}</Mono> },
          { label: 'Date', render: (r) => <Mono size={11} color="var(--t3)">{r.date}</Mono> },
          { label: 'Amount INR', align: 'right', render: (r) => <Mono color="var(--green)" weight={600}>{D.inr(r.inr)}</Mono> },
          { label: 'Amount RMB', align: 'right', render: (r) => <Mono>{D.rmb(r.rmb)}</Mono> },
          { label: 'Rate', align: 'right', render: (r) => <Mono>{r.rate}</Mono> },
          { label: 'Method', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.method}</span> },
          { label: 'Against', render: (r) => <Mono size={11} color="var(--t3)">{r.against}</Mono> },
          { label: 'Status', render: (r) => <Badge tone="green">{r.status}</Badge> },
        ]} />
      </Card>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
// 8. EXCHANGE RATES
function Fx() {
  return (
    <Stack>
      <Grid cols="1fr 1.5fr">
        <Card bodyPad="18px 20px 20px">
          <Eyebrow>CURRENT · CNY / INR</Eyebrow>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, margin: '6px 0 4px' }}>
            <span style={{ fontFamily: DISP, fontWeight: 700, fontSize: 46, color: 'var(--t1)', letterSpacing: '-.02em' }}>{D.FX}</span>
            <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: 'var(--green)' }}>▲ 0.02</span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--t3)', fontFamily: MONO }}>Set 14 Dec · Arjun Mehta · applied to all open draw-downs</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <Mono size={10} color="var(--t3)">90-day range</Mono>
            <Mono size={12} color="var(--t1)">11.60 – 11.82</Mono>
          </div>
        </Card>
        <Card title="Rate trend · Sep → Dec">
          <div style={{ padding: '16px 20px 18px' }}>
            <Sparkline values={D.FX_SPARK} min={11.55} max={11.87} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 9.5, color: 'var(--t3)', marginTop: 8 }}>
              <span>11.60</span><span>11.82</span>
            </div>
          </div>
        </Card>
      </Grid>
      <Card title="Rate history">
        <Table rows={D.FX_HISTORY} rowKey={(r) => r.date} cols={[
          { label: 'Date', render: (r) => <Mono size={11} color="var(--t3)">{r.date}</Mono> },
          { label: 'CNY · INR', render: (r) => <Mono color="var(--t1)" weight={600}>{r.rate}</Mono> },
          { label: 'Δ', render: (r) => r.delta == null ? <Mono size={11} color="var(--t3)">—</Mono>
            : <Mono size={11} color={r.delta > 0 ? 'var(--green)' : 'var(--t3)'}>{r.delta > 0 ? '+' : ''}{r.delta.toFixed(2)}</Mono> },
          { label: 'Set by', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.by}</span> },
          { label: 'Applied to', align: 'right', render: (r) => <Mono size={11} color="var(--t3)">{r.applied}</Mono> },
        ]} />
      </Card>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
// 9. DOCUMENTS
function Documents() {
  const chips = ['All', 'PI', 'Packing', 'BL', 'Invoice', 'Receipts'];
  const [f, setF] = useState('All');
  const match = (doc) => {
    if (f === 'All') return true;
    if (f === 'PI') return doc.type === 'PI';
    if (f === 'Packing') return doc.type === 'Packing List';
    if (f === 'BL') return doc.type === 'Bill of Lading';
    if (f === 'Invoice') return doc.type === 'Commercial Invoice';
    if (f === 'Receipts') return doc.type === 'Wire Receipt';
    return true;
  };
  const docs = D.DOCUMENTS.filter(match);
  return (
    <Stack>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {chips.map((c) => <FilterChip key={c} active={f === c} onClick={() => setF(c)}>{c}</FilterChip>)}
        <div style={{ flex: 1 }} />
        <Btn><Plus size={14} style={{ marginRight: 6, verticalAlign: -2 }} />Upload</Btn>
      </div>
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
              <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--t3)' }}>{doc.ref} · {doc.date} · {doc.size}</div>
            </div>
          );
        })}
      </Grid>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
// 10. ADMIN
function Admin() {
  return (
    <Stack>
      <div style={{ display: 'flex' }}>
        <div style={{ flex: 1 }} />
        <Btn><Plus size={14} style={{ marginRight: 6, verticalAlign: -2 }} />Invite User</Btn>
      </div>
      {D.ORG_GROUPS.map((g) => (
        <Card key={g.org} title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 24, height: 24, borderRadius: 6, background: `color-mix(in srgb, ${toneVar(g.tagTone)} 16%, transparent)`,
              color: toneVar(g.tagTone), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: DISP, fontWeight: 700, fontSize: 12 }}>{g.tag}</span>
            {g.org}<Mono size={10} color="var(--t3)" style={{ marginLeft: 4 }}>{g.members.length} members</Mono>
          </span>}>
          <Table rows={g.members} rowKey={(m) => m.email} cols={[
            { label: 'Name', render: (m) => (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 28, height: 28, borderRadius: 999, background: 'var(--surface2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 10, fontWeight: 600, color: 'var(--t2)' }}>{initials(m.name)}</span>
                <span style={{ color: 'var(--t1)' }}>{m.name}</span>
              </span>) },
            { label: 'Email', render: (m) => <Mono size={11} color="var(--t3)">{m.email}</Mono> },
            { label: 'Role', render: (m) => <Badge tone={D.roleTone(m.role)}>{m.role}</Badge> },
            { label: 'Last active', render: (m) => <Mono size={11} color="var(--t3)">{m.last}</Mono> },
            { label: 'Status', align: 'right', render: (m) => <Badge tone={D.userStatusTone(m.status)}>{m.status}</Badge> },
          ]} />
        </Card>
      ))}
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
// 11. NEW CHINA ORDER
function NewOrder({ onNav }) {
  return (
    <div>
      <BackChip onClick={() => onNav('orders')}>Orders</BackChip>
      <Grid cols="1.5fr 1fr" style={{ alignItems: 'start' }}>
        <Stack>
          <Card title="Order details" bodyPad="20px">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1 / -1' }}><Field label="Title"><Input defaultValue="Night Wolf RC — full build" /></Field></div>
              <Field label="Category"><Select options={['Product', 'Part', 'Sub-part', 'Mould', 'Sample', 'Other']} /></Field>
              <Field label="Vendor"><Select options={['Solve Factory · Shenzhen']} /></Field>
              <Field label="Currency"><Select options={['RMB (¥)']} /></Field>
              <Field label="Expected ready date"><Input defaultValue="18 Jan" /></Field>
            </div>
          </Card>
          <Card title="Line items" bodyPad="16px 20px 20px">
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
              {['Product', 'Qty', 'Unit ¥'].map((l) => <div key={l} style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>{l}</div>)}
            </div>
            {[['Night Wolf RC', '1,000', '138'], ['Wheel set', '1,800', '6.5']].map((row, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                <Input defaultValue={row[0]} /><Input defaultValue={row[1]} /><Input defaultValue={row[2]} />
              </div>
            ))}
            <button className="mf-chip" style={{ width: '100%', padding: '9px 0', borderRadius: 8, fontFamily: MONO, fontSize: 11,
              background: 'transparent', border: '1px dashed var(--border-strong)', color: 'var(--t3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <Plus size={13} />Add line</button>
          </Card>
        </Stack>
        <Card title="Estimated cost" bodyPad="18px 20px 20px">
          {[['Goods value (¥149,700)', 1769454], ['SF commission · 5% (¥7,485)', 88473], ['Intl freight (est.)', 240000], ['Customs duty (est.)', 290000]].map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
              <span style={{ fontSize: 12.5, color: 'var(--t2)' }}>{r[0]}</span><Mono color="var(--t1)">{D.inr(r[1])}</Mono>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0 4px' }}>
            <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>Est. landed</span>
            <span style={{ fontFamily: DISP, fontWeight: 700, fontSize: 20, color: 'var(--t1)' }}>{D.inr(2387927)}</span>
          </div>
          <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--t3)', marginTop: 8, lineHeight: 1.5 }}>¥157,185 goods + comm · converted at CNY/INR {D.FX}</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <Btn onClick={() => onNav('orders')} style={{ flex: 1 }}>Create Order</Btn>
            <Btn variant="secondary" onClick={() => onNav('orders')}>Save draft</Btn>
          </div>
        </Card>
      </Grid>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// 12. RAISE DRAW-DOWN
function NewDrawdown({ onNav }) {
  return (
    <div>
      <BackChip onClick={() => onNav('drawdowns')}>Draw-downs</BackChip>
      <Grid cols="1.5fr 1fr" style={{ alignItems: 'start' }}>
        <Card title="Draw-down request" bodyPad="20px">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Phase"><Select options={['Goods advance', 'Shipping & customs', 'Local', 'Other']} /></Field>
            <Field label="Against order"><Select options={['— none —', ...D.ORDERS.map((o) => o.no)]} /></Field>
            <Field label="Amount (INR)"><Input defaultValue="2,10,000" /></Field>
            <Field label="Rate (CNY/INR)"><Input defaultValue="11.82" /></Field>
            <div style={{ gridColumn: '1 / -1' }}><Field label="Notes"><Textarea defaultValue="" placeholder="Add context for this request…" /></Field></div>
            <div style={{ gridColumn: '1 / -1' }}><Field label="Requested by"><Input defaultValue="Wei Chen (SF)" /></Field></div>
          </div>
        </Card>
        <Card title="Conversion preview" bodyPad="18px 20px 20px">
          <Eyebrow>Amount requested</Eyebrow>
          <div style={{ fontFamily: DISP, fontWeight: 700, fontSize: 30, color: 'var(--t1)', margin: '6px 0 12px' }}>{D.inr(210000)}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: MONO, fontSize: 14, color: 'var(--t2)' }}>
            <ArrowRight size={16} color="var(--t3)" /><span style={{ color: 'var(--t1)' }}>{D.rmb(17766)}</span>
            <span style={{ fontSize: 11, color: 'var(--t3)' }}>at {D.FX}</span>
          </div>
          <div style={{ marginTop: 16, padding: 14, borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--t2)', lineHeight: 1.5 }}>
            Posts as a <span style={{ color: 'var(--red)', fontWeight: 600 }}>debit</span> once paid.<br />Net position becomes <span style={{ color: 'var(--t1)', fontFamily: MONO }}>{D.inr(1073000)}</span>.
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <Btn onClick={() => onNav('drawdowns')} style={{ flex: 1 }}>Submit Request</Btn>
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
