'use client';
/* NewRequestModal — multi-step intake (Type → Details → Review → Filed).
   Ported from interactions.jsx; Submit posts to the throttleops worker
   (submitRequest) when authenticated, else shows the canned confirmation. */
import React, { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Icon } from './Icon';
import { PrimaryBtn } from './ui';
import { PRODUCTS, PRIORITY, REQ_TYPES, productChip } from '@/lib/throttleData';
import { fetchProducts, updateRequest } from '@/lib/throttleApi';

const REQ_CHANNELS = ['Amazon', 'Flipkart', 'Quick Commerce', 'Website', 'Social', 'Email', 'WhatsApp', 'Offline'];
const PRODUCT_SCOPED = { launch_pack: true, product_creative: true, motion_3d: true };

// `editing` (optional) = an existing request the owner is editing. When set, the
// modal opens prefilled at the Details step (type is fixed) and submits via
// updateRequest instead of submitRequest.
export function NewRequestModal({ open, onClose, editing }) {
  const { session } = useAuth();
  const isEdit = !!editing;
  const [step, setStep] = useState(0);
  const [type, setType] = useState(null);
  const [form, setForm] = useState({ title: '', products: [], priority: 'medium', channels: [], deadline: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [filedId, setFiledId] = useState('R-242');
  const [productCodes, setProductCodes] = useState(() => PRODUCTS.map(p => p.code));

  useEffect(() => {
    if (!open) return;
    setBusy(false); setFiledId('R-242');
    if (editing) {
      const td = editing.template_data || {};
      setType(editing.type || null);
      setForm({
        title: editing.title || '',
        products: Array.isArray(editing.products) ? editing.products : [],
        priority: td.priority || 'medium',
        channels: Array.isArray(td.channels) ? td.channels : [],
        deadline: td.deadline || '',
        notes: td.notes || '',
      });
      setStep(1); // type is fixed on edit — skip the type picker
    } else {
      setStep(0); setType(null);
      setForm({ title: '', products: [], priority: 'medium', channels: [], deadline: '', notes: '' });
    }
  }, [open, editing]);
  // Live product list from product_master (falls back to seed list on error)
  useEffect(() => {
    if (!open || !session) return;
    let alive = true;
    fetchProducts(session).then(codes => { if (alive && codes?.length) setProductCodes(codes); });
    return () => { alive = false; };
  }, [open, session]);
  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const toggleArr = (k, v) => setForm(f => ({ ...f, [k]: f[k].includes(v) ? f[k].filter(x => x !== v) : [...f[k], v] }));
  const t = type ? (REQ_TYPES[type] || { label: String(type).replace(/_/g, ' '), icon: 'box' }) : null;
  const scoped = type && PRODUCT_SCOPED[type];
  // What's still required to leave the current step (drives both the hint + the
  // "you clicked Continue but nothing happened" toast — never silently no-op).
  const missing = step === 0
    ? (type ? [] : ['a request type'])
    : step === 1
      ? [!form.title.trim() && 'a title', !form.deadline && 'a "Needed by" date', (scoped && !form.products.length) && 'at least one product'].filter(Boolean)
      : [];
  const canContinue = missing.length === 0;
  function goNext() {
    if (canContinue) { setStep(s => s + 1); return; }
    window.dispatchEvent(new CustomEvent('throttle:toast', { detail: { msg: 'Add ' + missing.join(', ') + ' to continue.', tone: 'bad', icon: 'alert' } }));
  }

  const STEPS = ['Type', 'Details', 'Review'];
  const label = { fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)', display: 'block', marginBottom: 8 };
  const field = { width: '100%', background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: '10px 12px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 14, outline: 'none' };

  async function submit() {
    if (busy) return;
    setBusy(true);
    if (session) {
      const template_data = { priority: form.priority, channels: form.channels, deadline: form.deadline || null, notes: form.notes || null };
      const is_product_scoped = form.products.length > 0;
      const products = form.products.map(code => ({ product_name: code, notes: null }));
      try {
        if (isEdit) {
          await updateRequest(session, { requestId: editing.id, title: form.title.trim(), templateData: template_data, is_product_scoped, products });
          setFiledId(typeof editing.id === 'string' ? editing.id.slice(0, 8) : String(editing.id));
        } else {
          const res = await workerFetch('submitRequest', { type, title: form.title.trim(), template_data, is_product_scoped, products }, session.access_token);
          const rid = res?.request_id || res?.data?.request_id;
          if (rid) setFiledId(typeof rid === 'string' ? rid.slice(0, 8) : String(rid));
        }
        window.dispatchEvent(new CustomEvent('throttle:requestfiled'));
      } catch (e) {
        window.dispatchEvent(new CustomEvent('throttle:toast', { detail: { msg: (isEdit ? 'Could not update request: ' : 'Could not file request: ') + (e.message || 'error'), tone: 'bad', icon: 'alert' } }));
      }
    }
    setBusy(false);
    setStep(3);
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 420, background: 'rgba(8,8,10,0.62)', backdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '7vh' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(660px, 94vw)', maxHeight: '86vh', background: 'var(--surface)',
        border: '1px solid var(--border-2)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-pop)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14, letterSpacing: '0.06em', color: 'var(--t1)', textTransform: 'uppercase' }}>{isEdit ? 'Edit Request' : 'New Request'}</span>
          {step < 3 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 6 }}>
              {STEPS.map((s, i) => (
                <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <span className="num" style={{ width: 20, height: 20, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
                    background: i <= step ? 'var(--yellow)' : 'var(--surface-2)', color: i <= step ? '#15140b' : 'var(--t4)' }}>{i + 1}</span>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: i === step ? 'var(--t1)' : 'var(--t4)' }}>{s}</span>
                  {i < 2 && <span style={{ width: 16, height: 1, background: 'var(--border-2)' }} />}
                </span>
              ))}
            </div>
          )}
          <button onClick={onClose} className="t-iconbtn" style={{ marginLeft: 'auto', width: 30, height: 30 }}><Icon name="x" size={15} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '22px 20px' }}>
          {step === 0 && (
            <>
              <p style={{ fontSize: 13.5, color: 'var(--t3)', margin: '0 0 18px' }}>What do you need made. Pick a type and we’ll ask for exactly what production needs.</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                {Object.entries(REQ_TYPES).map(([k, rt]) => {
                  const on = type === k;
                  return (
                    <button key={k} onClick={() => setType(k)} className="t-card-hover" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 14px',
                      borderRadius: 'var(--r-sm)', cursor: 'pointer', textAlign: 'left', transition: 'border-color .14s, background .14s',
                      background: on ? 'var(--active-bg)' : 'var(--card-bg)', border: `1px solid ${on ? 'var(--brand-bd)' : 'var(--border)'}` }}>
                      <span style={{ width: 36, height: 36, borderRadius: 'var(--r-sm)', background: on ? 'var(--yellow)' : 'var(--surface-2)', border: '1px solid var(--border-2)',
                        display: 'grid', placeItems: 'center', color: on ? '#15140b' : 'var(--yellow)', flexShrink: 0 }}><Icon name={rt.icon} size={17} /></span>
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: on ? 'var(--t1)' : 'var(--t2)' }}>{rt.label}</span>
                      {on && <Icon name="check" size={15} style={{ marginLeft: 'auto', color: 'var(--yellow)' }} />}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 32, height: 32, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)', border: '1px solid var(--border-2)', display: 'grid', placeItems: 'center', color: 'var(--yellow)' }}><Icon name={t.icon} size={16} /></span>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t1)' }}>{t.label}</span>
              </div>
              <div>
                <label style={label}>Title</label>
                <input autoFocus value={form.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Flare launch hero — Amazon A+" style={field} />
              </div>
              <div>
                <label style={label}>Product{scoped ? '' : ' (optional)'}</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {productCodes.map(code => {
                    const p = productChip(code);
                    return (
                      <button key={code} onClick={() => toggleArr('products', code)} className="t-chip" data-on={form.products.includes(code)}>
                        <span style={{ width: 7, height: 7, borderRadius: 2, background: p.accent, display: 'inline-block', marginRight: 6 }} />{code}</button>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <label style={label}>Priority</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {Object.entries(PRIORITY).map(([k, p]) => (
                      <button key={k} onClick={() => set('priority', k)} className="t-chip" data-on={form.priority === k}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.color, display: 'inline-block', marginRight: 6 }} />{p.label}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={label}>Needed by</label>
                  <input type="date" value={form.deadline} onChange={e => set('deadline', e.target.value)} style={field} />
                </div>
              </div>
              <div>
                <label style={label}>Channels</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {REQ_CHANNELS.map(c => (
                    <button key={c} onClick={() => toggleArr('channels', c)} className="t-chip" data-on={form.channels.includes(c)}>{c}</button>
                  ))}
                </div>
              </div>
              <div>
                <label style={label}>Brief / notes</label>
                <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={3} placeholder="Specs, references, anything production needs to know." style={{ ...field, resize: 'vertical', minHeight: 70 }} />
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <p style={{ fontSize: 13.5, color: 'var(--t3)', margin: '0 0 18px' }}>One look before it goes to the approval queue.</p>
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                {[['Type', t.label], ['Title', form.title || '—'],
                  ['Product', form.products.length ? form.products.join(', ') : '—'],
                  ['Priority', PRIORITY[form.priority].label],
                  ['Needed by', form.deadline || '—'],
                  ['Channels', form.channels.length ? form.channels.join(', ') : '—'],
                  ['Notes', form.notes || '—']].map((r, i) => (
                  <div key={r[0]} style={{ display: 'grid', gridTemplateColumns: '130px 1fr', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ padding: '11px 14px', background: 'var(--surface-2)', fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t3)' }}>{r[0]}</div>
                    <div style={{ padding: '11px 16px', fontSize: 13.5, color: 'var(--t1)' }}>{r[1]}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div style={{ textAlign: 'center', padding: '34px 0' }}>
              <span style={{ width: 60, height: 60, borderRadius: '50%', background: 'var(--ok-bg)', border: '1px solid var(--ok-bd)', color: 'var(--ok-fg)', display: 'grid', placeItems: 'center', margin: '0 auto 18px' }}><Icon name="check" size={28} /></span>
              <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 20, color: 'var(--t1)', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.02em' }}>{isEdit ? 'Request updated' : 'Request filed'}</h2>
              <p style={{ fontSize: 14, color: 'var(--t3)', margin: 0, lineHeight: 1.5 }}>
                <span className="num" style={{ color: 'var(--yellow)' }}>{filedId}</span> {isEdit ? 'is updated and back in the approval queue.' : 'is in the approval queue.'}<br/>You’ll get a ping when a lead picks it up.</p>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          {step > (isEdit ? 1 : 0) && step < 3 && (
            <button onClick={() => setStep(s => s - 1)} className="t-btn" style={{ padding: '9px 14px', borderRadius: 'var(--r-sm)', background: 'transparent', border: '1px solid var(--border-2)', color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Back</button>
          )}
          {step < 2 && !canContinue && missing.length > 0 && (
            <span style={{ fontSize: 12, color: 'var(--t3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="alert" size={13} style={{ color: 'var(--yellow)' }} />Add {missing.join(', ')}
            </span>
          )}
          <span style={{ marginLeft: 'auto' }} />
          {step < 2 && <PrimaryBtn icon="chevronRight" onClick={goNext}>Continue</PrimaryBtn>}
          {step === 2 && <PrimaryBtn icon="check" onClick={submit}>{busy ? (isEdit ? 'Saving…' : 'Filing…') : (isEdit ? 'Save changes' : 'Submit request')}</PrimaryBtn>}
          {step === 3 && <PrimaryBtn icon="check" onClick={onClose}>Done</PrimaryBtn>}
        </div>
      </div>
    </div>
  );
}
