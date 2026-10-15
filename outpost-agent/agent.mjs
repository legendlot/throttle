#!/usr/bin/env node
// ============================================================
// OUTPOST PRINT AGENT — runs on a vendor bench laptop (and/or the PC driving the sticker printers).
// Forked from the LOT line print server (line_printserver/printserver.js v2.3). What changed:
//   • No database key. It is an enrolled Outpost device: an ECDSA key in device.json signs every request to outpostops.
//   • Leased claims: a job is handed to one agent for 60 s (labels) / 180 s (sticker sheets) and reported exactly once.
//     A report that can't be delivered is kept in pending-reports.json and retried, across restarts. If it never lands,
//     the job turns "outcome unknown" and a supervisor decides (reprint / it printed) — never a silent second print.
//   • Templates: the line's batch + EAN labels, plus the CTN carton label and the 13 mm UPC QR sticker sheet.
//
//   node agent.mjs enrol <8-digit code>     once, with the code LOT's owner issued for this agent
//   node agent.mjs run                      the service
//   node agent.mjs sample <kind>            print one sample (batch_label|ean_label|ctn_label|upc_stickers), no server
// ============================================================
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, DEFAULTS } from './lib/tspl.mjs';
import { enrol, loadClient } from './lib/client.mjs';
import { openPrinter, PrintError } from './lib/printers.mjs';

export const VERSION = '1.0.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const KEY_FILE = join(HERE, 'device.json');
const PENDING_FILE = join(HERE, 'pending-reports.json');
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

export function loadConfig(file = join(HERE, 'config.json')) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  return {
    base_url: c.base_url || 'https://outpostops.afshaan.workers.dev',
    poll_ms: Math.max(1000, Number(c.poll_ms) || 2000),
    heartbeat_ms: Math.min(60_000, Math.max(10_000, Number(c.heartbeat_ms) || 30_000)),   // the floor shows offline after 90 s
    label_printer: c.label_printer || null,          // this bench's TE244 — omit on a sticker-only PC
    sticker_printer: c.sticker_printer || null,      // a 300-dpi sticker printer — omit on a plain bench
    label: { ...DEFAULTS.label, ...(c.label || {}) },
    stickers: { ...DEFAULTS.stickers, ...(c.stickers || {}) },
  };
}

