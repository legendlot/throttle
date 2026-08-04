'use client';
// Links — LOT's own URL shortener, sitting on the Phase-B /r/<code> redirect (S261).
//
// The redirect was built to make WhatsApp button clicks attributable. This page is the other half:
// mint a link by hand, CHANGE WHERE IT POINTS afterwards, and see what got clicked. The driving use
// is printed QR codes — packaging inserts, box labels, catalogue, print ads — where the destination
// has to stay changeable long after the artwork is on paper and cannot be recalled.
//
// ⚠️ This page is scoped to kind='campaign' and must stay that way. The other kind, 'recipient', is
// minted per-message by the send path; each one maps to a single customer's cart or order, they will
// run to millions, and listing them here would be both useless and a privacy surface. They belong on
// the message, not in an admin list.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  Link2, Plus, Search, QrCode, Pencil, ExternalLink, Copy, History, BarChart3, X, Check,
} from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState, FieldLabel } from '@/components/ui.js';
import { fmtDateTime, fmtDateShort } from '@/components/format.js';

// Kept byte-identical to the worker's SLUG_RE (commsops src/links.js). A form that accepts what the
// worker rejects is a form that fails on save with no explanation.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

const input = {
  width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
  border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--t1)',
};

function CopyBtn({ text, showToast }) {
  return (
    <Btn onClick={async () => {
      try { await navigator.clipboard.writeText(text); showToast('Copied', 'success'); }
      catch { showToast('Could not copy — select and copy manually', 'error'); }
    }}><Copy size={13} /> Copy</Btn>
  );
}

