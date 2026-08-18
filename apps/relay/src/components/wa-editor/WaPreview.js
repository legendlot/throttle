'use client';
// WhatsApp template preview — a phone-framed mock of what the recipient actually receives.
//
// Split out of WaEditor (2026-07-28) so the templates page can PIN it beside the form in a
// two-column layout instead of stacking it below. Editing copy and watching the bubble change
// is the whole job of this screen, and stacked panels meant scrolling away from the preview to
// reach the field you were editing.
//
// Deliberately hardcoded WhatsApp colours (not app theme tokens): this simulates a third-party
// surface, so it must look like WhatsApp in BOTH app themes, not like Relay.
import { Badge } from '@/components/ui.js';
import { placeholdersIn, previewText } from './waTemplate.js';
import { ArrowLeft, Phone, MoreVertical, Smile, Paperclip, Camera, ExternalLink } from 'lucide-react';

const WA = {
  chat: '#ECE5DD', bubble: '#fff', header: '#075E54', headerText: '#fff',
  text: '#111', meta: '#8696A0', link: '#00A5F4', rule: '#E9EDEF', inputBg: '#fff',
};

// `fill` lets a CALLER supply its own text resolver. The templates editor passes nothing and
// gets `previewText` (Meta's approval examples, which is what an author is checking). The
// campaign page passes its value-resolver and gets the real merged copy. Same handset frame,
// same image header, one component — the campaign page used to hand-roll a bare chat bubble on
// the app's own dark surface, so the WhatsApp preview was neither phone-shaped nor able to show
// the image header, on the channel that carries an image in nearly every send.
export default function WaPreview({ wa, mapping, buttons, errs, senderLabel, fill, showStatus = true }) {
  const c = wa || {};
  const render = (text, comp) => (fill ? fill(text, comp) : previewText(text, mapping, comp));
  // MUST mirror WaEditor's derivation exactly — `header_format` is what's load-bearing on the
  // wire, and an absent one defaults to TEXT when `header` is set (legacy rows). Reading a
  // non-existent `header_type` here would silently drop every image header from the preview.
  const headerType = c.header_format === 'IMAGE' ? 'IMAGE'
    : (c.header_format === 'TEXT' || (!c.header_format && c.header)) ? 'TEXT'
    : 'NONE';
  const btns = Array.isArray(buttons) ? buttons : [];
  const bodyText = render(c.body, 'body');
  const nPh = placeholdersIn(c.body || '').length;

  return (
    <div className="wa-pv">
      <div className="wa-pv-phone">
        {/* chat header — orients the preview as a real conversation, not a floating card */}
        <div className="wa-pv-top" style={{ background: WA.header, color: WA.headerText }}>
          <ArrowLeft size={17} style={{ opacity: .9, flex: '0 0 auto' }} />
          <div className="wa-pv-avatar" />
          <div className="wa-pv-name">
            <span>{senderLabel || 'Legend of Toys'}</span>
          </div>
          <Phone size={15} style={{ opacity: .9, flex: '0 0 auto' }} />
          <MoreVertical size={15} style={{ opacity: .9, flex: '0 0 auto' }} />
        </div>

        <div className="wa-pv-chat" style={{ background: WA.chat }}>
          <div className="wa-pv-bubble" style={{ background: WA.bubble, color: WA.text }}>
            {headerType === 'IMAGE' && (
              c.header_media_url
                ? <img src={c.header_media_url} alt="" className="wa-pv-img" />
                : <div className="wa-pv-img wa-pv-img-empty">Image header</div>
            )}
            {headerType === 'TEXT' && c.header && (
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{render(c.header, 'header')}</div>
            )}
            <div style={{ whiteSpace: 'pre-wrap' }}>
              {bodyText || <span style={{ color: '#999' }}>Body preview…</span>}
            </div>
            {c.footer && <div style={{ color: WA.meta, fontSize: 12, marginTop: 6 }}>{render(c.footer, 'footer')}</div>}
            <div className="wa-pv-time" style={{ color: WA.meta }}>12:56</div>
          </div>

          {btns.length > 0 && (
            <div className="wa-pv-btns">
              {btns.map((b, i) => (
                <div key={i} className="wa-pv-btn" style={{ background: WA.bubble, color: WA.link }}>
                  {b.type === 'URL' && <ExternalLink size={13} />}
                  {b.text || 'Button'}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="wa-pv-input" style={{ background: WA.chat }}>
          <div className="wa-pv-inputbar" style={{ background: WA.inputBg, color: WA.meta }}>
            <Smile size={16} />
            <span style={{ flex: 1, fontSize: 12.5 }}>Type a message</span>
            <Paperclip size={15} />
            <Camera size={15} />
          </div>
        </div>
      </div>

      {showStatus && errs && errs.length > 0 ? (
        <div className="wa-pv-status">
          <div className="kv-k" style={{ marginBottom: 6 }}>
            <Badge label={`${errs.length} to fix before submitting`} tone="yellow" />
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-3)' }}>
            {errs.map((e, i) => <li key={i} style={{ marginBottom: 3 }}>{e}</li>)}
          </ul>
        </div>
      ) : showStatus && (c.body || '').trim() ? (
        <div className="wa-pv-status">
          <Badge label="Ready to submit to Meta" tone="green" />
          <span className="dim" style={{ fontSize: 12, marginLeft: 8 }}>
            {nPh} body placeholder{nPh === 1 ? '' : 's'}
          </span>
        </div>
      ) : null}
    </div>
  );
}
