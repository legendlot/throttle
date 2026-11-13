'use client';
// Announcements (General-space rethink P4) — General's broadcast role. Founders post to everyone or any teams; a team
// head to the teams they head (getMe.can_announce drives the composer; the worker decides). Readers mark a post Seen;
// the author and founders see who has and hasn't. ?id= focuses one post (static export: no dynamic route).
// A post / Seen / edit is a docketopsPost, whose counts-changed event re-runs getMe — so the sidebar badge follows.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { useCachedQuery } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Megaphone, Pin, PinOff, Archive, Pencil, Check, Eye, X, Users, Globe, Clock, Plus } from 'lucide-react';
import { Button, IconButton, Pill, EmptyState } from '../../../components/ui/index.js';
import { Avatar } from '../../../components/primitives.js';
import { Switch } from '../../../components/AdminParts.js';
import { useChrome } from '../../../lib/chrome.js';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { announcementsKey, freshness } from '../../../lib/load.js';
import { LoadError } from '../../../components/LoadError.js';
import { TITLE_MAX, BODY_MAX, relTime, expiryNote, expiryDateInput, todayIst, allowedTeams, canPost, composerError,
  mirrorToast, mirrorStatus, announcementErrorText } from '../../../lib/announcements.js';
import { fmtDateTime } from '../../../lib/format.js';

export default function AnnouncementsPage() {
  return <Suspense fallback={<Spinner />}><AnnouncementsInner /></Suspense>;
}

