// How resolveSkus writes a not-yet-mapped SKU into the /mapping queue (sales.unmapped_sku) — S409.
//
// ⛔ INSERT-IF-ABSENT ONLY: on_conflict names the real unique key (channel_id, channel_sku) and the
// resolution is ignore-duplicates, so an existing row — above all a human's `ignored` / `resolved` —
// is never touched from here. `sales.reconcile_unmapped_sku()` (cron, every run) owns the refresh
// of last_seen / pending_* on existing rows and already preserves ignored/resolved (0030).
//
// History: this POST used to send merge-duplicates with NO on_conflict. PostgREST then resolves on the
// primary key (id), which the payload never carries, so any batch holding an already-queued SKU 409'd
// and dropped every NEW unknown SKU with it — silently, since sbSales never throws and the response
// was not read. Measured 2026-10-06: reconcile never writes sample_title, and 116 of 273 null-title
// rows had a titled staged sale ingested >1 h after first_seen — had the merge ever succeeded,
// resolveSkus would have filled those titles. "Fixing" that by adding on_conflict while keeping merge-duplicates would have
// rewritten status:'open' over every ignored row — the drift the S403 backlog item was chasing, whose
// real writer was the pre-0030 reconcile.
export const UNMAPPED_QUEUE_INSERT = {
  path: '/rest/v1/unmapped_sku?on_conflict=channel_id,channel_sku',
  prefer: 'return=minimal,resolution=ignore-duplicates',
};
