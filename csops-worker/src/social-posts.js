// Pure rules for filling a store.cs_social_posts row's display fields — kept out of index.js so
// they are testable without a network or a database (social-posts.test.mjs).
//
// Why it exists: the comment webhook carries only a media id, so a webhook-first post used to be
// stored BARE and stay bare, and Pitstop's /comments showed "On post <id>" with no caption or link
// (Bhavani #bugs 1791362733, measured 2026-10-07: 220 of 247 posts, 147 of them ads).

export const POST_META_FIELDS = ['permalink', 'caption', 'media_url', 'media_type'];

/** A row is finished once it has a permalink; anything less is filled again on the next touch. */
export function postNeedsMeta(row) {
  return !row?.permalink;
}

/**
 * Whether to ask Meta for a post's fields. Only Instagram: the IGAA token works against
 * graph.instagram.com alone, so a Facebook post must never reach that host. The poller already
 * holds the fields from /me/media and passes them in, so it never triggers a read.
 */
export function shouldFetchPostMeta(channel, meta) {
  return !meta && channel === 'instagram';
}

/** The PATCH for a found bare row: only fields Meta actually gave, so nothing is ever nulled out. */
export function postMetaPatch(meta) {
  const patch = {};
  for (const k of POST_META_FIELDS) if (meta?.[k]) patch[k] = meta[k];
  return patch;
}
