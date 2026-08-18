'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { UtmFields, UtmMarketingNote } from '@/components/utm.js';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Check, Lock, Unlock, ShieldAlert } from 'lucide-react';
import { PageHead, Panel, Btn } from '@/components/ui.js';
import { useConfirm } from '@/components/confirm.js';


// <input type="datetime-local"> speaks LOCAL wall-clock with no zone; the column is
// timestamptz. Convert explicitly in both directions — reading the raw input value as if it
// were UTC would shift every watermark by the IST offset (5h30m), which on a fail-closed
// emit gate means silently messaging about a different 5.5-hour slice of shipments.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v) {
  if (!v) return '';
  const d = new Date(v);              // parsed as local time, which is what the user typed
  return isNaN(d) ? '' : d.toISOString();
}

const FIELDS = [
  { key: 'approval_required_marketing', label: 'Require approval for marketing sends', type: 'toggle',
    hint: 'When on, marketing campaigns above the audience threshold need an approver.' },
  { key: 'approval_audience_threshold', label: 'Approval audience threshold', type: 'number',
    hint: 'Marketing sends to more than this many contacts require approval.' },
  { key: 'frequency_cap_per_day', label: 'Frequency cap (messages / day)', type: 'number',
    hint: 'Max messages a single contact can receive within the window.' },
  { key: 'frequency_cap_window_hours', label: 'Frequency cap window (hours)', type: 'number',
    hint: 'Rolling window the per-day cap is measured over.' },
  // S268: quiet hours moved to their own per-channel panel below. These two remain as the
  // FALLBACK for any channel with no row of its own — kept whole-hour because that is what
  // the columns are (int), and relabelled: they previously claimed "HH:MM" while storing an
  // integer hour, which is how the pair got read as more configurable than it was.
  { key: 'quiet_hours_start', label: 'Fallback quiet start (hour, 0–23)', type: 'number',
    hint: 'Used only by channels with no row in the per-channel table below.' },
  { key: 'quiet_hours_end', label: 'Fallback quiet end (hour, 0–23)', type: 'number',
    hint: 'Used only by channels with no row in the per-channel table below.' },
  { key: 'attribution_window_days', label: 'Attribution window (days)', type: 'number',
    hint: 'Conversions within this window after a send are attributed to it.' },
  { key: 'daily_send_budget', label: 'Daily send budget (marketing)', type: 'number',
    hint: 'Warm-up throttle — max marketing sends per day (IST). Blank = unlimited. Ramp 500 → 2k → 5k → blank.' },
  // ── COD→prepaid (C2P) + WhatsApp media ─────────────────────────────────────
  // These four existed as columns and were documented as operational switches, but were absent
  // from the worker's saveRelaySettings allow-list until S243 — so every change, including the
  // documented wa_media revert, needed an engineer running SQL. Exposed here so the runbook
  // ends with the team, not with Claude.
  { key: 'payment_links_enabled', label: 'COD→prepaid: collect real payments', type: 'toggle',
    hint: 'THE C2P go-live gate. Off = pay-links are never minted and the Shopify cancel/recreate ops no-op, so the journey is safe to run end-to-end with no money moving. Turn on only for a real conversion test.' },
  { key: 'c2p_cod_fee', label: 'COD fee to deduct (₹ per order)', type: 'number',
    hint: 'Charged prepaid = (COD total − this) × (1 − discount %). Per ORDER, not per item, and applied BEFORE the percentage — which is what lets a customer\'s coupon carry through automatically. Currently ₹50.' },
  { key: 'c2p_prepaid_discount_pct', label: 'Prepaid discount (%)', type: 'number',
    hint: 'The prepaid saving, applied after the COD fee is deducted. Must be 0–99. Currently 3.' },
  { key: 'wrong_number_redirect_enabled', label: 'Marketing/transactional replies: redirect to support', type: 'toggle',
    hint: 'Replaces the BiteSpeed automation that stops at the support cutover. A customer who replies to the marketing or transactional number gets ONE reply pointing them at the support line, and their message raises a ticket so it is not invisible to the queue. Redirect rather than answer: those numbers carry no support templates, so once the 24h window shuts that thread can never be reopened. Never fires on a C2P button tap, on someone mid-journey, or on STOP.' },
  { key: 'wrong_number_redirect_phone_ids', label: 'Numbers that redirect (Meta phone number IDs, comma-separated)', type: 'text',
    hint: 'ALLOW-LIST, deliberately not "everything except support". After migration support is itself a Relay thread with a new ID, and an exclusion-shaped rule would start telling support customers to go to support. Anything not listed here never redirects.' },
  { key: 'wrong_number_redirect_text', label: 'Redirect message', type: 'text',
    hint: 'Sent as a normal message (the customer just wrote, so the 24h window is open) — no Meta template approval needed, so you can edit this freely and it takes effect on the next reply.' },
  { key: 'wa_media_id_enabled', label: 'WhatsApp: send images by media ID', type: 'toggle',
    hint: 'On = upload each header image to Meta once and reuse the ID. Off = send the image URL, which makes Meta re-fetch it on every send and fail asynchronously (error 131053 — looks sent, arrives never). Leave ON; this is the revert switch if the ID path ever misbehaves.' },
];

