'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Check, Lock, Unlock, ShieldAlert } from 'lucide-react';
import { PageHead, Panel, Btn } from '@/components/ui.js';

const FIELDS = [
  { key: 'approval_required_marketing', label: 'Require approval for marketing sends', type: 'toggle',
    hint: 'When on, marketing campaigns above the audience threshold need an approver.' },
  { key: 'approval_audience_threshold', label: 'Approval audience threshold', type: 'number',
    hint: 'Marketing sends to more than this many contacts require approval.' },
  { key: 'frequency_cap_per_day', label: 'Frequency cap (messages / day)', type: 'number',
    hint: 'Max messages a single contact can receive within the window.' },
  { key: 'frequency_cap_window_hours', label: 'Frequency cap window (hours)', type: 'number',
    hint: 'Rolling window the per-day cap is measured over.' },
  { key: 'quiet_hours_start', label: 'Quiet hours start (HH:MM)', type: 'text',
    hint: 'No sends after this local time.' },
  { key: 'quiet_hours_end', label: 'Quiet hours end (HH:MM)', type: 'text',
    hint: 'Sends resume from this local time.' },
  { key: 'attribution_window_days', label: 'Attribution window (days)', type: 'number',
    hint: 'Conversions within this window after a send are attributed to it.' },
];

export default function SettingsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [form, setForm] = useState({});
  const [allowText, setAllowText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const s = await garageFetch('getRelaySettings', {}, session);
      setForm(s || {});
      setAllowText(Array.isArray(s?.test_mode_allow) ? s.test_mode_allow.join('\n') : '');
    } catch (e) { showToast(e.message || 'Failed to load settings', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  // Toggling the lock is the single most consequential action on this page.
  function toggleTestMode() {
    const turningOff = form.test_mode !== false; // currently ON → about to unlock
    if (turningOff) {
      const ok = window.confirm(
        'UNLOCK real-customer sends?\n\nTest mode currently blocks every send to any address ' +
        'outside the allowlist. Turning it OFF lets Relay email REAL CUSTOMERS.\n\n' +
        'Only do this once sign-off is given. Continue?');
      if (!ok) return;
    }
    set('test_mode', turningOff ? false : true);
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
                    <span className="perm-lbl">Allowlist {locked ? <Lock size={11} style={{ verticalAlign: 'middle' }} /> : <Unlock size={11} style={{ verticalAlign: 'middle' }} />}</span>
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
                    <button className={`tgl ${form[f.key] ? 'on' : ''}`} onClick={() => set(f.key, !form[f.key])} disabled={saving}>
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
          </>
        )}
    </div>
  );
}
