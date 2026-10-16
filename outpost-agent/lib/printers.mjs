// Printer drivers. Each send() resolves when the printer side has the job, or throws a PrintError saying whether the
// label might have come out: sent=false → nothing reached the printer (safe to retry), sent=true → unknown.
//   windows:<name>   Windows spooler, RAW (winspool.drv through koffi)
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

// Windows spooler, RAW, straight through winspool.drv (OpenPrinter → StartDocPrinter "RAW" → WritePrinter). koffi is a
// prebuilt N-API FFI, so it runs on any Node ≥ 20 with no compiler; @thiagoelg/node-printer (the line print server's)
// has no Windows build past Node 17. Loaded on first use, so the tests and the tcp/file drivers never need it.
// State comes from PRINTER_INFO_2 (x64 layout: 13 pointers, then Attributes @104 and Status @124): an unplugged USB
// queue is usually flagged by Attributes WORK_OFFLINE, not by a Status bit.
const PRINTER_BAD = { 0x1: 'PAUSED', 0x2: 'ERROR', 0x8: 'PAPER_JAM', 0x10: 'PAPER_OUT', 0x80: 'OFFLINE',
  0x1000: 'NOT_AVAILABLE', 0x100000: 'USER_INTERVENTION', 0x400000: 'DOOR_OPEN' };
const ATTR_WORK_OFFLINE = 0x400;
// A job sent while any of these is set would wait in the Windows queue and come out later, possibly after a supervisor
// reprinted it: refuse it instead (nothing sent, so it goes back in the queue).
const HOLDS = ['PAUSED', 'OFFLINE', 'WORK_OFFLINE', 'NOT_AVAILABLE'];

let spool;
function winspool() {
  if (spool) return spool;
  let koffi;
  try { koffi = createRequire(import.meta.url)('koffi'); }
  catch { throw new Error('windows printing needs: npm install (koffi)'); }
  const lib = koffi.load('winspool.drv');
  const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
  const DOC_INFO_1 = koffi.struct('DOC_INFO_1W', { pDocName: 'str16', pOutputFile: 'str16', pDatatype: 'str16' });
  const f = (name, args) => lib.func('__stdcall', name, 'int', args);   // Win32 BOOL is a 4-byte int
  const fn = {
    open: f('OpenPrinterW', ['str16', koffi.out(koffi.pointer(HANDLE)), 'void *']),
    close: f('ClosePrinter', [HANDLE]),
    startDoc: lib.func('__stdcall', 'StartDocPrinterW', 'uint32', [HANDLE, 'uint32', koffi.pointer(DOC_INFO_1)]),
    endDoc: f('EndDocPrinter', [HANDLE]),
    abort: f('AbortPrinter', [HANDLE]),
    startPage: f('StartPagePrinter', [HANDLE]),
    endPage: f('EndPagePrinter', [HANDLE]),
    write: f('WritePrinter', [HANDLE, 'void *', 'uint32', koffi.out(koffi.pointer('uint32'))]),
    get: f('GetPrinterW', [HANDLE, 'uint32', 'void *', 'uint32', koffi.out(koffi.pointer('uint32'))]),
  };
  spool = {
    open(name) { const h = [null]; return fn.open(name, h, null) && h[0] ? h[0] : null; },
    close: h => fn.close(h) !== 0,
    startDoc: (h, doc) => fn.startDoc(h, 1, { pDocName: doc, pOutputFile: null, pDatatype: 'RAW' }) !== 0,
    startPage: h => fn.startPage(h) !== 0,
    write(h, buf) { const n = [0]; const ok = fn.write(h, buf, buf.length, n) !== 0; return ok ? n[0] : -1; },
    endPage: h => fn.endPage(h) !== 0,
    endDoc: h => fn.endDoc(h) !== 0,
    abort: h => fn.abort(h) !== 0,
    info(h) {                                         // { attributes, status } or null when unreadable
      const need = [0];
      fn.get(h, 2, null, 0, need);
      if (!need[0] || need[0] < 128) return null;
      const buf = Buffer.alloc(need[0]);
      if (!fn.get(h, 2, buf, buf.length, need)) return null;
      return { attributes: buf.readUInt32LE(104), status: buf.readUInt32LE(124) };
    },
  };
  return spool;
}

// The flags a PRINTER_INFO_2 reading raises, by name.
export function printerFlags(info) {
  const bad = Object.entries(PRINTER_BAD).filter(([bit]) => info.status & Number(bit)).map(([, v]) => v);
  if (info.attributes & ATTR_WORK_OFFLINE) bad.push('WORK_OFFLINE');
  return bad;
}

export function windowsDriver(name, w = winspool()) {   // w: the spooler calls (a fake in the tests)
  if (!String(name || '').trim()) throw new Error('windows printer needs a name: windows:<exact printer name>');
  return {
    name,
    async send(data, tag) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
      // sent=false only while nothing can have reached the printer. Spooled = handed to Windows; the in-house line
      // server treats that as printed too.
      let h;
      try { h = w.open(name); } catch (e) { throw new PrintError(`printer "${name}": ${e.message}`, false); }
      if (!h) throw new PrintError(`printer "${name}" not found`, false);
      let inDoc = false, wrote = false;
      try {
        const info = w.info(h);
        const held = info ? printerFlags(info).filter(f => HOLDS.includes(f)) : [];
        if (held.length) throw new PrintError(`printer "${name}" is ${held.join(',').toLowerCase()}`, false);
        if (!w.startDoc(h, `Outpost ${tag || 'label'}`)) throw new PrintError(`printer "${name}" refused the job`, false);
        inDoc = true;
        w.startPage(h);
        wrote = true;                                 // from here some bytes may be on their way
        const n = w.write(h, buf);
        if (n !== buf.length) throw new PrintError(`printer "${name}" took ${Math.max(n, 0)} of ${buf.length} bytes`, true);
        w.endPage(h);
        inDoc = false;
        if (!w.endDoc(h)) throw new PrintError(`printer "${name}" did not finish the job`, true);
      } catch (e) {
        if (inDoc) { try { w.abort(h); } catch { /* closing anyway */ } }   // drop a half-written job, never print it
        throw e instanceof PrintError ? e : new PrintError(e.message, wrote);
      } finally {
        try { w.close(h); } catch { /* gone */ }
      }
    },
    async status() {
      try {
        const h = w.open(name);
        if (!h) return { ok: false, detail: 'not found' };
        try {
          const info = w.info(h);
          if (!info) return { ok: true, detail: 'status unreadable' };
          const bad = printerFlags(info);
          return { ok: !bad.length, detail: bad.join(',') || null };
        } finally { w.close(h); }
      } catch (e) { return { ok: false, detail: e.message }; }
    },
  };
}
