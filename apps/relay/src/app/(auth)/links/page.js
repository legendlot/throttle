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
import { PageHead, Panel, Badge, Btn, EmptyState, FieldLabel, InfoDot, Modal } from '@/components/ui.js';
import { UtmFields } from '@/components/utm.js';
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
          slug: d.slug, target_url: d.target_url, title: d.title || null, utm: d.utm || null,
        }, session);
        showToast('Link created', 'success');
      } else {
        await workerFetch('updateLink', {
          code: d.code, target_url: d.target_url, title: d.title || null, utm: d.utm || null,
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

  // The QR encodes `?s=qr` so a scan is distinguishable from a tap on the same link. Without it the
  // two are IDENTICAL at the server — a QR resolves to the very same URL — and the split can never
  // be recovered afterwards, so it has to be baked into the artwork at generation time.
  //
  // ⚠️ Read as a LABEL only, never as permission to count: the parameter is caller-controllable.
  const qrUrl = (code) => `${fullUrl(code)}?s=qr`;

  async function makeQr(code) {
    try {
      // Dynamic import: qrcode is only needed when someone actually asks for one, and it is not
      // worth putting in the initial bundle of a page that is mostly a table.
      const QR = (await import('qrcode')).default;
      const dataUrl = await QR.toDataURL(qrUrl(code), { width: 1024, margin: 2 });
      setQr({ code, dataUrl });
    } catch (e) { showToast(e.message || 'Could not build the QR code', 'error'); }
  }

  if (!links && !firstLoad.current) return <Spinner />;

  return (
    <>
      <PageHead
        title="Links"
        sub="Short links you name yourself — repoint them any time, including after printing."
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
          display: 'flex', alignItems: 'center', gap: 7,
        }}>
          {/* Kept as a banner, NOT folded into an ⓘ: this is a live blocking state, not documentation.
              Hiding it would let someone print a QR that can never be re-issued. */}
          <strong style={{ color: 'var(--t1)' }}>No short domain configured — do not print any QR yet.</strong>
          <InfoDot label="About the short domain">
            <p>Links can be created and will work, but there is no public host to serve them until{' '}
              <code>link_base_url</code> is set.</p>
            <p>A printed code cannot be re-issued, so printing before the domain is live produces
              artwork that is permanently dead.</p>
          </InfoDot>
        </div>
      )}

      {/* ⚠️ SAY THE SCOPE ON THE PAGE, not only in the source comment above.
          This page lists kind='campaign' links only. Nothing on screen said so, and the page title
          read as "every link you have" — so on 15 Aug a template's per-person link was looked for
          here, not found, and read as "my campaign is not being tracked" on send day, while the
          campaign banner simultaneously (and correctly) said "Tracked per person". Both surfaces
          were right; the gap between them was the whole problem.
          Stated as plain text rather than an ⓘ because the person who needs it is looking for
          something that is ABSENT — they have no reason to open a tooltip about a list they have
          already concluded is wrong. */}
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--t2)',
                  display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span>
          Only links you create here appear in this list. The per-person links a template mints at
          send time are not listed — their clicks roll up on the campaign itself.
        </span>
        <InfoDot label="Why per-person links are not listed">
          <p>There are two kinds of short link, with deliberately opposite rules.</p>
          <p><b>The ones on this page</b> you name yourself. They never expire, the destination stays
            editable, and they are what goes on packaging and print.</p>
          <p><b>Per-person links</b> are minted automatically, one for every recipient, when a
            campaign or journey sends. They run to tens of thousands per send and each one maps to a
            single customer — so listing them here would be unreadable and would put customer
            journeys in an admin table.</p>
          <p>To see how a campaign&rsquo;s links performed, open the campaign: its stats carry
            <b> Clicked</b> and <b>Click rate</b> across everyone who received it.</p>
        </InfoDot>
      </p>

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
          /* An empty list is exactly when someone concludes their campaign is untracked — it is the
             emptiest possible evidence for the wrong conclusion. Repeat the scope here. */
          <EmptyState
            icon="inbox" title="No links yet"
            hint="Create one to get a short URL you can repoint later — useful anywhere the destination might change after the link is out. Empty is normal: a campaign sending per-person links adds nothing to this list."
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
                        // Carry the stored utm into the draft. Omitting it would make an unrelated
                        // edit (a title tweak) silently POST utm:null and wipe the tagging.
                        utm: l.utm || null,
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
              <FieldLabel info={(
                <>
                  <p>Lower-case letters, numbers and hyphens, 2–31 characters.</p>
                  <p><b>Permanent.</b> The short name can never be changed afterwards, because it may
                    end up printed on packaging that is already in customers&rsquo; hands.</p>
                </>
              )}>Short name</FieldLabel>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                <span style={{ color: 'var(--t3)', fontSize: 13 }}>{base || '(no domain yet)'}/r/</span>
                <input style={input} value={editing.slug} autoFocus
                       onChange={(e) => setEditing({ ...editing, slug: e.target.value.toLowerCase() })}
                       placeholder="diwali26" />
              </div>
            </>
          ) : null}

          <FieldLabel info={(
            <>
              <p>Where someone who taps this link ends up. Changeable at any time — that is the
                point of a short link.</p>
              <p>Every change is recorded, and clicks are counted separately for each destination,
                so you can see how many landed where.</p>
            </>
          )}>Destination</FieldLabel>
          <input style={{ ...input, marginBottom: 12 }} value={editing.target_url}
                 onChange={(e) => setEditing({ ...editing, target_url: e.target.value })}
                 placeholder="https://www.legendoftoys.com/products/ghost" />

          <FieldLabel info="For your own reference in this list — never shown to a customer.">Name</FieldLabel>
          <input style={{ ...input, marginBottom: 12 }} value={editing.title}
                 onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                 placeholder="Diwali 2026 catalogue insert" />

          <div style={{ marginBottom: 12 }}>
            <UtmFields scope="link" value={editing.utm || null}
                       onChange={(next) => setEditing({ ...editing, utm: next })} />
          </div>

          {editing.mode === 'edit' && (
            <>
              <FieldLabel info="Recorded against this change in the destination history, so it explains itself months later.">Why (optional)</FieldLabel>
              <input style={{ ...input, marginBottom: 12 }} value={editing.reason}
                     onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
                     placeholder="Campaign moved to the new landing page" />
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 12 }}>
                <input type="checkbox" checked={!!editing.active}
                       onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                Active
                <InfoDot label="About retiring a link">
                  <p>Retiring sends anyone who taps it to the homepage instead of the destination.</p>
                  <p>The link is <b>never deleted</b> — printed copies keep being scanned for years,
                    and a dead code must never show an error page.</p>
                </InfoDot>
              </label>
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
          <p style={{ fontSize: 12, color: 'var(--t3)', textAlign: 'center', margin: '0 0 12px',
                      display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
            <span>{qrUrl(qr.code)}</span>
            <InfoDot label="About the ?s=qr marker">
              <p>The QR encodes <code>?s=qr</code> so a scan can be told apart from someone tapping
                the same link. It lands on the identical destination.</p>
              <p>It has to be in the artwork — once printed, a scan and a tap are otherwise
                indistinguishable and the split can never be recovered.</p>
            </InfoDot>
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

          <div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', marginBottom: 6,
                        display: 'flex', gap: 5, alignItems: 'center' }}>
            Clicks per day
            <InfoDot label="About these numbers">
              <p><b>Counted clicks only.</b> Link previews, crawlers and bots are excluded, so this
                reads lower than raw traffic and is the more honest number.</p>
              <p>Days are IST, matching every other date in LOT. Hover a bar for that day&rsquo;s
                clicks and how many distinct people they came from.</p>
              <p><b>There is no lifetime &ldquo;unique visitors&rdquo; figure, deliberately.</b> Telling
                people apart across days would mean fingerprinting them; we identify a visitor only
                within a single day and store no IP address at all. Adding the daily numbers up
                would count the same person twice, so it is not offered.</p>
            </InfoDot>
          </div>
          {!detail.daily?.length ? (
            <p style={{ fontSize: 13, color: 'var(--t3)', margin: '0 0 14px' }}>No clicks yet.</p>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 70, marginBottom: 14 }}>
              {[...detail.daily].reverse().map((d) => {
                const max = Math.max(...detail.daily.map((x) => x.clicks), 1);
                // Uniques are per-day by construction (the visitor key rotates daily), so they can
                // only ever be shown against a single day — never summed into a lifetime figure.
                const u = (detail.stats?.daily_unique || []).find((x) => x.day === d.day);
                return (
                  <div key={d.day}
                       title={`${fmtDateShort(d.day)} — ${d.clicks} click${d.clicks === 1 ? '' : 's'}`
                              + (u ? ` from ${u.uniques} ${u.uniques === 1 ? 'person' : 'people'}` : '')}
                       style={{ flex: 1, minWidth: 3, height: `${(d.clicks / max) * 100}%`,
                                background: 'var(--accent, #6aa9ff)', borderRadius: 2 }} />
                );
              })}
            </div>
          )}

          {/* ── where the clicks actually went ──────────────────────────────
              The reason the per-click table exists. After a repoint, the totals above cannot say
              which destination a click reached; this can, because each click stores the URL that
              was live when it happened. */}
          {detail.stats?.by_destination?.length > 1 && (
            <>
              <div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', marginBottom: 6,
                            display: 'flex', gap: 5, alignItems: 'center' }}>
                Clicks by destination
                <InfoDot label="About the destination split">
                  <p>Each click records the destination that was live at the moment it happened, so a
                    repoint splits the numbers here rather than blurring them into one total.</p>
                  <p>Only clicks from 6 Aug 2026 onward are split this way — earlier ones predate
                    per-click recording and are counted in the total only.</p>
                </InfoDot>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 14 }}>
                <tbody>
                  {detail.stats.by_destination.map((d) => (
                    <tr key={d.target_url} style={{ borderTop: '1px solid var(--line)' }}>
                      <td style={{ padding: '5px 0', color: 'var(--t2)', wordBreak: 'break-all' }}>{d.target_url}</td>
                      <td style={{ padding: '5px 0', textAlign: 'right', width: 60,
                                   fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{d.clicks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <Breakdowns stats={detail.stats} />

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

// Scan-vs-tap, device, browser, referrer, country — the detail a shortener is expected to have.
//
// Rendered only where there is something to say: an all-'unknown' column is noise, and a single
// row is not a breakdown. Each list is capped — a long tail of one-click referrers pushes the
// useful rows off screen and tells you nothing.
function Breakdowns({ stats }) {
  if (!stats) return null;

  const groups = [
    { key: 'by_source', label: 'Scan vs tap', field: 'source',
      info: 'A QR code encodes ?s=qr, so a scan is distinguishable from someone tapping the same link. Codes printed before 6 Aug 2026 carry no marker and read as unknown.' },
    { key: 'by_device', label: 'Device', field: 'device' },
    { key: 'by_browser', label: 'Browser', field: 'browser' },
    { key: 'by_referrer', label: 'Came from', field: 'referrer_host',
      info: 'The site that linked here. "direct" means no referrer was sent — normal for a QR scan, a messaging app or a typed URL.' },
    { key: 'by_country', label: 'Country', field: 'country' },
  ];

  const shown = groups
    .map((g) => ({ ...g, rows: (stats[g.key] || []).slice(0, 6) }))
    // A breakdown with one row, or one that is entirely 'unknown', is not information.
    .filter((g) => g.rows.length > 1
      || (g.rows.length === 1 && !['unknown', 'direct'].includes(String(g.rows[0][g.field]))));

  if (!shown.length) return null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 14, marginBottom: 14 }}>
      {shown.map((g) => (
        <div key={g.key}>
          <div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', marginBottom: 4,
                        display: 'flex', gap: 5, alignItems: 'center' }}>
            {g.label}
            {g.info && <InfoDot label={`About ${g.label}`}>{g.info}</InfoDot>}
          </div>
          {g.rows.map((r) => (
            <div key={String(r[g.field])}
                 style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12,
                          color: 'var(--t2)', padding: '2px 0' }}>
              <span>{String(r[g.field])}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{r.clicks}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

