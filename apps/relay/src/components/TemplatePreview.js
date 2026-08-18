'use client';
import MsgPreview from '@/components/MsgPreview.js';
import WaPreview from '@/components/wa-editor/WaPreview.js';
// Live template preview + a plain-language value editor.
//
// Why this exists: the only way to fill a template's variables was a raw JSON "Constants" box,
// so testing a template meant knowing both the token names and JSON syntax. That put the test
// out of reach of exactly the person who should be running it. Here the variables are surfaced
// as labelled inputs and the message re-renders as you type, so "does this read right?" is
// answered by looking, not by decoding a rendered string after the fact.
//
// Four channels, three token syntaxes — WhatsApp is positional ({{1}}) because that is what
// Meta stores and `mapping` maps position→token; email and SMS are by name ({token}); RCS is
// bracketed named params ([token], the TrustSignal registration syntax).

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

// The per-recipient tracked-link variable on an sms/rcs template (send.js mintLinkVariable).
// It is FILLED BY THE SEND PATH, so the value editor must not demand a value for it — and a
// value typed into it would actually WIN over the minted link, silently untracking the send.
function mintedLinkParam(template) {
  if (!template || (template.channel !== 'sms' && template.channel !== 'rcs')) return null;
  const c = template.content || {};
  return c.link_param && c.link_target_base ? c.link_param : null;
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
  const linkParam = mintedLinkParam(template);
  const constants = variables.filter((v) => v.source === 'constant');
  const derived = variables.filter((v) => v.source !== 'constant');

  return (
    <div>
      {constants.map((v) => {
        if (v.token === linkParam) {
          return (
            <div key={v.token} style={{ marginBottom: 12 }}>
              <div className="kv-k" style={{ marginBottom: 4 }}>{v.token.replace(/_/g, ' ')}</div>
              <div className="tw-note" style={{ margin: 0 }}>
                Filled automatically — every recipient gets their own tracked short link to{' '}
                <span className="mono">{template.content.link_target_base}</span>. Leave it blank:
                a value typed here would override the tracked link and untrack the whole send.
              </div>
            </div>
          );
        }
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
    // Delegates to the SAME handset mock the template editor uses. This branch used to
    // hand-roll a bare chat bubble on the app's own dark surface: not phone-shaped, and it
    // rendered `header` as text only, so an IMAGE header — which nearly every LOT send
    // carries — appeared nowhere at all. SMS and RCS already went through a framed preview,
    // so WhatsApp was the one channel whose preview did not look like a handset.
    return (
      <div>
        <WaPreview
          wa={c}
          mapping={mapping}
          buttons={Array.isArray(c.buttons) ? c.buttons : []}
          senderLabel="Legend of Toys"
          fill={(text) => fillWa(text, mapping, variables, values)}
          showStatus={false}
        />
        <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
          {c.category || 'UTILITY'} · {c.language || 'en'} · {c.meta_name}
        </div>
      </div>
    );
  }

  if (template.channel === 'sms' || template.channel === 'rcs') {
    const isRcs = template.channel === 'rcs';
    // SMS keeps its DLT-registered body locally; an RCS row is a BINDING — the creative lives
    // at the vendor, so the best local render is the compose draft when one was kept.
    const d = c.draft || {};
    const raw = isRcs ? (d.body || '') : (c.body || '');
    return (
      <MsgPreview
        channel={template.channel}
        sender={isRcs ? 'L.O.T' : (c.header || 'LGNDRC')}
        body={raw}
        variables={variables}
        values={values}
        image={isRcs && (d.type === 'rich_card' || c.rcs_type === 'rich_card')
          ? (d.media_url || '') : null}
        cardTitle={isRcs ? d.card_title : null}
        chips={isRcs && d.btn_text ? [{ label: d.btn_text }] : []}
        emptyNote={isRcs
          ? `The RCS creative is registered at TrustSignal${template.provider_template_id
              ? ` (id ${template.provider_template_id})` : ''} — Relay fills: ${
              (Array.isArray(c.var_params) && c.var_params.length) ? c.var_params.join(', ') : 'no variables'}.`
          : 'No body on this template.'}
        meta={isRcs
          ? `RCS · ${c.rcs_type || 'text_message'} · falls back to SMS if the handset has no RCS`
          : `SMS · DLT ${c.dlt_template_id || 'unregistered'}`}
      />
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
