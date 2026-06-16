'use client';
// Manifest "Pit Wall" — all screens, wired to live getBootstrap data.
import React, { useState, useEffect } from 'react';
import { garageFetch } from '@throttle/db';
import { ArrowLeft, ArrowRight, Plus, ChevronDown, FileText } from 'lucide-react';
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
const initials = (name) => (name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

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
  return (
    <Stack>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Dropdown>All states</Dropdown>
        <Dropdown>All categories</Dropdown>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => onNav('newOrder')}><Plus size={14} style={{ marginRight: 6, verticalAlign: -2 }} />New Order</Btn>
      </div>
      <Card>
        {data.orders.length ? (
          <Table onRowClick={(r) => onNav('orderDetail', r.id)} rows={data.orders} rowKey={(r) => r.no} cols={[
            { label: 'Order', render: (r) => <Mono color="var(--t1)" weight={600}>{r.no}</Mono> },
            { label: 'Title', render: (r) => <span style={{ color: 'var(--t2)' }}>{r.title}</span> },
            { label: 'Category', render: (r) => <Mono size={11} color="var(--t3)">{D.label(r.category)}</Mono> },
            { label: 'Value (RMB)', align: 'right', render: (r) => r.valueRmb ? <Mono>{D.rmb(r.valueRmb)}</Mono> : <Mono color="var(--t3)">—</Mono> },
            { label: 'Snorkel PO', render: (r) => PO(r.po) },
            { label: 'State', render: (r) => <Badge tone={D.costStateTone(r.costState)}>{D.label(r.costState)}</Badge> },
            { label: 'Date', align: 'right', render: (r) => <Mono size={11} color="var(--t3)">{r.date}</Mono> },
          ]} />
        ) : <Empty>No orders yet</Empty>}
      </Card>
    </Stack>
  );
}

