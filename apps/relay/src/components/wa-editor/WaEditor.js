'use client';
import { useRef, useState } from 'react';
import { Plus, Trash2, Upload, X } from 'lucide-react';
import { supabase, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import { Panel, Badge, Btn } from '@/components/ui.js';
import {
  WA_CATEGORIES, WA_COMPONENTS, WA_LIMITS, WA_WABAS,
  normalizeMetaName, placeholdersIn, previewText, validateWaTemplate,
} from './waTemplate.js';

const BTN_TYPES = ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'];
const HEADER_TYPES = [
  { value: 'NONE', label: 'None' },
  { value: 'TEXT', label: 'Text' },
  { value: 'IMAGE', label: 'Image' },
];
// Self-serve image headers reuse the email-editor's exact upload mechanic (EmailEditor.js
// uploadAsset): sign a URL into the public relay-email-assets bucket, PUT via the
// storage-js signed-upload helper, get back a public URL. Same bucket + same 5MB/mime
// limits enforced worker- and bucket-side (email-assets.js validateAsset).
const ASSET_BUCKET = 'relay-email-assets';
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const ACCEPT_MIME = 'image/png,image/jpeg,image/gif,image/webp';

async function uploadHeaderImage(file, session) {
  if (!file.type || !file.type.startsWith('image/')) throw new Error('not an image');
  if (file.size > MAX_ASSET_BYTES) throw new Error('image too large (max 5MB)');
  const r = await workerFetch('createEmailAssetUploadUrl', { file_name: file.name, mime_type: file.type }, session);
  const d = r?.data;
  if (!d?.token || !d?.storage_path) throw new Error(r?.error || 'sign failed');
  const up = await supabase.storage.from(ASSET_BUCKET).uploadToSignedUrl(d.storage_path, d.token, file);
  if (up.error) throw up.error;
  return d.public_url;
}

function Count({ n, cap }) {
  return <span className="dim" style={{ fontSize: 11, color: n > cap ? 'var(--danger,#DE2A2A)' : undefined }}>{n}/{cap}</span>;
}

// The WhatsApp-side authoring surface: Meta template fields + positional-slot mapping
// + a live preview bubble. Pure presentation — the page owns state, save and submit.
export default function WaEditor({ wa, setWa, variables, disabled, locked, session, wabas }) {
  const c = wa || {};
  const mapping = Array.isArray(c.mapping) ? c.mapping : [];
  const tokens = (variables || []).map((v) => v.token).filter(Boolean);
  const errs = validateWaTemplate(c, tokens);
  const { showToast } = useToast();
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const set = (k, v) => setWa({ ...c, [k]: v });

  // A media header carries NO text (Meta's rule) — the three states are mutually exclusive
  // in the UI, though `header_format` is what's actually load-bearing on the wire. Absent
  // `header_format` defaults to TEXT (see wa-templates.js), so a legacy row that only ever
  // set `header` still shows as Text here.
  const headerType = c.header_format === 'IMAGE' ? 'IMAGE'
    : (c.header_format === 'TEXT' || (!c.header_format && c.header)) ? 'TEXT'
    : 'NONE';

  // `header_format`/`header_media_url` are worker-preserved-on-omission (saveTemplate merges
  // them back in when the UI sends null/undefined — review C4/M8), so an intentional CLEAR
  // must send a non-null value the merge won't second-guess: 'TEXT' (functionally "no header"
  // once `header` is also emptied) rather than undefined. `header_handle` is worker-owned and
  // never authored here — but a NEW or REMOVED asset invalidates whatever handle Meta minted
  // for the old one, so we explicitly blank it (never fabricate a real value) to force submit
  // to re-upload rather than silently reusing a stale sample image.
  function setHeaderType(type) {
    if (type === 'NONE') setWa({ ...c, header_format: 'TEXT', header: '', header_media_url: '', header_handle: '' });
    else if (type === 'TEXT') setWa({ ...c, header_format: 'TEXT', header_media_url: '', header_handle: '' });
    else if (type === 'IMAGE') setWa({ ...c, header_format: 'IMAGE', header: '' });
  }

  async function onPickImage(e) {
    const file = e.target.files?.[0];
    e.target.value = '';   // allow re-picking the same filename
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadHeaderImage(file, session);
      setWa({ ...c, header_format: 'IMAGE', header: '', header_media_url: url, header_handle: '' });
      showToast('Header image uploaded', 'success');
    } catch (err) {
      showToast('Upload failed: ' + (err?.message || err), 'error');
    } finally { setUploading(false); }
  }

  function removeImage() { setWa({ ...c, header_media_url: '', header_handle: '' }); }
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
          <select className="f-inp" value={c.waba_id || ''} disabled={disabled || !!locked}
            onChange={(e) => set('waba_id', e.target.value)}>
            <option value="">Select an account…</option>
            {(wabas && wabas.length ? wabas : WA_WABAS).map((w) => <option key={w.id} value={w.id}>{w.label} — {w.hint}</option>)}
          </select>
          <div className="tw-note" style={{ marginTop: 6 }}>
            Templates live on ONE account and cannot be moved. Author on the account of the number
            that will actually send this message.
          </div>
        </div>

        <div className="ff" style={{ marginTop: 14 }}>
          <div className="kv-k">
            Header <span className="dim">(optional)</span>
            {headerType === 'TEXT' && <Count n={(c.header || '').length} cap={WA_LIMITS.header} />}
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: headerType === 'NONE' ? 0 : 8 }}>
            {HEADER_TYPES.map((h) => (
              <Btn key={h.value} kind={headerType === h.value ? 'primary' : 'ghost'}
                onClick={() => setHeaderType(h.value)} disabled={disabled}>{h.label}</Btn>
            ))}
          </div>
          {headerType === 'TEXT' && (
            <input className="f-inp" value={c.header || ''} onChange={(e) => set('header', e.target.value)}
              disabled={disabled} placeholder="Still thinking it over?" />
          )}
          {headerType === 'IMAGE' && (
            <div>
              {c.header_media_url ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <img src={c.header_media_url} alt="Header preview"
                    style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border,#e5e5e5)', flexShrink: 0 }} />
                  <div className="mono dim" style={{ flex: 1, minWidth: 0, fontSize: 11, wordBreak: 'break-all' }}>{c.header_media_url}</div>
                  {!disabled && (
                    <>
                      <Btn onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading}>
                        <Upload size={14} /> {uploading ? 'Uploading…' : 'Replace'}
                      </Btn>
                      <Btn onClick={removeImage} disabled={uploading}><X size={14} /> Remove</Btn>
                    </>
                  )}
                </div>
              ) : (
                !disabled && (
                  <Btn onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading}>
                    <Upload size={14} /> {uploading ? 'Uploading…' : 'Upload image'}
                  </Btn>
                )
              )}
              <input ref={fileRef} type="file" accept={ACCEPT_MIME} style={{ display: 'none' }} onChange={onPickImage} />
              <div className="tw-note" style={{ marginTop: 6 }}>
                PNG/JPEG/GIF/WebP, max 5MB. Meta reviews this exact image as the template&apos;s sample header.
              </div>
            </div>
          )}
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

    </>
  );
}

// The preview moved OUT of this component (2026-07-28) so the page can pin it beside the form
// — see WaPreview.js. This derives exactly what the preview needs from the same `wa` object,
// so the page doesn't have to duplicate WaEditor's normalisation (mapping/buttons/validation
// drifting between the editor and the preview is the bug this avoids).
export function waPreviewProps(wa, variables) {
  const c = wa || {};
  // validateWaTemplate takes TOKEN STRINGS, not variable rows — passing the rows makes every
  // placeholder read as unbound and the preview would cry "fix before submitting" on a valid
  // template. Mirrors the derivation above exactly.
  const tokens = (variables || []).map((v) => v.token).filter(Boolean);
  return {
    wa: c,
    mapping: Array.isArray(c.mapping) ? c.mapping : [],
    buttons: Array.isArray(c.buttons) ? c.buttons : [],
    errs: validateWaTemplate(c, tokens),
  };
}
