'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, EmptyState, Combobox, useToast, buildBagLabelsHtml, printWindow } from '@throttle/ui';

const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16, maxWidth: 620 };
const phdr  = { padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const body  = { padding: 14 };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 10px', fontSize: 13, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' };
const btnP  = { background: 'var(--accent, #213ce2)', border: 'none', borderRadius: 3, padding: '9px 16px', fontSize: 13, color: '#fff', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 14px', fontSize: 12, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

export default function BagStickersPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const allowed = hasPermission(perms, 'bag_sticker');

  const [parts, setParts]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [partCode, setPartCode] = useState('');
  const [bagSize, setBagSize]   = useState('');
  const [totalQty, setTotalQty] = useState('');
  const [busy, setBusy]         = useState(false);
  const [lastBatch, setLastBatch] = useState(null); // { bags, label }
  const [dupPrompt, setDupPrompt] = useState(null); // { bags, minutesAgo, message, requestId }

  useEffect(() => {
    if (!allowed) { setLoading(false); return; }
    let live = true;
    (async () => {
      try {
        const rows = await garageFetch('getMaterials', {}, session);
        const active = (Array.isArray(rows) ? rows : []).filter(r => r.is_active !== false);
        if (live) setParts(active);
      } catch (e) {
        if (live) showToast(e.message || 'Failed to load parts', 'error');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [allowed, session, showToast]);

  const partMap = useMemo(() => {
    const m = {};
    for (const p of parts) m[p.part_code] = p;
    return m;
  }, [parts]);

  const options = useMemo(() => parts.map(p => ({
    value: p.part_code,
    label: `${p.part_code} — ${p.part_name}${p.product && p.product !== 'Universal' ? ` (${p.product})` : ' (Universal)'}`,
  })), [parts]);

  function selectPart(code) {
    setPartCode(code);
    const p = partMap[code];
    if (p && p.bag_size && !bagSize) setBagSize(String(p.bag_size));
  }

  const sz = parseInt(bagSize) || 0;
  const tq = parseInt(totalQty) || 0;
  const nb = sz >= 1 && tq >= 1 ? Math.ceil(tq / sz) : 0; // auto-derived bag count
  const remainder = sz >= 1 && tq >= 1 ? (tq % sz) : 0;
  const canPrint = !!partCode && sz >= 1 && tq >= 1 && nb <= 500 && !busy;

  // Each press of Generate gets ONE id, reused across a confirm round-trip so the
  // worker's UNIQUE-backed replay guard can recognise it. A NEW press mints a new id,
  // which is correct — that genuinely is a new batch.
  function newRequestId() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch { /* fall through */ }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  async function generate(opts = {}) {
    if (!canPrint && !opts.force) return;
    const requestId = opts.requestId || newRequestId();
    setBusy(true);
    try {
      const res = await workerFetch('generateManualBags', {
        data: {
          part_code: partCode, bag_size: sz, total_qty: tq,
          request_id: requestId,
          ...(opts.confirmDuplicate ? { confirm_duplicate: true } : {}),
        },
      }, session);

      // An identical batch was printed minutes ago. Offer the reprint FIRST — that is
      // almost always what was wanted; new labels let the same stock be picked twice.
      if (res?.data?.needs_confirm) {
        setDupPrompt({
          bags:       res.data.existing_bags || [],
          minutesAgo: res.data.minutes_ago,
          message:    res.data.message,
          requestId,
        });
        return;
      }

      const bags = res?.data?.bags || [];
      if (!bags.length) { showToast('No bags generated', 'info'); return; }
      printWindow(buildBagLabelsHtml(bags, 'MANUAL'));
      setLastBatch({ bags, label: `${partCode} — ${bags.length} bag${bags.length === 1 ? '' : 's'} for ${tq} pcs` });
      showToast(
        res?.data?.duplicate
          ? `Already generated — reprinting the same ${bags.length} label${bags.length === 1 ? '' : 's'}`
          : `${bags.length} bag label${bags.length === 1 ? '' : 's'} generated for ${partCode}`,
        res?.data?.duplicate ? 'info' : 'success');
    } catch (e) {
      showToast(e.message || 'Bag generation failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  function reprint() {
    if (lastBatch?.bags?.length) printWindow(buildBagLabelsHtml(lastBatch.bags, 'MANUAL'));
  }

  // Reprints the EXISTING labels — creates no new bags. The safe path, and the default.
  function reprintExisting() {
    const bags = dupPrompt?.bags || [];
    if (bags.length) {
      printWindow(buildBagLabelsHtml(bags, 'MANUAL'));
      setLastBatch({ bags, label: `${partCode} — ${bags.length} bag${bags.length === 1 ? '' : 's'} (reprint)` });
      showToast(`Reprinted ${bags.length} existing label${bags.length === 1 ? '' : 's'} — no new bags created`, 'success');
    }
    setDupPrompt(null);
  }

  // Deliberate override: the floor really does have a second physical set of bags.
  function printNewAnyway() {
    const requestId = dupPrompt?.requestId;
    setDupPrompt(null);
    generate({ confirmDuplicate: true, requestId, force: true });
  }

  if (!allowed) {
    return <div style={{ padding: 24 }}><EmptyState title="No access" message="You don't have permission to print bag stickers." /></div>;
  }

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontFamily: 'var(--cond)', fontSize: 22, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t1)', margin: '0 0 4px' }}>Bag Stickers</h1>
      <p style={{ color: 'var(--t3)', fontSize: 12.5, margin: '0 0 18px', maxWidth: 620, lineHeight: 1.5 }}>
        Print bag QR stickers for a part that is missing one. <strong style={{ color: 'var(--t2)' }}>Does not change stock.</strong> Only print for physical bags that have no label — printing extra labels creates extra scannable bags.
      </p>

      {loading ? <Spinner /> : (
        <div style={panel}>
          <div style={phdr}>Print Bag Stickers</div>
          <div style={body}>
            <div style={{ marginBottom: 12 }}>
              <span style={lbl}>Part (search by code or name) *</span>
              <Combobox
                value={partCode}
                options={options}
                onChange={selectPart}
                placeholder="Search parts…"
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <span style={lbl}>Bag size (pieces per bag) *</span>
                <input style={input} type="number" min="1" value={bagSize} onChange={e => setBagSize(e.target.value)} placeholder="e.g. 50" />
              </div>
              <div>
                <span style={lbl}>Total quantity *</span>
                <input style={input} type="number" min="1" value={totalQty} onChange={e => setTotalQty(e.target.value)} placeholder="e.g. 1000" />
              </div>
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginBottom: 14 }}>
              {nb > 0
                ? <>Will print <strong style={{ color: 'var(--t1)' }}>{nb}</strong> bag{nb === 1 ? '' : 's'} — {remainder > 0 ? <>{nb - 1} × {sz} + 1 × {remainder}</> : <>{nb} × {sz}</>} = <strong style={{ color: 'var(--t1)' }}>{tq}</strong> pcs</>
                : 'Pick a part, enter bag size + total quantity.'}
              {nb > 500 && <span style={{ color: '#ff7070' }}> — that exceeds 500 bags; raise bag size or lower quantity.</span>}
            </div>
            {dupPrompt && (
              <div style={{ border: '1px solid #d9a441', background: 'rgba(217,164,65,0.08)', borderRadius: 4, padding: 12, marginBottom: 14 }}>
                <div style={{ fontFamily: 'var(--cond)', fontSize: 12.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#d9a441', marginBottom: 6 }}>
                  Already printed {dupPrompt.minutesAgo} minute{dupPrompt.minutesAgo === 1 ? '' : 's'} ago
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.5, marginBottom: 10 }}>
                  {dupPrompt.message}
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button style={btnP} onClick={reprintExisting}>Reprint those labels</button>
                  <button style={btnS} onClick={printNewAnyway}>Print a new set anyway</button>
                  <button style={btnS} onClick={() => setDupPrompt(null)}>Cancel</button>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button style={{ ...btnP, opacity: canPrint ? 1 : 0.5, cursor: canPrint ? 'pointer' : 'not-allowed' }} disabled={!canPrint} onClick={() => generate()}>
                {busy ? 'Generating…' : 'Generate & Print'}
              </button>
              {lastBatch && (
                <button style={btnS} onClick={reprint}>Reprint last batch</button>
              )}
            </div>
            {lastBatch && (
              <div style={{ marginTop: 12, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                Last printed: {lastBatch.label}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
