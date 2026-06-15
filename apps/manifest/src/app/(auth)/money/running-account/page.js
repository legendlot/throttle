'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import {
  panelStyle, panelHeaderStyle, pageH1, pageSub, tableThStyle, tableTdStyle, StatusBadge, fmtINR, fmtDate, titleCase,
} from '../../../../lib/manifestui.js';

const KIND_TONE = { payment: 'green', goods: 'red', charge: 'red', manual: 'blue' };

export default function RunningAccountPage() {
  const { session } = useAuth();
  const [acct, setAcct] = useState(null);
  const [due, setDue] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      garageFetch('getRunningAccount', {}, session).catch(() => ({ entries: [], balance: 0 })),
      garageFetch('getMoneyDue', {}, session).catch(() => null),
    ]).then(([a, d]) => { setAcct(a); setDue(d); }).finally(() => setLoading(false));
  }, [session]);

  const balance = acct ? Number(acct.balance) : 0;
  const owes = balance < 0;

  return (
    <div>
      <div style={{ marginBottom: 16 }}><h1 style={pageH1}>Running Account</h1><div style={pageSub}>LOT ↔ Solve Factory · pooled ledger · credits (payments) − debits (goods + costs)</div></div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ ...panelStyle, marginBottom: 0, flex: 1, minWidth: 220, padding: '16px' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--t3)' }}>Net position (actual)</div>
          <div style={{ fontFamily: 'var(--cond)', fontSize: 30, fontWeight: 900, marginTop: 6, color: owes ? 'var(--red)' : 'var(--green)' }}>{fmtINR(Math.abs(balance))}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', marginTop: 4 }}>{owes ? 'LOT owes Solve Factory' : 'Solve Factory holds LOT funds (advance)'}</div>
        </div>
        {due && (
          <div style={{ ...panelStyle, marginBottom: 0, flex: 1, minWidth: 220, padding: '16px' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--t3)' }}>Provisional (after pending costs)</div>
            <div style={{ fontFamily: 'var(--cond)', fontSize: 30, fontWeight: 900, marginTop: 6, color: Number(due.provisional_balance) < 0 ? 'var(--red)' : 'var(--green)' }}>{fmtINR(Math.abs(Number(due.provisional_balance)))}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>est. costs pending {fmtINR(due.estimate_charges)} · open draw-downs {fmtINR(due.open_drawdowns)}</div>
          </div>
        )}
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Ledger</span></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Date</th><th style={tableThStyle}>Type</th><th style={tableThStyle}>Ref</th>
              <th style={tableThStyle}>Description</th><th style={{ ...tableThStyle, textAlign: 'right' }}>Amount</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}>Balance</th>
            </tr></thead>
            <tbody>
              {loading && <tr><td style={tableTdStyle} colSpan={6}>Loading…</td></tr>}
              {!loading && (!acct?.entries || acct.entries.length === 0) && <tr><td style={{ ...tableTdStyle, color: 'var(--t3)' }} colSpan={6}>No ledger entries yet</td></tr>}
              {(acct?.entries || []).map((e, i) => {
                const amt = Number(e.signed_inr);
                return (
                  <tr key={i}>
                    <td style={tableTdStyle}>{fmtDate(e.entry_date || e.created_at)}</td>
                    <td style={tableTdStyle}><StatusBadge label={titleCase(e.kind)} tone={KIND_TONE[e.kind] || 'gray'} /></td>
                    <td style={tableTdStyle}>{e.ref_no || '—'}</td>
                    <td style={tableTdStyle}>{e.description || '—'}</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right', color: amt < 0 ? 'var(--red)' : 'var(--green)' }}>{amt < 0 ? '−' : '+'}{fmtINR(Math.abs(amt))}</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right', color: 'var(--t2)' }}>{fmtINR(e.running_balance)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
