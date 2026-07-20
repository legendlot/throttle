'use client';
import { Plus, Trash2 } from 'lucide-react';
import { Panel, Badge, Btn } from '@/components/ui.js';
import {
  WA_CATEGORIES, WA_COMPONENTS, WA_LIMITS, WA_WABAS,
  normalizeMetaName, placeholdersIn, previewText, validateWaTemplate,
} from './waTemplate.js';

const BTN_TYPES = ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'];

function Count({ n, cap }) {
  return <span className="dim" style={{ fontSize: 11, color: n > cap ? 'var(--danger,#DE2A2A)' : undefined }}>{n}/{cap}</span>;
}

// The WhatsApp-side authoring surface: Meta template fields + positional-slot mapping
// + a live preview bubble. Pure presentation — the page owns state, save and submit.
export default function WaEditor({ wa, setWa, variables, disabled }) {
  const c = wa || {};
  const mapping = Array.isArray(c.mapping) ? c.mapping : [];
  const tokens = (variables || []).map((v) => v.token).filter(Boolean);
  const errs = validateWaTemplate(c, tokens);

  const set = (k, v) => setWa({ ...c, [k]: v });
  const setMap = (i, k, v) => setWa({ ...c, mapping: mapping.map((m, j) => (j === i ? { ...m, [k]: v } : m)) });
  const addMap = () => {
    const body = mapping.filter((m) => (m.component || 'body') === 'body');
    setWa({ ...c, mapping: [...mapping, { component: 'body', pos: body.length + 1, token: tokens[0] || '', example: '' }] });
  };
  const rmMap = (i) => setWa({ ...c, mapping: mapping.filter((_, j) => j !== i) });

  const buttons = Array.isArray(c.buttons) ? c.buttons : [];
  const setBtn = (i, k, v) => set('buttons', buttons.map((b, j) => (j === i ? { ...b, [k]: v } : b)));
  const addBtn = () => set('buttons', [...buttons, { type: 'QUICK_REPLY', text: '' }]);
  const rmBtn = (i) => set('buttons', buttons.filter((_, j) => j !== i));

  return (
    <>
      <Panel title="WhatsApp template" pad>
        <div className="tw-note" style={{ marginTop: 0, marginBottom: 12 }}>
          WhatsApp templates use Meta&apos;s positional <code>{'{{1}}'}</code> placeholders, not
          our <code>{'{token}'}</code> tags. Write the copy with <code>{'{{1}}'}</code>, <code>{'{{2}}'}</code>…
          then bind each slot to a declared variable below. Meta must approve a template before it can be sent.
        </div>
        <div className="form-grid">
          <div className="ff"><div className="kv-k">Meta template name</div>
            <input className="f-inp mono" value={c.meta_name || ''} disabled={disabled}
              onChange={(e) => set('meta_name', e.target.value)}
              onBlur={(e) => set('meta_name', normalizeMetaName(e.target.value))}
              placeholder="abandoned_cart_v1" />
          </div>
          <div className="ff"><div className="kv-k">Category</div>
            <select className="f-inp" value={c.category || 'MARKETING'} disabled={disabled}
              onChange={(e) => set('category', e.target.value)}>
              {WA_CATEGORIES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
        </div>

        <div className="ff" style={{ marginTop: 14 }}>
          <div className="kv-k">WhatsApp Business Account</div>
          <select className="f-inp" value={c.waba_id || ''} disabled={disabled || !!c.provider_template_id}
            onChange={(e) => set('waba_id', e.target.value)}>
            <option value="">Select an account…</option>
            {WA_WABAS.map((w) => <option key={w.id} value={w.id}>{w.label} — {w.hint}</option>)}
          </select>
          <div className="tw-note" style={{ marginTop: 6 }}>
            Templates live on ONE account and cannot be moved. Author on the account of the number
            that will actually send this message.
          </div>
        </div>

        <div className="ff" style={{ marginTop: 14 }}>
          <div className="kv-k">Header <span className="dim">(optional, text)</span> <Count n={(c.header || '').length} cap={WA_LIMITS.header} /></div>
          <input className="f-inp" value={c.header || ''} onChange={(e) => set('header', e.target.value)}
            disabled={disabled} placeholder="Still thinking it over?" />
        </div>
        <div className="ff" style={{ marginTop: 14 }}>
          <div className="kv-k">Body <Count n={(c.body || '').length} cap={WA_LIMITS.body} /></div>
          <textarea className="f-inp" rows={5} value={c.body || ''} onChange={(e) => set('body', e.target.value)}
            disabled={disabled} placeholder={'Hi {{1}}, your {{2}} is still in your cart.'} />
        </div>
        <div className="ff" style={{ marginTop: 14 }}>
          <div className="kv-k">Footer <span className="dim">(optional, no placeholders)</span> <Count n={(c.footer || '').length} cap={WA_LIMITS.footer} /></div>
          <input className="f-inp" value={c.footer || ''} onChange={(e) => set('footer', e.target.value)}
            disabled={disabled} placeholder="Legend of Toys" />
        </div>
      </Panel>

      <Panel title="Buttons" count={buttons.length}
        action={!disabled ? <Btn onClick={addBtn}><Plus size={14} /> Add button</Btn> : null}>
        {buttons.length === 0
          ? <div style={{ padding: 18, color: 'var(--text-4)', fontSize: 12.5 }}>No buttons.</div>
          : (
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {buttons.map((b, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 1.6fr 32px', gap: 8, alignItems: 'center' }}>
                  <select className="f-inp" value={b.type} onChange={(e) => setBtn(i, 'type', e.target.value)} disabled={disabled}>
                    {BTN_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                  <input className="f-inp" value={b.text || ''} onChange={(e) => setBtn(i, 'text', e.target.value)}
                    disabled={disabled} placeholder="Button text" />
                  {b.type === 'URL'
                    ? <input className="f-inp mono" value={b.url || ''} onChange={(e) => setBtn(i, 'url', e.target.value)}
                        disabled={disabled} placeholder="https://legendoftoys.com/cart" />
                    : b.type === 'PHONE_NUMBER'
                      ? <input className="f-inp mono" value={b.phone_number || ''} onChange={(e) => setBtn(i, 'phone_number', e.target.value)}
                          disabled={disabled} placeholder="+919880212323" />
                      : <span className="dim" style={{ fontSize: 12 }}>Reply arrives as an inbound message.</span>}
                  {!disabled
                    ? <button className="dr-close" onClick={() => rmBtn(i)} title="Remove"><Trash2 size={14} /></button>
                    : <span />}
                </div>
              ))}
            </div>
          )}
      </Panel>

      <Panel title="Placeholder mapping" count={mapping.length}
        action={!disabled ? <Btn onClick={addMap}><Plus size={14} /> Add slot</Btn> : null}>
        <div className="tw-note" style={{ margin: '12px 14px 0' }}>
          Binds each <code>{'{{n}}'}</code> to a declared variable. Meta needs an example value per slot to review the template.
        </div>
        {mapping.length === 0
          ? <div style={{ padding: 18, color: 'var(--text-4)', fontSize: 12.5 }}>No slots. Add one per <code>{'{{n}}'}</code> used above.</div>
          : (
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 1.3fr 1.5fr 32px', gap: 8 }} className="kv-k">
                <span>Component</span><span>Slot</span><span>Variable</span><span>Example</span><span />
              </div>
              {mapping.map((m, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 1.3fr 1.5fr 32px', gap: 8, alignItems: 'center' }}>
                  <select className="f-inp" value={m.component || 'body'} onChange={(e) => setMap(i, 'component', e.target.value)} disabled={disabled}>
                    {WA_COMPONENTS.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                  <input className="f-inp mono" type="number" min={1} value={m.pos ?? 1}
                    onChange={(e) => setMap(i, 'pos', Number(e.target.value))} disabled={disabled} />
                  <select className="f-inp mono" value={m.token || ''} onChange={(e) => setMap(i, 'token', e.target.value)} disabled={disabled}>
                    <option value="">— pick a variable —</option>
                    {tokens.map((x) => <option key={x} value={x}>{`{${x}}`}</option>)}
                  </select>
                  <input className="f-inp" value={m.example || ''} onChange={(e) => setMap(i, 'example', e.target.value)}
                    disabled={disabled} placeholder="Afshaan" />
                  {!disabled
                    ? <button className="dr-close" onClick={() => rmMap(i)} title="Remove"><Trash2 size={14} /></button>
                    : <span />}
                </div>
              ))}
            </div>
          )}
      </Panel>

      <Panel title="Preview" pad>
        <div style={{ background: '#ECE5DD', padding: 20, borderRadius: 8, display: 'flex', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 8, padding: '8px 10px', maxWidth: 380, width: '100%',
            boxShadow: '0 1px 1px rgba(0,0,0,.13)', fontSize: 14, lineHeight: 1.4, color: '#111' }}>
            {c.header && <div style={{ fontWeight: 700, marginBottom: 4 }}>{previewText(c.header, mapping, 'header')}</div>}
            <div style={{ whiteSpace: 'pre-wrap' }}>{previewText(c.body, mapping, 'body') || <span style={{ color: '#999' }}>Body preview…</span>}</div>
            {c.footer && <div style={{ color: '#8696A0', fontSize: 12, marginTop: 6 }}>{c.footer}</div>}
            {buttons.length > 0 && (
              <div style={{ borderTop: '1px solid #E9EDEF', marginTop: 8, paddingTop: 4 }}>
                {buttons.map((b, i) => (
                  <div key={i} style={{ color: '#00A5F4', textAlign: 'center', padding: '6px 0', fontSize: 13.5 }}>{b.text || 'Button'}</div>
                ))}
              </div>
            )}
          </div>
        </div>
        {errs.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="kv-k" style={{ marginBottom: 6 }}><Badge label={`${errs.length} to fix before submitting`} tone="yellow" /></div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-3)' }}>
              {errs.map((e, i) => <li key={i} style={{ marginBottom: 3 }}>{e}</li>)}
            </ul>
          </div>
        )}
        {errs.length === 0 && (c.body || '').trim() && (
          <div style={{ marginTop: 14 }}>
            <Badge label="Ready to submit to Meta" tone="green" />
            <span className="dim" style={{ fontSize: 12, marginLeft: 8 }}>
              {placeholdersIn(c.body).length} body placeholder{placeholdersIn(c.body).length === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </Panel>
    </>
  );
}
