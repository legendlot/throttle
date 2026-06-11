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
  const [numBags, setNumBags]   = useState('');
  const [busy, setBusy]         = useState(false);
  const [lastBatch, setLastBatch] = useState(null); // { bags, label }

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
  const nb = parseInt(numBags) || 0;
  const total = sz > 0 && nb > 0 ? sz * nb : 0;
  const canPrint = !!partCode && sz >= 1 && nb >= 1 && nb <= 500 && !busy;

  async function generate() {
    if (!canPrint) return;
    setBusy(true);
    try {
      const res = await workerFetch('generateManualBags', {
        data: { part_code: partCode, bag_size: sz, num_bags: nb },
      }, session);
      const bags = res?.data?.bags || [];
      if (!bags.length) { showToast('No bags generated', 'info'); return; }
      printWindow(buildBagLabelsHtml(bags, 'MANUAL'));
      setLastBatch({ bags, label: `${partCode} — ${bags.length} bag${bags.length === 1 ? '' : 's'} × ${sz}` });
      showToast(`${bags.length} bag label${bags.length === 1 ? '' : 's'} generated for ${partCode}`, 'success');
    } catch (e) {
      showToast(e.message || 'Bag generation failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  function reprint() {
    if (lastBatch?.bags?.length) printWindow(buildBagLabelsHtml(lastBatch.bags, 'MANUAL'));
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
                <span style={lbl}>Number of bags *</span>
                <input style={input} type="number" min="1" max="500" value={numBags} onChange={e => setNumBags(e.target.value)} placeholder="e.g. 10" />
              </div>
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginBottom: 14 }}>
              {total > 0
                ? <>Will print <strong style={{ color: 'var(--t1)' }}>{nb}</strong> bag{nb === 1 ? '' : 's'} × <strong style={{ color: 'var(--t1)' }}>{sz}</strong> = <strong style={{ color: 'var(--t1)' }}>{total}</strong> pieces</>
                : 'Pick a part and enter bag size + count.'}
              {nb > 500 && <span style={{ color: '#ff7070' }}> — max 500 bags per print.</span>}
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button style={{ ...btnP, opacity: canPrint ? 1 : 0.5, cursor: canPrint ? 'pointer' : 'not-allowed' }} disabled={!canPrint} onClick={generate}>
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
