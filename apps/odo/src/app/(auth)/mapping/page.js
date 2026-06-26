'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
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
  // searchable-combobox options: search across product/model/color + code + sku
  const variantOptions = useMemo(() => variants.map(v => ({
    value: v.product_code,
    label: [v.product, v.model, v.color].filter(Boolean).join(' ') || v.product_code,
    hint: [v.product_code, v.sku].filter(Boolean).join(' · '),
  })), [variants]);

  const resolve = (row) => {
    const code = pick[row.id];
    if (!code) { toast?.showToast?.('Pick a variant first', 'error'); return; }
    salesPost('resolveUnmapped', { id: row.id, product_code: code }, session)
      .then(r => { toast?.showToast?.(`Mapped — ${r.dates} day(s) backfilled`, 'success'); load(); })
      .catch(e => toast?.showToast?.(e.message, 'error'));
  };
  const delMap = (id) => {
    if (!window.confirm('Remove this SKU mapping? This channel SKU will return to the unmapped queue on the next pull.')) return;
    salesPost('deleteSkuMap', { id }, session).then(() => load()).catch(e => toast?.showToast?.(e.message, 'error'));
  };

  if (loading) return <Spinner />;
  return (
    <div className="so-page" style={{ gap: 24, maxWidth: 1080 }}>
      <section>
        <h2 className="so-h2">Unmapped SKUs <span style={{ color: 'var(--amber)' }}>({unmapped.length})</span></h2>
        <p className="so-sub" style={{ margin: '4px 0 12px' }}>Channel SKUs we couldn’t auto-match. Map each once → its history backfills.</p>
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
                      <div style={{ minWidth: 240, maxWidth: 320 }}>
                        <Combobox
                          value={pick[u.id] || ''}
                          options={variantOptions}
                          onChange={(val) => setPick(p => ({ ...p, [u.id]: val }))}
                          placeholder="Search variant…"
                          disabled={!canManage}
                          portal
                        />
                      </div>
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
        <h2 className="so-h2" style={{ marginBottom: 12 }}>SKU map ({maps.length})</h2>
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
