'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Chip, KpiCard, EmptyState, Spinner } from '@throttle/ui';
import { Plus, Download, Search, ListChecks } from 'lucide-react';
import { csopsGet } from '../../../lib/csopsFetch.js';

// ── Sub-tabs ─────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'my',         label: 'My Queue' },
  { id: 'open',       label: 'All Open' },
  { id: 'awaiting',   label: 'Awaiting Evidence' },
  { id: 'logistics',  label: 'In Logistics' },
  { id: 'inspection', label: 'Inspection' },
  { id: 'resolution', label: 'Resolution' },
  { id: 'closed',     label: 'Closed' },
];

const TYPES     = ['replacement', 'refund', 'repair'];
const PLATFORMS = ['website','amazon','cred','blinkit','instamart','marketplace','offline','zepto','swiggy'];

// ── Visual helpers ───────────────────────────────────────────────────────────

const TYPE_PALETTE = {
  replacement: { bg: 'rgba(123, 147, 255, 0.12)', fg: '#7b93ff', border: 'rgba(123, 147, 255, 0.35)' },
  refund:      { bg: 'rgba(251, 191, 36, 0.12)',  fg: '#fbbf24', border: 'rgba(251, 191, 36, 0.35)' },
  repair:      { bg: 'rgba(74, 222, 128, 0.12)',  fg: '#4ade80', border: 'rgba(74, 222, 128, 0.35)' },
  other:       { bg: 'var(--surface-2)',          fg: 'var(--t2)', border: 'var(--border)' },
};

function TypeBadge({ type }) {
  const p = TYPE_PALETTE[type] || TYPE_PALETTE.other;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      background: p.bg,
      color: p.fg,
      border: `1px solid ${p.border}`,
      borderRadius: 'var(--radius-sm)',
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
    }}>{type}</span>
  );
}

function StagePill({ stage }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      background: 'var(--surface-2)',
      color: 'var(--t2)',
      borderRadius: 'var(--radius-sm)',
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      letterSpacing: '0.02em',
    }}>{stage}</span>
  );
}

