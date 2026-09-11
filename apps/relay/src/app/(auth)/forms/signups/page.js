'use client';
// One form's sign-ups — /forms/signups?form=<form id> (2026-09-11).
//
// A static sub-route + query param, not /forms/[id]: this app is a static export and cannot build
// a dynamic segment. The id is read once on mount from the real URL — same approach as
// journeys/page.js (?mode=) and campaigns/page.js (?open=), no useSearchParams/Suspense needed.
//
// ⚠️ Customer PII (email, phone). The worker gates it at relay_view, the same as Contacts. There is
// no CSV export here on purpose — that is a decision for Afshaan, not a default.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState, InfoDot, KpiStrip, ChannelChip, Stamp } from '@/components/ui.js';
import { fmtDateShort } from '@/components/format.js';

const PAGE = 100;

const input = {
  width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
  border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--t1)',
};
const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN'));

// Restock-ledger status → badge. `waiting` is the normal state until the product flips back in
// stock AND the journey is active; it is not an error.
const ALERT = {
  alerted:  { label: 'Alerted',  tone: 'green',  title: 'The back-in-stock event fired for this sign-up.' },
  queued:   { label: 'Queued',   tone: 'blue',   title: 'Back in stock — the alert is about to fire.' },
  retrying: { label: 'Retrying', tone: 'orange', title: 'The alert failed at least once and will be retried.' },
  stuck:    { label: 'Stuck',    tone: 'red',    title: 'The alert failed 5 times and is no longer retried.' },
  waiting:  { label: 'Waiting',  tone: 'gray',   title: 'Not back in stock since this sign-up, or the journey is not active yet.' },
};

