/**
 * Influencer location vocabulary (Reann, #bugs 2026-08-27: "Please use drop-downs for location
 * when adding an influencer to avoid manual entries and errors. City-wise drop-downs are
 * preferred.").
 *
 * The field was a bare text input and the result is measurable: 1,487 influencers, 658 with a
 * location, **194 distinct spellings** for them (measured 2026-08-27). Bengaluru alone is stored
 * four ways — Bangalore 61 · Bengaluru 33 · BANGALORE 25 · BLR 9 — so the location filter on the
 * influencers list offers the same city four times and each one finds a quarter of the people.
 *
 * ## Why a datalist and not the shared Combobox
 *
 * `Combobox` has NO free-text mode: a typed value that matches no option is discarded on blur.
 * That exact behaviour was shipped on Ignition's product field in S214 and had to be reverted
 * the same session, because a real product simply vanished when the user tabbed away. A location
 * list can never be complete — creators live in towns no canonical list carries — so the same
 * reversion would follow. `<input list=…>` gives the dropdown without the trap.
 *
 * ## Why snap-on-blur rather than a hard whitelist
 *
 * A strict dropdown prevents "Banglore" but also prevents Kodungallur. `canonicalLocation()`
 * instead SNAPS a typed value onto the canonical spelling when it recognises one (case, known
 * abbreviation, or known misspelling) and otherwise passes the text through untouched. Typos of
 * a known city are fixed; genuinely new places are still accepted.
 *
 * ⚠️ `Bangalore` is the canonical spelling here, not `Bengaluru`, because it is what the team
 * actually types (95 rows across its variants vs 33). This is a house-style choice, not a fact —
 * flip the ALIASES entry and the CITIES entry together if Reann prefers the official name.
 */

/** Cities offered first — the ones LOT actually works with, plus the metros. */
export const CITIES = [
  'Ahmedabad', 'Ajmer', 'Alappuzha', 'Amravati', 'Aurangabad', 'Balasore', 'Ballari',
  'Bangalore', 'Bhopal', 'Bhubaneswar', 'Chandigarh', 'Chennai', 'Coimbatore', 'Dehradun',
  'Delhi', 'Faridabad', 'Ghaziabad', 'Goa', 'Gurugram', 'Guwahati', 'Gwalior', 'Haridwar',
  'Hassan', 'Hisar', 'Hyderabad', 'Indore', 'Jabalpur', 'Jaipur', 'Jammu', 'Jodhpur',
  'Kannur', 'Kochi', 'Kolhapur', 'Kolkata', 'Kollam', 'Kota', 'Kottayam', 'Kozhikode',
  'Lucknow', 'Madurai', 'Mangaluru', 'Moradabad', 'Mumbai', 'Mysuru', 'Nagercoil', 'Nagpur',
  'Nashik', 'Navi Mumbai', 'Noida', 'Palakkad', 'Patna', 'Puducherry', 'Pune', 'Raipur',
  'Rajkot', 'Ratnagiri', 'Roorkee', 'Sangareddy', 'Shahjahanpur', 'Surat', 'Thane',
  'Thiruvananthapuram', 'Thoothukudi', 'Thrissur', 'Tirupati', 'Vadodara', 'Varanasi',
  'Vasai', 'Visakhapatnam', 'Villupuram',
];

/** States, offered after the cities — plenty of existing rows are state-level and that is fine. */
export const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Delhi NCR',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu & Kashmir', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

/** Everything the datalist offers, cities first. */
export const LOCATION_OPTIONS = [...CITIES, ...STATES];

/**
 * Known variants → canonical. Keys are lower-cased and space-collapsed.
 * Only entries where the two names are unambiguously the SAME place belong here — a guess that
 * merges two places is worse than leaving a duplicate in the list.
 */
const ALIASES = {
  // Bengaluru
  'bengaluru': 'Bangalore', 'bengalore': 'Bangalore', 'blr': 'Bangalore',
  // Delhi
  'new delhi': 'Delhi', 'delhi ncr': 'Delhi NCR',
  // Hyderabad
  'hyd': 'Hyderabad', 'hyderbad': 'Hyderabad',
  // Renamed / older names
  'madras': 'Chennai', 'trivandrum': 'Thiruvananthapuram', 'calicut': 'Kozhikode',
  'mysore': 'Mysuru', 'mangalore': 'Mangaluru', 'gurgaon': 'Gurugram',
  'pondicherry': 'Puducherry', 'vizag': 'Visakhapatnam',
  'vishakhapatnam': 'Visakhapatnam', 'bhubaneshwar': 'Bhubaneswar',
  'bhuvaneshwar': 'Bhubaneswar', 'ajmeer': 'Ajmer', 'kohlapur': 'Kolhapur',
  'vadora': 'Vadodara', 'tirpuati': 'Tirupati',
  // States typed short or misspelled
  'kl': 'Kerala', 'kerela': 'Kerala',
  'up': 'Uttar Pradesh', 'wb': 'West Bengal',
  'tamilnadu': 'Tamil Nadu',
  'maharastra': 'Maharashtra', 'maharshtra': 'Maharashtra',
  'gujrat': 'Gujarat',
  'harayana': 'Haryana',
  'jharkand': 'Jharkhand',
  'chattisgarh': 'Chhattisgarh',
  'andra pradesh': 'Andhra Pradesh',
  'himachal': 'Himachal Pradesh',
  'telagana': 'Telangana', 'telengana': 'Telangana',
  'uttarakand': 'Uttarakhand', 'uttrakhand': 'Uttarakhand',
  'jammu and kashmir': 'Jammu & Kashmir', 'jammu &amp; kashmir': 'Jammu & Kashmir',
};

// Canonical spellings keyed by their own lower-cased form, so "BANGALORE" and "bangalore"
// both resolve without needing an ALIASES entry each.
const CANONICAL_BY_LOWER = new Map(LOCATION_OPTIONS.map(v => [v.toLowerCase(), v]));

/**
 * Snap a typed location onto its canonical spelling when we recognise it; otherwise return the
 * tidied text exactly as typed. Never returns null for a non-empty input — an unrecognised place
 * is a real place we do not know about, not an error.
 */
export function canonicalLocation(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const key = s.toLowerCase();
  if (ALIASES[key]) return ALIASES[key];
  if (CANONICAL_BY_LOWER.has(key)) return CANONICAL_BY_LOWER.get(key);
  return s;
}
