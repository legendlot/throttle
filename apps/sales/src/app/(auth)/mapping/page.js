'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { salesGet, salesPost, fmtInt, inr } from '../../../lib/api.js';

export default function MappingPage() {
  const { session, perms } = useAuth();
  const canManage = !!(perms?.sales_mapping_manage || perms?.salesops_admin);
  const toast = useToast();
  const [unmapped, setUnmapped] = useState([]);
  const [maps, setMaps] = useState([]);
  const [variants, setVariants] = useState([]);
  const [channels, setChannels] = useState({});
  const [loading, setLoading] = useState(true);
  const [pick, setPick] = useState({});        // unmapped.id → product_code

  const load = () => {
    if (!session) return;
    setLoading(true);
    Promise.all([
      salesGet('getUnmapped', {}, session),
      salesGet('getSkuMap', {}, session),
      salesGet('getVariants', {}, session),
      salesGet('getBootstrap', {}, session),
    ]).then(([u, m, v, b]) => {
      setUnmapped(u?.rows || []); setMaps(m?.rows || []); setVariants(v?.rows || []);
      setChannels(Object.fromEntries((b?.channels || []).map(c => [c.channel_id, c.name])));
    }).finally(() => setLoading(false));
  };
  useEffect(load, [session]);

  const vlabel = useMemo(() => Object.fromEntries(variants.map(v => [v.product_code, [v.product, v.model, v.color].filter(Boolean).join(' ') + ` · ${v.product_code}`])), [variants]);

  const resolve = (row) => {
    const code = pick[row.id];
    if (!code) { toast?.showToast?.('Pick a variant first', 'error'); return; }
    salesPost('resolveUnmapped', { id: row.id, product_code: code }, session)
      .then(r => { toast?.showToast?.(`Mapped — ${r.dates} day(s) backfilled`, 'success'); load(); })
      .catch(e => toast?.showToast?.(e.message, 'error'));
  };
  const delMap = (id) => salesPost('deleteSkuMap', { id }, session).then(() => load()).catch(e => toast?.showToast?.(e.message, 'error'));

  if (loading) return <Spinner />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1080 }}>
      <section>
        <h2 style={{ fontFamily: 'var(--cond)', fontSize: 15, color: 'var(--t1)', marginBottom: 4 }}>Unmapped SKUs <span style={{ color: 'var(--amber)' }}>({unmapped.length})</span></h2>
        <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginBottom: 12 }}>Channel SKUs we couldn’t auto-match. Map each once → its history backfills.</p>
        <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
          {unmapped.length === 0 ? <div style={{ padding: 28, textAlign: 'center', color: 'var(--green)', fontFamily: 'var(--mono)', fontSize: 12 }}>All clear — nothing unmapped.</div> : (
            <table className="so-table">
              <thead><tr><th>Channel</th><th>Channel SKU</th><th>Sample</th><th className="so-num">Pend. units</th><th className="so-num">Pend. ₹</th><th>Map to variant</th><th></th></tr></thead>
              <tbody>
                {unmapped.map(u => (
                  <tr key={u.id}>
                    <td>{channels[u.channel_id] || '—'}</td>
                    <td style={{ color: 'var(--t1)' }}>{u.channel_sku}</td>
                    <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.sample_title || '—'}</td>
                    <td className="so-num">{fmtInt(u.pending_units)}</td>
                    <td className="so-num">{inr(u.pending_gross)}</td>
                    <td>
                      <select className="so-select" disabled={!canManage} value={pick[u.id] || ''} onChange={e => setPick(p => ({ ...p, [u.id]: e.target.value }))} style={{ maxWidth: 260 }}>
                        <option value="">— select —</option>
                        {variants.map(v => <option key={v.product_code} value={v.product_code}>{vlabel[v.product_code]}</option>)}
                      </select>
                    </td>
                    <td><button className="so-btn" disabled={!canManage} onClick={() => resolve(u)}>Map</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section>
        <h2 style={{ fontFamily: 'var(--cond)', fontSize: 15, color: 'var(--t1)', marginBottom: 12 }}>SKU map ({maps.length})</h2>
        <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="so-table">
            <thead><tr><th>Channel</th><th>Channel SKU</th><th>→ Variant</th><th>Matched</th><th></th></tr></thead>
            <tbody>
              {maps.map(m => (
                <tr key={m.id}>
                  <td>{channels[m.channel_id] || '—'}</td>
                  <td style={{ color: 'var(--t1)' }}>{m.channel_sku}</td>
                  <td>{vlabel[m.product_code] || m.product_code}</td>
                  <td><span className="so-pill" style={{ background: 'var(--surface2)', color: 'var(--t3)' }}>{m.match_on}</span></td>
                  <td>{canManage && <button className="so-btn ghost" onClick={() => delMap(m.id)}>Remove</button>}</td>
                </tr>
              ))}
              {maps.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 24, color: 'var(--t3)' }}>No mappings yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
