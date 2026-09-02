'use client';
// Suppressions — the global list of who Relay will not send to, and why (S336).
//
// `comms.suppressions` is step ① of the send gate and blocks EVERY purpose, transactional
// included: a suppressed customer stops receiving order and shipping messages, not just marketing.
// S253 gave it a per-contact panel, which answers "why did THIS customer get nothing?". This page
// answers the other question — "who is blocked, and is that number moving?" — which until now had
// no answer short of SQL.
//
// It was deliberately deferred while the table held 0 rows (an empty admin page is worse than no
// page). That threshold is long past: 3,380 rows as of 2026-09-02.
//
// ⚠️ DO NOT ADD A BULK LIFT. The largest single population here — `wa_undeliverable_wa_131026`,
// 1,582 rows — is not a backlog of mistakes, it is a WORKING mechanism draining a known bad
// population. A number is suppressed on the THIRD hard failure precisely because 7.7% of
// one-strike numbers later deliver fine (reference/decisions.md, "786 under-threshold numbers").
// A "clear all" button here would silently undo that and re-admit thousands of dead numbers to
// every future send. Lifting is one row at a time, on purpose, and it is recorded against a name.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  ShieldOff, Search, Download, ChevronLeft, ChevronRight, History, Undo2, X,
} from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState, InfoDot, Stamp } from '@/components/ui.js';
import { useConfirm } from '@/components/confirm.js';

const PAGE = 100;
// The worker caps a single read at 500 (and PostgREST caps everything at db-max-rows anyway), so a
// full export PAGES rather than asking for one enormous response. Bounded so a runaway table can
// never hang the browser on a click — if it ever trips, the toast says the export is partial
// rather than handing over a short file that looks complete.
const EXPORT_CAP = 20000;

const input = {
  width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
  border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--t1)',
};

