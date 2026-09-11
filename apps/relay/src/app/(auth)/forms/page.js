'use client';
// Forms — which /f/* capture forms exist, whether they are taking sign-ups, and how many (2026-09-11).
//
// The back-in-stock form went onto the storefront while its journey stayed DRAFT, and until this
// page the only way to see who was signing up was SQL. Click through (Open) for one form's
// sign-ups — /forms/signups?form=<id>, a static sub-route, because this app is a static export
// and cannot build a dynamic [id] route.
//
// No date picker, deliberately: the house rule is that a range picker defaults to Today, which on
// a form with a handful of sign-ups a week would show an empty page. All-time + 7/30-day columns.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { ChevronRight } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState, InfoDot, Stamp } from '@/components/ui.js';

// null = the count could not be read (worker returns null, never a fake 0).
const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN'));

export default function FormsPage() {
  const { userId } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [forms, setForms] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const firstLoad = useRef(false);

  const load = useCallback(async () => {
    const session = await getValidSession();
    if (!session) return;
    setLoadError(false);
    try {
      const r = await garageFetch('listForms', {}, session);
      setForms(Array.isArray(r?.forms) ? r.forms : []);
    } catch (e) {
      // An empty list and a failed load look identical but mean opposite things.
      setLoadError(true);
      setForms([]);
      showToast(e.message || 'Could not load forms', 'error');
    } finally { firstLoad.current = true; }
  }, [showToast]);

  // Keyed on userId, NOT session (CORE.md — the session object churns on every tab switch).
  useEffect(() => { if (userId) load(); }, [userId, load]);

  if (!forms && !firstLoad.current) return <Spinner />;

  const th = { padding: '6px 8px' };
  const td = { padding: '8px', fontVariantNumeric: 'tabular-nums' };

  return (
    <>
      <PageHead title="Forms" sub="Sign-up forms embedded on the storefront, and who is signing up through them." />

      <Panel
        title="Forms" count={forms?.length}
        info={(
          <>
            <p><b>Active</b> means the form accepts sign-ups. It is <b>not</b> a sending switch —
              whether anyone is messaged is decided by the journey that listens for the form.</p>
            <p>Counts are all-time, with rolling 7- and 30-day windows. <b>—</b> means the count
              could not be read, not zero.</p>
          </>
        )}
      >
        {loadError ? (
          <EmptyState icon="alert" title="Could not load forms" hint="Refresh to try again." />
        ) : !forms?.length ? (
          <EmptyState icon="inbox" title="No forms yet" hint="A form appears here once it exists in comms.forms." />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--t3)', fontSize: 11, textTransform: 'uppercase' }}>
                <th style={th}>Form</th>
                <th style={{ ...th, width: 80 }}>Kind</th>
                <th style={{ ...th, width: 80 }}>Total</th>
                <th style={{ ...th, width: 80 }}>7 days</th>
                <th style={{ ...th, width: 80 }}>30 days</th>
                <th style={{ ...th, width: 130 }}>Last sign-up</th>
                <th style={{ ...th, width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => {
                const c = f.counts || {};
                const open = () => router.push(`/forms/signups?form=${encodeURIComponent(f.id)}`);
                return (
                  <tr key={f.id} style={{ borderTop: '1px solid var(--line)' }}>
                    <td style={{ padding: '8px' }}>
                      <div style={{ fontWeight: 600, color: 'var(--t1)', display: 'flex', gap: 6, alignItems: 'center' }}>
                        {f.name || f.slug}
                        {f.active
                          ? <Badge label="Active" tone="green" dot />
                          : <Badge label="Inactive" tone="gray" title="Not accepting sign-ups" />}
                      </div>
                      <div style={{ color: 'var(--t3)', fontSize: 12 }}><code>{f.slug}</code></div>
                      {f.slug === 'back-in-stock' && (
                        <div style={{ color: 'var(--t3)', fontSize: 12, marginTop: 3,
                                      display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span>Embedded on sold-out product pages via <code>data-lot-form=&quot;back-in-stock&quot;</code>.
                            Sign-ups record even while its journey is draft.</span>
                          <InfoDot label="About the back-in-stock journey">
                            <p>The form and the alert are separate. The form only <b>records</b> the
                              sign-up; the customer is messaged when the product flips back in stock
                              <b> and</b> the back-in-stock journey is active.</p>
                            <p>While the journey is draft, no alert is sent and none is used up — each
                              sign-up waits and is still eligible once the journey is switched on.</p>
                          </InfoDot>
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, color: 'var(--t2)' }}>{f.kind}</td>
                    <td style={{ ...td, fontWeight: 600 }}>{num(c.total)}</td>
                    <td style={td}>{num(c.last_7_days)}</td>
                    <td style={td}>{num(c.last_30_days)}</td>
                    <td style={{ padding: '8px', color: 'var(--t3)' }}><Stamp value={c.last_submitted_at} /></td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>
                      <Btn onClick={open}>Open <ChevronRight size={14} /></Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
