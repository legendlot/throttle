'use client';
import { InfoDot } from '@/components/ui.js';

// Shared UTM editor. Used by the journey, campaign, template and account-settings surfaces so
// the fields, the precedence copy and the blank-means-inherit behaviour can't drift between them.
//
// Precedence (enforced in commsops `resolveUtm`, mirrored in the hints here):
//   template > journey/campaign > account defaults > auto-derived
//
// A BLANK field means "inherit", never "set to empty" — the worker drops blanks before merging,
// which is what lets a journey set utm_campaign without wiping the auto-derived utm_content.
// Placeholders show what will actually be sent if the field is left alone, so the author can see
// the inherited value rather than guessing.

export const UTM_FIELDS = [
  { key: 'utm_source', label: 'Source', hint: 'Where the traffic came from. Defaults to relay.' },
  { key: 'utm_medium', label: 'Medium', hint: 'Defaults to the send channel (whatsapp / email).' },
  { key: 'utm_campaign', label: 'Campaign', hint: 'The push this belongs to, e.g. diwali_2026.' },
  { key: 'utm_content', label: 'Content', hint: 'Which creative/variant, e.g. hero_a. For A/B reads.' },
  { key: 'utm_term', label: 'Term', hint: 'Optional. Keyword/audience slice.' },
];

// Only marketing sends are tagged — utility/transactional are deliberately left clean so
// attribution isn't polluted by shipping notifications. Surfaced so nobody wonders why their
// order-update journey shows no utm.
// Rendered as an ⓘ rather than a paragraph (S249): it is a standing rule that never
// changes, so it belongs where a reader can ask for it, not above the fields forever.
export function UtmMarketingNote() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 8 }}>
      <span className="dim" style={{ fontSize: 11 }}>Marketing sends only</span>
      <InfoDot label="About link tagging">
        <p>Only <b>marketing</b> sends are tagged.</p>
        <p>Utility and transactional messages — order updates, shipping, OTPs — are deliberately
        left untagged so they do not pollute campaign attribution.</p>
        <p>Links to non-LOT domains (courier tracking, for example) are never rewritten.</p>
      </InfoDot>
    </span>
  );
}

/**
 * value    — the utm object as stored ({utm_campaign: 'x'}), or null
 * onChange — (nextObjectOrNull) => void; emits null once every field is blank
 * auto     — {utm_source: 'relay', ...} the values that apply if left blank (shown as placeholder)
 * scope    — 'template' | 'journey' | 'campaign' | 'account'
 */
export function UtmFields({ value, onChange, auto = {}, disabled = false, scope = 'journey' }) {
  const v = value && typeof value === 'object' ? value : {};

  const set = (key, next) => {
    const merged = { ...v };
    if (String(next || '').trim() === '') delete merged[key];   // blank = inherit, not empty
    else merged[key] = next;
    onChange(Object.keys(merged).length ? merged : null);
  };

  const overrides = Object.keys(v).length;

  return (
    <div>
      <div className="kv-k" style={{ marginBottom: 6 }}>
        Link tracking (UTM){' '}
        {overrides ? <span className="mono" style={{ opacity: 0.7 }}>· {overrides} override{overrides > 1 ? 's' : ''}</span>
                   : <span style={{ opacity: 0.7 }}>· all inherited</span>}
      </div>
      <div className="tw-note" style={{ marginBottom: 10 }}>
        {scope === 'template' && <>Set here, this <b>wins over the journey, campaign and account defaults</b> — use it for which creative this is (Content).</>}
        {scope === 'journey' && <>Applies to every marketing send in this journey. A <b>template</b> can override any field; blank falls back to the account default, then to the journey name.</>}
        {scope === 'campaign' && <>Applies to this broadcast. A <b>template</b> can override any field; blank falls back to the account default, then to the campaign name.</>}
        {scope === 'account' && <>The account-wide floor. Any journey, campaign or template can override these.</>}
        {/* A short link has no template or journey above it — whatever is set here is simply what
            gets appended, so the inheritance copy above would be actively misleading. */}
        {scope === 'link' && <>Appended whenever someone taps this link. Nothing overrides it — a short link sits under no template or journey. <b>Only applied to legendoftoys.com destinations</b>; a link pointing anywhere else is passed through untouched.</>}
        {' '}Leave a field blank to inherit — blank never means empty.
      </div>
      <div className="form-grid">
        {UTM_FIELDS.map((f) => (
          <div className="ff" key={f.key}>
            <div className="kv-k">{f.label}</div>
            <input
              className="f-inp mono"
              value={v[f.key] ?? ''}
              onChange={(e) => set(f.key, e.target.value)}
              placeholder={auto[f.key] ? `auto: ${auto[f.key]}` : '—'}
              disabled={disabled}
              title={f.hint}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