// ── the outbox of undelivered reports (survives a restart) ──────────────────
// Only a missing file is an empty outbox. An unreadable / corrupt one throws, which stops claiming (tick catches it)
// and leaves the file for a human — rewriting it would lose reports the server is still waiting for.
function readPending() {
  let text;
  try { text = readFileSync(PENDING_FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error(`${PENDING_FILE} is not a list — fix or move it aside (it holds unsent print reports)`);
  return list;
}
function writePending(list) {
  writeFileSync(PENDING_FILE + '.tmp', JSON.stringify(list));
  renameSync(PENDING_FILE + '.tmp', PENDING_FILE);
}

export function makeAgent({ client, cfg, printers, pendingStore = { read: readPending, write: writePending } }) {
  let busy = false;
  const queueDepth = { n: 0 };

  async function report(r) {
    const res = await client.call('POST', '/v/agent/report', r);
    if (res.ok) {
      if (res.data?.superseded) log(`⚠ job ${r.job_id} was cancelled while printing — a superseded label may be on the floor`);
      return true;
    }
    // 400 / 404 are final — the job moved on (a supervisor resolved it, or it is not ours). Anything else (network, 5xx,
    // a paused vendor, a clock refusal) is kept and retried: dropping it would turn a printed label into "unknown".
    if (res.status === 400 || res.status === 404) {
      log(`report for job ${r.job_id} refused: ${res.error}`);
      return true;
    }
    return false;
  }

  async function flushPending() {
    const list = pendingStore.read();
    if (!list.length) return true;
    const left = [];
    for (const r of list) if (!(await report(r).catch(() => false))) left.push(r);
    pendingStore.write(left);
    return left.length === 0;
  }

  async function printOne(job) {
    const printer = job.kind === 'upc_stickers' ? printers.stickers : printers.labels;
    let outcome, error = null;
    if (!printer) { outcome = 'not_printed'; error = 'no printer for this job on this agent'; }
    else if (Date.parse(job.lease_until) - client.now() < 5_000) { outcome = 'not_printed'; error = 'lease about to expire'; }
    else {
      try {
        const data = build(job, cfg);
        await printer.send(data, `${job.id}-${job.kind}-a${job.attempt}`);
        outcome = 'printed';
      } catch (e) {
        outcome = e instanceof PrintError && e.sent ? 'unknown' : 'not_printed';
        error = String(e.message || e).slice(0, 300);
      }
    }
    const r = { job_id: job.id, attempt: job.attempt, outcome, error };
    log(`${outcome === 'printed' ? '✓' : '✗'} ${job.kind} ${job.ref}${job.reprint ? ' (reprint)' : ''} → ${outcome}${error ? ' — ' + error : ''}`);
    // Persist first, then deliver: a crash between the two re-sends a report, never loses one.
    pendingStore.write([...pendingStore.read(), r]);
    await flushPending();
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      // Undelivered reports first: claiming more while the server still thinks earlier jobs are leased to us would
      // only grow the pile of jobs a supervisor has to sort out.
      if (!(await flushPending())) return;
      const res = await client.call('POST', '/v/agent/claim', { labels: !!printers.labels, stickers: !!printers.stickers, limit: 3 });
      if (!res.ok) { if (res.status !== 503) log(`claim refused: ${res.status} ${res.error}`); return; }
      queueDepth.n = res.data.length;
      for (const job of res.data) await printOne(job);
    } catch (e) {
      log(`poll error: ${e.message}`);
    } finally { busy = false; }
  }

  async function heartbeat() {
    const list = [];
    for (const [role, p] of Object.entries(printers)) {
      if (!p) continue;
      const st = await p.status().catch(e => ({ ok: false, detail: e.message }));
      list.push({ role, name: p.name, ok: st.ok === true, detail: st.detail ?? null });
    }
    const res = await client.call('POST', '/v/agent/heartbeat', { version: VERSION, printers: list, queue: queueDepth.n })
      .catch(e => ({ ok: false, error: e.message }));
    if (!res.ok) log(`heartbeat refused: ${res.status ?? ''} ${res.error}`);
  }

  return { tick, heartbeat, flushPending, printOne };
}

const SAMPLES = {
  batch_label: { batch_label: 'LOT-00000001-E', product: 'Gator', model: 'Hydro', color: 'Red', channel: 'ecom', packed_at: new Date().toISOString() },
  ean_label: { ean: '8908012345671', product: 'Gator', model: 'Hydro', color: 'Red' },
  ctn_label: { ctn_no: 'CTN-0000001', product: 'Gator', model: 'Hydro', color: 'Red', sku: 'GOHR', channel: 'ecom',
               unit_count: 18, manifest_version: 1, closed_at: new Date().toISOString() },
  upc_stickers: { upcs: ['LOT-00000001', 'LOT-00000002', 'LOT-00000003', 'LOT-00000004'] },
};

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const cfg = loadConfig();
  if (cmd === 'enrol') {
    if (!/^\d{8}$/.test(String(arg || ''))) { console.error('usage: node agent.mjs enrol <8-digit code>'); process.exit(2); }
    const d = await enrol(cfg.base_url, arg, KEY_FILE);
    log(`enrolled as device ${d.device_id} (${d.label || ''}) — key saved to device.json; keep that file private`);
    return;
  }
  const printers = { labels: cfg.label_printer ? openPrinter(cfg.label_printer) : null,
                     stickers: cfg.sticker_printer ? openPrinter(cfg.sticker_printer) : null };
  if (cmd === 'sample') {
    if (!SAMPLES[arg]) { console.error(`usage: node agent.mjs sample ${Object.keys(SAMPLES).join('|')}`); process.exit(2); }
    const p = arg === 'upc_stickers' ? printers.stickers : printers.labels;
    if (!p) { console.error(`no ${arg === 'upc_stickers' ? 'sticker_printer' : 'label_printer'} in config.json`); process.exit(2); }
    await p.send(build({ kind: arg, payload: SAMPLES[arg] }, cfg), `sample-${arg}`);
    log(`sample ${arg} sent to ${p.name}`);
    return;
  }
  if (cmd !== 'run') { console.error('usage: node agent.mjs enrol <code> | run | sample <kind>'); process.exit(2); }
  if (!existsSync(KEY_FILE)) { console.error('not enrolled — run: node agent.mjs enrol <code>'); process.exit(1); }
  if (!printers.labels && !printers.stickers) { console.error('config.json names no printer'); process.exit(1); }

  const client = await loadClient(KEY_FILE);
  const agent = makeAgent({ client, cfg, printers });
  log(`Outpost print agent ${VERSION} — device ${client.deviceId}`);
  log(`labels: ${printers.labels?.name || '—'} · stickers: ${printers.stickers?.name || '—'}`);
  await agent.heartbeat();
  setInterval(() => agent.heartbeat(), cfg.heartbeat_ms);
  setInterval(() => agent.tick(), cfg.poll_ms);
  agent.tick();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
