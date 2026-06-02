'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';

// Read-only Purchase Orders view. POs moved to Snorkel (snorkel.legendoftoys.com)
// in Session 94 — this Garage page is a reference list only. No create / edit /
// approve here; clicking a PO opens its printable document view (also read-only).

const SNORKEL_URL = 'https://snorkel.legendoftoys.com';

const PO_STATUS_TONES = {
  Soft:                           'orange',
  Draft:                          'gray',
  Accepted:                       'blue',
  Approved:                       'blue',
  Sent:                           'yellow',
  'Confirmed & Payment Done':     'green',
  'Partially Received':           'yellow',
  Closed:                         'green',
  Cancelled:                      'red',
  'Pending Approval':             'yellow',
};
const PO_SOURCES = ['China', 'India', 'USA', 'Germany', 'Taiwan', 'Vietnam', 'Bangladesh', 'Japan', 'South Korea', 'UK', 'Italy', 'Turkey', 'Other'];
const PO_TYPES   = ['Product', 'Packaging', 'Para', 'Consumable', 'Component', 'Tools', 'Machines'];

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.2)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.25)' },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.3)' },
  orange: { bg: 'rgba(255,140,0,.15)',  fg: '#ffaa33', border: 'rgba(255,140,0,.25)' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)' },
};

function StatusBadge({ label, tone = 'gray' }) {
  const s = TONE_STYLES[tone] || TONE_STYLES.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
      textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{label}</span>
  );
}

function sourceTone(s) {
  if (s === 'China') return 'blue';
  if (s === 'India') return 'green';
  return 'gray';
}

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const selectStyle      = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit', cursor: 'pointer' };
const searchInputStyle = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'var(--mono)', minWidth: 200 };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

function formatDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function openPO(po_number) {
  window.open(`/procurement/pos/print?po_number=${encodeURIComponent(po_number)}`, '_blank');
}

export default function POListPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({ status: '', source: '', order_type: '' });
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const params = {};
      if (filters.status) params.status = filters.status;
      if (filters.source) params.source = filters.source;
      if (filters.order_type) params.order_type = filters.order_type;
      const pos = await garageFetch('getPOs', params, session);
      setRows(Array.isArray(pos) ? pos : []);
    } catch (e) {
      showToast(e.message || 'Failed to load purchase orders', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, filters, showToast]);

  useEffect(() => { load(); }, [load]);

  if (perms && !perms.procurement_view) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  // Multi-token AND-of-OR substring search across po_number / vendor_name /
  // vendor_code / order_type / source / raised_by name / status.
  const filteredRows = !search.trim()
    ? rows
    : (() => {
        const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
        return rows.filter((r) => {
          const fields = [
            r.po_number, r.vendor_name, r.vendor_code, r.order_type,
            r.source, r.raised_by_name, r.raised_by, r.status,
          ].map((v) => (v || '').toString().toLowerCase());
          return tokens.every((t) => fields.some((f) => f.includes(t)));
        });
      })();

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Purchase Orders
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Read-only reference list.
        </p>
      </div>

      {/* Migration notice — POs are now created and managed in Snorkel. */}
      <div style={{ background: 'rgba(33,60,226,.1)', border: '1px solid rgba(123,147,255,.35)', borderRadius: 4, padding: '12px 16px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12.5, color: 'var(--t1)', lineHeight: 1.5 }}>
          <strong style={{ color: '#7b93ff' }}>Purchase Orders have moved to Snorkel.</strong>{' '}
          To raise, edit, accept or approve POs — and to manage vendors, forwarders,
          reorders, addresses and new products — use Snorkel or contact your system admin.
          This page is a read-only reference of recent POs.
        </div>
        <a
          href={SNORKEL_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...btnSecondary, borderColor: 'rgba(123,147,255,.5)', color: '#7b93ff', textDecoration: 'none', whiteSpace: 'nowrap' }}
        >
          Open Snorkel →
        </a>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Filters {search.trim() && <span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontWeight: 400, fontSize: 11 }}>· {filteredRows.length} of {rows.length}</span>}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              data-search-primary
              placeholder="Search PO / vendor / code · /"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={searchInputStyle}
            />
            <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} style={selectStyle}>
              <option value="">All Statuses</option>
              {Object.keys(PO_STATUS_TONES).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={filters.source} onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value }))} style={selectStyle}>
              <option value="">All Sources</option>
              {PO_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={filters.order_type} onChange={(e) => setFilters((f) => ({ ...f, order_type: e.target.value }))} style={selectStyle}>
              <option value="">All Types</option>
              {PO_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <button style={btnSecondary} onClick={load} disabled={loading}>↻ Refresh</button>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : filteredRows.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
              No purchase orders match the filter
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>PO Number</th>
                <th style={tableThStyle}>Rev</th>
                <th style={tableThStyle}>Type</th>
                <th style={tableThStyle}>Source</th>
                <th style={tableThStyle}>Vendor</th>
                <th style={tableThStyle}>Lines</th>
                <th style={tableThStyle}>Value</th>
                <th style={tableThStyle}>Expected</th>
                <th style={tableThStyle}>Raised By</th>
                <th style={tableThStyle}>Status</th>
                <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
              </tr></thead>
              <tbody>
                {filteredRows.map((r) => (
                  <tr
                    key={r.po_number}
                    style={{ cursor: 'pointer' }}
                    onClick={() => openPO(r.po_number)}
                  >
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.po_number}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{r.revision ?? 0}</td>
                    <td style={tableTdStyle}>{r.order_type || '—'}</td>
                    <td style={tableTdStyle}><StatusBadge label={r.source || '—'} tone={sourceTone(r.source)} /></td>
                    <td style={tableTdStyle}>{r.vendor_name || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.line_count ?? r.lines ?? 0}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>
                      {r.source === 'China' && !perms?.procurement_china
                        ? <span style={{ color: 'var(--t3)', fontStyle: 'italic' }}>Restricted</span>
                        : <>{r.currency || ''} {(r.po_value ?? 0).toLocaleString('en-IN')}</>
                      }
                    </td>
                    <td style={tableTdStyle}>{formatDate(r.expected_delivery)}</td>
                    <td style={tableTdStyle}>{r.raised_by_name || r.raised_by || '—'}</td>
                    <td style={tableTdStyle}><StatusBadge label={r.status || '—'} tone={PO_STATUS_TONES[r.status] || 'gray'} /></td>
                    <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                      <button
                        style={btnSecondary}
                        onClick={(e) => { e.stopPropagation(); openPO(r.po_number); }}
                      >
                        View →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
