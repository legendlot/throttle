// Fails the build when the vendor bundle could reach LOT's database or internal apps: any Supabase host or key
// shape, or a link to another LOT app. Runs after `next build` (npm run build), so CI and local builds both gate.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OUT = new URL('../out', import.meta.url).pathname;
const BANNED = [
  [/supabase\.co/i, 'a Supabase host'],
  [/sb_(publishable|secret)_/, 'a Supabase key'],
  [/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/, 'a JWT (Supabase anon/service key shape)'],
  [/\b(?!outpostops\.)[a-z0-9-]+\.afshaan\.workers\.dev/i, 'a LOT worker other than outpostops'],
  [/lotopsproxy|manifestops|(garage|redline|depot|snorkel|odo|podium|pitstop|ignition|docket|relay|throttle)\.legendoftoys\.com/i, 'a LOT internal app or worker'],
];
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);                    // every published file, whatever its type (an SVG or a font can carry text)
  }
})(OUT);
const hits = [];
for (const f of files) {
  const s = readFileSync(f, 'latin1');
  for (const [re, what] of BANNED) if (re.test(s)) hits.push(`${f.slice(OUT.length + 1)}: ${what} (${s.match(re)[0]})`);
}
if (!files.length) { console.error('check-isolation: no build output found'); process.exit(1); }
if (hits.length) { console.error('check-isolation: the vendor bundle must not carry these:\n  ' + hits.join('\n  ')); process.exit(1); }
console.log(`check-isolation: ${files.length} files clean (no Supabase host/key, no LOT internal app)`);
