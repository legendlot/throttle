'use client';
/* ════════════════════════════════════════════════════════════
   Meta diagnostics — why did Instagram/Messenger refuse a reply?

   Exists because a refused Meta send used to be undiagnosable after the fact.
   S314 made csops PERSIST the refusal (`cs_wa_messages.status='failed'` +
   `status_error`) and shipped `diagIgRecipient`, a read-only probe — but the
   probe had no caller anywhere in this app, so running it needed a hand-typed
   thread UUID and an admin token. That is why the 2026-08-26 "code 200" report
   went a day without an answer.

   This page is the missing half: the failures as a worklist, and Diagnose on
   the row itself. It SENDS NOTHING — the probe is two GETs against the same
   token and host the real send uses.

   ⚠️ The raw Meta error is rendered VERBATIM and is deliberately not
   prettified into an explanation. The one time an unread Meta error was
   paraphrased from documentation instead of measured, the copy told agents a
   send would work while it was silently failing (S262/S263). Read what Meta
   said; do not write what it probably meant.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner } from '@throttle/ui';
import { AlertTriangle, RefreshCw, Stethoscope } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../../lib/csopsFetch.js';

/* Meta error codes we have actually OBSERVED on this estate, with what each one
   is known to mean here. Anything unlisted renders as "not yet characterised"
   rather than being guessed at — an unknown code is a question, not an answer. */
const KNOWN_CODES = {
  10:  { label: 'Outside 24h — Human Agent unapproved', tone: 'amber',
         note: 'Documented and expected. The window had shut; HUMAN_AGENT is pending Meta review. Not a defect.' },
  100: { label: 'Invalid parameter', tone: 'amber',
         note: 'Usually the 2,000-character reply cap. The composer now caps per channel; a hit here means the cap was bypassed.' },
  190: { label: 'Token expired / revoked', tone: 'red',
         note: 'Account-wide, not per chat. Since S311 the IG token self-refreshes; a 190 means the refresh chain broke.' },
  200: { label: 'Permissions error — recipient-side', tone: 'red',
         note: 'NOT the 24h block and NOT the token: it lands while the window is open and other chats send fine. Cause is per-recipient and has never been characterised. This is the row to Diagnose.' },
};

function codeInfo(code) {
  return KNOWN_CODES[code] || { label: 'Not yet characterised', tone: 'slate', note: null };
}

const TONE = {
  red:   { bg: 'rgba(220,38,38,0.10)',  bd: '#dc2626', fg: '#f87171' },
  amber: { bg: 'rgba(217,164,65,0.10)', bd: '#d9a441', fg: '#d9a441' },
  slate: { bg: 'rgba(100,116,139,0.10)', bd: '#64748b', fg: '#94a3b8' },
};

function fmt(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  } catch { return String(ts); }
}