export default function FormSignupsPage() {
  const { userId } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [formId, setFormId] = useState(null);
  const [data, setData] = useState(null);         // {form, rows, total, limit, offset}
  const [summary, setSummary] = useState(null);   // kept from the offset=0 response while paging
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const firstLoad = useRef(false);

  useEffect(() => {
    try { setFormId(new URLSearchParams(window.location.search).get('form') || ''); } catch { setFormId(''); }
  }, []);

  const load = useCallback(async (id, offset) => {
    const session = await getValidSession();
    if (!session) return;
    setBusy(true);
    setLoadError(null);
    try {
      const r = await garageFetch('getFormSubmissions', { form_id: id, limit: PAGE, offset }, session);
      setData(r);
      if (r?.summary) setSummary(r.summary);
    } catch (e) {
      setLoadError(/not_found|form_id_invalid/.test(e.message || '') ? 'missing' : 'failed');
      showToast(e.message || 'Could not load sign-ups', 'error');
    } finally { setBusy(false); firstLoad.current = true; }
  }, [showToast]);

  // Keyed on userId, NOT session (CORE.md — the session object churns on every tab switch, and
  // a reload here would reset the page the reader is on).
  useEffect(() => { if (userId && formId) load(formId, 0); }, [userId, formId, load]);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((r) => [r.name, r.email, r.phone, r.variant_sku, r.product_code, r.product_title]
      .some((v) => v && String(v).toLowerCase().includes(needle)));
  }, [data, q]);

  const back = <Btn onClick={() => router.push('/forms')}><ArrowLeft size={14} /> Forms</Btn>;

  if (formId === '') {
    return (<><PageHead title="Sign-ups" actions={back} />
      <EmptyState icon="alert" title="No form selected" hint="Open a form from the Forms list." /></>);
  }
  // The spinner is the INITIAL load only — paging keeps the table and the search box mounted.
  if (!data && !loadError && !firstLoad.current) return <Spinner />;
  if (!data) {
    return (<><PageHead title="Sign-ups" actions={back} />
      <EmptyState icon="alert"
        title={loadError === 'missing' ? 'Form not found' : 'Could not load sign-ups'}
        hint={loadError === 'missing' ? 'It may have been removed. Go back to the Forms list.' : 'Refresh to try again.'} /></>);
  }

  const { form, total, offset } = data;
  // `total` is null when the count header could not be read — that is "unknown", not zero, so
  // only a real 0 (or an unknown count with no rows at all) is the empty state.
  const empty = total === 0 || (total == null && !(data.rows || []).length);
  const isBis = form.slug === 'back-in-stock';
  const s = summary || {};
  const cells = [
    { label: 'Total sign-ups', value: num(s.total ?? total), lead: true },
    { label: 'Distinct contacts', value: num(s.distinct_contacts) },
    { label: 'Last 7 days', value: num(s.last_7_days) },
    { label: 'WhatsApp opt-ins', value: num(s.channels ? s.channels.whatsapp : null) },
    ...(isBis ? [{ label: 'Alerted', value: num(s.alerted) }] : []),
  ];
  const perDay = s.per_day || [];
  const maxDay = Math.max(1, ...perDay.map((d) => d.count));
  const pageEnd = Math.min(offset + (data.rows || []).length, total ?? Infinity);
  const th = { padding: '6px 8px' };
  const td = { padding: '8px', verticalAlign: 'top' };

  return (
    <>
      <PageHead
        title={form.name || form.slug}
        sub={<><code>{form.slug}</code> · {form.active ? 'accepting sign-ups' : 'not accepting sign-ups'}</>}
        actions={back}
      />

      {empty ? (
        <Panel title="Sign-ups">
          <EmptyState icon="inbox" title="No sign-ups yet"
            hint={isBis
              ? 'They appear here as soon as a customer submits the form on a sold-out product page — even while the journey is draft.'
              : 'They appear here as soon as someone submits the form.'} />
        </Panel>
      ) : (
        <>
          <div style={{ marginBottom: 14 }}><KpiStrip cells={cells} /></div>
          {s.sampled && (
            <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--t3)' }}>
              Distinct contacts, opt-ins, the daily chart and top products are computed over the newest{' '}
              {num(s.rows_considered)} sign-ups. Total, 7-day and alerted counts are exact.
            </p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: isBis ? 'minmax(0,2fr) minmax(0,1fr)' : '1fr',
                        gap: 14, marginBottom: 14 }}>
            <Panel title="Sign-ups per day" pad info="The last 30 days, by IST calendar day. Hover a bar for the day's count.">
              {!perDay.some((d) => d.count) ? (
                <p style={{ fontSize: 13, color: 'var(--t3)', margin: 0 }}>No sign-ups in the last 30 days.</p>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 70 }}>
                    {perDay.map((d) => (
                      <div key={d.day} title={`${fmtDateShort(d.day)} — ${d.count} sign-up${d.count === 1 ? '' : 's'}`}
                           style={{ flex: 1, minWidth: 3, height: `${Math.max((d.count / maxDay) * 100, d.count ? 4 : 1)}%`,
                                    background: d.count ? 'var(--accent, #6aa9ff)' : 'var(--line)', borderRadius: 2 }} />
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>
                    <span>{fmtDateShort(perDay[0]?.day)}</span><span>Today</span>
                  </div>
                </>
              )}
            </Panel>

            {isBis && (
              <Panel title="Top products" pad
                info="Ranked by sign-ups per Shopify variant SKU, with the LOT product code where sales.sku_map knows it. Early test sign-ups that stored no SKU are counted as 'no SKU'.">
                {!s.top_products?.length ? (
                  <p style={{ fontSize: 13, color: 'var(--t3)', margin: 0 }}>No product SKUs recorded yet.</p>
                ) : (
                  <>
                    {s.top_products.map((p) => (
                      <div key={p.sku} style={{ display: 'flex', justifyContent: 'space-between', gap: 8,
                                                fontSize: 12, color: 'var(--t2)', padding: '3px 0' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.product_code && <b style={{ color: 'var(--t1)' }}>{p.product_code} </b>}
                          <code>{p.sku}</code>
                        </span>
                        <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{p.count}</span>
                      </div>
                    ))}
                    {s.no_sku > 0 && (
                      <div style={{ fontSize: 12, color: 'var(--t3)', padding: '3px 0' }}>No SKU: {s.no_sku}</div>
                    )}
                  </>
                )}
              </Panel>
            )}
          </div>

          <Panel
            title="Sign-ups" count={total}
            info={(
              <>
                <p>Newest first. Times are IST. Name, email and phone are what the customer typed on
                  the form, falling back to their contact profile.</p>
                <p>Search filters the rows on this page only.</p>
              </>
            )}
            action={
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Search size={14} style={{ color: 'var(--t3)' }} />
                <input style={{ ...input, width: 240 }} placeholder="Search name, email, phone or SKU"
                       value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            }
          >
            {!rows.length ? (
              <EmptyState icon="inbox" title="No matches" hint="Nothing on this page matches the search." />
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, opacity: busy ? 0.6 : 1 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--t3)', fontSize: 11, textTransform: 'uppercase' }}>
                    <th style={{ ...th, width: 120 }}>Signed up</th>
                    <th style={th}>Name</th>
                    <th style={th}>Email</th>
                    <th style={th}>Phone</th>
                    {isBis && <th style={th}>Product</th>}
                    <th style={{ ...th, width: 80 }}>Channels</th>
                    {isBis && <th style={{ ...th, width: 90 }}>Alert</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const a = r.alert ? (ALERT[r.alert.status] || ALERT.waiting) : null;
                    const legacy = !r.variant_sku && r.payload?.product_code;
                    return (
                      <tr key={r.id} style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={{ ...td, color: 'var(--t3)' }}><Stamp value={r.submitted_at} /></td>
                        <td style={{ ...td, color: 'var(--t1)' }}>{r.name || <span className="dim">—</span>}</td>
                        <td style={{ ...td, wordBreak: 'break-all' }}>{r.email || <span className="dim">—</span>}</td>
                        <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{r.phone || <span className="dim">—</span>}</td>
                        {isBis && (
                          <td style={td}>
                            {r.product_title && <div style={{ color: 'var(--t1)' }}>{r.product_title}</div>}
                            {r.product_code && <b style={{ color: 'var(--t1)' }}>{r.product_code} </b>}
                            {r.variant_sku ? <code>{r.variant_sku}</code>
                              : legacy ? <span className="dim" title="An early test sign-up that stored a Shopify variant id, not a SKU">
                                  id {String(r.payload.product_code)}</span>
                                : <span className="dim">—</span>}
                          </td>
                        )}
                        <td style={td}>
                          <span style={{ display: 'inline-flex', gap: 4 }}>
                            {(r.channels || []).map((c) => <ChannelChip key={c} channel={c} />)}
                          </span>
                        </td>
                        {isBis && (
                          <td style={td}>
                            <Badge label={a.label} tone={a.tone}
                              title={r.alert.last_error ? `${a.title} Last error: ${r.alert.last_error}` : a.title} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {(total > PAGE || offset > 0) && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8,
                            padding: '10px 8px', fontSize: 12, color: 'var(--t3)' }}>
                <span>{num(offset + 1)}–{num(pageEnd)} of {num(total)}</span>
                <Btn disabled={busy || offset === 0} onClick={() => load(formId, Math.max(0, offset - PAGE))}>
                  <ChevronLeft size={14} /> Newer
                </Btn>
                <Btn disabled={busy || total == null || offset + PAGE >= total} onClick={() => load(formId, offset + PAGE)}>
                  Older <ChevronRight size={14} />
                </Btn>
                <InfoDot label="About paging" side="left" width={260}>
                  <p>{PAGE} sign-ups per page. The tiles and charts above always cover the whole form.</p>
                </InfoDot>
              </div>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
