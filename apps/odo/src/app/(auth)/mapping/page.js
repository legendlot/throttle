'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { AlertTriangle, Unlink } from 'lucide-react';
import { salesGet, salesPost, fmtInt, inr } from '../../../lib/api.js';
import { FAMILIES, familyOf } from '../../../lib/families.js';
import { PageHead, PanelHead, Pill, Swatch, Nil } from '../../../components/prism.js';
import { STATUS } from '../../../lib/hues.js';

// match_on is product vocabulary (exact / fuzzy / manual) — semantic tokens, never a family hue.
// 'manual' is the one that borrows the accent: a human made that call.
const MATCH_HUE = { exact: STATUS.good, fuzzy: STATUS.warn, manual: '#F2CD1A' };

// The Unmapped panel is the single amber surface in Odo. These rows hold real revenue OUT of
// every rollup until someone maps them, so the panel itself carries the warning wash (§9.10) —
// this is a queue with a cost, not just another table.
const AMBER_CARD = { background: 'rgba(245,158,11,.08)', borderColor: 'rgba(245,158,11,.24)' };
const AMBER_TH = { borderBottomColor: 'rgba(245,158,11,.2)', color: 'var(--t2)' };

const famColor = (name) => FAMILIES[familyOf(name || '')].color;

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
      // getBootstrap's channel rows come back as `{ id, name, type }`, NOT `{ channel_id }` —
      // keying on `c.channel_id` alone built `{ undefined: <last name> }`, so every Channel cell
      // rendered an em-dash (and, since the redesign, a grey "other" swatch instead of the real
      // family colour). AmazonPage already guards this the same way. Display-only fix.
      setChannels(Object.fromEntries((b?.channels || []).map(c => [c.channel_id || c.id, c.name])));
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

  // Headline for the amber panel: what this queue is actually costing the rollups.
  const pendingGross = useMemo(() => unmapped.reduce((a, u) => a + (Number(u.pending_gross) || 0), 0), [unmapped]);

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
    <div className="so-page" style={{ maxWidth: 1180 }}>
      <PageHead title="Mapping" sub="Point channel SKUs at catalogue variants — unmapped rows hold revenue out of every rollup" />

      {/* ── Unmapped queue (amber) ── */}
      <div className="so-card flush" style={AMBER_CARD}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '0 18px 12px' }}>
          <AlertTriangle size={19} strokeWidth={1.75} color="var(--amber)" style={{ flex: 'none', marginTop: 1 }} />
          <div style={{ minWidth: 0 }}>
            <div className="so-h2">Unmapped SKUs <span style={{ fontFamily: 'var(--mono)', fontWeight: 400, color: 'var(--amber)' }}>({unmapped.length})</span></div>
            <div className="so-sub" style={{ fontSize: 12, marginTop: 3 }}>
              {/* The what-this-is sentence shows in BOTH states — the populated case is the one
                  operators actually see, so it can't be the state that drops the explanation. */}
              Channel SKUs we couldn’t auto-match. Map each once → its history backfills.
              {unmapped.length > 0 && (
                <> <span style={{ fontFamily: 'var(--mono)', color: 'var(--amber)' }}>{inr(pendingGross)}</span> of pending revenue is parked until you do.</>
              )}
            </div>
          </div>
        </div>
        {unmapped.length === 0 ? (
          <div style={{ padding: '10px 18px 22px', textAlign: 'center', color: 'var(--green-fg)', fontFamily: 'var(--mono)', fontSize: 12 }}>All clear — nothing unmapped.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="so-table">
              <thead><tr>
                <th style={AMBER_TH}>Channel</th>
                <th style={AMBER_TH}>Channel SKU</th>
                <th style={AMBER_TH}>Sample title</th>
                <th className="so-num" style={AMBER_TH}>Pend. units</th>
                <th className="so-num" style={AMBER_TH}>Pend. ₹</th>
                <th style={AMBER_TH}>Map to variant</th>
                <th style={AMBER_TH}></th>
              </tr></thead>
              <tbody>
                {unmapped.map(u => {
                  const cname = channels[u.channel_id];
                  return (
                    <tr key={u.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {cname
                          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Swatch color={famColor(cname)} />{cname}</span>
                          : <Nil />}
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t1)' }}>{u.channel_sku}</td>
                      <td style={{ maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.sample_title || <Nil />}</td>
                      <td className="so-num">{fmtInt(u.pending_units)}</td>
                      <td className="so-num" style={{ color: 'var(--amber)', fontWeight: 500 }}>{inr(u.pending_gross)}</td>
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── The map itself ── */}
      <div className="so-card flush">
        <PanelHead title="SKU map" qual={`(${maps.length})`} style={{ marginBottom: 0 }} />
        <div style={{ overflowX: 'auto' }}>
          <table className="so-table">
            <thead><tr><th>Channel</th><th>Channel SKU</th><th>→ Variant</th><th>Matched</th><th className="so-num"></th></tr></thead>
            <tbody>
              {maps.map(m => {
                const cname = channels[m.channel_id];
                return (
                  <tr key={m.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {cname
                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Swatch color={famColor(cname)} />{cname}</span>
                        : <Nil />}
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t2-cell)' }}>{m.channel_sku}</td>
                    <td style={{ color: 'var(--t1)' }}>{vlabel[m.product_code] || m.product_code}</td>
                    <td><Pill color={MATCH_HUE[m.match_on] || 'var(--t3)'}>{m.match_on}</Pill></td>
                    <td className="so-num">
                      {canManage && (
                        <button className="so-btn bare" title="Remove this mapping" aria-label="Remove this mapping"
                          style={{ display: 'inline-flex', padding: 3, borderRadius: 6 }} onClick={() => delMap(m.id)}>
                          <Unlink size={16} strokeWidth={1.75} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {maps.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 24, color: 'var(--t3)' }}>No mappings yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
