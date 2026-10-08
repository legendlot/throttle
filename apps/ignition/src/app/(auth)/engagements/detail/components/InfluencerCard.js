'use client';
import { titleish } from '../../../../../lib/productLabel.js';
import { Card, KV } from './shared.js';

/** Influencer identity, on the deal (Reann #1, 2026-08-27). Read-only mirror of the profile. */
export function InfluencerCard({ inf }) {
  if (!inf || !inf.id) {
    return <Card title="Influencer"><div style={{ color: 'var(--text-3)', fontSize: 13 }}>Not linked.</div></Card>;
  }
  // A creator may run several platforms (channel_platforms[], S144); channel_platform is only
  // the primary one, so showing just that would under-report someone posting on two.
  const platforms = Array.isArray(inf.channel_platforms) && inf.channel_platforms.length
    ? inf.channel_platforms
    : (inf.channel_platform ? [inf.channel_platform] : []);
  return (
    <Card title="Influencer">
      <KV label="Handle" value={inf.channel_name || '—'} />
      <KV label="Name" value={inf.person_name || '—'} />
      <KV
        label="Phone"
        value={inf.contact_number
          // A tel: link so the number can be dialled from a phone — Ignition has a mobile shell
          // (S304) and this card is exactly what someone checks on the way to a call.
          ? <a href={`tel:${inf.contact_number}`} style={{ color: 'var(--text-1)', textDecoration: 'none', borderBottom: '1px dotted var(--text-3)' }}>{inf.contact_number}</a>
          : '—'}
      />
      <KV label="Email" value={inf.email || '—'} />
      <KV label="Location" value={inf.location || '—'} />
      <KV label="Platform" value={platforms.length ? platforms.map(titleish).join(', ') : '—'} />
      <KV label="Type" value={inf.influencer_type ? titleish(inf.influencer_type) : '—'} />
      <KV label="Followers" value={inf.follower_count ? Number(inf.follower_count).toLocaleString('en-IN') : '—'} />
    </Card>
  );
}
