'use client';
// Party balances — one signed row per sales partner (billed − credit notes − received).
// Built for the Tally reconciliation (Prarthi, 2026-09-11): Collections deliberately lists only
// invoices with money owed, so pivoting its export by partner drops every overpaid / fully
// credited invoice and OVERSTATES what the partner owes. This screen nets them. The worker
// (getSalesPartyBalances) uses Collections' exact population and per-order balance, so a
// partner's "Open invoices" figure here ties to the Collections list to the paisa.
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { Download } from 'lucide-react';
import { inr, csvCell } from '@/lib/sales';
import { PageHead, Kpi, Panel, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateShort, inrCompact } from '@/components/format.js';

// Sub-paisa noise never happens (the worker sums in paise), but a balance of exactly 0 is
// "settled" — neither owing nor in credit.
const isOwing  = r => Number(r.balance) > 0.005;
const isCredit = r => Number(r.balance) < -0.005;

// Signed display: owing "₹93,317.00", in credit "Cr ₹32,286.00" — never a bare minus sign that
// a skim reads as a small positive number.
function signedInr(n) {
  const v = Number(n) || 0;
  if (v < -0.005) return 'Cr ' + inr(-v);
  return inr(v);
}
function compactSigned(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '−' : '') + inrCompact(Math.abs(v));
}