export default function LinksPage() {
  const { userId, perms } = useAuth();
  const { showToast } = useToast();
  const [links, setLinks] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState('');
  const [base, setBase] = useState(null);        // comms.settings.link_base_url, or null when unset
  const [editing, setEditing] = useState(null);  // {mode:'create'|'edit', ...draft}
  const [detail, setDetail] = useState(null);    // {link, daily, changes}
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState(null);            // {code, dataUrl}
  // firstLoadDone: the spinner is an INITIAL-load affordance only. A background reload must never
  // unmount a form holding unsaved input (CORE.md, the useAuth session-churn rule).
  const firstLoad = useRef(false);

  const canEdit = !perms || perms.campaign_build;

  const load = useCallback(async (query) => {
    const session = await getValidSession();
    if (!session) return;
    setLoadError(false);
    try {
      const [rows, me] = await Promise.all([
        garageFetch('getLinks', query ? { q: query } : {}, session),
        garageFetch('getRelaySettings', {}, session).catch(() => null),
      ]);
      setLinks(Array.isArray(rows) ? rows : []);
      setBase(me?.link_base_url || null);
    } catch (e) {
      // An empty list and a failed load look identical but mean opposite things — one says
      // "make your first link", the other "we could not read them".
      setLoadError(true);
      setLinks([]);
      showToast(e.message || 'Could not load links', 'error');
    } finally { firstLoad.current = true; }
  }, [showToast]);

  // Keyed on userId, NOT session: onAuthStateChange re-fires on every tab switch and a real token
  // refresh lands ~hourly, so keying on the session object would reload — and blow away an open
  // form — while someone is typing into it.
  useEffect(() => { if (userId) load(''); }, [userId, load]);

  const fullUrl = (code) => (base ? `${base}/r/${code}` : `/r/${code}`);

  async function save() {
    const d = editing;
    if (!d) return;
    if (d.mode === 'create' && !SLUG_RE.test(d.slug || '')) {
      showToast('Short name: 2–31 characters, lower-case letters, numbers and hyphens', 'error');
      return;
    }
    if (!/^https?:\/\//i.test(d.target_url || '')) {
      showToast('Destination must be a full http(s) URL', 'error'); return;
    }
    setBusy(true);
    try {
      const session = await getValidSession();
      if (d.mode === 'create') {
        await workerFetch('createLink', {
          slug: d.slug, target_url: d.target_url, title: d.title || null,
        }, session);
        showToast('Link created', 'success');
      } else {
        await workerFetch('updateLink', {
          code: d.code, target_url: d.target_url, title: d.title || null,
          active: d.active, reason: d.reason || null,
        }, session);
        showToast('Link updated', 'success');
      }
      setEditing(null);
      await load(q);
    } catch (e) {
      // slug_taken comes back as its own error precisely so this can be actionable.
      const msg = /slug_taken/.test(e.message) ? 'That short name is already used'
        : /invalid_target/.test(e.message) ? 'That destination is not a valid URL'
        : e.message || 'Could not save';
      showToast(msg, 'error');
    } finally { setBusy(false); }
  }

  async function openDetail(code) {
    try {
      const session = await getValidSession();
      setDetail(await garageFetch('getLink', { code }, session));
    } catch (e) { showToast(e.message || 'Could not load link', 'error'); }
  }

  async function makeQr(code) {
    try {
      // Dynamic import: qrcode is only needed when someone actually asks for one, and it is not
      // worth putting in the initial bundle of a page that is mostly a table.
      const QR = (await import('qrcode')).default;
      const dataUrl = await QR.toDataURL(fullUrl(code), { width: 1024, margin: 2 });
      setQr({ code, dataUrl });
    } catch (e) { showToast(e.message || 'Could not build the QR code', 'error'); }
  }

  if (!links && !firstLoad.current) return <Spinner />;

  return (
    <>
      <PageHead
        title="Links"
        sub="Short links you own — change where they point at any time, including after they are printed."
        actions={canEdit && (
          <Btn kind="primary" onClick={() => setEditing({ mode: 'create', slug: '', target_url: '', title: '' })}>
            <Plus size={14} /> New link
          </Btn>
        )}
      />

      {/* The base host is the whole feature's off switch. Saying so here is the difference between
          "the shortener is broken" and "the domain is not live yet" when someone tries it. */}
      {!base && (
        <div style={{
          margin: '0 0 14px', padding: '10px 12px', borderRadius: 8, fontSize: 13,
          border: '1px solid var(--line)', background: 'var(--surface-2, var(--surface))', color: 'var(--t2)',
        }}>
          <strong style={{ color: 'var(--t1)' }}>No short domain is configured yet.</strong>{' '}
          Links can be created and will work, but there is no public host to put them on until
          <code style={{ margin: '0 4px' }}>link_base_url</code> is set. Do not print a QR code before then —
          a printed code cannot be re-issued.
        </div>
      )}

      <Panel
        title="Short links" count={links?.length}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Search size={14} style={{ color: 'var(--t3)' }} />
            <input
              style={{ ...input, width: 220 }} placeholder="Search name, code or destination"
              value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(q); }}
            />
          </div>
        }
      >
        {loadError ? (
          <EmptyState icon="alert" title="Could not load links" hint="Refresh to try again." />
        ) : !links?.length ? (
          <EmptyState
            icon="inbox" title="No links yet"
            hint="Create one to get a short URL you can repoint later — useful anywhere the destination might change after the link is out."
          />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--t3)', fontSize: 11, textTransform: 'uppercase' }}>
                <th style={{ padding: '6px 8px' }}>Short link</th>
                <th style={{ padding: '6px 8px' }}>Destination</th>
                <th style={{ padding: '6px 8px', width: 80 }}>Clicks</th>
                <th style={{ padding: '6px 8px', width: 130 }}>Last click</th>
                <th style={{ padding: '6px 8px', width: 230 }} />
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.code} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '8px' }}>
                    <div style={{ fontWeight: 600, color: 'var(--t1)' }}>
                      /r/{l.code} {!l.active && <Badge label="Retired" tone="gray" />}
                    </div>
                    {l.title && <div style={{ color: 'var(--t3)', fontSize: 12 }}>{l.title}</div>}
                  </td>
                  <td style={{ padding: '8px', maxWidth: 320 }}>
                    <a href={l.target_url} target="_blank" rel="noreferrer"
                       style={{ color: 'var(--t2)', display: 'inline-flex', gap: 4, alignItems: 'center',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>
                      {l.target_url} <ExternalLink size={11} />
                    </a>
                  </td>
                  <td style={{ padding: '8px', fontVariantNumeric: 'tabular-nums' }}>{l.click_count ?? 0}</td>
                  <td style={{ padding: '8px', color: 'var(--t3)' }}>
                    {l.last_clicked_at ? fmtDateTime(l.last_clicked_at) : '—'}
                  </td>
                  <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <CopyBtn text={fullUrl(l.code)} showToast={showToast} />{' '}
                    <Btn onClick={() => makeQr(l.code)}><QrCode size={13} /> QR</Btn>{' '}
                    <Btn onClick={() => openDetail(l.code)}><BarChart3 size={13} /> Stats</Btn>{' '}
                    {canEdit && (
                      <Btn onClick={() => setEditing({
                        mode: 'edit', code: l.code, target_url: l.target_url,
                        title: l.title || '', active: l.active, reason: '',
                      })}><Pencil size={13} /></Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {/* ── create / edit ─────────────────────────────────────────────────── */}
      {editing && (
        <Modal onClose={() => setEditing(null)}
               title={editing.mode === 'create' ? 'New link' : `Edit /r/${editing.code}`}>
          {editing.mode === 'create' ? (
            <>
              <FieldLabel hint="Lower-case letters, numbers and hyphens. This is permanent — it may end up printed.">Short name</FieldLabel>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                <span style={{ color: 'var(--t3)', fontSize: 13 }}>{base || '(no domain yet)'}/r/</span>
                <input style={input} value={editing.slug} autoFocus
                       onChange={(e) => setEditing({ ...editing, slug: e.target.value.toLowerCase() })}
                       placeholder="diwali26" />
              </div>
            </>
          ) : (
            <p style={{ fontSize: 12, color: 'var(--t3)', margin: '0 0 12px' }}>
              The short name can never change — it may already be printed. You can change where it
              goes, and every change is recorded.
            </p>
          )}

          <FieldLabel hint="Where someone who taps this link ends up. Changeable at any time.">Destination</FieldLabel>
          <input style={{ ...input, marginBottom: 12 }} value={editing.target_url}
                 onChange={(e) => setEditing({ ...editing, target_url: e.target.value })}
                 placeholder="https://www.legendoftoys.com/products/ghost" />

          <FieldLabel hint="For your own reference — never shown to a customer.">Name</FieldLabel>
          <input style={{ ...input, marginBottom: 12 }} value={editing.title}
                 onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                 placeholder="Diwali 2026 catalogue insert" />

          {editing.mode === 'edit' && (
            <>
              <FieldLabel hint="Recorded against this change so the history explains itself later.">Why (optional)</FieldLabel>
              <input style={{ ...input, marginBottom: 12 }} value={editing.reason}
                     onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
                     placeholder="Campaign moved to the new landing page" />
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 4 }}>
                <input type="checkbox" checked={!!editing.active}
                       onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                Active
              </label>
              <p style={{ fontSize: 12, color: 'var(--t3)', margin: '0 0 12px' }}>
                Retiring sends anyone who taps it to the homepage instead. The link is never deleted —
                printed copies keep getting scanned for years.
              </p>
            </>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn onClick={() => setEditing(null)}>Cancel</Btn>
            <Btn kind="primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : <><Check size={14} /> Save</>}
            </Btn>
          </div>
        </Modal>
      )}

      {/* ── QR ────────────────────────────────────────────────────────────── */}
      {qr && (
        <Modal onClose={() => setQr(null)} title={`QR — /r/${qr.code}`}>
          <img src={qr.dataUrl} alt="" style={{ width: '100%', maxWidth: 320, display: 'block', margin: '0 auto 12px' }} />
          <p style={{ fontSize: 12, color: 'var(--t3)', textAlign: 'center', margin: '0 0 12px' }}>
            {fullUrl(qr.code)}
            {!base && <><br /><strong>No short domain is set — do not print this yet.</strong></>}
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <a href={qr.dataUrl} download={`lot-qr-${qr.code}.png`}>
              <Btn kind="primary">Download PNG</Btn>
            </a>
          </div>
        </Modal>
      )}

      {/* ── stats + history ───────────────────────────────────────────────── */}
      {detail && (
        <Modal onClose={() => setDetail(null)} title={`/r/${detail.link.code}`}>
          <div style={{ display: 'flex', gap: 20, marginBottom: 14, fontSize: 13 }}>
            <div><div style={{ color: 'var(--t3)', fontSize: 11 }}>TOTAL CLICKS</div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>{detail.link.click_count ?? 0}</div></div>
            <div><div style={{ color: 'var(--t3)', fontSize: 11 }}>FIRST</div>
              <div>{detail.link.first_clicked_at ? fmtDateTime(detail.link.first_clicked_at) : '—'}</div></div>
            <div><div style={{ color: 'var(--t3)', fontSize: 11 }}>LAST</div>
              <div>{detail.link.last_clicked_at ? fmtDateTime(detail.link.last_clicked_at) : '—'}</div></div>
          </div>

          <p style={{ fontSize: 12, color: 'var(--t3)', margin: '0 0 12px' }}>
            Counted clicks only — link previews, crawlers and bots are excluded, so this reads lower
            than raw traffic and is the more honest number.
          </p>

          <div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', marginBottom: 6 }}>
            Clicks per day
          </div>
          {!detail.daily?.length ? (
            <p style={{ fontSize: 13, color: 'var(--t3)', margin: '0 0 14px' }}>No clicks yet.</p>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 70, marginBottom: 14 }}>
              {[...detail.daily].reverse().map((d) => {
                const max = Math.max(...detail.daily.map((x) => x.clicks), 1);
                return (
                  <div key={d.day} title={`${fmtDateShort(d.day)} — ${d.clicks}`}
                       style={{ flex: 1, minWidth: 3, height: `${(d.clicks / max) * 100}%`,
                                background: 'var(--accent, #6aa9ff)', borderRadius: 2 }} />
                );
              })}
            </div>
          )}

          <div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', marginBottom: 6,
                        display: 'flex', gap: 5, alignItems: 'center' }}>
            <History size={12} /> Destination history
          </div>
          {!detail.changes?.length ? (
            <p style={{ fontSize: 13, color: 'var(--t3)', margin: 0 }}>Never changed.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: 'var(--t2)' }}>
              {detail.changes.map((c) => (
                <li key={c.id} style={{ marginBottom: 6 }}>
                  <span style={{ color: 'var(--t3)' }}>{fmtDateTime(c.changed_at)}</span> — now{' '}
                  <code>{c.new_target_url}</code>
                  {c.old_target_url && <> (was <code>{c.old_target_url}</code>)</>}
                  {c.reason && <div style={{ color: 'var(--t3)' }}>{c.reason}</div>}
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </>
  );
}

function Modal({ title, children, onClose }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12,
        padding: 18, width: '100%', maxWidth: 520, maxHeight: '85vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15, color: 'var(--t1)' }}>{title}</h3>
          <button onClick={onClose} aria-label="Close"
                  style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--t3)' }}>
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
