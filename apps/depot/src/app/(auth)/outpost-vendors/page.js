'use client';
/* ════════════════════════════════════════════════════════════
   OUTPOST › VENDORS & DEVICES — the LOT owner's control of every
   vendor that packs finished units at its own site (O7, S422).

   • Vendor: live / kill switch, defect tolerance, leakage
     thresholds, pickup address; which product families it packs
     (carton qty, remote, box) — Setup tab.
   • Benches + print agents: one-time enrolment codes, revoke,
     unlock. Revoking a bench CLOSES its open cartons short (an
     open carton belongs to the device; nothing else could close
     it) and their CTN labels print at that bench's printer.
   • Operators: 3-digit op codes + PINs, roles, supervisor login
     codes for the vendor dashboard.
   Codes and PINs are shown ONCE and shared by hand (WhatsApp /
   email). Everything here is logged on the vendor's Activity tab.
   Owner-only: the worker checks `outpost_owner` on every call.
   ════════════════════════════════════════════════════════════ */
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Combobox, Modal, Spinner, useToast } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import { Icon, Panel, ToneBadge, btnGhost, btnPrimary } from '../../../components/kit/index.js';
import { opGet, opPost, fmtIST } from '../../../lib/outpost.js';
import {
  Confirm, ErrorPanel, Field, Input, OwnerGate, SecretModal, Select, Toggle,
  dangerBtn, label, mono, smallBtn, text, useOutpostVendors,
} from '../../../components/outpost/OutpostKit.js';

const TABS = [['setup', 'Setup'], ['devices', 'Benches & agents'], ['operators', 'Operators'], ['activity', 'Activity']];

export default function OutpostVendorsPage() {
  return <OwnerGate><VendorsInner /></OwnerGate>;
}

