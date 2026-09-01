import { garageFetch } from '@throttle/db';
import { dedupeInFlight } from '@/lib/dedupeInFlight.js';

// Shared in-flight `getCampaigns` request.
//
// THE PROBLEM. The On-Air poll lives in `(auth)/layout.js`, which wraps EVERY authed route, and
// calls `getCampaigns` on mount and then every 60s. Four other surfaces call it too — the home
// Control Tower, `/campaigns`, `/analytics` and the ⌘K palette — so landing on any of them
// fired the same list request twice, concurrently, for one screen (~0.4–0.7s each, S293 load
// profile). ⚠️ The backlog item said "home page"; the poll is in the shared layout, so it was
// four routes, not one — the same undercount as the other two items burned down this session.
//
// The heavy half of S293 was fixed same-day by pointing the On-Air poll at `campaign_stats(id)`
// instead of the every-campaign overview. This is the light residual.
//
// Staleness is impossible here by construction — see dedupeInFlight.js for why that is a
// deliberate choice and not an oversight.
// ⚠️ The key is what ties the two duplicated copies of this module together — see
// dedupeInFlight.js. It must be stable and unique per logical request.
export const getCampaignsShared = dedupeInFlight('getCampaigns', (session) => garageFetch('getCampaigns', {}, session));
