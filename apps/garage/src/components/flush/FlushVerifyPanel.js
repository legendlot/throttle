'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, buildBagLabelsHtml, printWindow } from '@throttle/ui';

// Canonical disposition values (kept stable — worker logic keys on these).
// LF_DISP_LABELS provides clearer floor-facing display labels.
const LF_DISPOSITIONS = ['Return to Stock', 'Quarantine', 'Scrap', 'Rework Queue'];
const LF_DISP_LABELS = {
  'Return to Stock': 'Restocked',
  Quarantine:        'Quarantine',
  Scrap:             'Damaged / Scratched',
  'Rework Queue':    'Rework Queue',
};
const LF_DISP_TONES = {
  'Return to Stock': 'green',
  Quarantine:        'red',
  Scrap:             'gray',
  'Rework Queue':    'yellow',
};
const TONE_COLORS = {
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#888'    },
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a' },
};

const inputStyle = {
  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3,
  padding: '5px 8px', fontSize: 12, color: 'var(--t1)', outline: 'none',
  fontFamily: 'inherit',
};
const selectStyle = { ...inputStyle, cursor: 'pointer' };
const labelStyle = {
  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
};

function newSplit() {
  return { disposition: 'Return to Stock', qty: 0, bin: '', notes: '', bagsOf: 0 };
}

function balanceOf(part) {
  const total = (part.splits || []).reduce((s, sp) => s + (parseFloat(sp.qty) || 0), 0);
  const raised = parseFloat(part.qty_raised) || 0;
  const diff = Math.round((total - raised) * 100) / 100;
  return { total, raised, diff };
}