function ageDays(createdAt) {
  if (!createdAt) return null;
  const ms = Date.now() - new Date(createdAt).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function AgeCell({ createdAt, dueAt, closedAt }) {
  if (closedAt) {
    const days = (new Date(closedAt) - new Date(createdAt)) / (1000 * 60 * 60 * 24);
    return <span style={{ color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{days.toFixed(0)} d (closed)</span>;
  }
  const d = ageDays(createdAt);
  if (d == null) return null;

  const overdue = dueAt && Date.now() > new Date(dueAt).getTime();
  const color = overdue ? 'var(--state-error-fg)' : d > 3 ? 'var(--state-warning-fg)' : 'var(--state-success-fg)';
  const fontWeight = overdue ? 700 : 600;

  const daysOver = overdue ? Math.floor((Date.now() - new Date(dueAt).getTime()) / (1000 * 60 * 60 * 24)) : null;

  return (
    <span style={{ color, fontFamily: 'var(--font-mono)', fontWeight, fontSize: 12 }}>
      {d.toFixed(0)} d
      {daysOver > 0 && (
        <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 500 }}>+{daysOver}d over</span>
      )}
    </span>
  );
}

function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone);
  if (s.length < 4) return s;
  return s.slice(0, -3) + '***';
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function QueuePage() {
  const { user, session } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const activeTab = searchParams.get('tab') || 'my';
  const typeFilter = searchParams.get('type') || '';
  const platformFilter = searchParams.get('platform') || '';
  const searchQ = searchParams.get('q') || '';

  const [counts, setCounts] = useState({});
  const [kpis, setKpis] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchInput, setSearchInput] = useState(searchQ);

  // Update URL with a partial param patch
  function setParam(key, value) {
    const params = new URLSearchParams(searchParams);
    if (value == null || value === '') params.delete(key);
    else params.set(key, value);
    router.push(`/queue?${params.toString()}`);
  }

  // Counts (every 60s) + KPIs (every 60s)
  useEffect(() => {
    if (!session) return;
    let alive = true;
    const fetchSummary = async () => {
      try {
        const [c, k] = await Promise.all([
          csopsGet('getQueueCounts', {}, session),
          csopsGet('getKpis', {}, session),
        ]);
        if (alive) { setCounts(c || {}); setKpis(k); }
      } catch (e) { if (alive) setError(e.message); }
    };
    fetchSummary();
    const t = setInterval(fetchSummary, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [session]);

  // Tickets — refetch on tab/filter/search change
  useEffect(() => {
    if (!session) return;
    let alive = true;
    setLoading(true);
    const params = { tab: activeTab };
    if (typeFilter)     params.type     = typeFilter;
    if (platformFilter) params.platform = platformFilter;
    if (searchQ)        params.search   = searchQ;

    csopsGet('getTickets', params, session)
      .then(d => { if (alive) { setTickets(d?.tickets || []); setError(null); } })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [session, activeTab, typeFilter, platformFilter, searchQ]);

  // Submit search on Enter
  function submitSearch(e) {
    e.preventDefault();
    setParam('q', searchInput.trim());
  }

  function exportCsv() {
    const rows = [
      ['ticket_no','customer','phone','product','model','type','stage','platform','agent','created_at','due_at','closed_at'],
      ...tickets.map(t => [
        t.ticket_no, t.customer_name || '', maskPhone(t.customer_phone),
        t.product || '', t.product_model || '',
        t.issue_type, t.stage, t.platform || '',
        t.assigned_agent_name || '', t.created_at || '', t.due_at || '', t.closed_at || '',
      ]),
    ];
    const csv = rows.map(r => r.map(v => {
      const s = String(v == null ? '' : v);
      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pitstop-${activeTab}-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      {/* ── Header ─────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 'var(--space-4)' }}>
        <h1 style={{
          fontFamily: 'var(--font-cond)',
          fontSize: 'var(--text-xl)',
          fontWeight: 600,
          letterSpacing: 'var(--tracking-tight)',
          textTransform: 'uppercase',
          color: 'var(--t1)',
        }}>Queue</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={exportCsv} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 12px',
            background: 'transparent',
            color: 'var(--t2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            cursor: 'pointer',
          }}>
            <Download size={13} strokeWidth={1.75} /> Export CSV
          </button>
          <Link href="/new" style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 14px',
            background: 'var(--brand-red)',
            color: '#fff',
            border: '1px solid var(--brand-red)',
            borderRadius: 'var(--radius-md)',
            fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            textDecoration: 'none',
          }}>
            <Plus size={14} strokeWidth={2} /> New Ticket
          </Link>
        </div>
      </div>

      {/* ── KPI row ────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <KpiCard label="My Open"             value={kpis?.my_open ?? '—'}              sub="assigned to you" />
        <KpiCard label="Overdue"             value={kpis?.overdue ?? '—'}              sub="past SLA"         color="red" />
        <KpiCard label="Awaiting Evidence ≥3d" value={kpis?.awaiting_evidence_old ?? '—'} sub="nudge candidates" color="orange" />
        <KpiCard label="Closed Today"        value={kpis?.closed_today ?? '—'}         sub="resolutions" />
        <KpiCard label="Avg Close (MTD)"     value={kpis?.avg_close_days_mtd == null ? '—' : `${kpis.avg_close_days_mtd}d`} sub="month-to-date" />
      </div>

      {/* ── Sub-tabs ───────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 4, padding: '4px 0',
        borderBottom: '1px solid var(--border)',
        marginBottom: 'var(--space-3)',
        overflowX: 'auto', flexWrap: 'wrap',
      }}>
        {TABS.map(t => {
          const isActive = activeTab === t.id;
          const count = counts[t.id];
          return (
            <button
              key={t.id}
              onClick={() => setParam('tab', t.id)}
              style={{
                padding: '8px 14px',
                background: isActive ? 'var(--surface-2)' : 'transparent',
                color: isActive ? 'var(--t1)' : 'var(--t3)',
                border: 'none',
                borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
                fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)',
                fontWeight: isActive ? 700 : 600,
                cursor: 'pointer', whiteSpace: 'nowrap',
                position: 'relative',
                borderBottom: isActive ? '2px solid var(--brand-red)' : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              {t.label}
              {count != null && (
                <span style={{
                  marginLeft: 6,
                  padding: '0 6px',
                  background: isActive ? 'var(--brand-red)' : 'var(--surface-3)',
                  color: isActive ? '#fff' : 'var(--t2)',
                  borderRadius: 8,
                  fontSize: 10, fontWeight: 700,
                }}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Filter bar ─────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
        {/* Search */}
        <form onSubmit={submitSearch} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '6px 10px',
            minWidth: 320,
          }}>
            <Search size={13} strokeWidth={1.75} color="var(--t3)" />
            <input
              data-search-primary
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search name, phone, order, UPC, ticket #…  ( / )"
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none', outline: 'none',
                color: 'var(--t1)',
                fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)',
              }}
            />
          </div>
          {searchQ && (
            <button type="button" onClick={() => { setSearchInput(''); setParam('q', ''); }} style={{
              background: 'transparent', border: 'none',
              color: 'var(--t3)', cursor: 'pointer',
              fontFamily: 'var(--font-mono)', fontSize: 11,
            }}>clear</button>
          )}
        </form>

        <span style={{ color: 'var(--border)', padding: '0 4px' }}>|</span>

        {/* Type chips */}
        <Chip active={typeFilter === ''} onClick={() => setParam('type', '')}>All types</Chip>
        {TYPES.map(t => (
          <Chip key={t} active={typeFilter === t} onClick={() => setParam('type', t)}>{t}</Chip>
        ))}

        <span style={{ color: 'var(--border)', padding: '0 4px' }}>|</span>

        {/* Platform select */}
        <select
          value={platformFilter}
          onChange={e => setParam('platform', e.target.value)}
          style={{
            background: 'var(--surface)',
            color: 'var(--t1)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '5px 8px',
            fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)',
          }}
        >
          <option value="">All platforms</option>
          {PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {/* ── Error / loading ────────────────────────── */}
      {error && (
        <div style={{
          padding: 12, marginBottom: 12,
          background: 'var(--state-error-bg)',
          color: 'var(--state-error-fg)',
          border: '1px solid var(--state-error)',
          borderRadius: 'var(--radius-md)',
          fontFamily: 'var(--font-mono)', fontSize: 12,
        }}>
          {error}
        </div>
      )}

      {/* ── Table ──────────────────────────────────── */}
      {loading ? (
        <Spinner />
      ) : tickets.length === 0 ? (
        <EmptyState icon={ListChecks} title="No tickets match" message="Adjust filters or open a new ticket." />
      ) : (
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <thead style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
              <tr>
                <Th>Ticket</Th>
                <Th>Customer</Th>
                <Th>Product</Th>
                <Th>Type</Th>
                <Th>Stage</Th>
                <Th>Platform</Th>
                <Th>Agent</Th>
                <Th align="right">Age / SLA</Th>
              </tr>
            </thead>
            <tbody>
              {tickets.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                    onClick={() => router.push(`/queue/${t.ticket_no}/`)}>
                  <Td mono><span style={{ color: 'var(--t1)', fontWeight: 600 }}>{t.ticket_no}</span></Td>
                  <Td>
                    <div style={{ color: 'var(--t1)' }}>{t.customer_name}</div>
                    <div style={{ color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{maskPhone(t.customer_phone)}</div>
                  </Td>
                  <Td>
                    {t.product ? `${t.product}${t.product_model ? ` · ${t.product_model}` : ''}` : <span style={{ color: 'var(--t4)' }}>—</span>}
                    {t.product_color && <span style={{ color: 'var(--t3)', marginLeft: 4 }}>· {t.product_color}</span>}
                  </Td>
                  <Td><TypeBadge type={t.issue_type} /></Td>
                  <Td><StagePill stage={t.stage} /></Td>
                  <Td>
                    <span style={{ color: 'var(--t2)' }}>{t.platform || '—'}</span>
                    {t.external_order_id && (
                      <div style={{ color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{t.external_order_id}</div>
                    )}
                  </Td>
                  <Td>{t.assigned_agent_name || <span style={{ color: 'var(--t4)' }}>—</span>}</Td>
                  <Td align="right"><AgeCell createdAt={t.created_at} dueAt={t.due_at} closedAt={t.closed_at} /></Td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{
            padding: '8px 14px',
            background: 'var(--surface-2)',
            color: 'var(--t3)',
            fontFamily: 'var(--font-mono)', fontSize: 11,
            borderTop: '1px solid var(--border)',
          }}>
            {tickets.length} ticket{tickets.length === 1 ? '' : 's'}
          </div>
        </div>
      )}
    </div>
  );
}

function Th({ children, align = 'left' }) {
  return (
    <th style={{
      padding: '8px 12px',
      textAlign: align,
      color: 'var(--t3)',
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 'var(--tracking-wide)',
      textTransform: 'uppercase',
    }}>{children}</th>
  );
}

function Td({ children, mono, align = 'left' }) {
  return (
    <td style={{
      padding: '10px 12px',
      color: 'var(--t2)',
      verticalAlign: 'middle',
      textAlign: align,
      fontFamily: mono ? 'var(--font-mono)' : 'inherit',
    }}>{children}</td>
  );
}
