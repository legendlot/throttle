'use client';
// Inline identity for the influencer chosen on a new deal (Reann 6-pt ①, S214).
// Shows who you actually picked — channel + person, platform, a clickable channel
// link, reach/followers, location, contact POC — so you can confirm it's the right
// creator before creating the deal. Used by NewDealModal + the New Deal page.

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
  const meta = [i.influencer_type, i.location].filter(Boolean).join(' · ');
  const poc = i.contact_poc_name
    ? `${i.contact_poc_name}${i.contact_poc_type ? ` (${i.contact_poc_type})` : ''}` : null;

  return (
    <div style={wrap}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: '#FF6B00', fontWeight: 700 }}>{i.influencer_code}</span>
          <span style={{ fontWeight: 600 }}>{i.channel_name || i.person_name || '—'}</span>
          {i.channel_name && i.person_name && i.person_name !== i.channel_name && (
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{i.person_name}</span>
          )}
        </div>
        {meta && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{meta}</div>}

        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6, fontSize: 11, color: 'var(--text-2)' }}>
          {platforms.length > 0 && <span>{platforms.join(', ')}</span>}
          {reach != null && <span>Reach <strong style={{ color: 'var(--text-1)' }}>{reach}</strong></span>}
          {followers != null && <span>Followers <strong style={{ color: 'var(--text-1)' }}>{followers}</strong></span>}
          {poc && <span>POC {poc}</span>}
        </div>

        {linkHref && (
          <a href={linkHref} target="_blank" rel="noreferrer"
            style={{ display: 'inline-block', marginTop: 6, fontSize: 12, color: '#FF6B00', wordBreak: 'break-all' }}>
            {link} ↗
          </a>
        )}
      </div>
      {onChange && (
        <button type="button" onClick={onChange} style={ghost}>Change</button>
      )}
    </div>
  );
}

const wrap = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
  padding: 12, background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
};
const ghost = {
  padding: '6px 12px', background: 'transparent', color: 'var(--text-2)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer', flexShrink: 0,
};
