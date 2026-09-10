'use client';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, getValidSession } from '@throttle/db';
import { useToast } from '@throttle/ui';
import { Download } from 'lucide-react';
import { Panel, Btn } from '@/components/ui.js';
import { inputStyle, labelStyle } from '@/lib/snorkelui';
import { todayStr } from '@throttle/domain';
import { buildPaymentsExportCsv } from '@/lib/paymentsExport.js';
import PaymentList from './PaymentList.js';

// The Tally / vendor-ledger export (Priya, #bugs 2026-09-07). PAID ONLY — UTR and payment date
// only exist once paid, and an unpaid row cannot be booked without inviting a double entry when
// it later pays.
// ⚠️ Shown ONLY to the roles `getPaidPaymentsExport` lets through (payment_request AND one of
// approve / execute / super_admin). Never render a button that hands its user a 403 — and this
// file carries UTRs.
function PaidPaymentsExport() {
  const { showToast } = useToast();
  // Every range picker in every LOT app opens on Today — house rule, not a per-screen choice.
  const [from, setFrom] = useState(todayStr);
  const [to, setTo]     = useState(todayStr);
  const [rows, setRows] = useState([]);
  // Non-null only when the worker says the read was cut short: { total, fetched, limit }.
  const [truncation, setTruncation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // The count is LIVE on the range, and that is the point: only 7 payments are paid at all today
  // and the newest is 2026-09-08, so the Today default very often matches ZERO rows. A silent
  // empty file reads as broken software — the screen has to say "nothing here" before the
  // download does.
  const load = useCallback(async () => {
    if (!from || !to || from > to) { setRows([]); setTruncation(null); setLoaded(false); return; }
    setLoading(true);
    try {
      const s = await getValidSession();
      const data = await garageFetch('getPaidPaymentsExport', { from, to }, s);
      setRows(data?.rows || []);
      setTruncation(data?.truncated ? data : null);
      setLoaded(true);
    } catch (e) {
      showToast(e.message || 'Failed to load payments', 'error');
      setRows([]); setTruncation(null); setLoaded(false);
    } finally { setLoading(false); }
  }, [from, to, showToast]);
  useEffect(() => { load(); }, [load]);

  function exportCsv() {
    if (!rows.length) return;
    // ⚠️ Same reasoning as the PO exports: this file gets TOTALLED in a spreadsheet, where a short
    // total reads as authoritative. Confirm first, then carry the fact in the FILENAME — the only
    // part of the warning that survives the file being saved, renamed or emailed on.
    if (truncation) {
      const ok = window.confirm(
        `This export is PARTIAL.\n\n` +
        (truncation.total != null
          ? `${truncation.total} payments fall in these dates, but only the first ${truncation.limit} were loaded. `
          : `More payments fall in these dates than the first ${truncation.limit} that were loaded. `) +
        `Any total you calculate from this file will be too low.\n\nExport the partial file anyway?`
      );
      if (!ok) return;
    }
    const blob = new Blob([buildPaymentsExportCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // The range is in the name — this file is filed against a Tally period, so "which dates" must
    // survive the download folder.
    a.download = truncation
      ? `lot-payments-PARTIAL-${rows.length}-${from}-to-${to}.csv`
      : `lot-payments-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Panel title="Export paid payments">
      <div style={{ padding: '12px 16px 0', fontSize: 12, color: 'var(--t2)' }}>
        For Tally, vendor ledgers and bank reconciliation — <b>paid requests only</b>, with UTR,
        payment date and any TDS deducted.
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', padding: '14px 16px' }}>
        <div>
          <label style={labelStyle}>From</label>
          <input type="date" style={inputStyle} value={from} max={to} onChange={e => setFrom(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>To</label>
          <input type="date" style={inputStyle} value={to} min={from} onChange={e => setTo(e.target.value)} />
        </div>
        <Btn kind="primary" onClick={exportCsv} disabled={loading || !rows.length}>
          <Download size={14} /> Export CSV
        </Btn>
        <div style={{ fontSize: 13, color: 'var(--t2)' }}>
          {loading
            ? 'Counting…'
            : from > to
              ? 'The From date is after the To date.'
              : `${rows.length} payment${rows.length === 1 ? '' : 's'} in this range`}
        </div>
      </div>
      {/* The empty state is explicit on purpose: the Today default will usually be empty, and
          "no button, no message" is how a working screen gets reported as broken. */}
      {loaded && !loading && rows.length === 0 && (
        <div style={{
          margin: '0 16px 16px', padding: '10px 14px', borderRadius: 8,
          background: 'var(--surface-2)', border: '1px solid var(--bd)',
          color: 'var(--t2)', fontSize: 13, lineHeight: 1.5,
        }}>
          No payments were made between <b>{from}</b> and <b>{to}</b>, so there is nothing to
          export. Widen the dates — the picker opens on today.
        </div>
      )}
      {truncation && (
        <div style={{
          margin: '0 16px 16px', padding: '10px 14px', borderRadius: 8,
          background: 'var(--warn-bg, #fff7ed)', border: '1px solid var(--warn-br, #fdba74)',
          color: 'var(--warn-fg, #9a3412)', fontSize: 13, lineHeight: 1.5,
        }}>
          <strong>
            {truncation.total != null
              ? `Showing the first ${truncation.limit} of ${truncation.total} payments.`
              : `Showing the first ${truncation.limit} payments — there are more.`}
          </strong>{' '}
          The export will be marked PARTIAL.
        </div>
      )}
    </Panel>
  );
}

export default function MyPaymentRequestsPage() {
  const { perms } = useAuth();
  // Same FOUR permissions the worker's guard tests, in the same order — a button that 403s is a
  // permission taught to one surface and not the next. `getPaidPaymentsExport` gates on
  // payment_request FIRST (an AND), then on any of approve/execute/super_admin. Latent today
  // (every current grant holder has payment_request via admin/finance_manager; jarvis_ro is the
  // only role without it), but a role granted execute alone would render the panel and 403 on
  // every mount.
  const canExport = !!(perms?.payment_request &&
    (perms.payment_approve || perms.payment_execute || perms.payment_super_admin));
  return (
    <PaymentList
      scope="mine"
      title="My Payment Requests"
      sub="Every request you've raised, and where it has got to — no need to ask."
      showNewCta
      emptyHint="Raise one from New Payment Request."
      // Rendered under the page title by PaymentList, not above it. Only for the three
      // privileged roles — everyone else's page is unchanged.
      beforeList={canExport ? <PaidPaymentsExport /> : null}
    />
  );
}