function VendorsInner() {
  const { session, userId } = useAuth();
  const { showToast } = useToast();
  const V = useOutpostVendors(session, userId);
  const [tab, setTab] = useState('setup');
  const [adding, setAdding] = useState(false);
  const [ask, setAsk] = useState(null);
  const vendor = V.vendors.find(v => v.vendor_id === V.vendorId) || null;
  const paused = V.killAll !== 'off';

  const setKillAll = on => setAsk({
    title: on ? 'Pause ALL of Outpost?' : 'Resume Outpost?', danger: on, yes: on ? 'Pause everything' : 'Resume',
    body: on ? 'Every vendor bench, print agent and dashboard stops within 30 seconds. Nothing is lost; packing resumes when you switch it back.'
      : 'Vendors that are live (and not individually stopped) can pack again within 30 seconds.',
    onYes: async () => { await opPost('setKillAll', { on }, session); showToast(on ? 'Outpost paused' : 'Outpost resumed', 'success'); await V.reload(); },
  });

  if (V.loading) return <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (V.error) return <ErrorPanel error={V.error} onRetry={V.reload} />;

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto' }}>
      <Panel pad={14} style={{ marginBottom: 16, borderColor: paused ? 'var(--bad-fg)' : 'var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Icon name="shield" size={16} />
          <div style={{ ...text, flex: 1, minWidth: 220 }}>
            <strong style={{ color: 'var(--t1)' }}>Outpost {paused ? 'is PAUSED for every vendor' : 'is running'}</strong>
            {V.killAll == null && ' — the global switch could not be read, so vendors are refused (fail closed).'}
          </div>
          <Toggle on={!paused} onChange={on => setKillAll(!on)} title="Global kill switch" />
        </div>
      </Panel>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {V.vendors.map(v => (
          <button key={v.vendor_id} onClick={() => V.setVendorId(v.vendor_id)}
            style={{ ...btnGhost, borderColor: v.vendor_id === V.vendorId ? 'var(--yellow)' : 'var(--border-2)',
              color: v.vendor_id === V.vendorId ? 'var(--t1)' : 'var(--t2)' }}>
            {v.vendor_name || `Vendor ${v.vendor_id}`}
            <ToneBadge tone={v.killed ? 'bad' : v.active ? 'ok' : 'mute'}>{v.killed ? 'stopped' : v.active ? 'live' : 'off'}</ToneBadge>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button style={btnPrimary} onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Add vendor</button>
      </div>

      {!vendor ? (
        <Panel pad={30}><div style={{ ...text, textAlign: 'center' }}>No vendor is set up in Outpost yet. Add one to start.</div></Panel>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16, overflowX: 'auto' }}>
            {TABS.map(([id, name]) => (
              <button key={id} onClick={() => setTab(id)} style={{ background: 'none', border: 'none', cursor: 'pointer',
                padding: '9px 14px', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
                color: tab === id ? 'var(--t1)' : 'var(--t3)', borderBottom: `2px solid ${tab === id ? 'var(--yellow)' : 'transparent'}` }}>
                {name}
              </button>
            ))}
          </div>
          {tab === 'setup' && <SetupTab key={vendor.vendor_id} vendor={vendor} onSaved={V.reload} />}
          {tab === 'devices' && <DevicesTab key={vendor.vendor_id} vendorId={vendor.vendor_id} />}
          {tab === 'operators' && <OperatorsTab key={vendor.vendor_id} vendorId={vendor.vendor_id} />}
          {tab === 'activity' && <ActivityTab key={vendor.vendor_id} vendorId={vendor.vendor_id} />}
        </>
      )}

      {adding && <AddVendor existing={V.vendors.map(v => v.vendor_id)} onClose={() => setAdding(false)}
        onAdded={async id => { setAdding(false); await V.reload(); V.setVendorId(id); setTab('setup'); }} />}
      <Confirm ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

// ── add a vendor (a store.vendors row → an Outpost vendor_config, OFF until set live) ──
function AddVendor({ existing, onClose, onAdded }) {
  const { session } = useAuth();
  const [list, setList] = useState(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { opGet('getStoreVendors', {}, session).then(setList).catch(e => setErr(e.message)); /* eslint-disable-next-line */ }, []);
  const options = (list || []).filter(v => !existing.includes(v.id))
    .map(v => ({ value: String(v.id), label: `${v.vendor_name}${v.location ? ` · ${v.location}` : ''}${v.vendor_code ? ` (${v.vendor_code})` : ''}` }));
  return (
    <Modal open onClose={onClose} title="Add a vendor to Outpost" confirmLabel="Add vendor" loading={busy} error={err}
      confirmDisabled={!pick} onConfirm={async () => {
        setBusy(true); setErr(null);
        try { await opPost('setVendorConfig', { vendor_id: Number(pick), active: false }, session); await onAdded(Number(pick)); }
        catch (e) { setErr(e.message); } finally { setBusy(false); }
      }}>
      <div style={{ ...text, marginBottom: 12 }}>Pick the vendor from the vendor master. It starts <strong>off</strong>: set up its
        products, benches and operators, then switch it live.</div>
      {!list ? <Spinner /> : <Combobox options={options} value={pick} onChange={setPick} placeholder="Search vendors…" />}
    </Modal>
  );
}

// ── Setup: vendor config + products ─────────────────────────────────────────
function SetupTab({ vendor, onSaved }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [f, setF] = useState(() => ({
    defect_tolerance_pct: String(vendor.defect_tolerance_pct ?? ''), pickup_address: vendor.pickup_address || '',
    leak_unused_sticker_days: String(vendor.leak_unused_sticker_days ?? ''),
    leak_packed_undispatched_days: String(vendor.leak_packed_undispatched_days ?? ''),
    leak_over_po_pct: String(vendor.leak_over_po_pct ?? ''),
  }));
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null);
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  const save = async () => {
    const nums = { defect_tolerance_pct: [0, 100], leak_unused_sticker_days: [1, 365], leak_packed_undispatched_days: [1, 365], leak_over_po_pct: [0, 100] };
    const body = { vendor_id: vendor.vendor_id, pickup_address: f.pickup_address.trim() || null };
    for (const [k, [lo, hi]] of Object.entries(nums)) {
      const n = Number(f[k]);
      if (f[k] === '' || !Number.isFinite(n) || n < lo || n > hi) { showToast(`${k.replace(/_/g, ' ')}: ${lo}–${hi}`, 'error'); return; }
      body[k] = k.endsWith('_days') ? Math.round(n) : n;
    }
    setBusy(true);
    try { await opPost('setVendorConfig', body, session); showToast('Vendor saved', 'success'); await onSaved(); }
    catch (e) { showToast(e.message, 'error'); } finally { setBusy(false); }
  };
  const flip = (field, on) => setAsk({
    title: field === 'active' ? (on ? `Set ${vendor.vendor_name} live?` : `Switch ${vendor.vendor_name} off?`)
      : (on ? `Stop ${vendor.vendor_name} now?` : `Release the stop on ${vendor.vendor_name}?`),
    danger: (field === 'killed' && on) || (field === 'active' && !on),
    body: field === 'killed' ? (on ? 'Kill switch: every bench, agent and dashboard of this vendor is refused within 30 seconds. Use it when something is wrong; nothing is lost.'
      : 'The vendor can work again within 30 seconds (if it is live).')
      : (on ? 'Its enrolled benches and operators can log in and pack.' : 'Its benches and operators are refused until you set it live again.'),
    onYes: async () => { await opPost('setVendorConfig', { vendor_id: vendor.vendor_id, [field]: on }, session); await onSaved(); },
  });

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Panel title="Vendor" icon="settings" pad={18}>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Toggle on={vendor.active} onChange={on => flip('active', on)} />
            <div style={text}><strong style={{ color: 'var(--t1)' }}>Live</strong> — may log in and pack</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Toggle on={!vendor.killed} onChange={on => flip('killed', !on)} />
            <div style={text}><strong style={{ color: vendor.killed ? 'var(--bad-fg)' : 'var(--t1)' }}>{vendor.killed ? 'STOPPED' : 'Not stopped'}</strong> — vendor kill switch</div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
          <Field name="Defect tolerance %" hint="Above this a consignment's defects are an SLA breach.">
            <Input inputMode="decimal" value={f.defect_tolerance_pct} onChange={set('defect_tolerance_pct')} /></Field>
          <Field name="Unused stickers flag (days)" hint="Minted, not on a unit, older than this.">
            <Input inputMode="numeric" value={f.leak_unused_sticker_days} onChange={set('leak_unused_sticker_days')} /></Field>
          <Field name="Packed, not dispatched (days)">
            <Input inputMode="numeric" value={f.leak_packed_undispatched_days} onChange={set('leak_packed_undispatched_days')} /></Field>
          <Field name="Packed over PO (%)">
            <Input inputMode="decimal" value={f.leak_over_po_pct} onChange={set('leak_over_po_pct')} /></Field>
        </div>
        <Field name="Pickup address" hint="For direct shipping (v2)." style={{ marginTop: 14 }}>
          <textarea value={f.pickup_address} onChange={set('pickup_address')} rows={2}
            style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: '9px 11px',
              color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 14, width: '100%', resize: 'vertical' }} />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button style={{ ...btnPrimary, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save vendor'}</button>
        </div>
      </Panel>
      <ProductsPanel vendorId={vendor.vendor_id} />
      <Confirm ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

function ProductsPanel({ vendorId }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState(null);
  const [boxes, setBoxes] = useState([]);
  const [edit, setEdit] = useState(null);           // null | {} (new) | row
  const load = () => opGet('getVendorProducts', { vendor_id: vendorId }, session).then(setRows).catch(e => showToast(e.message, 'error'));
  useEffect(() => {
    load();
    garageFetch('getBoxTypes', {}, session).then(d => setBoxes(Array.isArray(d) ? d.filter(b => b.is_active !== false) : [])).catch(() => {});
    /* eslint-disable-next-line */
  }, [vendorId]);
  const boxName = id => boxes.find(b => b.id === id)?.name || (id ? 'retired box' : '—');
  return (
    <Panel title="Products this vendor packs" icon="box" pad={14}
      action={<button style={smallBtn} onClick={() => setEdit({})}><Icon name="plus" size={12} /> Add product</button>}>
      {!rows ? <Spinner /> : !rows.length ? (
        <div style={text}>No products yet. Add a product family (e.g. Gator) — its active car colourways are covered automatically.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead><tr>{['Family', 'Mode', 'Remote', 'Per carton', 'Carton box', 'Status', ''].map(h => <th key={h} style={{ ...label, textAlign: 'left', padding: '6px 8px' }}>{h}</th>)}</tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.id} style={{ borderTop: '1px solid var(--border)', opacity: r.active ? 1 : 0.55 }}>
                <td style={{ ...text, padding: 8, color: 'var(--t1)', fontWeight: 600 }}>{r.product}</td>
                <td style={{ padding: 8 }}><ToneBadge tone={r.mode === 'packed' ? 'brand' : 'mute'}>{r.mode === 'packed' ? 'packs' : 'builds only'}</ToneBadge></td>
                <td style={{ ...mono, padding: 8 }}>{r.remote_code || '—'}</td>
                <td className="num" style={{ padding: 8 }}>{r.carton_qty}</td>
                <td style={{ ...text, padding: 8 }}>{boxName(r.box_type_id)}</td>
                <td style={{ padding: 8 }}><ToneBadge tone={r.active ? 'ok' : 'mute'}>{r.active ? 'active' : 'off'}</ToneBadge></td>
                <td style={{ padding: 8, textAlign: 'right' }}><button style={smallBtn} onClick={() => setEdit(r)}><Icon name="edit" size={12} /> Edit</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {edit && <ProductForm vendorId={vendorId} row={edit.id ? edit : null} boxes={boxes}
        onClose={() => setEdit(null)} onSaved={() => { setEdit(null); showToast('Product saved', 'success'); load(); }} />}
    </Panel>
  );
}

function ProductForm({ vendorId, row, boxes, onClose, onSaved }) {
  const { session } = useAuth();
  const [f, setF] = useState({ product: row?.product || '', mode: row?.mode || 'packed', remote_code: row?.remote_code || '',
    carton_qty: row ? String(row.carton_qty) : '', box_type_id: row?.box_type_id || '', active: row ? row.active : true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} title={row ? `Edit · ${row.product}` : 'Add a product family'} confirmLabel="Save" loading={busy} error={err}
      dismissOnBackdrop={false} confirmDisabled={!f.product.trim()} onConfirm={async () => {
        setBusy(true); setErr(null);
        const body = { vendor_id: vendorId, product: f.product.trim(), mode: f.mode, active: f.active,
          box_type_id: f.box_type_id || null };
        // Blank remote / qty on a NEW row = let the worker pick (the family's sole remote; Gator 18 / Shadow 24).
        if (f.remote_code.trim() || row) body.remote_code = f.remote_code.trim().toUpperCase() || null;
        if (f.carton_qty.trim()) body.carton_qty = f.carton_qty.trim();
        try { await opPost('setVendorProduct', body, session); onSaved(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
      }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field name="Product family" hint="As in the product master, e.g. Gator."><Input value={f.product} onChange={set('product')} disabled={!!row} /></Field>
        <Field name="Mode"><Select value={f.mode} onChange={set('mode')}>
          <option value="packed">Packs finished units (Outpost)</option><option value="built_only">Builds only (LOT packs; FBU GRN)</option></Select></Field>
        <Field name="Remote code" hint="Blank on a new row = the family's only active remote."><Input value={f.remote_code} onChange={set('remote_code')} placeholder="e.g. GOXXR" /></Field>
        <Field name="Units per carton" hint="Blank on a new row = Gator 18 / Shadow 24."><Input inputMode="numeric" value={f.carton_qty} onChange={set('carton_qty')} /></Field>
        <Field name="Carton box"><Select value={f.box_type_id} onChange={set('box_type_id')}>
          <option value="">—</option>{boxes.map(b => <option key={b.id} value={b.id}>{b.name} ({b.length_cm}×{b.width_cm}×{b.height_cm})</option>)}</Select></Field>
        <Field name="Active"><div style={{ paddingTop: 6 }}><Toggle on={f.active} onChange={v => setF(p => ({ ...p, active: v }))} /></div></Field>
      </div>
    </Modal>
  );
}

// ── Benches & agents ────────────────────────────────────────────────────────
function DevicesTab({ vendorId }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing } = useRefreshState();
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [secret, setSecret] = useState(null);
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setRefreshing(true);
    try { setD(await opGet('getDevices', { vendor_id: vendorId }, session)); setErr(null); }
    catch (e) { setErr(e.message); } finally { setRefreshing(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [vendorId]);
  if (err) return <ErrorPanel error={err} onRetry={load} />;
  if (!d) return <Spinner />;
  const live = d.devices.filter(x => x.status === 'active');
  const gone = d.devices.filter(x => x.status !== 'active');

  const revoke = x => setAsk({
    title: `Revoke ${x.label || `device ${x.id}`}?`, danger: true, yes: 'Revoke device',
    body: <>This {x.kind === 'agent' ? 'print agent' : 'bench'} is refused at once and anyone logged in on it is logged out. It cannot be re-used: to bring
      it back, issue a new enrolment code.{x.kind === 'bench' && <><br /><br /><strong>Any carton this bench has open is closed short now</strong>,
      and its CTN label prints at bench {x.bench_no}'s printer — an open carton belongs to this device, so nothing else could close it.</>}</>,
    onYes: async () => {
      const r = await opPost('revokeDevice', { id: x.id }, session);
      const n = r.closed_cartons?.length || 0;
      showToast(n ? `Revoked. Closed short: ${r.closed_cartons.map(c => `${c.ctn_no} (${c.unit_count}/${c.capacity})`).join(', ')}` : 'Revoked',
        'success', n ? 10000 : undefined);
      await load();
    },
  });
  const unlock = async x => {
    try { await opPost('unlockDevice', { id: x.id }, session); showToast('Bench unlocked', 'success'); load(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  const revokeCode = e => setAsk({ title: `Cancel the code for ${e.label}?`, yes: 'Cancel code', body: 'The code stops working at once.',
    onYes: async () => { await opPost('revokeEnrolment', { id: e.id }, session); await load(); } });

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Panel title="Enrolled devices" icon="printer" pad={14}
        action={<button style={smallBtn} onClick={() => setForm({ kind: 'bench', bench_no: '', label: '' })}><Icon name="plus" size={12} /> Enrolment code</button>}>
        {!live.length ? <div style={text}>No device is enrolled yet. Issue an enrolment code, then open outpost.legendoftoys.com on the bench laptop and enter it.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead><tr>{['Device', 'Kind', 'Bench', 'Enrolled', 'Last seen', 'State', ''].map(h => <th key={h} style={{ ...label, textAlign: 'left', padding: '6px 8px' }}>{h}</th>)}</tr></thead>
              <tbody>{live.map(x => {
                const locked = x.pin_locked_until && Date.parse(x.pin_locked_until) > Date.now();
                const printers = x.kind === 'agent' ? agentSummary(x) : null;
                return (
                  <tr key={x.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...text, padding: 8, color: 'var(--t1)', fontWeight: 600 }}>{x.label || `#${x.id}`}</td>
                    <td style={{ padding: 8 }}><ToneBadge tone={x.kind === 'agent' ? 'brand' : 'mute'}>{x.kind === 'agent' ? 'print agent' : 'bench'}</ToneBadge></td>
                    <td className="num" style={{ padding: 8 }}>{x.bench_no ?? '—'}</td>
                    <td style={{ ...text, padding: 8 }}>{fmtIST(x.enrolled_at)}</td>
                    <td style={{ ...text, padding: 8 }}>{fmtIST(x.last_seen_at)}</td>
                    <td style={{ ...text, padding: 8 }}>
                      {locked ? <ToneBadge tone="bad">PIN-locked</ToneBadge> : printers ? <span title={printers.title}>{printers.text}</span> : <ToneBadge tone="ok">active</ToneBadge>}
                    </td>
                    <td style={{ padding: 8, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {locked && <button style={{ ...smallBtn, marginRight: 6 }} onClick={() => unlock(x)}>Unlock</button>}
                      <button style={dangerBtn} onClick={() => revoke(x)}>Revoke</button>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </Panel>

      {d.pending_enrolments.length > 0 && (
        <Panel title="Codes not used yet" icon="clock" pad={14}>
          {d.pending_enrolments.map(e => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 4px', borderTop: '1px solid var(--border)' }}>
              <div style={{ ...text, flex: 1, color: 'var(--t1)' }}>{e.label} <span style={{ color: 'var(--t3)' }}>· {e.kind}{e.bench_no ? ` · bench ${e.bench_no}` : ''}</span></div>
              <div style={{ ...text, fontSize: 12 }}>expires {fmtIST(e.expires_at)}</div>
              <button style={smallBtn} onClick={() => revokeCode(e)}>Cancel</button>
            </div>
          ))}
        </Panel>
      )}

      {gone.length > 0 && (
        <Panel title="Revoked" icon="x" pad={14}>
          {gone.map(x => (
            <div key={x.id} style={{ ...text, padding: '6px 4px', borderTop: '1px solid var(--border)', opacity: 0.7 }}>
              {x.label || `#${x.id}`} · {x.kind}{x.bench_no ? ` · bench ${x.bench_no}` : ''} · revoked {fmtIST(x.revoked_at)}
            </div>
          ))}
        </Panel>
      )}

      {form && (
        <Modal open onClose={() => setForm(null)} title="New enrolment code" confirmLabel="Create code" dismissOnBackdrop={false}
          confirmDisabled={form.kind === 'bench' && !form.bench_no} loading={busy}
          onConfirm={async () => {
            if (busy) return;                   // one click = one code: a second would be live but never shown
            setBusy(true);
            try {
              const r = await opPost('createEnrolment', { vendor_id: vendorId, kind: form.kind, bench_no: form.bench_no || null,
                label: form.label.trim() }, session);
              setForm(null);
              setSecret({ title: `Enrolment code · ${r.label}`, lead: `Enter this on ${form.kind === 'agent' ? 'the print agent' : 'the bench laptop, at outpost.legendoftoys.com'}. It works once.`,
                items: [['Code', r.code]], expires: fmtIST(r.expires_at) });
              load();
            } catch (e) { showToast(e.message, 'error'); } finally { setBusy(false); }
          }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field name="Device"><Select value={form.kind} onChange={e => setForm(p => ({ ...p, kind: e.target.value }))}>
              <option value="bench">Bench laptop</option><option value="agent">Print agent</option></Select></Field>
            <Field name="Bench no." hint={form.kind === 'agent' ? 'The bench whose label printer it drives; blank = sticker printers only.' : '1–99'}>
              <Input inputMode="numeric" value={form.bench_no} onChange={e => setForm(p => ({ ...p, bench_no: e.target.value.replace(/\D/g, '').slice(0, 2) }))} /></Field>
          </div>
          <Field name="Label" hint="Optional — defaults to “Bench N” / “Print agent”." style={{ marginTop: 14 }}>
            <Input value={form.label} onChange={e => setForm(p => ({ ...p, label: e.target.value }))} maxLength={60} /></Field>
          {form.kind === 'bench' && live.some(x => x.kind === 'bench' && String(x.bench_no) === String(form.bench_no)) && (
            <div style={{ ...text, color: 'var(--warn-fg)', marginTop: 12 }}>Bench {form.bench_no} already has an enrolled laptop. If it is being
              replaced, revoke the old one so its open cartons are closed.</div>
          )}
        </Modal>
      )}
      <SecretModal secret={secret} onClose={() => setSecret(null)} />
      <Confirm ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

// An agent's heartbeat (devices.agent_status, written by /v/agent/heartbeat): online = within 90 s.
function agentSummary(x) {
  const at = x.agent_status_at ? Date.parse(x.agent_status_at) : 0;
  if (!at) return { text: 'no heartbeat yet', title: '' };
  const online = Date.now() - at < 90_000;
  const printers = Array.isArray(x.agent_status?.printers) ? x.agent_status.printers : [];
  const bad = printers.filter(p => p && p.ok === false);
  return { text: `${online ? '● online' : '○ offline'}${printers.length ? ` · ${printers.length - bad.length}/${printers.length} printers ok` : ''}`,
    title: `last heartbeat ${fmtIST(x.agent_status_at)}` };
}

// ── Operators ───────────────────────────────────────────────────────────────
function OperatorsTab({ vendorId }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);           // {id?, name, role, was?}
  const [secret, setSecret] = useState(null);
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);          // one click = one operator / one code (a second would never be shown)
  const load = () => opGet('getOperators', { vendor_id: vendorId }, session).then(r => { setRows(r); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [vendorId]);
  if (err) return <ErrorPanel error={err} onRetry={load} />;
  if (!rows) return <Spinner />;

  const saveForm = async () => {
    if (!form.name.trim()) { showToast('Name required', 'error'); return; }
    if (busy) return;
    setBusy(true);
    try {
      if (form.id) {
        // Send the role only when it changed: any role in the body logs the operator out of their bench.
        await opPost('updateOperator', { id: form.id, name: form.name.trim(), ...(form.role !== form.was ? { role: form.role } : {}) }, session);
        showToast('Operator saved', 'success');
      } else {
        const r = await opPost('createOperator', { vendor_id: vendorId, name: form.name.trim(), role: form.role }, session);
        setSecret({ title: `New ${r.role} · ${r.name}`, lead: 'They log in on a bench with their operator code and PIN.',
          items: [['Operator code', r.op_code], ['PIN', r.pin]] });
      }
      setForm(null); load();
    } catch (e) { showToast(e.message, 'error'); } finally { setBusy(false); }
  };
  const resetPin = o => setAsk({ title: `New PIN for ${o.name}?`, yes: 'Issue new PIN',
    body: 'Their old PIN stops working and they are logged out of any bench.',
    onYes: async () => { const r = await opPost('resetPin', { id: o.id }, session);
      setSecret({ title: `New PIN · ${o.name}`, items: [['PIN', r.pin]], lead: `Operator code ${r.op_code}.${r.sessions_not_ended
        ? ' ⚠ The PIN changed, but a bench session of theirs could not be ended — deactivate and re-activate them if they must be logged out now.' : ''}` });
      load(); } });
  const setActive = (o, active) => setAsk({ title: `${active ? 'Re-activate' : 'Deactivate'} ${o.name}?`, danger: !active,
    yes: active ? 'Re-activate' : 'Deactivate',
    body: active ? 'They can log in again with their existing PIN.' : 'They are logged out of any bench and cannot log in.',
    onYes: async () => { await opPost('updateOperator', { id: o.id, active }, session); load(); } });
  const unlock = async o => {
    try { await opPost('unlockOperator', { id: o.id }, session); showToast(`${o.name} unlocked`, 'success'); load(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  const loginCode = async o => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await opPost('createLoginCode', { operator_id: o.id }, session);
      setSecret({ title: `Dashboard login code · ${r.operator}`, lead: 'For the vendor supervisor dashboard. Works once; the session lasts 12 hours.',
        items: [['Login code', r.code]], expires: fmtIST(r.expires_at) });
    } catch (e) { showToast(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <Panel title="Operators" icon="users" pad={14}
      action={<button style={smallBtn} onClick={() => setForm({ name: '', role: 'operator' })}><Icon name="plus" size={12} /> Add operator</button>}>
      {!rows.length ? <div style={text}>No operators yet. Add at least one supervisor (they mint stickers, approve un-packs and dispatch).</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead><tr>{['Code', 'Name', 'Role', 'Status', 'Added', ''].map(h => <th key={h} style={{ ...label, textAlign: 'left', padding: '6px 8px' }}>{h}</th>)}</tr></thead>
            <tbody>{rows.map(o => {
              const locked = o.pin_locked_until && Date.parse(o.pin_locked_until) > Date.now();
              return (
                <tr key={o.id} style={{ borderTop: '1px solid var(--border)', opacity: o.active ? 1 : 0.55 }}>
                  <td style={{ ...mono, padding: 8, color: 'var(--t1)' }}>{o.op_code}</td>
                  <td style={{ ...text, padding: 8, color: 'var(--t1)' }}>{o.name}</td>
                  <td style={{ padding: 8 }}><ToneBadge tone={o.role === 'supervisor' ? 'brand' : 'mute'}>{o.role}</ToneBadge></td>
                  <td style={{ padding: 8 }}>{!o.active ? <ToneBadge>inactive</ToneBadge> : locked ? <ToneBadge tone="bad">locked till {fmtIST(o.pin_locked_until)}</ToneBadge> : <ToneBadge tone="ok">active</ToneBadge>}</td>
                  <td style={{ ...text, padding: 8 }}>{fmtIST(o.created_at)}</td>
                  <td style={{ padding: 8, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {locked && <button style={{ ...smallBtn, marginRight: 6 }} onClick={() => unlock(o)}>Unlock</button>}
                    {o.active && o.role === 'supervisor' && <button style={{ ...smallBtn, marginRight: 6 }} disabled={busy} onClick={() => loginCode(o)}>Login code</button>}
                    {o.active && <button style={{ ...smallBtn, marginRight: 6 }} onClick={() => resetPin(o)}>New PIN</button>}
                    {o.active && <button style={{ ...smallBtn, marginRight: 6 }} onClick={() => setForm({ id: o.id, name: o.name, role: o.role, was: o.role })}>Edit</button>}
                    <button style={o.active ? dangerBtn : smallBtn} onClick={() => setActive(o, !o.active)}>{o.active ? 'Deactivate' : 'Re-activate'}</button>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {form && (
        <Modal open onClose={() => setForm(null)} title={form.id ? 'Edit operator' : 'Add operator'} confirmLabel={form.id ? 'Save' : 'Add + issue PIN'}
          dismissOnBackdrop={false} loading={busy} onConfirm={saveForm}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>
            <Field name="Name"><Input value={form.name} maxLength={80} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} /></Field>
            <Field name="Role"><Select value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}>
              <option value="operator">Operator</option><option value="supervisor">Supervisor</option></Select></Field>
          </div>
          {form.id && <div style={{ ...text, fontSize: 12, marginTop: 12 }}>Changing the role logs them out of any bench.</div>}
          {!form.id && <div style={{ ...text, fontSize: 12, marginTop: 12 }}>The next free 3-digit code and a 6-digit PIN are issued; you see the PIN once.</div>}
        </Modal>
      )}
      <SecretModal secret={secret} onClose={() => setSecret(null)} />
      <Confirm ask={ask} onClose={() => setAsk(null)} />
    </Panel>
  );
}

// ── Activity (outpost.events, newest first) ─────────────────────────────────
function ActivityTab({ vendorId }) {
  const { session } = useAuth();
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(true);
  const [err, setErr] = useState(null);
  const load = async before => {
    try {
      const r = await opGet('getEvents', { vendor_id: vendorId, before_id: before || null }, session);
      setRows(p => (before ? [...(p || []), ...r] : r)); setMore(r.length === 200); setErr(null);
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [vendorId]);
  if (err) return <ErrorPanel error={err} onRetry={() => load()} />;
  if (!rows) return <Spinner />;
  return (
    <Panel pad={8}>
      {!rows.length ? <div style={{ ...text, padding: 20 }}>Nothing yet.</div> : rows.map(e => (
        <div key={e.id} style={{ display: 'grid', gridTemplateColumns: '130px 90px 190px 1fr', gap: 10, padding: '7px 8px', borderTop: '1px solid var(--border)', alignItems: 'start' }}>
          <span style={{ ...text, fontSize: 12 }}>{fmtIST(e.at)}</span>
          <span><ToneBadge tone={e.actor_kind === 'lot' ? 'brand' : 'mute'}>{e.actor_kind}</ToneBadge></span>
          <span style={{ ...mono, color: 'var(--t1)' }}>{e.action}</span>
          <span style={{ ...mono, fontSize: 11.5, color: 'var(--t3)', wordBreak: 'break-word' }}>{summarise(e.detail)}</span>
        </div>
      ))}
      {more && rows.length > 0 && <div style={{ padding: 10 }}><button style={smallBtn} onClick={() => load(rows[rows.length - 1].id)}>Older</button></div>}
    </Panel>
  );
}

const summarise = d => (d && typeof d === 'object'
  ? Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')
  : '');