// Reason → tone. Unknown reasons render gray rather than being coerced into a severity we have not
// actually assigned: new reasons get written by webhooks without this page being redeployed.
const TONE = {
  gdpr_redact: 'gray',
  complaint: 'red',
  hard_bounce: 'red',
  manual: 'yellow',
};
const toneFor = (r) => TONE[r] || (String(r || '').startsWith('wa_') ? 'yellow' : 'gray');

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(name, header, body) {
  const csv = [header, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export default function SuppressionsPage() {
  const { userId, perms } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const [view, setView] = useState('active');      // 'active' | 'lifted'
  const [rows, setRows] = useState(null);
  const [lifts, setLifts] = useState([]);
  const [total, setTotal] = useState(null);        // null = UNKNOWN, never render as 0
  const [liftsTotal, setLiftsTotal] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);

  // Draft filter state vs applied filter state. Typing must not fire a request per keystroke, and
  // the applied values are what paging and export read — so a half-typed box can never produce an
  // export that disagrees with the table.
  const [qDraft, setQDraft] = useState('');
  const [channelDraft, setChannelDraft] = useState('');
  const [reasonDraft, setReasonDraft] = useState('');
  const [applied, setApplied] = useState({ q: '', channel: '', reason: '' });

  // NB no `firstLoadDone` ref here, deliberately, and the CORE.md rule it exists for is still
  // honoured: the filter inputs live in the Panel's `action` slot, so the loading branch replaces
  // the TABLE only and can never unmount a box someone is typing into. The spinner is additionally
  // initial-load only (`rows === null`), so a background reload does not blank the table either.
  const canLift = !perms || perms.data_consent_admin;

  const load = useCallback(async (f, off, v) => {
    const session = await getValidSession();
    if (!session) return;
    setLoadError(false);
    try {
      const params = { limit: String(PAGE) };
      if (v === 'lifted') {
        // The lifts side has its own paging on the same action; ask for a minimal suppressions
        // page alongside it rather than a second round trip.
        params.limit = '1';
        params.lifts_limit = String(PAGE);
        params.lifts_offset = String(off);
      } else {
        params.offset = String(off);
        params.lifts_limit = '1';
        if (f.q) params.q = f.q;
        if (f.channel) params.channel = f.channel;
        if (f.reason) params.reason = f.reason;
      }
      const r = await garageFetch('getSuppressions', params, session);
      // In the lifted view the suppressions side is asked for `limit=1` purely to keep this to one
      // round trip — writing that single row into `rows` would flash it as a stale one-row table on
      // the way back to Active. Keep whatever Active last held, but resolve null → [] so the
      // initial-load spinner cannot stick if someone switches tabs before the first read returns.
      if (v === 'lifted') setRows((prev) => prev ?? []);
      else setRows(Array.isArray(r?.suppressions) ? r.suppressions : []);
      setLifts(Array.isArray(r?.lifts) ? r.lifts : []);
      // `total` is null when the header was missing or malformed. Keep the null — the UI says
      // "unknown", because rendering it as 0 would read as "nobody is blocked" on a table with
      // thousands of rows in it.
      setTotal(r?.total ?? null);
      setLiftsTotal(r?.lifts_total ?? null);
    } catch (e) {
      // An empty list and a failed read look identical on screen and mean opposite things.
      setLoadError(true);
      setRows([]);
      showToast(e.message || 'Could not load suppressions', 'error');
    }
  }, [showToast]);

  // Keyed on userId, NOT session: onAuthStateChange re-fires on every tab switch and a real token
  // refresh lands ~hourly, so keying on the session object would reload the table under someone
  // mid-way through reading it.
  useEffect(() => { if (userId) load(applied, offset, view); }, [userId, load, applied, offset, view]);

  function applyFilters() {
    setOffset(0);
    setApplied({ q: qDraft.trim(), channel: channelDraft, reason: reasonDraft.trim() });
  }
  function clearFilters() {
    setQDraft(''); setChannelDraft(''); setReasonDraft('');
    setOffset(0);
    setApplied({ q: '', channel: '', reason: '' });
  }

  async function lift(b) {
    if (b.reason === 'gdpr_redact') {
      showToast('A GDPR/DPDP erasure block cannot be lifted here', 'error');
      return;
    }
    // Same copy and the same danger tone as the per-contact panel — one block, two surfaces, and
    // they must not disagree about how serious this is.
    const extra = b.reason === 'complaint'
      ? 'This address reported a previous message as SPAM. Re-enabling sending to it puts sender '
        + 'reputation at risk for every other customer.'
      : null;
    const wa = String(b.reason || '').startsWith('wa_')
      ? 'This number was suppressed after repeated hard delivery failures, not by a person. '
        + 'Lifting it re-admits it to every future send; if the number is genuinely dead it will '
        + 'simply fail again and be re-suppressed.'
      : null;
    const points = [extra, wa].filter(Boolean);
    if (!(await confirm({
      tone: 'danger',
      title: `Lift the ${b.reason} block on ${b.value}?`,
      lede: <>They start receiving <b>{b.channel}</b> again, including marketing if they are opted in.</>,
      points: points.length ? points : null,
      note: 'This is recorded against your name.',
      confirmLabel: 'Lift the block',
    }))) return;
    setBusy(true);
    try {
      const session = await getValidSession();
      await workerFetch('removeSuppression', { id: b.id }, session);
      showToast('Block lifted', 'success');
      load(applied, offset, view);
    } catch (e) {
      const m = String(e.message || '');
      showToast(m === 'gdpr_redact_cannot_be_lifted'
        ? 'Erasure requests cannot be lifted — this is a legal block'
        : (m || 'Could not lift the block'), 'error');
    } finally { setBusy(false); }
  }

  async function exportCsv() {
    setBusy(true);
    try {
      const session = await getValidSession();
      // ⚠️ Export what is ON SCREEN. This used to always export active suppressions, so pressing
      // Export while the Lifted tab was showing silently downloaded a different dataset than the
      // one being looked at — a file that is wrong in the one way a CSV can never be caught being
      // wrong, because nobody re-checks a download against the page. (Caught by hostile review.)
      if (view === 'lifted') {
        const allLifts = [];
        let lo = 0;
        for (;;) {
          const r = await garageFetch('getSuppressions',
            { limit: '1', lifts_limit: '500', lifts_offset: String(lo) }, session);
          const batch = Array.isArray(r?.lifts) ? r.lifts : [];
          allLifts.push(...batch);
          if (batch.length < 500 || allLifts.length >= EXPORT_CAP) break;
          lo += 500;
        }
        downloadCsv('relay-suppressions-lifted',
          ['channel', 'value', 'original_reason', 'original_blocked_at', 'lifted_at', 'lifted_by', 'note'],
          allLifts.map((l) => [l.channel, l.value, l.original_reason, l.original_created_at,
            l.lifted_at, l.lifted_by, l.note]));
        showToast(`Exported ${allLifts.length.toLocaleString()} lifted blocks`, 'success');
        return;
      }
      const all = [];
      let off = 0;
      // Page until a short page arrives — the same rule CORE.md records for any read that can
      // exceed db-max-rows. Ordering is created_at,id in the worker, so boundaries are stable.
      for (;;) {
        const params = { limit: '500', offset: String(off), lifts_limit: '1' };
        if (applied.q) params.q = applied.q;
        if (applied.channel) params.channel = applied.channel;
        if (applied.reason) params.reason = applied.reason;
        const r = await garageFetch('getSuppressions', params, session);
        const batch = Array.isArray(r?.suppressions) ? r.suppressions : [];
        all.push(...batch);
        if (batch.length < 500 || all.length >= EXPORT_CAP) break;
        off += 500;
      }
      const capped = all.length >= EXPORT_CAP;
      downloadCsv('relay-suppressions',
        ['channel', 'value', 'reason', 'blocked_at', 'profile_id'],
        all.map((r) => [r.channel, r.value, r.reason, r.created_at, r.profile_id || '']));
      showToast(capped
        ? `Exported the first ${all.length.toLocaleString()} — more remain, narrow the filters`
        : `Exported ${all.length.toLocaleString()} rows`, capped ? 'error' : 'success');
    } catch (e) {
      showToast(e.message || 'Could not export', 'error');
    } finally { setBusy(false); }
  }

  // `rows` starts null and only becomes [] once a read has returned. Those two states MUST render
  // differently here: "no rows yet" during the initial load would otherwise render the empty state,
  // and on this page the empty state reads "Nobody is blocked" — the most confidently wrong
  // sentence the screen can show, on a table with 3,380 rows in it. (Caught by hostile review.)
  // `rows === null` is precisely "no read has returned yet" — it is set to an array (possibly
  // empty) by both the success and the failure path, so this cannot stick. A ref would be wrong
  // here: reading one during render does not re-render when it flips.
  const loading = rows === null;
  const list = view === 'lifted' ? lifts : rows;
  const count = view === 'lifted' ? liftsTotal : total;
  const filtered = !!(applied.q || applied.channel || applied.reason);
  const shownFrom = offset + 1;
  const shownTo = offset + (list?.length || 0);
  const hasPrev = offset > 0;
  // Prefer the real total when we have it — a full last page would otherwise offer a Next that
  // lands on an empty table. Fall back to the page size when `count` is null (unknown), because a
  // Next that depends on a number we may not have would disappear exactly when it is needed.
  const hasNext = count != null
    ? offset + PAGE < count
    : (list?.length || 0) >= PAGE;

  const tab = (id, label, icon) => (
    <Btn onClick={() => { setView(id); setOffset(0); }}
         style={view === id ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}>
      {icon} {label}
    </Btn>
  );

  return (
    <>
      <PageHead
        title="Suppressions"
        sub="Everyone Relay will not send to, and why."
        actions={
          <Btn onClick={exportCsv} disabled={busy || !list?.length}>
            <Download size={14} /> Export CSV
          </Btn>
        }
      />

      {/* Said on the page, not only in the source. Someone opening this list for the first time
          sees thousands of rows and the natural reading is "something is badly wrong" — the
          opposite of the truth for the largest group. */}
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--t2)',
                  display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span>
          A suppression blocks <b>every</b> message on that channel — order and shipping updates
          too, not just marketing. A large number here is normal and mostly healthy.
        </span>
        <InfoDot label="Why this list is long, and why that is fine">
          <p><b>Hard bounces</b> are addresses the mail provider told us do not exist. Continuing
            to send to them is what damages deliverability for everyone else.</p>
          <p><b>WhatsApp undeliverable</b> numbers are suppressed only on the <b>third</b> hard
            failure. That threshold is deliberate: about 7.7% of numbers that fail once go on to
            deliver perfectly well, so suppressing earlier would silently drop reachable
            customers. The retries are how the dead numbers are found.</p>
          <p>So a growing count is the mechanism working, not a backlog to clear. Only a count
            that stops falling over months is a signal worth chasing.</p>
          <p><b>Erasure blocks</b> (GDPR/DPDP) cannot be lifted here at all — they are legal.</p>
        </InfoDot>
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {tab('active', 'Active blocks', <ShieldOff size={14} />)}
        {tab('lifted', 'Lifted', <History size={14} />)}
      </div>

      <Panel
        title={view === 'lifted' ? 'Lifted blocks' : 'Active blocks'}
        count={count ?? undefined}
        action={view === 'active' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Search size={14} style={{ color: 'var(--t3)' }} />
            <input
              style={{ ...input, width: 200 }} placeholder="Search email or number"
              value={qDraft} onChange={(e) => setQDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }}
            />
            <select style={{ ...input, width: 120 }} value={channelDraft}
                    onChange={(e) => setChannelDraft(e.target.value)}>
              <option value="">All channels</option>
              <option value="email">Email</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="sms">SMS</option>
            </select>
            <input
              style={{ ...input, width: 170 }} placeholder="Reason (exact)"
              value={reasonDraft} onChange={(e) => setReasonDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }}
            />
            <Btn onClick={applyFilters}>Apply</Btn>
            {filtered && <Btn onClick={clearFilters}><X size={14} /> Clear</Btn>}
          </div>
        ) : null}
      >
        {loading ? (
          <div style={{ padding: '28px 0' }}><Spinner /></div>
        ) : loadError ? (
          <EmptyState icon="alert" title="Could not load suppressions" hint="Refresh to try again." />
        ) : !list?.length ? (
          <EmptyState
            icon="inbox"
            title={view === 'lifted' ? 'No blocks have been lifted' : (filtered ? 'Nothing matches those filters' : 'Nobody is blocked')}
            hint={view === 'lifted'
              ? 'When someone lifts a block it is recorded here with their name — this is the only record that the block ever existed.'
              : (filtered ? 'Clear the filters to see the full list.' : 'Nothing has hard-bounced, been reported as spam, or been erased.')}
          />
        ) : view === 'lifted' ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--t3)', fontSize: 11, textTransform: 'uppercase' }}>
                <th style={{ padding: '6px 8px', width: 90 }}>Channel</th>
                <th style={{ padding: '6px 8px' }}>Address</th>
                <th style={{ padding: '6px 8px', width: 170 }}>Was blocked for</th>
                <th style={{ padding: '6px 8px', width: 130 }}>Lifted</th>
                <th style={{ padding: '6px 8px' }}>By</th>
              </tr>
            </thead>
            <tbody>
              {lifts.map((l) => (
                <tr key={l.id} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '8px', color: 'var(--t2)' }}>{l.channel}</td>
                  <td style={{ padding: '8px' }} className="mono">{l.value}</td>
                  <td style={{ padding: '8px' }}>
                    <Badge label={l.original_reason} tone={toneFor(l.original_reason)} />
                  </td>
                  <td style={{ padding: '8px', color: 'var(--t3)' }}><Stamp value={l.lifted_at} /></td>
                  <td style={{ padding: '8px', color: 'var(--t2)' }}>
                    {l.lifted_by || '—'}
                    {l.note && <div style={{ color: 'var(--t3)', fontSize: 12 }}>{l.note}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--t3)', fontSize: 11, textTransform: 'uppercase' }}>
                <th style={{ padding: '6px 8px', width: 90 }}>Channel</th>
                <th style={{ padding: '6px 8px' }}>Address</th>
                <th style={{ padding: '6px 8px', width: 200 }}>Reason</th>
                <th style={{ padding: '6px 8px', width: 130 }}>Blocked</th>
                <th style={{ padding: '6px 8px', width: 190 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '8px', color: 'var(--t2)' }}>{b.channel}</td>
                  <td style={{ padding: '8px' }} className="mono">{b.value}</td>
                  <td style={{ padding: '8px' }}><Badge label={b.reason} tone={toneFor(b.reason)} /></td>
                  <td style={{ padding: '8px', color: 'var(--t3)' }}><Stamp value={b.created_at} /></td>
                  <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {b.reason === 'gdpr_redact' ? (
                      <span style={{ color: 'var(--t3)', fontSize: 12 }}>legal erasure — cannot be lifted</span>
                    ) : canLift ? (
                      <Btn onClick={() => lift(b)} disabled={busy}><Undo2 size={14} /> Lift block</Btn>
                    ) : (
                      <span style={{ color: 'var(--t3)', fontSize: 12 }}>needs consent admin</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!!list?.length && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        gap: 8, padding: '10px 8px 2px', fontSize: 12, color: 'var(--t3)' }}>
            <span>
              {shownFrom.toLocaleString()}–{shownTo.toLocaleString()}
              {count == null ? '' : ` of ${count.toLocaleString()}`}
              {count == null && <span title="The database did not report a total for this query."> (total unavailable)</span>}
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              <Btn onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={!hasPrev || busy}>
                <ChevronLeft size={14} /> Previous
              </Btn>
              <Btn onClick={() => setOffset(offset + PAGE)} disabled={!hasNext || busy}>
                Next <ChevronRight size={14} />
              </Btn>
            </span>
          </div>
        )}
      </Panel>
    </>
  );
}