export default function MetaDiagnosticsPage() {
  const { perms, session } = useAuth();
  const [failures, setFailures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [firstLoadDone, setFirstLoadDone] = useState(false);
  const [error, setError] = useState(null);
  const [days, setDays] = useState(14);
  const [probingId, setProbingId] = useState(null);
  const [probe, setProbe] = useState(null);          // { thread_id, result } | { thread_id, error }
  const [manualId, setManualId] = useState('');

  const load = useCallback(async (d) => {
    try {
      const r = await csopsGet('getMetaSendFailures', { days: String(d) }, session);
      setFailures(r?.failures || []);
      // A degraded enrichment still lists the refusals, but the rows will say "(unknown)"
      // instead of a handle — say why, rather than letting it read as missing data.
      setError(r?.enrichment_error
        ? `Customer details could not be loaded, so rows show as (unknown). The refusals below are still accurate. ${r.enrichment_error}`
        : null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); setFirstLoadDone(true); }
  }, [session]);

  useEffect(() => { if (session) load(days); }, [session, days, load]);

  async function diagnose(threadId) {
    if (!threadId || probingId) return;
    setProbingId(threadId);
    setProbe(null);
    try {
      const r = await csopsPost('diagIgRecipient', { thread_id: threadId.trim() }, session);
      setProbe({ thread_id: threadId, result: r });
    } catch (e) {
      // A failed probe is itself evidence — show it rather than swallowing it.
      setProbe({ thread_id: threadId, error: e.message });
    } finally { setProbingId(null); }
  }

  if (!perms?.cs_ticket_admin) {
    return <EmptyState icon="🔒" message="Admin permission required to view Meta diagnostics." />;
  }
  // Never swap the surface for a spinner once loaded — a background token refresh
  // re-fires this effect roughly hourly and would otherwise wipe an open probe result.
  if (loading && !firstLoadDone) return <Spinner />;

  return (
    <div style={{ padding: 20, maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Refused Meta sends</h2>
        <select value={days} onChange={e => { setLoading(true); setDays(Number(e.target.value)); }}
                style={{ background: 'var(--surface,#111)', color: 'inherit', border: '1px solid #333', borderRadius: 4, padding: '4px 8px' }}>
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <button onClick={() => { setLoading(true); load(days); }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', color: 'inherit',
                         border: '1px solid #333', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--text2,#8a8a8a)', lineHeight: 1.5 }}>
        One row per chat per error code; <strong>Attempts</strong> is how many times the agent pressed send.
        Diagnosing sends nothing — it makes two read-only Graph calls with the same credential the reply
        would have used. Failures are only recorded from 2026-08-26 onward, when csops began persisting them.
      </p>

      {error && (
        <div style={{ border: '1px solid #dc2626', background: 'rgba(220,38,38,0.08)', borderRadius: 4, padding: 10, marginBottom: 14, fontSize: 13 }}>
          {error}
        </div>
      )}

      {!failures.length ? (
        <EmptyState icon="✅" title="No refused sends"
                    message={`Nothing failed in the last ${days} days. Widen the range if you are chasing an older report.`} />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text2,#8a8a8a)', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                <th style={{ padding: '6px 8px' }}>Customer</th>
                <th style={{ padding: '6px 8px' }}>Ch</th>
                <th style={{ padding: '6px 8px' }}>Error</th>
                <th style={{ padding: '6px 8px' }}>Window</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Attempts</th>
                <th style={{ padding: '6px 8px' }}>Last attempt</th>
                <th style={{ padding: '6px 8px' }} />
              </tr>
            </thead>
            <tbody>
              {failures.map(f => {
                const info = codeInfo(f.error_code);
                const tone = TONE[info.tone];
                return (
                  <tr key={`${f.thread_id}-${f.error_code}`} style={{ borderTop: '1px solid #222' }}>
                    <td style={{ padding: '8px' }}>
                      {/* A thread has a handle (IG/Messenger) or a phone (WhatsApp) — never a
                          `customer_name`; that column lives on cs_tickets, not cs_wa_threads. */}
                      <div style={{ fontWeight: 600 }}>{f.customer_handle || f.customer_phone || '(unknown)'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text2,#8a8a8a)', fontFamily: 'var(--mono,monospace)' }}>{f.recipient_id || '—'}</div>
                    </td>
                    <td style={{ padding: '8px', fontSize: 12 }}>{f.channel || '—'}</td>
                    <td style={{ padding: '8px' }}>
                      <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 3, fontSize: 11.5, fontWeight: 700,
                                     background: tone.bg, border: `1px solid ${tone.bd}`, color: tone.fg }}>
                        {f.error_code ?? '?'} · {info.label}
                      </span>
                      <div style={{ fontSize: 11.5, color: 'var(--text2,#8a8a8a)', marginTop: 3, maxWidth: 380 }}>{f.error_message}</div>
                    </td>
                    <td style={{ padding: '8px', fontSize: 12 }}>
                      {f.window_open_at_attempt
                        ? <span style={{ color: '#4ade80' }}>open</span>
                        : <span style={{ color: 'var(--text2,#8a8a8a)' }}>shut</span>}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{f.attempts}</td>
                    <td style={{ padding: '8px', fontSize: 12, whiteSpace: 'nowrap' }}>{fmt(f.last_at)}</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>
                      {f.channel === 'instagram' ? (
                        <button onClick={() => diagnose(f.thread_id)} disabled={!!probingId}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent', color: 'inherit',
                                         border: '1px solid #333', borderRadius: 4, padding: '4px 9px',
                                         cursor: probingId ? 'default' : 'pointer', opacity: probingId && probingId !== f.thread_id ? 0.4 : 1 }}>
                          <Stethoscope size={13} />
                          {probingId === f.thread_id ? 'Probing…' : 'Diagnose'}
                        </button>
                      ) : (
                        /* The probe is Instagram-only by construction; offering it on a Messenger
                           row would return a confusing token mismatch rather than nothing. */
                        <span style={{ fontSize: 11, color: 'var(--text2,#8a8a8a)' }}>IG only</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Manual escape hatch: a thread that never got as far as a persisted failure
          (anything refused before 2026-08-26) will not be in the list above. */}
      <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid #222' }}>
        <div style={{ fontSize: 12.5, color: 'var(--text2,#8a8a8a)', marginBottom: 6 }}>
          Probe a thread by id (for a refusal older than the persistence, or one reported by hand):
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input value={manualId} onChange={e => setManualId(e.target.value)}
                 placeholder="cs_wa_threads.id (uuid)"
                 style={{ flex: '1 1 340px', background: 'var(--surface,#111)', color: 'inherit', border: '1px solid #333',
                          borderRadius: 4, padding: '6px 9px', fontFamily: 'var(--mono,monospace)', fontSize: 12.5 }} />
          <button onClick={() => diagnose(manualId)} disabled={!manualId.trim() || !!probingId}
                  style={{ background: 'transparent', color: 'inherit', border: '1px solid #333', borderRadius: 4,
                           padding: '6px 12px', cursor: manualId.trim() && !probingId ? 'pointer' : 'default' }}>
            Diagnose
          </button>
        </div>
      </div>

      {probe && (
        <div style={{ marginTop: 20, border: '1px solid #333', borderRadius: 5, overflow: 'hidden' }}>
          <div style={{ padding: '9px 12px', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Stethoscope size={14} />
            <strong style={{ fontSize: 13 }}>Probe result</strong>
            <span style={{ fontSize: 11.5, color: 'var(--text2,#8a8a8a)', fontFamily: 'var(--mono,monospace)' }}>{probe.thread_id}</span>
          </div>
          {probe.error ? (
            <div style={{ padding: 12, fontSize: 13, color: '#f87171', display: 'flex', gap: 8 }}>
              <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{probe.error}</span>
            </div>
          ) : (
            <>
              <div style={{ padding: '10px 12px', fontSize: 12.5, color: 'var(--text2,#8a8a8a)', borderBottom: '1px solid #222', lineHeight: 1.55 }}>
                <strong style={{ color: 'inherit' }}>How to read this:</strong> if <code>me</code> returns 200 but{' '}
                <code>recipient</code> does not, the credential is healthy and Meta is refusing this
                specific person — which is the code-200 case, and the response body below is the first
                direct evidence of why. If <code>me</code> also fails, the problem is the token, not the customer.
              </div>
              <pre style={{ margin: 0, padding: 12, fontSize: 11.5, lineHeight: 1.5, overflowX: 'auto',
                            fontFamily: 'var(--mono,monospace)', background: 'rgba(0,0,0,0.25)' }}>
{JSON.stringify(probe.result, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