export default function PartyBalancesPage() {
  const { userId, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [seg, setSeg] = useState('all');
  const [search, setSearch] = useState('');
  const [sortDir, setSortDir] = useState('desc');
  const firstLoadDone = useRef(false);

  // Keyed on userId, never on session (CORE: a token refresh hands over a new session object).
  const load = useCallback(async () => {
    if (!userId) return;
    if (!firstLoadDone.current) setLoading(true);
    try {
      const s = await getValidSession();
      const data = await garageFetch('getSalesPartyBalances', {}, s);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) { showToast(e.message || 'Failed to load party balances', 'error'); }
    finally { firstLoadDone.current = true; setLoading(false); }
  }, [userId, showToast]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = rows.filter(r => {
      if (seg === 'owing' && !isOwing(r)) return false;
      if (seg === 'credit' && !isCredit(r)) return false;
      if (!q) return true;
      return `${r.partner_name || ''} ${r.partner_code || ''}`.toLowerCase().includes(q);
    });
    const dir = sortDir === 'asc' ? 1 : -1;
    return out.sort((a, b) => dir * (Number(a.balance) - Number(b.balance))
      || String(a.partner_name || '').localeCompare(String(b.partner_name || '')));
  }, [rows, seg, search, sortDir]);

  if (perms && !perms.sales_view && !perms.sales_order_manage && !perms.sales_payment_manage) {
    return <div style={{ padding: 24, color: 'var(--text-3)' }}>Access restricted.</div>;
  }

  const owing = rows.filter(isOwing);
  const credit = rows.filter(isCredit);
  const totalOwed = owing.reduce((s, r) => s + Number(r.balance || 0), 0);
  const totalCredit = credit.reduce((s, r) => s + Number(r.balance || 0), 0); // negative
  const net = totalOwed + totalCredit;

  const segs = [
    { id: 'all',    lbl: 'All',       n: rows.length },
    { id: 'owing',  lbl: 'Owing',     n: owing.length },
    { id: 'credit', lbl: 'In credit', n: credit.length },
  ];

  // Writes exactly the rows on screen (segment + search + sort applied). Balance stays a SIGNED
  // number so it pivots and sums in a spreadsheet; the Cr/Dr column carries the reading.
  function exportCsv() {
    const cols = ['Partner', 'Partner Code', 'Channel', 'Type', 'Billed', 'Credit Notes', 'Received',
      'Balance', 'Dr/Cr', 'Open Invoices', 'Open Balance', 'Oldest Due', 'Last Order'];
    const lines = [cols.join(',')];
    for (const r of filtered) lines.push([r.partner_name, r.partner_code, r.channel_key, r.partner_type,
      r.billed, r.credits, r.received, r.balance, isCredit(r) ? 'Cr' : isOwing(r) ? 'Dr' : '',
      r.open_count, r.open_balance, r.oldest_due, r.last_order_date].map(csvCell).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `lot-party-balances-${todayStr()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="pg">
      <PageHead title="Party Balances"
        sub="What each partner owes after credit notes and receipts, netted across all invoices. Negative = partner in credit."
        actions={<>
          <Btn onClick={() => router.push('/sales/collections')}>← Collections</Btn>
          <Btn onClick={exportCsv} disabled={!filtered.length}><Download size={14} /> Export</Btn>
        </>} />

      <div className="kpi-row kpi-3">
        <Kpi label="Owed by partners" value={totalOwed} sub={`${owing.length} partners owing`} tone="yellow" format={(v) => inrCompact(v)} />
        <Kpi label="Held in credit" value={Math.abs(totalCredit)} sub={`${credit.length} partners in credit`} tone="green" format={(v) => inrCompact(v)} />
        <Kpi label="Net receivable" value={net} sub="owed − credit held" tone="blue" format={(v) => compactSigned(v)} />
      </div>

      <div className="seg">
        {segs.map(({ id, lbl, n }) => (
          <button key={id} className={`seg-btn ${seg === id ? 'on' : ''}`} onClick={() => setSeg(id)}>{lbl} <span className="seg-n">{n}</span></button>
        ))}
      </div>

      <Panel title="Partners" count={filtered.length}
        action={
          <div className="filters">
            <input className="sel" data-search-primary type="text" placeholder="Search partner / code · /" value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 180 }} />
            <Btn onClick={load} disabled={loading}>Refresh</Btn>
          </div>
        }>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : filtered.length === 0 ? <EmptyState icon="inbox" title="No partners" hint={rows.length ? 'Nothing matches this filter.' : 'No invoiced orders yet.'} />
          : (
            <table className="dt">
              <thead><tr>
                <th>Partner</th><th>Code</th><th>Channel</th>
                <th className="num">Billed</th><th className="num">Credit notes</th><th className="num">Received</th>
                <th className="num" style={{ cursor: 'pointer' }} onClick={() => setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))}
                  title="Sort by balance">Balance {sortDir === 'desc' ? '▼' : '▲'}</th>
                <th className="num">Open inv.</th><th>Oldest due</th><th>Last order</th>
              </tr></thead>
              <tbody>
                {filtered.map(r => {
                  const cr = isCredit(r), ow = isOwing(r);
                  return (
                    <tr key={r.partner_id || r.partner_name}>
                      <td className={r.partner_id ? 'accent row-click' : ''}
                        onClick={r.partner_id ? () => router.push(`/sales/partners/detail?id=${encodeURIComponent(r.partner_id)}`) : undefined}>
                        {r.partner_name || '—'}
                      </td>
                      <td className="mono dim" style={{ fontSize: 11 }}>{r.partner_code || '—'}</td>
                      <td className="mono dim" style={{ fontSize: 11 }}>{r.channel_key || '—'}</td>
                      <td className="num mono">{inr(r.billed)}</td>
                      <td className="num mono dim">{Number(r.credits) ? inr(r.credits) : '—'}</td>
                      <td className="num mono">{inr(r.received)}</td>
                      <td className="num mono" style={{ fontWeight: 600, color: cr ? 'var(--green-fg)' : ow ? 'var(--red-fg)' : 'var(--text-3)' }}>
                        {signedInr(r.balance)}
                      </td>
                      <td className="num mono">{r.open_count || <span className="dim">0</span>}</td>
                      <td className="mono dim">{r.oldest_due ? fmtDateShort(r.oldest_due) : '—'}</td>
                      <td className="mono dim">{r.last_order_date ? fmtDateShort(r.last_order_date) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </Panel>
    </div>
  );
}
