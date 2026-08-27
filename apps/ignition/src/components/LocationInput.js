'use client';
import { LOCATION_OPTIONS, canonicalLocation } from '../lib/locations.js';

/**
 * City/state picker for the influencer forms (Reann, #bugs 2026-08-27).
 *
 * A `<datalist>`-backed input, NOT the shared Combobox: Combobox discards a typed value that
 * matches no option on blur, which is fine for a closed catalogue and wrong for places — see the
 * S214 product-field reversion, and the reasoning in lib/locations.js.
 *
 * On blur the value is snapped to its canonical spelling when we recognise it (BANGALORE → Bangalore,
 * BLR → Bangalore, Kerela → Kerala) and otherwise left exactly as typed.
 */
export default function LocationInput({ value, onChange, style, placeholder = 'Start typing a city…' }) {
  return (
    <>
      <input
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        // Snap on blur, not on every keystroke: rewriting mid-word fights the person typing.
        onBlur={e => {
          const snapped = canonicalLocation(e.target.value);
          if (snapped !== e.target.value) onChange(snapped);
        }}
        list="ignition-locations"
        placeholder={placeholder}
        style={style}
      />
      <datalist id="ignition-locations">
        {LOCATION_OPTIONS.map(l => <option key={l} value={l} />)}
      </datalist>
    </>
  );
}
