// The audience-exclusion rule block — segments · named campaigns · same-channel contacted-within-N-hours.
//
// Extracted out of campaigns.js in S338b, when journeys got the SAME block (decisions §S338b).
// Column names on comms.journeys mirror comms.campaigns exactly (migration 0064) precisely so ONE
// reader serves both: a campaign row and a journey row are interchangeable here, and the RPC param
// names below are the only place the mapping to comms.campaign_excluded() lives.
function exclusionArgs(row) {
  return {
    p_exclude_segments: Array.isArray(row.exclude_segment_ids) ? row.exclude_segment_ids : [],
    p_exclude_campaigns: Array.isArray(row.exclude_campaign_ids) ? row.exclude_campaign_ids : [],
    p_exclude_contacted_hours: row.exclude_contacted_hours ?? null,
  };
}

// Is there anything to check? Takes the ARGS (not the row) so a caller cannot ask this question of
// one shape and the RPC of another. A 0 or a null hours value reads as "rule off" — never as
// "exclude anyone contacted in the last 0 hours" — matching the server-side coercion on save.
function hasExclusions(args) {
  return args.p_exclude_segments.length > 0 || args.p_exclude_campaigns.length > 0
    || (args.p_exclude_contacted_hours != null && args.p_exclude_contacted_hours > 0);
}

module.exports = { exclusionArgs, hasExclusions };
