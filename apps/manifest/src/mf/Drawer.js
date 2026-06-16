'use client';
// Manifest "Pit Wall" — ledger drill-down drawer with ref-derived deep-links.
import React from 'react';
import { X, ChevronRight, Package, CreditCard, HandCoins, FileText } from 'lucide-react';
import { Badge, Btn, MONO, DISP } from './ui.js';
import { signedInr, ledgerTone, label } from './data.js';

function linkedRecord(ref) {
  if (/^CN-/.test(ref)) return { icon: Package, title: ref, sub: 'View order detail', screen: 'orderDetail' };
  if (/^WIRE-/.test(ref)) return { icon: CreditCard, title: ref, sub: 'View in Payments', screen: 'payments' };
  if (/^DD-/.test(ref)) return { icon: HandCoins, title: ref, sub: 'View draw-down', screen: 'drawdowns' };
  return { icon: FileText, title: ref, sub: 'View in Documents', screen: 'documents' };
}

function Row({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '9px 0', borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
      <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--t3)' }}>{k}</span>
      <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--t1)', textAlign: 'right' }}>{v}</span>
    </div>
  );
}

export function Drawer({ entry, onClose, onNav }) {
  if (!entry) return null;
  const tone = ledgerTone(entry.kind);
  const c = tone === 'green' ? 'var(--green)' : 'var(--red)';
  const link = linkedRecord(entry.ref);
  const LinkIcon = link.icon;
  const postedBy = entry.kind === 'payment' ? 'Arjun Mehta · LOT' : 'Wei Chen · SF';
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(8,7,10,.55)', zIndex: 50 }} />
      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, maxWidth: '92vw', zIndex: 51,
        background: 'var(--surface)', borderLeft: '1px solid var(--border)', boxShadow: '-28px 0 60px -28px rgba(0,0,0,.8)',
        display: 'flex', flexDirection: 'column' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '20px 22px', borderBottom: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: '.14em', color: 'var(--t3)', marginBottom: 4 }}>LEDGER ENTRY</div>
            <div style={{ fontFamily: MONO, fontSize: 16, fontWeight: 600, color: 'var(--t1)' }}>{entry.ref}</div>
          </div>
          <button onClick={onClose} className="mf-icobtn" style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={16} color="var(--t2)" />
          </button>
        </div>
        {/* body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <Badge tone={tone}>{label(entry.kind)}</Badge>
            <span style={{ fontFamily: MONO, fontSize: 26, fontWeight: 700, color: c }}>{signedInr(entry.amt)}</span>
          </div>
          <div style={{ fontFamily: DISP, fontSize: 14, color: 'var(--t2)', lineHeight: 1.5, marginBottom: 20 }}>{entry.desc}</div>
          <div>
            <Row k="Date" v={entry.date} />
            <Row k="Type" v={label(entry.kind)} />
            <Row k="Direction" v={entry.amt < 0 ? 'Debit' : 'Credit'} />
            <Row k="Running balance" v={signedInr(entry.balance).replace('+', '')} />
            <Row k="Posted by" v={postedBy} />
            <Row k="Reconciled" v="Yes" />
          </div>
          {/* linked record */}
          <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', margin: '22px 0 10px' }}>Linked record</div>
          <div className="mf-icobtn" onClick={() => onNav(link.screen)}
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 14px', borderRadius: 10,
              background: 'var(--surface2)', border: '1px solid var(--border)' }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: 'color-mix(in srgb, var(--accent) 14%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <LinkIcon size={17} color="var(--accent)" strokeWidth={1.7} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: 'var(--t1)' }}>{link.title}</div>
              <div style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--t3)' }}>{link.sub}</div>
            </div>
            <ChevronRight size={17} color="var(--t3)" />
          </div>
        </div>
        {/* footer */}
        <div style={{ display: 'flex', gap: 10, padding: '16px 22px', borderTop: '1px solid var(--border)' }}>
          <Btn variant="secondary" onClick={onClose} style={{ flex: 1 }}>Close</Btn>
          <Btn variant="primary" style={{ flex: 1 }}>View Evidence</Btn>
        </div>
      </div>
    </>
  );
}
