'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

// Hardcoded product list from public.product_master (active, cars only)
// Avoids cross-schema client query complexity — update when products change
const PRODUCTS = [
  'Alex','Apex','Bracey','Brutus','Bumble','Dash','Diesel','Doughty',
  'Ellie','Fang','Flare','Flare LE','Gazer','Ghost','Iris','Knox',
  'McCloud','NightWolf','Nitro','Otto','Shadow','Shuttle','Thunder','Titan','Vera'
];

export default function ProductSelector({ selected, onChange }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const filtered = PRODUCTS.filter(p =>
    p.toLowerCase().includes(search.toLowerCase())
  );

  function toggle(product) {
    if (selected.includes(product)) {
      onChange(selected.filter(p => p !== product));
    } else {
      onChange([...selected, product]);
    }
  }

  return (
    <div className="relative">
      {/* Selected tags */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {selected.map(p => (
            <span
              key={p}
              className="flex items-center gap-1 bg-zinc-800 text-zinc-200 text-xs px-2 py-1 rounded"
            >
              {p}
              <button
                type="button"
                onClick={() => toggle(p)}
                className="text-zinc-500 hover:text-white ml-1"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <input
        type="text"
        placeholder="Search products..."
        value={search}
        onChange={e => { setSearch(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
      />

      {/* Dropdown */}
      {open && (
        <div className="absolute z-10 w-full mt-1 bg-zinc-900 border border-zinc-700 rounded-lg max-h-48 overflow-y-auto shadow-xl">
          {filtered.length === 0 && (
            <p className="text-zinc-600 text-xs px-3 py-2">No products found</p>
          )}
          {filtered.map(p => (
            <button
              key={p}
              type="button"
              onClick={() => { toggle(p); setSearch(''); }}
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                selected.includes(p)
                  ? 'bg-zinc-700 text-white'
                  : 'text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              {selected.includes(p) && <span className="mr-2 text-green-400">✓</span>}
              {p}
            </button>
          ))}
        </div>
      )}

      {/* Close on outside click */}
      {open && (
        <div
          className="fixed inset-0 z-0"
          onClick={() => setOpen(false)}
        />
      )}
    </div>
  );
}
