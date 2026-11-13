'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Lock, AlertTriangle, X } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';
import { Button, IconButton, EmptyState } from '../../../../components/ui/index.js';
import { AdminHead } from '../../../../components/AdminParts.js';
import { channelError, announcementErrorText } from '../../../../lib/announcements.js';

const MODES = [
  { value: 'off',  label: 'Off',  hint: 'Nothing goes to Slack.' },
  { value: 'test', label: 'Test', hint: 'No channel gets anything. Each test recipient below gets a DM: the message, plus a line per team (or Everyone) saying which channel it would post to, or that live would skip it because no channel is set. No test recipients = nothing sent.' },
  { value: 'live', label: 'Live', hint: 'Every new announcement is posted to the real channels below.' },
];

/**
 * docket_admin: the Slack mirror for announcements (P4, docket.settings.announcements). An everyone-post goes to the
 * org channel; a team post to that team's channel (none set = no mirror). The Docket bot must be invited to each
 * channel — a post to a channel it isn't in is recorded on the announcement as not_in_channel.
 */
export default function AdminAnnouncementsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [s, setS] = useState(null);              // the form: { mode, org_channel, team_channels, test_employee_ids }
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [saving, setSaving] = useState(false);
  const [pick, setPick] = useState('');

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const [cfg, deps, emps] = await Promise.all([
        docketopsGet('getAnnouncementSettings', {}, session),
        docketopsGet('getDepartments', {}, session),
        docketopsGet('getEmployees', {}, session),
      ]);
      setS({ mode: cfg.mode, org_channel: cfg.org_channel || '', team_channels: { ...(cfg.team_channels || {}) }, test_employee_ids: cfg.test_employee_ids || [] });
      setDepartments((deps || []).filter(d => d.active !== false));
      setEmployees(emps || []);
    } catch (e) { showToast(announcementErrorText(e) || e.message || 'Failed to load', 'error'); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  const empName = useMemo(() => Object.fromEntries(employees.map(e => [e.id, e.full_name])), [employees]);
  const pickOpts = useMemo(() => employees.filter(e => !(s?.test_employee_ids || []).includes(e.id))
    .map(e => ({ value: e.id, label: e.full_name })), [employees, s]);
  const errs = useMemo(() => {
    if (!s) return {};
    const out = {};
    if (channelError(s.org_channel)) out.org = channelError(s.org_channel);
    for (const d of departments) if (channelError(s.team_channels[d.id])) out[d.id] = channelError(s.team_channels[d.id]);
    return out;
  }, [s, departments]);

  async function save() {
    if (Object.keys(errs).length) { showToast('Fix the channel IDs marked below', 'error'); return; }
    if (s.mode === 'live' && !window.confirm('Live mode posts every new announcement to the real Slack channels. Turn it on?')) return;
    setSaving(true);
    try {
      // Only active teams are listed, so only their channels are sent (an inactive team's entry is dropped).
      const team_channels = {};
      for (const d of departments) { const c = String(s.team_channels[d.id] || '').trim(); if (c) team_channels[d.id] = c.toUpperCase(); }
      const saved = await docketopsPost('saveAnnouncementSettings', { mode: s.mode, org_channel: s.org_channel.trim().toUpperCase() || null,
        team_channels, test_employee_ids: s.test_employee_ids }, session);
      setS({ mode: saved.mode, org_channel: saved.org_channel || '', team_channels: { ...saved.team_channels }, test_employee_ids: saved.test_employee_ids });
      showToast('Saved', 'success');
    } catch (e) { showToast(announcementErrorText(e) || e.message || 'Failed', 'error'); }
    finally { setSaving(false); }
  }

  if (perms && !perms.docket_admin) return <div className="adm"><EmptyState icon={Lock} title="Admins only" body="Requires docket_admin." /></div>;
  if (!s) return <Spinner />;
  const setChan = (id) => (e) => setS(x => ({ ...x, team_channels: { ...x.team_channels, [id]: e.target.value } }));

  return (
    <div className="adm">
      <AdminHead title="Announcements"
        lede={<>The Slack mirror for announcements. An announcement to everyone goes to the org channel; one to a team goes to that team&rsquo;s channel. Invite the Docket bot to each channel (<span className="adm-mono">/invite @Docket</span>), or the post is recorded as <span className="adm-mono">not_in_channel</span>. Edits are never re-sent.</>}
        action={<Button variant="primary" onClick={save} loading={saving}>Save</Button>} />

      <section className="adm-card">
        <div className="adm-card-h"><span>Mode</span></div>
        <div className="adm-card-b">
          <div role="radiogroup" aria-label="Slack mirror mode">
            {MODES.map(m => (
              <label key={m.value} className="adm-row ann-radio">
                <span className="adm-row-l">
                  <input type="radio" name="ann-mode" value={m.value} checked={s.mode === m.value} onChange={() => setS(x => ({ ...x, mode: m.value }))} disabled={saving} />
                  <strong>{m.label}</strong> <span className="adm-row-hint">{m.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {s.mode === 'live' && <div className="adm-note ann-warn"><AlertTriangle size={14} /> Live posts to real channels that people read.</div>}
        </div>
      </section>

      <section className="adm-card">
        <div className="adm-card-h"><span>Channels <span className="adm-count">channel ID, e.g. C0123ABCD</span></span></div>
        <div className="adm-card-b">
          <label className="adm-field"><span className="adm-lbl">Org channel (announcements to everyone)</span>
            <input className="adm-input mono" value={s.org_channel} onChange={e => setS(x => ({ ...x, org_channel: e.target.value }))} placeholder="No org channel" disabled={saving} />
            {errs.org && <span className="ann-field-err">{errs.org}</span>}</label>
          <div className="adm-field">
            <span className="adm-lbl">Team channels <span className="adm-row-hint">· a team with none set gets no Slack post</span></span>
            {departments.map(d => (
              <div key={d.id} className="adm-row">
                <span className="adm-row-l">{d.name}</span>
                <span className="ann-chan">
                  <input className="adm-input mono" value={s.team_channels[d.id] || ''} onChange={setChan(d.id)} placeholder="No channel" aria-label={`${d.name} channel ID`} disabled={saving} />
                  {errs[d.id] && <span className="ann-field-err">{errs[d.id]}</span>}
                </span>
              </div>
            ))}
            {departments.length === 0 && <div className="adm-item-sub">No active teams.</div>}
          </div>
        </div>
      </section>

      <section className="adm-card">
        <div className="adm-card-h"><span>Test recipients <span className="adm-count">{s.test_employee_ids.length || ''}</span></span></div>
        <div className="adm-card-b">
          <div className="adm-item-sub">In test mode, only these people get a DM, for every new announcement, whether or not a channel is set. With nobody here, test mode sends nothing.</div>
          <div className="adm-pick">
            <Combobox value={pick} options={pickOpts} placeholder="Add a person…" allowClear portal style={{ width: '100%' }}
              onChange={(v, opt) => { if (opt) { setS(x => ({ ...x, test_employee_ids: [...x.test_employee_ids, v] })); setPick(''); } }} />
          </div>
          {s.test_employee_ids.length > 0 && (
            <div className="adm-chips">
              {s.test_employee_ids.map(id => (
                <span key={id} className="adm-chip">
                  {empName[id] || 'Unknown person'}
                  <IconButton icon={X} size="sm" label={`Remove ${empName[id] || 'recipient'}`} tooltip={false} disabled={saving}
                    onClick={() => setS(x => ({ ...x, test_employee_ids: x.test_employee_ids.filter(t => t !== id) }))} />
                </span>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