export default function SettingsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState({});
  const [allowText, setAllowText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // S268 — per-channel quiet windows. Separate table, separate save, so a validation failure
  // on one channel can never half-write the global settings form.
  const [quiet, setQuiet] = useState([]);
  const [savingQuiet, setSavingQuiet] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [s, q] = await Promise.all([
        garageFetch('getRelaySettings', {}, session),
        garageFetch('getChannelQuietHours', {}, session).catch(() => []),
      ]);
      setSavedCourierFrom(s?.courier_emit_from || null);
      setForm(s || {});
      setAllowText(Array.isArray(s?.test_mode_allow) ? s.test_mode_allow.join('\n') : '');
      // `time` comes back as HH:MM:SS; the input wants HH:MM.
      setQuiet((Array.isArray(q) ? q : []).map((r) => ({
        ...r, start_time: String(r.start_time || '').slice(0, 5), end_time: String(r.end_time || '').slice(0, 5),
      })));
    } catch (e) { showToast(e.message || 'Failed to load settings', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  // Toggling the lock is the single most consequential action on this page.
  async function toggleTestMode() {
    const turningOff = form.test_mode !== false; // currently ON → about to unlock
    if (turningOff) {
      // The single most consequential toggle in Relay: everything downstream trusts this
      // flag, and nothing else stands between a draft and the whole customer base. Typed
      // confirmation, not because typing prevents mistakes, but because it forces a beat.
      const ok = await confirm({
        tone: 'danger',
        title: 'Unlock real-customer sends?',
        lede: 'Test mode currently blocks every send to any address outside the allowlist.',
        points: [
          <>Turning it off lets Relay message <b>real customers</b></>,
          'Every campaign and journey is affected at once',
          'Nothing else gates a send once this is off',
        ],
        warning: 'Only do this once sign-off is given.',
        requireTyped: 'UNLOCK',
        confirmLabel: 'Unlock real sends',
        cancelLabel: 'Keep test mode on',
      });
      if (!ok) return;
    }
    set('test_mode', turningOff ? false : true);
  }

  // `payment_links_enabled` turning ON is the one toggle on this page that starts taking real
  // money from real customers, and it lives in a bulk save alongside quiet hours — so it gets the
  // same deliberate confirmation `test_mode` has, rather than being a stray click away.
  async function toggleField(key) {
    const next = !form[key];
    if (key === 'payment_links_enabled' && next) {
      const ok = await confirm({
        tone: 'danger',
        title: 'Turn on real payment collection?',
        lede: 'The COD to prepaid journey starts acting on live orders.',
        points: [
          'Mints live Cashfree payment links',
          'Cancels real Shopify orders',
          'Creates real prepaid replacements',
        ],
        warning: 'Only do this when you are ready for a real conversion test.',
        confirmLabel: 'Turn collection on',
        cancelLabel: 'Leave it off',
      });
      if (!ok) return;
    }
    set(key, next);
  }

  // Impact preview for the courier watermark (S254). Only meaningful when the date moves
  // EARLIER than what is stored — moving it forward can only reduce what qualifies.
  const [impact, setImpact] = useState(null);
  const [savedCourierFrom, setSavedCourierFrom] = useState(null);

  useEffect(() => {
    const next = form.courier_emit_from;
    if (!session || !next || !savedCourierFrom) { setImpact(null); return; }
    if (Date.parse(next) >= Date.parse(savedCourierFrom)) { setImpact(null); return; }
    let alive = true;
    setImpact({ loading: true });
    const h = setTimeout(async () => {
      try {
        const r = await garageFetch('getCourierEmitImpact', { from: next }, session);
        if (alive) setImpact({ total: Number(r?.total || 0), by: r?.by_lifecycle || {} });
      } catch { if (alive) setImpact(null); }
    }, 400);
    return () => { alive = false; clearTimeout(h); };
  }, [form.courier_emit_from, savedCourierFrom, session]);

  // Separate save for this panel so a watermark change is always a deliberate act with its
  // own confirmation, never something that rides along with an unrelated settings edit.
  async function saveEmission() {
    const next = form.courier_emit_from;
    const movedBack = next && savedCourierFrom && Date.parse(next) < Date.parse(savedCourierFrom);
    if (movedBack) {
      const n = impact && !impact.loading ? impact.total : null;
      if (!(await confirm({
        tone: 'danger',
        title: 'Move the courier watermark back?',
        lede: n != null
          ? <><b>{n.toLocaleString('en-IN')}</b> customer message{n === 1 ? '' : 's'} become eligible and will send at about 15 per 5-minute tick.</>
          : 'This makes previously-skipped shipments eligible again.',
        warning: 'These are real WhatsApp messages about orders, deliveries and returns.',
        confirmLabel: 'Move the watermark',
      }))) return;
    }
    await save();
  }

  function setQuietRow(ch, patch) {
    setQuiet((rows) => rows.map((r) => (r.channel === ch ? { ...r, ...patch } : r)));
  }
  async function saveQuiet() {
    setSavingQuiet(true);
    try {
      await workerFetch('saveChannelQuietHours', {
        rows: quiet.map(({ channel, enabled, start_time, end_time, note }) => ({ channel, enabled, start_time, end_time, note })),
      }, session);
      showToast('Quiet hours saved', 'success');
      load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setSavingQuiet(false); }
  }

  async function save() {
    setSaving(true);
    try {
      const payload = {};
      FIELDS.forEach((f) => {
        const v = form[f.key];
        if (f.type === 'number') payload[f.key] = v === '' || v == null ? null : Number(v);
        else if (f.type === 'toggle') payload[f.key] = !!v;
        else payload[f.key] = v ?? null;
      });
      payload.test_mode = form.test_mode !== false; // fail-safe: anything but explicit false = ON
      payload.test_mode_allow = allowText.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
      // jsonb, not one of the flat FIELDS — null means "no account floor, auto-derive".
      payload.utm_defaults = form.utm_defaults || null;
      // Emit watermarks + the segment-entry cap (S254). Sent only when present so a partial
      // form can never blank a fail-closed watermark — the worker refuses a blank anyway,
      // but not sending it at all is the stronger guarantee.
      if (form.courier_emit_from) payload.courier_emit_from = form.courier_emit_from;
      if (form.rto_stage_emit_from) payload.rto_stage_emit_from = form.rto_stage_emit_from;
      if (form.segment_entry_max_per_tick !== '' && form.segment_entry_max_per_tick != null) {
        payload.segment_entry_max_per_tick = Number(form.segment_entry_max_per_tick);
      }
      await workerFetch('saveRelaySettings', payload, session);
      showToast('Settings saved', 'success');
      load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  }

  if (perms && !perms.relay_super_admin) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Super-admin only.</div>;

  return (
    <div className="pg">
      <PageHead title="Approval & Caps" sub="Global guardrails for sends — approval thresholds, frequency caps, quiet hours, attribution." />
      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : (
          <>
          {(() => {
            const locked = form.test_mode !== false;
            return (
              <Panel title="Test mode — global send lock" pad>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 10,
                  border: `1px solid ${locked ? 'rgba(242,205,26,.5)' : 'rgba(222,42,42,.6)'}`,
                  background: locked ? 'rgba(242,205,26,.08)' : 'rgba(222,42,42,.08)', marginBottom: 16,
                }}>
                  {locked ? <Lock size={22} color="#F2CD1A" /> : <ShieldAlert size={22} color="#DE2A2A" />}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>
                      {locked ? 'LOCKED — internal sends only' : 'OPEN — real customers can be emailed'}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 2 }}>
                      {locked
                        ? 'Every send (campaigns, journeys, test-sends, all channels) is blocked unless the recipient matches the allowlist below.'
                        : 'The lock is OFF. Relay will deliver to any consented recipient, including real customers. Re-lock unless a live send is in progress.'}
                    </div>
                  </div>
                  <button className={`tgl ${locked ? 'on' : ''}`} onClick={toggleTestMode} disabled={saving} title={locked ? 'Unlock sends' : 'Re-lock sends'}>
                    <span className="tgl-knob" /><span className="tgl-txt">{locked ? 'LOCKED' : 'OPEN'}</span>
                  </button>
                </div>
                <div className="perm-row" style={{ alignItems: 'flex-start' }}>
                  <div className="perm-l">
                    <span className="perm-lbl">Allowlist {locked ? <Lock size={12} style={{ verticalAlign: 'middle' }} /> : <Unlock size={12} style={{ verticalAlign: 'middle' }} />}</span>
                    <span className="perm-key">One per line. Lines starting with “@” match a whole domain; otherwise an exact email. Only these receive sends while locked.</span>
                  </div>
                  <textarea
                    className="f-inp mono"
                    style={{ width: 280, minHeight: 84, resize: 'vertical' }}
                    value={allowText}
                    onChange={(e) => setAllowText(e.target.value)}
                    placeholder={'@legendoftoys.com\nsomeone@example.com'}
                    disabled={saving}
                  />
                </div>
                <div className="form-foot">
                  <Btn kind="primary" onClick={save} disabled={saving}><Check size={14} /> {saving ? 'Saving…' : 'Save settings'}</Btn>
                </div>
              </Panel>
            );
          })()}
          <Panel title="Send governance" pad>
            <div className="perm-list">
              {FIELDS.map((f) => (
                <div className="perm-row" key={f.key}>
                  <div className="perm-l"><span className="perm-lbl">{f.label}</span><span className="perm-key">{f.hint}</span></div>
                  {f.type === 'toggle' ? (
                    <button className={`tgl ${form[f.key] ? 'on' : ''}`} onClick={() => toggleField(f.key)} disabled={saving}>
                      <span className="tgl-knob" /><span className="tgl-txt">{form[f.key] ? 'ON' : 'OFF'}</span>
                    </button>
                  ) : (
                    <input
                      className={`f-inp ${f.type === 'number' ? 'mono' : ''}`}
                      style={{ width: 160 }}
                      type={f.type === 'number' ? 'number' : 'text'}
                      value={form[f.key] ?? ''}
                      onChange={(e) => set(f.key, e.target.value)}
                      disabled={saving}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="form-foot">
              <Btn kind="primary" onClick={save} disabled={saving}><Check size={14} /> {saving ? 'Saving…' : 'Save settings'}</Btn>
            </div>
          </Panel>

          {/* S268 — per-channel quiet hours. One global pair could not serve every channel:
              promotional SMS in India is deliverable 10:00–21:00 only (TCCCPR, scrubbed at the
              carrier), WhatsApp sits outside TCCCPR, and email is not a telecom resource. */}
          <Panel title="Quiet hours — per channel" pad>
            <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 12, lineHeight: 1.55 }}>
              Applies to <strong>marketing sends only</strong> — transactional and utility messages
              bypass quiet hours entirely, and so do allowlisted test recipients. Times are IST.
              A window may cross midnight (21:00 → 10:00). Journey sends <strong>park and retry</strong> at
              the channel’s own boundary rather than being dropped.
            </div>
            <div className="table-scroll">
            <table className="dt">
              <thead><tr><th>Channel</th><th>Quiet hours</th><th>From</th><th>To</th><th>Why</th></tr></thead>
              <tbody>
                {quiet.length === 0
                  ? <tr><td colSpan={5} className="dim">No per-channel rows — every channel is using the fallback hours above.</td></tr>
                  : quiet.map((r) => (
                    <tr key={r.channel}>
                      <td style={{ fontWeight: 600, color: 'var(--t1)' }}>{r.channel}</td>
                      <td>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!r.enabled}
                            onChange={(e) => setQuietRow(r.channel, { enabled: e.target.checked })} />
                          <span className={r.enabled ? '' : 'dim'}>{r.enabled ? 'On' : 'Off — always sends'}</span>
                        </label>
                      </td>
                      <td><input className="f-inp mono" style={{ width: 96 }} type="time" value={r.start_time || ''}
                        disabled={!r.enabled}
                        onChange={(e) => setQuietRow(r.channel, { start_time: e.target.value })} /></td>
                      <td><input className="f-inp mono" style={{ width: 96 }} type="time" value={r.end_time || ''}
                        disabled={!r.enabled}
                        onChange={(e) => setQuietRow(r.channel, { end_time: e.target.value })} /></td>
                      <td className="dim" style={{ fontSize: 11.5, maxWidth: 460, whiteSpace: 'normal', lineHeight: 1.5 }}>{r.note}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            </div>
            <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
              {/* Disabled on an empty list: that state means the READ failed (or the table is
                  genuinely empty), and saving nothing is never what the author wants — it would
                  just POST an empty batch and look like it worked. */}
              <Btn kind="primary" onClick={saveQuiet} disabled={savingQuiet || quiet.length === 0}>
                <Check size={14} /> {savingQuiet ? 'Saving…' : 'Save quiet hours'}
              </Btn>
              <span className="dim" style={{ fontSize: 11.5 }}>
                {quiet.length === 0
                  ? 'Nothing to save — reload the page; if this persists the channel table could not be read.'
                  : 'Saved separately from the fields above.'}
              </span>
            </div>
          </Panel>

          <Panel title="Link tracking — account defaults" pad>
            <UtmFields
              scope="account"
              value={form.utm_defaults}
              onChange={(next) => set('utm_defaults', next)}
              disabled={saving}
              auto={{ utm_source: 'relay', utm_medium: 'the send channel', utm_campaign: 'the journey / campaign name', utm_content: 'the template name' }}
            />
            <UtmMarketingNote />
            <div className="form-foot">
              <Btn kind="primary" onClick={save} disabled={saving}><Check size={14} /> {saving ? 'Saving…' : 'Save settings'}</Btn>
            </div>
          </Panel>

          {/* EVENT EMISSION (S254) — the last three SQL-only switches.
              These are not ordinary settings: two of them are FAIL-CLOSED watermarks that
              gate real customer messaging. shipment-events.js and rto-stages.js emit
              NOTHING when unset, so a blank here silently switches a feed off — which is
              why the worker refuses a blank rather than writing one. */}
          <Panel title="Event emission — go-live watermarks" pad>
            <div className="tw-note" style={{ marginTop: 0 }}>
              Courier and RTO journey events are <b>forward-only</b>: each feed emits nothing
              that happened before its watermark. Moving one <b>forward</b> is safe — fewer
              shipments qualify. Moving one <b>back</b> makes previously-skipped shipments
              eligible again and will send real messages.
            </div>

            <div className="form-grid" style={{ marginTop: 14 }}>
              <div className="ff">
                <div className="kv-k">Courier events emit from</div>
                <input className="f-inp mono" type="datetime-local" disabled={saving}
                  value={toLocalInput(form.courier_emit_from)}
                  onChange={(e) => { set('courier_emit_from', fromLocalInput(e.target.value)); }} />
                <div className="tw-note" style={{ marginTop: 6 }}>
                  Gates <code>order_shipped</code>, <code>order_out_for_delivery</code>,{' '}
                  <code>order_delivered</code>, <code>order_rto</code>. Drains at ~15 per
                  5-minute tick, so a large backlog releases over hours, not at once.
                </div>
              </div>

              <div className="ff">
                <div className="kv-k">RTO stage events emit from</div>
                <input className="f-inp mono" type="datetime-local" disabled={saving}
                  value={toLocalInput(form.rto_stage_emit_from)}
                  onChange={(e) => set('rto_stage_emit_from', fromLocalInput(e.target.value))} />
                <div className="tw-note" style={{ marginTop: 6 }}>
                  Its own watermark, deliberately separate from the courier one — reusing that
                  would have back-fired every historical scan. Safer to move: each tick only
                  scans the last <b>6 hours</b> regardless, so dropping this date cannot
                  release a long backlog.
                </div>
              </div>

              <div className="ff">
                <div className="kv-k">Segment-entry enrolments per tick</div>
                <input className="f-inp mono w-num" type="number" min={1} max={20000} disabled={saving}
                  value={form.segment_entry_max_per_tick ?? ''}
                  onChange={(e) => set('segment_entry_max_per_tick', e.target.value)} />
                <div className="tw-note" style={{ marginTop: 6 }}>
                  Cap on how many people a widened segment can enrol into an entry journey in
                  one run. The remainder is not dropped — the next tick re-detects it.
                  Default 500. Must be at least 1: zero would read as &quot;none&quot; but
                  actually falls back to 500.
                </div>
              </div>
            </div>

            {/* Impact preview — the reason this is safe to expose at all. */}
            {impact && (
              <div className={`impact-box ${impact.total > 0 ? 'is-warn' : 'is-ok'}`}>
                {impact.loading ? 'Checking what this would release…' : (
                  impact.total > 0 ? (
                    <>
                      <b>{Number(impact.total).toLocaleString('en-IN')} customer message
                      {impact.total === 1 ? '' : 's'} would become eligible</b> at that date
                      {impact.by && Object.keys(impact.by).length > 0 && (
                        <> — {Object.entries(impact.by).map(([k, v]) => `${v} ${k}`).join(' · ')}</>
                      )}. They send at ~15 per 5-minute tick.
                    </>
                  ) : <><b>Nothing new becomes eligible</b> at that date.</>
                )}
              </div>
            )}

            <div className="form-foot">
              <Btn kind="primary" onClick={saveEmission} disabled={saving}>
                <Check size={14} /> {saving ? 'Saving…' : 'Save emission settings'}
              </Btn>
            </div>
          </Panel>
          </>
        )}
    </div>
  );
}
