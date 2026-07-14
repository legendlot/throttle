import { TAT } from './tat-data.js';

// Forward transit days from Bangalore origin for a destination pincode, per ship mode.
// mode: 'express' | 'surface' (default surface). Returns an integer, or null when the pincode
// is not in the Delhivery TAT table (caller then uses the graceful fallback).
export function tatDays(pincode, mode = 'surface') {
  const rec = TAT[String(pincode)];
  if (!rec) return null;
  return mode === 'express' ? rec[0] : rec[1];
}
