'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Wallet, Sparkles } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { fmtINR, monthKey, halfKey, fyStartYear, periodLabel } from '../../../../lib/payouts.js';
import ContractLabourPanel from '../../../../components/ContractLabourPanel.js';
import RazorpayxSyncModal from '../../../../components/RazorpayxSyncModal.js';

const FY = fyStartYear();  // current fiscal-year start calendar year
const MONTHS = Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1; const y = m >= 4 ? FY : FY + 1; return monthKey(y, m); });
const NOW = new Date();
const CUR_MONTH = monthKey(NOW.getFullYear(), NOW.getMonth() + 1);

export default function PayoutsAdminPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [tab, setTab] = useState('fixed');            // fixed | variable | adhoc
  const [period, setPeriod] = useState(MONTHS.includes(CUR_MONTH) ? CUR_MONTH : MONTHS[0]);
  const [half, setHalf] = useState(halfKey(FY, 1));
  const [sheet, setSheet] = useState(null);           // null=loading, false=forbidden
  const [edits, setEdits] = useState({});             // employee_id → {pct, amount, note, type, paid_on}
  const [busy, setBusy] = useState(false);
  const [rzpSync, setRzpSync] = useState(false);

  const periodKey = tab === 'variable' ? half : period;
  useEffect(() => {
    setSheet(null); setEdits({});
    if (!session || tab === 'contract') return;
    const type = tab === 'adhoc' ? 'other' : tab;
    podiumopsGet('getPayoutPeriodSheet', { period_key: periodKey, payout_type: type }, session)
      .then(setSheet).catch(() => setSheet(false));
  }, [session, tab, period, half]); // eslint-disable-line react-hooks/exhaustive-deps

  if (sheet === false) return <div style={{ color: 'var(--t3)' }}>Requires salary access.</div>;

  async function generateFixed() {
    setBusy(true);
    try {
      const r = await podiumopsPost('generateFixedPayouts', { period_key: period }, session);
      showToast(`Generated ${r.created}, skipped ${r.skipped}`, 'success');
      const rr = await podiumopsGet('getPayoutPeriodSheet', { period_key: period, payout_type: 'fixed' }, session);
      setSheet(rr);
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true);
    try {
      const rows = [];
      for (const row of (sheet?.rows || [])) {
        const e = edits[row.employee_id]; if (!e) continue;
        const target = row.default_target;
        let amount = (e.amount != null && e.amount !== '') ? Number(e.amount)
          : (tab === 'variable' && e.pct != null && e.pct !== '' && target != null) ? Math.round(target * Number(e.pct)) / 100
          : (tab === 'fixed' ? target : null);
        if (amount == null || isNaN(amount)) continue;
        rows.push({
          employee_id: row.employee_id,
          payout_type: tab === 'adhoc' ? (e.type || 'other') : tab,
          period_key: tab === 'adhoc' ? null : periodKey,
          period_type: tab === 'adhoc' ? 'one_time' : undefined,
          target_amount: (tab === 'variable' || tab === 'fixed') ? target : null,
          achievement_pct: (tab === 'variable' && e.pct !== '' && e.pct != null) ? Number(e.pct) : null,
          amount, paid_on: e.paid_on || null, note: e.note || null,
          source: tab === 'variable' ? 'variable_calc' : 'manual',
        });
      }
      if (!rows.length) { showToast('Nothing to save', 'error'); return; }
      const r = await podiumopsPost('upsertPayouts', { rows }, session);
      showToast(`Saved ${r.saved}`, 'success');
      const type = tab === 'adhoc' ? 'other' : tab;
      const rr = await podiumopsGet('getPayoutPeriodSheet', { period_key: periodKey, payout_type: type }, session);
      setSheet(rr); setEdits({});
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }

  const setEdit = (id, patch) => setEdits((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  const visibleRows = useMemo(() => {
    const rows = sheet?.rows || [];
    if (tab !== 'variable') return rows;
    const want = sheet?.period_type; // monthly | half_yearly
    return rows.filter((r) => (r.bonus_type === 'Monthly' ? 'monthly' : r.bonus_type === 'Half-Yearly' ? 'half_yearly' : null) === want);
  }, [sheet, tab]);

  return (
    <div style={{ maxWidth: 940 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {['fixed', 'variable', 'adhoc', 'contract'].map((t) => (
          <div key={t} className={'pd-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)} style={{ textTransform: 'capitalize' }}>{t === 'adhoc' ? 'Ad-hoc' : t === 'contract' ? 'Contract Labour' : t}</div>
        ))}
      </div>

      {tab === 'contract' && <ContractLabourPanel session={session} />}

      {tab !== 'contract' && (<>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {tab === 'variable' ? (
          <select value={half} onChange={(e) => setHalf(e.target.value)} className="pd-input" style={sel}>
            {[1, 2].map((h) => <option key={h} value={halfKey(FY, h)}>{periodLabel(halfKey(FY, h))}</option>)}
          </select>
        ) : (
          <select value={period} onChange={(e) => setPeriod(e.target.value)} className="pd-input" style={sel}>
            {MONTHS.map((k) => <option key={k} value={k}>{periodLabel(k)}</option>)}
          </select>
        )}
        {tab === 'fixed' && <>
          <button onClick={generateFixed} disabled={busy} style={btn}><Sparkles size={13} /> Generate month from CTC</button>
          <button onClick={() => setRzpSync(true)} disabled={busy} style={btn}><Wallet size={13} /> Sync from RazorpayX</button>
        </>}
      </div>

      {sheet === null ? <div style={{ marginTop: 16 }}><Spinner /></div> : (
        <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
          {visibleRows.map((row) => {
            const e = edits[row.employee_id] || {};
            const existing = row.existing;
            const computed = (tab === 'variable' && e.pct != null && e.pct !== '' && row.default_target != null)
              ? Math.round(row.default_target * Number(e.pct)) / 100 : null;
            return (
              <div key={row.employee_id} style={gridRow}>
                <div style={{ flex: 2, minWidth: 160 }}>
                  <div style={{ color: 'var(--t1)', fontSize: 13.5 }}>{row.full_name}</div>
                  <div style={{ color: 'var(--t3)', fontSize: 11 }}>{row.department || '—'}{row.bonus_type ? ' · ' + row.bonus_type : ''}{existing ? ' · saved ' + fmtINR(existing.amount) : ''}</div>
                </div>
                {tab === 'adhoc' ? (
                  <>
                    <select value={e.type || 'other'} onChange={(ev) => setEdit(row.employee_id, { type: ev.target.value })} className="pd-input" style={{ ...cell, flex: 1 }}>
                      <option value="one_time_bonus">Bonus</option><option value="perk">Perk</option><option value="other">Other</option>
                    </select>
                    <input placeholder="amount" value={e.amount ?? ''} onChange={(ev) => setEdit(row.employee_id, { amount: ev.target.value })} className="pd-input" style={cell} />
                    <input type="date" value={e.paid_on || ''} onChange={(ev) => setEdit(row.employee_id, { paid_on: ev.target.value })} className="pd-input" style={cell} />
                  </>
                ) : tab === 'variable' ? (
                  <>
                    <span className="num" style={hint}>target {fmtINR(row.default_target)}</span>
                    <input placeholder="%" value={e.pct ?? (existing?.achievement_pct ?? '')} onChange={(ev) => setEdit(row.employee_id, { pct: ev.target.value })} className="pd-input" style={{ ...cell, width: 70 }} />
                    <span className="num" style={{ ...hint, color: 'var(--t1)' }}>{fmtINR(computed ?? existing?.amount ?? null)}</span>
                  </>
                ) : (
                  <input placeholder="amount" value={e.amount ?? (existing?.amount ?? row.default_target ?? '')} onChange={(ev) => setEdit(row.employee_id, { amount: ev.target.value })} className="pd-input" style={{ ...cell, width: 140 }} />
                )}
                <input placeholder="note" value={e.note ?? (existing?.note || '')} onChange={(ev) => setEdit(row.employee_id, { note: ev.target.value })} className="pd-input" style={{ ...cell, flex: 1, minWidth: 100 }} />
              </div>
            );
          })}
          {visibleRows.length === 0 && <div style={{ padding: 16, color: 'var(--t3)' }}>No eligible people for this period.</div>}
        </div>
      )}

      <button onClick={save} disabled={busy || sheet === null} style={{ ...btn, marginTop: 14 }}><Wallet size={14} /> Save</button>
      </>)}

      {rzpSync && (
        <RazorpayxSyncModal
          session={session} month={period}
          onClose={() => setRzpSync(false)}
          onDone={() => { setRzpSync(false); podiumopsGet('getPayoutPeriodSheet', { period_key: period, payout_type: 'fixed' }, session).then(setSheet).catch(() => {}); }}
        />
      )}
    </div>
  );
}

const sel = { background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 10px', fontSize: 13 };
const cell = { background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '6px 8px', fontSize: 12.5 };
const hint = { fontSize: 12, color: 'var(--t3)', minWidth: 90, textAlign: 'right' };
const gridRow = { display: 'flex', gap: 8, alignItems: 'center', padding: '9px 12px', borderTop: '1px solid var(--border)', flexWrap: 'wrap' };
const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--yellow)', color: '#1a1a1a', border: 'none', borderRadius: 'var(--r-sm)', padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