// ════════════════════════════════════════════════════════════════
function OrderDetail({ detailId, session, onNav }) {
  const [resp, setResp] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    if (!detailId) { setErr('No order selected'); return; }
    garageFetch('getOrder', { id: detailId }, session).then((d) => { if (alive) setResp(d); }).catch((e) => alive && setErr(e?.message || 'Load failed'));
    return () => { alive = false; };
  }, [detailId, session]);

  if (err) return <div><BackChip onClick={() => onNav('orders')}>Orders</BackChip><Empty>{err}</Empty></div>;
  if (!resp) return <div><BackChip onClick={() => onNav('orders')}>Orders</BackChip><Empty>Loading…</Empty></div>;
  const o = resp.order;
  return (
    <div>
      <BackChip onClick={() => onNav('orders')}>Orders</BackChip>
      <Grid cols="1.5fr 1fr" style={{ alignItems: 'start' }}>
        <Stack>
          <Card bodyPad="20px">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 }}>
              <div>
                <div style={{ fontFamily: DISP, fontWeight: 700, fontSize: 24, color: 'var(--t1)' }}>{o.order_no}</div>
                <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 4 }}>{o.title} · {o.vendor_name || 'Solve Factory'}{o.order_label ? ` · ${o.order_label}` : ''}</div>
                <div style={{ marginTop: 10 }}><Badge tone={D.costStateTone(o.cost_state)}>{D.label(o.cost_state)}</Badge></div>
              </div>
              {o.linked_po_number && <Btn variant="secondary">Re-sync {o.linked_po_number}</Btn>}
            </div>
            <div style={{ marginTop: 16, padding: '11px 14px', borderRadius: 9, fontFamily: MONO, fontSize: 11.5,
              background: o.linked_po_number ? 'color-mix(in srgb, var(--green) 12%, transparent)' : 'var(--surface2)',
              border: '1px solid ' + (o.linked_po_number ? 'color-mix(in srgb, var(--green) 28%, transparent)' : 'var(--border)'), color: 'var(--t2)' }}>
              {o.linked_po_number
                ? <>Linked Snorkel China PO: <span style={{ color: 'var(--green)', fontWeight: 600 }}>{o.linked_po_number}</span></>
                : 'Not yet projected to Snorkel'}
            </div>
          </Card>
          <Card title={`Line items · ${resp.lines.length}`}>
            {resp.lines.length ? (
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
        <Card title="Cost breakdown" bodyPad="18px 20px 20px">
          {resp.costRows.map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
              <span style={{ fontSize: 12.5, color: 'var(--t2)' }}>{r.label}</span><Mono color="var(--t1)">{D.inr(r.amt)}</Mono>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0 4px' }}>
            <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>{o.cost_state === 'in_flight' ? 'Purchase (in-flight)' : 'Landed total'}</span>
            <span style={{ fontFamily: DISP, fontWeight: 700, fontSize: 20, color: 'var(--t1)' }}>{D.inr(o.cost_state === 'in_flight' ? o.purchase_inr : resp.landed)}</span>
          </div>
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
function NewOrder({ onNav }) {
  return (
    <div>
      <BackChip onClick={() => onNav('orders')}>Orders</BackChip>
      <Grid cols="1.5fr 1fr" style={{ alignItems: 'start' }}>
        <Stack>
          <Card title="Order details" bodyPad="20px">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1 / -1' }}><Field label="Title"><Input placeholder="e.g. Night Wolf RC — full build" /></Field></div>
              <Field label="Category"><Select options={['Product', 'Part', 'Sub-part', 'Mould', 'Sample', 'Other']} /></Field>
              <Field label="Vendor"><Select options={['Solve Factory · Shenzhen']} /></Field>
              <Field label="Currency"><Select options={['RMB (¥)']} /></Field>
              <Field label="Expected ready date"><Input placeholder="e.g. 18 Jan" /></Field>
            </div>
          </Card>
          <Card title="Line items" bodyPad="16px 20px 20px">
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
              {['Product', 'Qty', 'Unit ¥'].map((l) => <div key={l} style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>{l}</div>)}
            </div>
            {[0, 1].map((i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                <Input placeholder="Product" /><Input placeholder="0" /><Input placeholder="0" />
              </div>
            ))}
            <button className="mf-chip" style={{ width: '100%', padding: '9px 0', borderRadius: 8, fontFamily: MONO, fontSize: 11, background: 'transparent', border: '1px dashed var(--border-strong)', color: 'var(--t3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <Plus size={13} />Add line</button>
          </Card>
        </Stack>
        <Card title="Estimated cost" bodyPad="18px 20px 20px">
          <div style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.6 }}>
            Goods (¥ × FX) + 2.5% SF commission + logistics. Live estimate appears as you add lines.
          </div>
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
function NewDrawdown({ data, onNav }) {
  return (
    <div>
      <BackChip onClick={() => onNav('drawdowns')}>Draw-downs</BackChip>
      <Grid cols="1.5fr 1fr" style={{ alignItems: 'start' }}>
        <Card title="Draw-down request" bodyPad="20px">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Phase"><Select options={['Goods advance', 'Shipping & customs', 'Local', 'Other']} /></Field>
            <Field label="Against order"><Select options={['— none —', ...data.orders.map((o) => o.no)]} /></Field>
            <Field label="Amount (INR)"><Input placeholder="0" /></Field>
            <Field label="Rate (CNY/INR)"><Input defaultValue={data.fx.current ?? ''} /></Field>
            <div style={{ gridColumn: '1 / -1' }}><Field label="Notes"><Textarea placeholder="Add context for this request…" /></Field></div>
            <div style={{ gridColumn: '1 / -1' }}><Field label="Requested by"><Input placeholder="Name" /></Field></div>
          </div>
        </Card>
        <Card title="Conversion preview" bodyPad="18px 20px 20px">
          <Eyebrow>Amount requested</Eyebrow>
          <div style={{ fontFamily: DISP, fontWeight: 700, fontSize: 30, color: 'var(--t1)', margin: '6px 0 12px' }}>₹0</div>
          <div style={{ marginTop: 4, padding: 14, borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--t2)', lineHeight: 1.5 }}>
            Posts as a <span style={{ color: 'var(--red)', fontWeight: 600 }}>debit</span> once paid, converted at the rate above.
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
