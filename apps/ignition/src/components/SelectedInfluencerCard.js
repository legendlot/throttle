'use client';
import { Avatar, RatingDot } from './ui/index.js';

// Inline identity for the influencer chosen on a new deal (Reann 6-pt ①, S214).
// Shows who you actually picked — channel + person, platform, a clickable channel
// link, reach/followers, location, contact POC — so you can confirm it's the right
// creator before creating the deal. Used by NewDealModal + the New Deal page.
// Pit Control (2026-10-08): the prototype's card — avatar, name + code, then
// type · reach · location · ● rating. The prototype's "last deal Nd ago" is DROPPED (W9, plan
// § Scope ruling) — no source for it. The S214 identity extras stay on a muted second line.

const fmt = (n) => (n == null || n === '' ? null : Number(n).toLocaleString('en-IN'));

export default function SelectedInfluencerCard({ influencer, onChange }) {
  if (!influencer) return null;
  const i = influencer;
  const platforms = Array.isArray(i.channel_platforms) && i.channel_platforms.length
    ? i.channel_platforms : (i.channel_platform ? [i.channel_platform] : []);
  const link = (i.channel_link || '').trim();
  const linkHref = link && !/^https?:\/\//i.test(link) ? `https://${link}` : link;
  const reach = fmt(i.reach);
  const followers = fmt(i.follower_count);
  const poc = i.contact_poc_name
    ? `${i.contact_poc_name}${i.contact_poc_type ? ` (${i.contact_poc_type})` : ''}` : null;
  const name = i.channel_name || i.person_name || '—';
  const meta = [
    i.influencer_type ? cap(i.influencer_type) : null,
    reach != null ? `${reach} reach` : null,
    i.location || null,
  ].filter(Boolean);
  const extras = [
    platforms.length ? platforms.join(', ') : null,
    followers != null ? `${followers} followers` : null,
    poc ? `POC ${poc}` : null,
  ].filter(Boolean);

  return (
    <div className="ig-pop" style={wrap}>
      <Avatar name={name} seed={i.influencer_code || name} size={44} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 15, overflowWrap: 'anywhere' }}>
          {name}{' '}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent-hi)', fontWeight: 600 }}>{i.influencer_code}</span>
        </div>
        {i.channel_name && i.person_name && i.person_name !== i.channel_name && (
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{i.person_name}</div>
        )}
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 2, display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 6 }}>
          {meta.map((m, k) => <span key={k}>{m} ·</span>)}
          <RatingDot rating={i.quality_rating} style={{ fontSize: 13, color: RATING_FG[i.quality_rating] || 'var(--text-3)' }} />
        </div>
        {extras.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-4)', marginTop: 4 }}>{extras.join(' · ')}</div>
        )}
        {linkHref && (
          <a href={linkHref} target="_blank" rel="noreferrer"
            style={{ display: 'inline-block', marginTop: 4, fontSize: 12, color: 'var(--accent-hi)', wordBreak: 'break-all' }}>
            {link} ↗
          </a>
        )}
      </div>
      {onChange && (
        <button type="button" onClick={onChange} className="ig-card-action" style={change}>Change</button>
      )}
    </div>
  );
}

function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

const RATING_FG = { green: 'var(--state-success-fg)', yellow: 'var(--state-warning-fg)', red: 'var(--state-error-fg)' };
const wrap = {
  display: 'flex', alignItems: 'center', gap: 14,
  padding: 14, background: 'var(--bg)', borderRadius: 'var(--r-row)',
  border: '1px solid var(--accent)',
};
const change = { fontSize: 13, color: 'var(--text-3)', flexShrink: 0, alignSelf: 'center' };
