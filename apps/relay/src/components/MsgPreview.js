'use client';
// SMS + RCS phone-framed preview — the same handset mock WaPreview gives WhatsApp, drawn as
// Google Messages, which is literally where RCS renders and where SMS lands on Android.
// Reuses the wa-pv-* frame classes; colours are deliberately hardcoded Messages colours, not
// app theme tokens — this simulates a third-party surface, so it must look like Messages in
// BOTH app themes (same rule as WaPreview).
//
// Token filling happens HERE (not imported from TemplatePreview, which imports this file):
// SMS bodies carry {token} names, RCS registrations carry [token] brackets. Resolution order
// mirrors the send path: explicit value → fallback → the bare token, greyed by the caller's
// copy ("Greyed words are examples or fallbacks").
import { ArrowLeft, Phone, MoreVertical, BadgeCheck, Plus, Mic, ExternalLink } from 'lucide-react';

const GM = {
  chat: '#ffffff', bubble: '#f1f3f4', header: '#ffffff', headerText: '#202124',
  text: '#202124', meta: '#5f6368', chip: '#0b57d0', rule: '#e8eaed', inputBg: '#f1f3f4',
  verified: '#1a73e8',
};

function fillTokens(text, variables, values, syntax) {
  const re = syntax === 'bracket' ? /\[([a-zA-Z0-9_]+)\]/g : /\{(\w+)\}/g;
  return String(text || '').replace(re, (whole, token) => {
    const v = (variables || []).find((x) => x.token === token);
    if (!v) return whole;
    const explicit = values?.[token];
    if (explicit != null && String(explicit).trim() !== '') return String(explicit);
    if (v.fallback) return v.fallback;
    return whole;
  });
}

// channel: 'sms' | 'rcs' · sender: header/bot name · body: raw template text ·
// variables/values: for token fill · image/cardTitle: rich_card bits · chips: [{label}] ·
// meta: dim line under the frame · status: node under the frame (checks, badges)
export default function MsgPreview({ channel, sender, body, variables, values,
                                     image, cardTitle, chips, emptyNote, meta, status }) {
  const isRcs = channel === 'rcs';
  const filled = fillTokens(body, variables, values, isRcs ? 'bracket' : 'name');
  const btns = (chips || []).filter((c) => c && (c.label || '').trim());

  return (
    <div className="wa-pv">
      <div className="wa-pv-phone" style={{ background: GM.chat }}>
        {/* Messages app bar — sender identity is the load-bearing bit: SMS shows the DLT
            header, an RCS bot shows its display name with the verified tick. */}
        <div className="wa-pv-top" style={{ background: GM.header, color: GM.headerText,
          borderBottom: `1px solid ${GM.rule}` }}>
          <ArrowLeft size={17} style={{ opacity: .7, flex: '0 0 auto' }} />
          <div className="wa-pv-avatar" style={{ background: isRcs ? '#fde293' : '#d2e3fc',
            color: '#202124', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 700 }}>
            {(sender || '?').slice(0, 1)}
          </div>
          <div className="wa-pv-name" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span>{sender || (isRcs ? 'L.O.T' : 'LGNDRC')}</span>
            {isRcs && <BadgeCheck size={14} style={{ color: GM.verified, flex: '0 0 auto' }} />}
          </div>
          <Phone size={15} style={{ opacity: .6, flex: '0 0 auto' }} />
          <MoreVertical size={15} style={{ opacity: .6, flex: '0 0 auto' }} />
        </div>

        <div className="wa-pv-chat" style={{ background: GM.chat }}>
          <div className="wa-pv-bubble" style={{ background: GM.bubble, color: GM.text,
            borderRadius: 16, borderBottomLeftRadius: 4 }}>
            {image != null && (
              image
                ? <img src={image} alt="" className="wa-pv-img" />
                : <div className="wa-pv-img wa-pv-img-empty">Card image</div>
            )}
            {cardTitle && <div style={{ fontWeight: 700, marginBottom: 4 }}>{cardTitle}</div>}
            <div style={{ whiteSpace: 'pre-wrap' }}>
              {filled || <span style={{ color: '#9aa0a6' }}>{emptyNote || 'Message preview…'}</span>}
            </div>
            <div className="wa-pv-time" style={{ color: GM.meta }}>12:56</div>
          </div>

          {/* RCS suggestion chips — the outlined pills under the bubble are RCS's signature
              surface; SMS never has them (a URL in an SMS is just text). */}
          {btns.length > 0 && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {btns.map((b, i) => (
                <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
                  border: `1px solid ${GM.rule}`, borderRadius: 16, padding: '5px 12px',
                  color: GM.chip, fontSize: 12.5, fontWeight: 600, background: '#fff' }}>
                  <ExternalLink size={12} />
                  {b.label}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="wa-pv-input" style={{ background: GM.chat }}>
          <div className="wa-pv-inputbar" style={{ background: GM.inputBg, color: GM.meta }}>
            <Plus size={16} />
            <span style={{ flex: 1, fontSize: 12.5 }}>{isRcs ? 'RCS message' : 'Text message'}</span>
            <Mic size={15} />
          </div>
        </div>
      </div>

      {meta && <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>{meta}</div>}
      {status}
    </div>
  );
}