function AnnouncementsInner() {
  const { session, userId } = useAuth();
  const { showToast } = useToast();
  const { canAnnounce } = useChrome();
  const focusId = useSearchParams().get('id') || '';
  const [past, setPast] = useState(false);
  const [seenLocal, setSeenLocal] = useState(() => new Set());   // Mark seen, applied before the next read
  const [departments, setDepartments] = useState([]);
  const [composing, setComposing] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [seenFor, setSeenFor] = useState(null);     // the post whose Seen list is open
  const [busy, setBusy] = useState('');             // the id (or 'new') being written
  const focused = useRef('');

  // The list is cached per user and per Past toggle (read-only: painted at once, refreshed behind). The hook
  // keeps only the newest answer for the current toggle, so a slow Live read can't land under Past. A copy
  // from the cache never enables a write: each card's Edit / Pin / Archive / Mark seen waits for a list
  // fetched in this visit (`fetched`), and the composer is gated by getMe's can_announce (fresh only).
  const key = announcementsKey(past);
  const fetched = useRef(new WeakSet());
  const inFlight = useRef(0);
  const q = useCachedQuery({ key, userId, enabled: !!session,
    fetcher: async () => {
      inFlight.current += 1;
      try {
        const r = await docketopsGet('getAnnouncements', past ? { include_past: '1' } : {}, session);
        const list = Array.isArray(r) ? r : [];
        fetched.current.add(list);
        return list;
      } finally { inFlight.current -= 1; }
    } });
  const live = !!session;
  useEffect(() => { if (live) q.refresh(); }, [live, key]); // eslint-disable-line react-hooks/exhaustive-deps
  // After a write: the hook JOINS a read already in flight, and that read began before the write — so wait
  // for it, then read again.
  const load = useCallback(() => (inFlight.current ? q.refresh().then(() => q.refresh()) : q.refresh()), [q.refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const fresh = q.data !== undefined && fetched.current.has(q.data);
  const rows = useMemo(() => (q.data === undefined ? null
    : seenLocal.size ? q.data.map(x => (seenLocal.has(x.id) && !x.seen_by_me ? { ...x, seen_by_me: true } : x)) : q.data), [q.data, seenLocal]);
  const stale = freshness([q]);

  const poster = canPost(canAnnounce);
  useEffect(() => {
    if (!session || !poster) return;
    docketopsGet('getDepartments', {}, session).then(d => setDepartments(d || [])).catch(() => {});
  }, [session, poster]);
  const teams = useMemo(() => allowedTeams(canAnnounce, departments), [canAnnounce, departments]);
  const teamName = useMemo(() => Object.fromEntries(departments.map(d => [d.id, d.name])), [departments]);

  // ?id= → scroll to that post once it is on the page (once per id).
  useEffect(() => {
    if (!focusId || !rows || focused.current === focusId) return;
    const el = document.getElementById('ann-' + focusId);
    if (el) { focused.current = focusId; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }, [focusId, rows]);

  async function write(id, action, body, okMsg) {
    if (busy) return null;
    setBusy(id);
    try { const r = await docketopsPost(action, body, session); if (okMsg) showToast(okMsg, 'success'); return r || {}; }
    catch (e) { showToast(announcementErrorText(e) || e.message || 'Failed', 'error'); return null; }
    finally { setBusy(''); }
  }
  async function create(d) {
    const r = await write('new', 'createAnnouncement', { title: d.title, body: d.body, audience: d.audience,
      team_ids: d.audience === 'teams' ? d.team_ids : [], pinned: d.pinned, expires_at: d.expiry || null });
    if (!r) return;
    showToast(mirrorToast(r.mirror, teamName), 'success');
    setComposing(false); load();
  }
  async function saveEdit(a, d) {
    const body = { id: a.id, title: d.title, body: d.body, pinned: d.pinned };
    if (d.expiry !== expiryDateInput(a.expires_at)) body.expires_at = d.expiry || null;   // unchanged: not re-checked
    if (await write(a.id, 'updateAnnouncement', body, 'Saved')) { setEditingId(''); load(); }
  }
  async function markSeen(a) {
    if (await write(a.id, 'markAnnouncementSeen', { id: a.id })) {
      setSeenLocal(s => new Set(s).add(a.id));
    }
  }
  async function togglePin(a) {
    if (await write(a.id, 'updateAnnouncement', { id: a.id, pinned: !a.pinned }, a.pinned ? 'Unpinned' : 'Pinned')) load();
  }
  async function archive(a) {
    if (!window.confirm(`Archive "${a.title}"? It leaves everyone's list. Slack messages already sent stay in Slack.`)) return;
    if (await write(a.id, 'archiveAnnouncement', { id: a.id }, 'Archived')) load();
  }

  return (
    <div className="screen ann">
      <div className="ann-head">
        <p className="ann-lede">News for everyone, or for a team. Mark a post seen once you have read it.</p>
        <div className="ann-head-act">
          <label className="ann-past"><Switch on={past} label="Show past announcements" onClick={() => setPast(p => !p)} /> Show past</label>
          {poster && !composing && <Button variant="primary" icon={Plus} onClick={() => setComposing(true)}>New announcement</Button>}
        </div>
      </div>

      {composing && (
        <Composer canAnnounce={canAnnounce} teams={teams} busy={busy === 'new'} onCancel={() => setComposing(false)} onSubmit={create} />
      )}

      {rows !== null && (!fresh || stale.warn) && stale.text && (
        <div aria-live="polite" style={{ fontSize: 12, margin: '0 0 10px', color: stale.warn ? 'var(--st-blocked)' : 'var(--text-4)' }}>
          {stale.text}{stale.warn && <button type="button" onClick={q.refresh} style={{ marginLeft: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', textDecoration: 'underline', fontSize: 'inherit' }}>Retry</button>}
        </div>
      )}

      {rows === null ? (q.error
        ? <LoadError message={announcementErrorText(q.error) || "Couldn't load announcements."} onRetry={q.refresh} />
        : <Spinner />) : rows.length === 0 ? (
        <EmptyState icon={Megaphone} title={past ? 'No announcements' : 'No live announcements'}
          body={poster ? 'Post one for everyone you can reach. It also goes to Slack when the mirror is on.' : 'Founders and team heads post news here.'} />
      ) : (
        <div className="ann-list">
          {rows.map(a => (editingId === a.id
            ? <Composer key={a.id} edit initial={a} canAnnounce={canAnnounce} teams={teams} busy={busy === a.id}
                onCancel={() => setEditingId('')} onSubmit={(d) => saveEdit(a, d)} />
            : <Card key={a.id} a={a} focus={a.id === focusId} busy={busy === a.id} locked={!fresh}
                onSeen={() => markSeen(a)} onPin={() => togglePin(a)} onArchive={() => archive(a)}
                onEdit={() => setEditingId(a.id)} onSeenList={() => setSeenFor(a)} />))}
        </div>
      )}

      {seenFor && <SeenList a={seenFor} session={session} onClose={() => setSeenFor(null)} />}
    </div>
  );
}

// locked: the card is the cached copy — its writes wait for this visit's read.
function Card({ a, focus, busy, locked = false, onSeen, onPin, onArchive, onEdit, onSeenList }) {
  const exp = expiryNote(a.expires_at);
  return (
    <article id={'ann-' + a.id} className={'ann-card' + (focus ? ' focus' : '') + (a.pinned ? ' pinned' : '') + (a.is_live === false ? ' past' : '')}>
      <header className="ann-card-h">
        <h2 className="ann-title">{a.pinned && <Pin size={13} className="ann-pin" aria-label="Pinned" />}{a.title}</h2>
        {a.can_manage && (
          <div className="ann-acts">
            <IconButton icon={Pencil} size="sm" label="Edit" onClick={onEdit} disabled={busy || locked} />
            <IconButton icon={a.pinned ? PinOff : Pin} size="sm" label={a.pinned ? 'Unpin' : 'Pin to the top'} onClick={onPin} disabled={busy || locked} />
            <IconButton icon={Archive} size="sm" label="Archive" onClick={onArchive} disabled={busy || locked} />
          </div>
        )}
      </header>
      <div className="ann-body">{a.body}</div>
      <footer className="ann-foot">
        <span className="ann-who">
          <Avatar name={a.author_name || 'Docket'} size={20} />
          <span className="ann-author">{a.author_name || 'Someone'}</span>
          <span className="ann-dot">·</span>
          <span className="ann-time" title={fmtDateTime(a.created_at)}>{relTime(a.created_at)}</span>
        </span>
        <span className="ann-aud">
          {a.audience === 'everyone'
            ? <Pill icon={Globe}>Everyone</Pill>
            : (a.teams || []).map(t => <Pill key={t.id} icon={Users}>{t.name || 'Team'}</Pill>)}
          {exp && <span className={'ann-exp' + (a.is_live === false ? ' over' : '')}><Clock size={12} aria-hidden /> {exp}</span>}
        </span>
        <span className="ann-seen">
          {a.can_manage && a.audience_count != null && (
            <button type="button" className="ann-seen-count" onClick={onSeenList} title="Who has and hasn't seen it">
              <Eye size={13} aria-hidden /> Seen by {a.seen_count} of {a.audience_count}
            </button>
          )}
          {a.seen_by_me
            ? <span className="ann-seen-me"><Check size={13} aria-hidden /> Seen</span>
            : <Button size="sm" icon={Check} onClick={onSeen} loading={busy} disabled={locked}>Mark seen</Button>}
        </span>
      </footer>
      {a.can_manage && <div className="ann-mirror">{mirrorStatus(a.slack, Object.fromEntries((a.teams || []).map(t => [t.id, t.name])))}</div>}
    </article>
  );
}

// New post, or (edit) title / body / pin / expiry of an existing one — the audience is fixed once posted.
function Composer({ edit = false, initial = null, canAnnounce, teams, busy, onCancel, onSubmit }) {
  const [d, setD] = useState(() => (initial
    ? { title: initial.title, body: initial.body, audience: initial.audience, team_ids: initial.team_ids || [], pinned: !!initial.pinned, expiry: expiryDateInput(initial.expires_at) }
    : { title: '', body: '', audience: canAnnounce?.everyone ? 'everyone' : 'teams', team_ids: teams.length === 1 ? [teams[0].id] : [], pinned: false, expiry: '' }));
  const [problem, setProblem] = useState('');
  // The single allowed team arrives after getDepartments: pick it then.
  useEffect(() => {
    if (!edit && d.audience === 'teams' && !d.team_ids.length && teams.length === 1) setD(x => ({ ...x, team_ids: [teams[0].id] }));
  }, [teams]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setD(x => ({ ...x, [k]: e.target.value }));
  // A team chip switches the audience to teams (from Everyone) and toggles that team.
  const toggleTeam = (id) => setD(x => {
    const ids = x.audience === 'teams' ? x.team_ids : [];
    return { ...x, audience: 'teams', team_ids: ids.includes(id) ? ids.filter(t => t !== id) : [...ids, id] };
  });
  function submit(e) {
    e.preventDefault();
    const p = edit ? composerError({ ...d, audience: 'everyone' }, { everyone: true }) : composerError(d, canAnnounce);
    setProblem(p);
    if (!p) onSubmit({ ...d, title: d.title.trim(), body: d.body.trim() });
  }
  return (
    <form className="ann-card ann-compose" onSubmit={submit}>
      <label className="adm-field"><span className="adm-lbl">Title</span>
        <input className="adm-input" value={d.title} onChange={set('title')} maxLength={TITLE_MAX} placeholder="What's the news?" autoFocus disabled={busy} /></label>
      <label className="adm-field"><span className="adm-lbl">Announcement <span className="ann-len">{d.body.length}/{BODY_MAX}</span></span>
        <textarea className="ann-textarea" value={d.body} onChange={set('body')} maxLength={BODY_MAX} rows={5} placeholder="Plain text. Line breaks are kept." disabled={busy} /></label>
      {!edit && (
        <div className="adm-field">
          <span className="adm-lbl">Who sees it</span>
          <div className="adm-chips">
            {canAnnounce?.everyone && (
              <button type="button" className={'ann-chip' + (d.audience === 'everyone' ? ' on' : '')} aria-pressed={d.audience === 'everyone'}
                onClick={() => setD(x => ({ ...x, audience: 'everyone' }))}><Globe size={12} aria-hidden /> Everyone</button>
            )}
            {teams.map(t => {
              const on = d.audience === 'teams' && d.team_ids.includes(t.id);
              return (
                <button key={t.id} type="button" className={'ann-chip' + (on ? ' on' : '')} aria-pressed={on}
                  onClick={() => toggleTeam(t.id)}>
                  <Users size={12} aria-hidden /> {t.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="ann-compose-row">
        <label className="ann-inline"><Switch on={d.pinned} label="Pin to the top" onClick={() => setD(x => ({ ...x, pinned: !x.pinned }))} disabled={busy} /> Pin to the top</label>
        <label className="ann-inline">Expires
          <input type="date" className="adm-input ann-date" value={d.expiry} min={todayIst()} onChange={set('expiry')} disabled={busy} />
          {d.expiry && <IconButton icon={X} size="sm" label="No expiry" onClick={() => setD(x => ({ ...x, expiry: '' }))} />}
        </label>
      </div>
      {problem && <div className="ann-problem" role="alert">{problem}</div>}
      <div className="ann-compose-foot">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="primary" type="submit" loading={busy}>{edit ? 'Save' : 'Post'}</Button>
      </div>
    </form>
  );
}

function SeenList({ a, session, onClose }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    docketopsGet('getAnnouncementSeen', { id: a.id }, session).then(setData)
      .catch(e => setFailed(announcementErrorText(e) || 'Could not load who has seen it'));
  }, [a.id, session]);
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="ann-modal-bd" data-modal onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ann-modal" role="dialog" aria-label="Who has seen it">
        <div className="ann-modal-h">
          <span>{data ? `Seen by ${data.seen_count} of ${data.audience_count}` : 'Seen by'}</span>
          <IconButton icon={X} size="sm" label="Close" onClick={onClose} />
        </div>
        <div className="ann-modal-sub">{a.title}</div>
        {failed ? <div className="ann-problem">{failed}</div> : !data ? <Spinner /> : (
          <>
            <div className="adm-lbl ann-modal-lbl">Not seen yet · {data.not_seen.length}</div>
            {data.not_seen.length ? data.not_seen.map(p => (
              <div key={p.employee_id} className="ann-person"><Avatar name={p.name} size={20} /> {p.name}<span className="ann-person-team">{p.team || ''}</span></div>
            )) : <div className="ann-none">Everyone has seen it.</div>}
            <div className="adm-lbl ann-modal-lbl">Seen · {data.seen.length}</div>
            {data.seen.map(p => (
              <div key={p.employee_id} className="ann-person"><Avatar name={p.name} size={20} /> {p.name}<span className="ann-person-team">{p.team || ''} · {relTime(p.seen_at)}</span></div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