export function FlushVerifyPanel({ flushId, onClose, onVerified }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [flush, setFlush] = useState(null);
  const [parts, setParts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!flushId || !session) return;
      setLoading(true);
      setError(null);
      try {
        const data = await garageFetch('getFlush', { flush_id: flushId }, session);
        if (cancelled) return;
        setFlush(data.flush);
        const initial = (data.lines || []).map((l) => ({
          line_id: l.line_id,
          part_code: l.part_code,
          part_name: l.part_name || '',
          return_type: l.return_type || '—',
          qty_raised: parseFloat(l.qty_raised) || 0,
          splits: [{ disposition: 'Return to Stock', qty: parseFloat(l.qty_raised) || 0, bin: '', notes: '', bagsOf: 0 }],
        }));
        setParts(initial);
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load flush');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [flushId, session]);

  function addSplit(partIndex) {
    setParts((prev) => prev.map((p, i) => i === partIndex
      ? { ...p, splits: [...p.splits, newSplit()] }
      : p));
  }

  function removeSplit(partIndex, splitIndex) {
    setParts((prev) => prev.map((p, i) => {
      if (i !== partIndex) return p;
      if (p.splits.length <= 1) return p;
      return { ...p, splits: p.splits.filter((_, si) => si !== splitIndex) };
    }));
  }

  function updateSplit(partIndex, splitIndex, field, value) {
    setParts((prev) => prev.map((p, i) => {
      if (i !== partIndex) return p;
      return {
        ...p,
        splits: p.splits.map((sp, si) => si === splitIndex ? { ...sp, [field]: value } : sp),
      };
    }));
  }

  async function handleSubmit() {
    if (!flush) return;
    const imbalanced = parts.filter((p) => Math.abs(balanceOf(p).diff) > 0.001);
    if (imbalanced.length) {
      const detail = imbalanced.map((p) => `${p.part_code} (${balanceOf(p).total} vs ${p.qty_raised})`).join(', ');
      showToast(`Totals don't match: ${detail}`, 'error');
      return;
    }
    const dispositions = [];
    const bagRequests = [];
    parts.forEach((p) => {
      p.splits.forEach((sp) => {
        const qty = parseFloat(sp.qty) || 0;
        if (qty <= 0) return;
        dispositions.push({
          line_id: p.line_id,
          part_code: p.part_code,
          part_name: p.part_name,
          disposition: sp.disposition,
          qty,
          bin_code: sp.disposition === 'Quarantine' ? (sp.bin || null) : null,
          notes: sp.notes || null,
        });
        const bagsOf = parseInt(sp.bagsOf) || 0;
        if (sp.disposition === 'Return to Stock' && bagsOf > 0) {
          bagRequests.push({
            part_code: p.part_code,
            part_name: p.part_name,
            qty,
            bags_of: bagsOf,
          });
        }
      });
    });
    if (!dispositions.length) {
      showToast('Enter at least one verified quantity', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await workerFetch('verifyFlush', { data: { flush_id: flush.flush_id, dispositions } }, session);
      const result = res.data || res;
      showToast(`Flush ${flush.flush_id} verified — ${result.stock_returned || 0} returned to stock`, 'success');

      // Bag-label generation against the auto-created Line Flush GRN.
      // Worker returns grn_no when stock was restocked; if absent, skip silently.
      if (result.grn_no && bagRequests.length > 0) {
        const allBags = [];
        const failed = [];
        for (const r of bagRequests) {
          try {
            const bagRes = await workerFetch('generateBagsForGrn', {
              data: {
                grn_no:    result.grn_no,
                part_code: r.part_code,
                part_name: r.part_name,
                qty:       r.qty,
                bags_of:   r.bags_of,
              }
            }, session);
            allBags.push(...(bagRes?.data?.bags || []));
          } catch (e) {
            failed.push(`${r.part_code}: ${e.message || e}`);
          }
        }
        if (allBags.length > 0) {
          showToast(`${allBags.length} bag label${allBags.length === 1 ? '' : 's'} generated`, 'success');
          printWindow(buildBagLabelsHtml(allBags, result.grn_no));
        }
        if (failed.length > 0) {
          showToast(`Bag generation failed for ${failed.length} part(s) — reprint from GRN detail`, 'error');
        }
      }

      if (onVerified) onVerified(result);
      if (onClose) onClose();
    } catch (e) {
      showToast(e.message || 'Verification failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 16, color: '#ff7070', fontSize: 12 }}>{error}</div>
    );
  }
  if (!flush) return null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', gap: 16, fontSize: 11, alignItems: 'center', flexWrap: 'wrap' }}>
          <span><span style={{ color: 'var(--t3)' }}>Date: </span><strong>{flush.flush_date || '—'}</strong></span>
          <span><span style={{ color: 'var(--t3)' }}>Line: </span><strong>{flush.line_no || '—'}</strong></span>
          <span><span style={{ color: 'var(--t3)' }}>Shift: </span><strong>{flush.shift || '—'}</strong></span>
          <span><span style={{ color: 'var(--t3)' }}>Raised by: </span><strong>{flush.raised_by || '—'}</strong></span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--t2)', cursor: 'pointer', borderRadius: 3, padding: '4px 10px', fontSize: 12 }}
            disabled={submitting}
          >
            ✕
          </button>
        )}
      </div>

      <div style={{ padding: 12 }}>
        {parts.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
            No parts to verify
          </div>
        )}
        {parts.map((p, pi) => {
          const bal = balanceOf(p);
          let balText = '✓ Balanced';
          let balColor = '#4ade80';
          if (bal.diff > 0.001) { balText = `▲ ${bal.diff} over`; balColor = '#ff7070'; }
          else if (bal.diff < -0.001) { balText = `▼ ${Math.abs(bal.diff)} under`; balColor = '#f2cd1a'; }
          return (
            <div key={p.line_id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: 8, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--yellow)' }}>{p.part_code}</span>
                  <span style={{ fontSize: 12 }}>{p.part_name}</span>
                  <span style={{
                    display: 'inline-block', padding: '2px 6px', borderRadius: 2,
                    fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
                    textTransform: 'uppercase', background: 'rgba(80,80,80,.2)', color: '#aaa',
                    border: '1px solid rgba(80,80,80,.3)',
                  }}>
                    {p.return_type}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: 'var(--t3)' }}>
                    Qty raised: <strong style={{ color: 'var(--t1)', fontFamily: 'var(--mono)' }}>{p.qty_raised}</strong>
                  </span>
                  <button
                    onClick={() => addSplit(pi)}
                    style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--t3)', cursor: 'pointer', fontSize: 10, padding: '2px 8px', borderRadius: 3 }}
                  >
                    + Split
                  </button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '180px 80px 80px 130px 1fr 24px', gap: 6, fontSize: 9, color: 'var(--t3)', marginBottom: 4, paddingLeft: 2, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                <div>Disposition</div>
                <div>Qty</div>
                <div>Qty/Bag</div>
                <div>Bin</div>
                <div>Notes</div>
                <div></div>
              </div>

              {p.splits.map((sp, si) => {
                const tone = LF_DISP_TONES[sp.disposition] || 'gray';
                const tc = TONE_COLORS[tone];
                const isRestock = sp.disposition === 'Return to Stock';
                return (
                  <div key={si} style={{ display: 'grid', gridTemplateColumns: '180px 80px 80px 130px 1fr 24px', gap: 6, marginBottom: 4 }}>
                    <select
                      value={sp.disposition}
                      onChange={(e) => updateSplit(pi, si, 'disposition', e.target.value)}
                      style={{ ...selectStyle, background: tc.bg, color: tc.fg }}
                      disabled={submitting}
                    >
                      {LF_DISPOSITIONS.map((d) => <option key={d} value={d}>{LF_DISP_LABELS[d] || d}</option>)}
                    </select>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={sp.qty}
                      onChange={(e) => updateSplit(pi, si, 'qty', e.target.value)}
                      style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
                      disabled={submitting}
                    />
                    {isRestock ? (
                      <input
                        type="number"
                        min="0"
                        placeholder="Bag"
                        value={sp.bagsOf}
                        onChange={(e) => updateSplit(pi, si, 'bagsOf', e.target.value)}
                        style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
                        disabled={submitting}
                        title="Units per bag — leave 0 to skip bag-label printing"
                      />
                    ) : <div />}
                    <input
                      type="text"
                      placeholder="Bin"
                      value={sp.bin}
                      onChange={(e) => updateSplit(pi, si, 'bin', e.target.value)}
                      style={{ ...inputStyle, display: sp.disposition === 'Quarantine' ? '' : 'none', fontFamily: 'var(--mono)' }}
                      disabled={submitting}
                    />
                    {sp.disposition !== 'Quarantine' && <div />}
                    <input
                      type="text"
                      placeholder="Notes (optional)"
                      value={sp.notes}
                      onChange={(e) => updateSplit(pi, si, 'notes', e.target.value)}
                      style={inputStyle}
                      disabled={submitting}
                    />
                    <button
                      onClick={() => removeSplit(pi, si)}
                      disabled={submitting || p.splits.length <= 1}
                      style={{ background: 'transparent', border: '1px solid var(--border)', color: p.splits.length <= 1 ? 'var(--t3)' : '#ff7070', cursor: p.splits.length <= 1 ? 'not-allowed' : 'pointer', fontSize: 11, borderRadius: 3, padding: 0 }}
                      title="Remove split"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}

              <div style={{ display: 'flex', gap: 8, padding: '6px 2px 0', borderTop: '1px solid var(--border)', marginTop: 6, fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--t3)', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Store total: <strong style={{ color: 'var(--t1)' }}>{bal.total}</strong> · Production raised: <strong style={{ color: 'var(--t1)' }}>{bal.raised}</strong></span>
                <span style={{ color: balColor, fontWeight: 700 }}>{balText}</span>
              </div>
            </div>
          );
        })}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          {onClose && (
            <button
              onClick={onClose}
              disabled={submitting}
              style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '7px 14px', fontSize: 12, color: 'var(--t2)', cursor: submitting ? 'wait' : 'pointer', fontFamily: 'var(--cond)' }}
            >
              CANCEL
            </button>
          )}
          <button
            onClick={handleSubmit}
            disabled={submitting || parts.length === 0}
            style={{ background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: submitting ? 'wait' : 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em', opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? 'VERIFYING…' : 'CONFIRM VERIFICATION'}
          </button>
        </div>
      </div>
    </div>
  );
}
