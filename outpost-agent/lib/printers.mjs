// Printer drivers. Each send() resolves when the printer side has the job, or throws a PrintError saying whether the
// label might have come out: sent=false → nothing reached the printer (safe to retry), sent=true → unknown.
//   windows:<name>   Windows spooler, RAW (the line print server's way; needs @thiagoelg/node-printer)
//   tcp:<host>:<port> raw socket (port 9100 on a networked TSC)
//   file:<dir>       writes <job>.prn — dry runs and template checks, nothing printed
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';

export class PrintError extends Error {
  constructor(message, sent) { super(message); this.sent = sent; }
}

export function openPrinter(spec) {
  const [type, ...rest] = String(spec || '').split(':');
  const arg = rest.join(':');
  if (type === 'file') return fileDriver(arg || './prints');
  if (type === 'tcp') return tcpDriver(arg);
  if (type === 'windows') return windowsDriver(arg);
  throw new Error(`printer "${spec}": use windows:<name>, tcp:<host>:<port> or file:<dir>`);
}

function fileDriver(dir) {
  mkdirSync(dir, { recursive: true });
  return {
    name: `file:${dir}`,
    async send(data, tag) {
      try { writeFileSync(join(dir, `${tag}.prn`), data); } catch (e) { throw new PrintError(e.message, false); }
    },
    async status() { return { ok: true, detail: 'dry run' }; },
  };
}

function tcpDriver(arg) {
  const m = /^(.+):(\d+)$/.exec(arg);
  if (!m) throw new Error('tcp printer needs host:port');
  const [host, port] = [m[1], Number(m[2])];
  let last = { ok: null, detail: 'not used yet' };
  return {
    name: `tcp:${arg}`,
    send(data) {
      return new Promise((resolve, reject) => {
        let wrote = false;
        let done = false;
        const s = net.createConnection({ host, port, timeout: 8000 }, () => {
          wrote = true;
          s.end(data, 'latin1', err => {
            if (err) return bad(err.message);              // a failed write may still have put bytes on the printer
            done = true; s.setTimeout(0); s.destroy();
            last = { ok: true, detail: null }; resolve();
          });
        });
        const bad = msg => {
          if (done) return;
          done = true; s.destroy(); last = { ok: false, detail: msg }; reject(new PrintError(msg, wrote));
        };
        s.on('timeout', () => bad('printer timed out'));
        s.on('error', e => bad(e.message));
      });
    },
    async status() { return last; },
  };
}

function windowsDriver(name) {
  let printer;
  try { printer = createRequire(import.meta.url)('@thiagoelg/node-printer'); }
  catch { throw new Error('windows printing needs: npm install @thiagoelg/node-printer'); }
  return {
    name,
    send(data) {
      // Missing printer = provably nothing sent. Any error from printDirect itself may follow a partial write to the
      // spooler (the native module throws after partial writes), so it is "unknown", never a silent retry.
      try { if (!printer.getPrinter(name)) throw new Error('not found'); }
      catch (e) { return Promise.reject(new PrintError(`printer "${name}" not found: ${e.message}`, false)); }
      return new Promise((resolve, reject) => {
        try {
          // Spooled = handed to Windows; the in-house line server treats that as printed too.
          printer.printDirect({ data, printer: name, type: 'RAW', success: () => resolve(),
            error: e => reject(new PrintError(String(e?.message || e), true)) });
        } catch (e) { reject(new PrintError(e.message, true)); }
      });
    },
    async status() {
      try {
        const p = printer.getPrinter(name);
        const st = [].concat(p?.status || []).join(',');
        return { ok: !!p && !/ERROR|OFFLINE|PAPER|NOT_AVAILABLE/i.test(st), detail: st || null };
      } catch (e) { return { ok: false, detail: `not found: ${e.message}` }; }
    },
  };
}
