'use client';
// Live template preview + a plain-language value editor.
//
// Why this exists: the only way to fill a template's variables was a raw JSON "Constants" box,
// so testing a template meant knowing both the token names and JSON syntax. That put the test
// out of reach of exactly the person who should be running it. Here the variables are surfaced
// as labelled inputs and the message re-renders as you type, so "does this read right?" is
// answered by looking, not by decoding a rendered string after the fact.
//
// Two channels, two token syntaxes — WhatsApp is positional ({{1}}) because that is what Meta
// stores and `mapping` maps position→token; email is by name ({token}).

// A variable's value, in the same precedence the send path uses, so the preview does not
// flatter the real thing: explicit value → fallback (profile vars) → Meta's example → unfilled.
export function resolveValue(v, mapping, values) {
  const explicit = values?.[v.token];
  if (explicit != null && String(explicit).trim() !== '') return { text: String(explicit), state: 'filled' };
  if (v.fallback) return { text: v.fallback, state: 'fallback' };
  const ex = (mapping || []).find((m) => m.token === v.token)?.example;
  if (ex) return { text: ex, state: 'example' };
  return { text: `{${v.token}}`, state: 'missing' };
}

// Substitute a WhatsApp body/header/footer. Meta stores positional {{1}}; `mapping` says which
// token each position carries.
function fillWa(text, mapping, variables, values) {
  return String(text || '').replace(/\{\{(\d+)\}\}/g, (whole, pos) => {
    const m = (mapping || []).find((x) => String(x.pos) === String(pos));
    if (!m) return whole;
    const v = (variables || []).find((x) => x.token === m.token) || { token: m.token };
    return resolveValue(v, mapping, values).text;
  });
}

function fillEmail(text, variables, values, mapping) {
  return String(text || '').replace(/\{(\w+)\}/g, (whole, token) => {
    const v = (variables || []).find((x) => x.token === token);
    if (!v) return whole;
    return resolveValue(v, mapping, values).text;
  });
}

/* ---- the value editor -------------------------------------------------- */
// Only `constant` variables need a human. Profile/event ones resolve per-recipient at send time,
// so showing them as inputs would imply a control that does not exist — they are shown as
// read-only context instead, which is also how you discover a template needs contact data.
export function TemplateValues({ template, values, onChange, disabled }) {
  const variables = template?.variables || [];
  const mapping = template?.content?.mapping || [];
  if (!variables.length) {
    return <div className="dim" style={{ fontSize: 13 }}>This template has no variables — nothing to fill in.</div>;
  }
  const constants = variables.filter((v) => v.source === 'constant');
  const derived = variables.filter((v) => v.source !== 'constant');

  return (
    <div>
      {constants.map((v) => {
        const ex = mapping.find((m) => m.token === v.token)?.example;
        const val = values?.[v.token] ?? '';
        return (
          <div key={v.token} style={{ marginBottom: 12 }}>
            <div className="kv-k" style={{ marginBottom: 4 }}>{v.token.replace(/_/g, ' ')}</div>
            <input className="f-inp" value={val} disabled={disabled}
              placeholder={ex ? `e.g. ${ex}` : ''}
              onChange={(e) => onChange({ ...(values || {}), [v.token]: e.target.value })} />
            {!String(val).trim() && (
              <div style={{ fontSize: 11, color: 'var(--warn-fg, #b26a00)', marginTop: 3 }}>
                Needs a value — the send will fail without it.
              </div>
            )}
          </div>
        );
      })}
      {derived.length > 0 && (
        <div className="tw-note" style={{ marginTop: 4, marginBottom: 0 }}>
          Filled automatically per recipient:{' '}
          {derived.map((v, i) => (
            <span key={v.token}>
              {i > 0 && ', '}
              <strong>{v.token.replace(/_/g, ' ')}</strong>
              <span className="dim"> (from the {v.source}{v.fallback ? `, else “${v.fallback}”` : ''})</span>
            </span>
          ))}.
        </div>
      )}
    </div>
  );
}

/* ---- the preview ------------------------------------------------------- */
export function TemplatePreview({ template, values }) {
  if (!template) {
    return <div className="dim" style={{ fontSize: 13 }}>Pick a template to preview it.</div>;
  }
  const c = template.content || {};
  const variables = template.variables || [];
  const mapping = c.mapping || [];

  if (template.channel === 'whatsapp') {
    const header = c.header ? fillWa(c.header, mapping, variables, values) : '';
    const body = fillWa(c.body, mapping, variables, values);
    const footer = c.footer ? fillWa(c.footer, mapping, variables, values) : '';
    const buttons = Array.isArray(c.buttons) ? c.buttons : [];
    return (
      <div>
        {/* Deliberately shaped like a chat bubble: the question being answered is "how will this
            look on a handset", and a bare block of text does not answer it. */}
        <div style={{
          background: 'var(--surface-2, #f2f5f4)', borderRadius: 10, padding: '10px 12px',
          maxWidth: 420, borderTopLeftRadius: 2, whiteSpace: 'pre-wrap',
          fontSize: 13, lineHeight: 1.5, color: 'var(--t1, #111)',
        }}>
          {header && <div style={{ fontWeight: 700, marginBottom: 6 }}>{header}</div>}
          <div>{body}</div>
          {footer && <div style={{ fontSize: 11, opacity: .6, marginTop: 8 }}>{footer}</div>}
          {buttons.length > 0 && (
            <div style={{ marginTop: 10, borderTop: '1px solid rgba(0,0,0,.12)', paddingTop: 6 }}>
              {buttons.map((b, i) => (
                <div key={i} style={{ textAlign: 'center', color: '#1a73e8', fontSize: 13, padding: '5px 0' }}>
                  {b.text || '(button)'}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
          {c.category || 'UTILITY'} · {c.language || 'en'} · {c.meta_name}
        </div>
      </div>
    );
  }

  const subject = fillEmail(c.subject, variables, values, mapping);
  const text = fillEmail(c.text_body || '', variables, values, mapping);
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>{subject || '(no subject)'}</div>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5 }}>
        {text || <span className="dim">This template is HTML-only — open it in Templates to see the full design.</span>}
      </div>
    </div>
  );
}
