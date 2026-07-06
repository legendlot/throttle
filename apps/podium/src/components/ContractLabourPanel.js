'use client';
import { useEffect, useMemo, useState } from 'react';
import { useToast } from '@throttle/ui';
import { Trash2, Plus } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';
import { fmtINR, monthKey, fyStartYear, periodLabel } from '../lib/payouts.js';

const FY = fyStartYear();
const MONTHS = Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1; const y = m >= 4 ? FY : FY + 1; return monthKey(y, m); });

// Bulk / vendor payouts (contract-labour agency etc.) — one row, not per-employee.
// All people-cost lives in the one ledger (Option A) so Odo SG&A reads a single source.
export default function ContractLabourPanel({ session }) {
  const { showToast } = useToast();
  const [rows, setRows] = useState(null);   // null=loading, false=forbidden
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ payee_label: '', period_key: MONTHS[0], amount: '', paid_on: '', note: '' });

  const load = () => {
    if (!session) return;
    podiumopsGet('getBulkPayouts', {}, session).then((r) => setRows(r.payouts || [])).catch(() => setRows(false));
  };
  useEffect(load, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = useMemo(() => (rows || []).reduce((s, r) => s + Number(r.amount || 0), 0), [rows]);
  if (rows === false) return <div style={{ color: 'var(--t3)' }}>Requires salary access.</div>;

  async function add() {
    if (!f.payee_label.trim() || f.amount === '' || isNaN(Number(f.amount))) { showToast('Agency + amount required', 'error'); return; }
    setBusy(true);
    try {
      await podiumopsPost('upsertPayouts', { rows: [{
        payee_type: 'vendor', payee_label: f.payee_label.trim(), payout_type: 'contract_labour',
        period_key: f.period_key || null, amount: Number(f.amount), paid_on: f.paid_on || null,
        note: f.note || null, source: 'manual',
      }] }, session);
      showToast('Saved', 'success');
      setF({ ...f, amount: '', note: '' });
      load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  async function del(id) {
    setBusy(true);
    try { await podiumopsPost('deletePayout', { id }, session); load(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <p style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.6, marginBottom: 12 }}>
        Bulk payouts to a labour agency / vendor — recorded here (not per person) so all people-cost sits in one ledger for SG&amp;A.
        The individual contract workers stay in the directory for org/availability.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Agency / vendor" value={f.payee_label} onChange={(e) => setF({ ...f, payee_label: e.target.value })} className="pd-input" style={{ ...cell, flex: 2, minWidth: 160 }} />
        <select value={f.period_key} onChange={(e) => setF({ ...f, period_key: e.target.value })} className="pd-input" style={cell}>
          {MONTHS.map((k) => <option key={k} value={k}>{periodLabel(k)}</option>)}
          <option value="">No period (ad-hoc)</option>
        </select>
        <input placeholder="amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="pd-input" style={{ ...cell, width: 130 }} />
        <input type="date" value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} className="pd-input" style={cell} />
        <input placeholder="note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} className="pd-input" style={{ ...cell, flex: 1, minWidth: 100 }} />
        <button onClick={add} disabled={busy} style={btn}><Plus size={14} /> Add</button>
      </div>

      <div style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
        {rows === null ? <div style={{ padding: 14, color: 'var(--t3)' }}>Loading…</div>
          : rows.length === 0 ? <div style={{ padding: 14, color: 'var(--t3)' }}>No vendor payouts recorded.</div>
          : rows.map((r) => (
            <div key={r.id} style={gridRow}>
              <div style={{ flex: 2, color: 'var(--t1)', fontSize: 13.5 }}>{r.payee_label}</div>
              <div style={{ flex: 1, color: 'var(--t3)', fontSize: 12 }}>{r.period_key ? periodLabel(r.period_key) : 'ad-hoc'}{r.paid_on ? ' · paid ' + r.paid_on : ''}</div>
              <div className="num" style={{ color: 'var(--t1)', fontSize: 13, minWidth: 110, textAlign: 'right' }}>{fmtINR(r.amount)}</div>
              <button onClick={() => del(r.id)} disabled={busy} title="Delete" style={iconBtn}><Trash2 size={14} /></button>
            </div>
          ))}
      </div>
      {rows?.length > 0 && <div style={{ marginTop: 8, textAlign: 'right', fontSize: 12.5, color: 'var(--t2)' }}>Total: <span className="num" style={{ color: 'var(--t1)' }}>{fmtINR(total)}</span></div>}
    </div>
  );
}

const cell = { background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '7px 9px', fontSize: 12.5 };
const gridRow = { display: 'flex', gap: 8, alignItems: 'center', padding: '9px 12px', borderTop: '1px solid var(--border)' };
const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--yellow)', color: '#1a1a1a', border: 'none', borderRadius: 'var(--r-sm)', padding: '8px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const iconBtn = { background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--t3)', cursor: 'pointer', padding: 5, display: 'inline-flex' };
