// src/xlsx-lite.mjs — a minimal, pure .xlsx reader for the Cloudflare Workers runtime.
// No npm deps, no Node built-ins: zip central-directory walk by hand + DecompressionStream('deflate-raw')
// for the (only) compression method Excel uses. Reads exactly what the Flipkart report needs — cell
// values by column letter, shared strings, inline strings — not a general spreadsheet library.

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

// Uint8Array -> string, ASCII/UTF-8 zip entry names are all this build ever sees.
const dec = new TextDecoder();

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Scan backwards for the End-Of-Central-Directory record. The comment field (0-65535 bytes) is the
// only variable-length thing after it, so search the last 64KB+22.
function findEocd(view, bytes) {
  const max = Math.min(bytes.length, 65557); // 22 (EOCD) + 65535 (max comment)
  const start = bytes.length - max;
  for (let i = bytes.length - 22; i >= start && i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new Error('xlsx-lite: not a zip file (End-Of-Central-Directory signature not found)');
}

export async function unzipEntries(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOff = findEocd(view, bytes);
  const entryCount = view.getUint16(eocdOff + 10, true);
  let cenOff = view.getUint32(eocdOff + 16, true);

  const out = new Map();
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(cenOff, true) !== CEN_SIG) throw new Error(`xlsx-lite: central directory entry ${i} has a bad signature`);
    const method = view.getUint16(cenOff + 10, true);
    const compSize = view.getUint32(cenOff + 20, true);
    const nameLen = view.getUint16(cenOff + 28, true);
    const extraLen = view.getUint16(cenOff + 30, true);
    const commentLen = view.getUint16(cenOff + 32, true);
    const localOff = view.getUint32(cenOff + 42, true);
    const name = dec.decode(bytes.subarray(cenOff + 46, cenOff + 46 + nameLen));

    if (view.getUint32(localOff, true) !== LOC_SIG) throw new Error(`xlsx-lite: local file header for "${name}" has a bad signature`);
    const locNameLen = view.getUint16(localOff + 26, true);
    const locExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + locNameLen + locExtraLen;
    const slice = bytes.subarray(dataStart, dataStart + compSize);

    if (!name.endsWith('/')) {
      if (method === 0) out.set(name, slice.slice());
      else if (method === 8) out.set(name, await inflate(slice));
      else throw new Error(`xlsx-lite: entry "${name}" uses unsupported compression method ${method}`);
    }
    cenOff += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Decode the XML entities this build can see in Flipkart's export: named + numeric (decimal/hex).
function decodeXmlEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (m, e) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default:
        return e[1] === 'x'
          ? String.fromCodePoint(parseInt(e.slice(2), 16))
          : String.fromCodePoint(parseInt(e.slice(1), 10));
    }
  });
}

// Every <t> inside one <si>...</si> (or the single <t> of an inline <is>...</is>), concatenated —
// rich-text runs split one string across several <t> siblings.
function joinRuns(siOrIsXml) {
  const parts = [];
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(siOrIsXml))) parts.push(decodeXmlEntities(m[1]));
  return parts.join('');
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) out.push(joinRuns(m[1]));
  return out;
}

// xl/workbook.xml sheet order -> r:id, then xl/_rels/workbook.xml.rels r:id -> worksheet path.
function resolveSheetPath(workbookXml, relsXml, sheetIndex) {
  if (workbookXml) {
    const sheets = [...workbookXml.matchAll(/<sheet\b[^>]*\/>/g)].map(m => m[0]);
    const sheet = sheets[sheetIndex];
    if (sheet) {
      const ridM = /r:id="([^"]+)"/.exec(sheet);
      const rid = ridM && ridM[1];
      if (rid && relsXml) {
        const relM = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*\\/>`).exec(relsXml);
        if (relM) {
          const targetM = /Target="([^"]+)"/.exec(relM[0]);
          if (targetM) {
            let target = targetM[1];
            if (target.startsWith('/')) return target.slice(1);
            return `xl/${target.replace(/^\.?\//, '')}`;
          }
        }
      }
    }
  }
  return `xl/worksheets/sheet${sheetIndex + 1}.xml`;
}

function cellValue(cellXml, t, sharedStrings) {
  if (t === 'inlineStr') {
    const isM = /<is>([\s\S]*?)<\/is>/.exec(cellXml);
    return isM ? joinRuns(isM[1]) : null;
  }
  const vM = /<v>([\s\S]*?)<\/v>/.exec(cellXml);
  if (!vM) return undefined; // no value at all — caller skips the cell
  const raw = vM[1];
  if (t === 's') {
    const idx = Number(raw);
    return sharedStrings[idx] ?? null;
  }
  if (t === 'str') return decodeXmlEntities(raw);
  if (t === 'b') return raw === '1';
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function readXlsxSheet(bytes, sheetIndex = 0) {
  const entries = await unzipEntries(bytes);
  const decodeEntry = name => (entries.has(name) ? dec.decode(entries.get(name)) : null);

  const workbookXml = decodeEntry('xl/workbook.xml');
  const relsXml = decodeEntry('xl/_rels/workbook.xml.rels');
  const sheetPath = resolveSheetPath(workbookXml, relsXml, sheetIndex);
  if (!entries.has(sheetPath)) throw new Error(`xlsx-lite: worksheet entry "${sheetPath}" not found in the archive`);

  const sharedStrings = parseSharedStrings(decodeEntry('xl/sharedStrings.xml'));
  const sheetXml = dec.decode(entries.get(sheetPath));

  const rows = [];
  const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rowM;
  while ((rowM = rowRe.exec(sheetXml))) {
    const r = Number(rowM[1]);
    const rowXml = rowM[2];
    const obj = {};
    let any = false;
    // Two top-level alternatives, not a nested one: a self-closed <c .../> (no value) must not let
    // its trailing "/" get swallowed by the "[^>]*" of the open-tag branch, which would make that
    // branch's ">...</c>" match span into the FOLLOWING cell (silently steals its value+column).
    const cellRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
    let cellM;
    while ((cellM = cellRe.exec(rowXml))) {
      const attrs = cellM[1] !== undefined ? cellM[1] : cellM[2];
      const inner = cellM[3] || '';
      const refM = /\br="([A-Z]+)\d+"/.exec(attrs);
      if (!refM) continue;
      const tM = /\bt="([^"]+)"/.exec(attrs);
      const t = tM ? tM[1] : 'n';
      const val = cellValue(inner, t, sharedStrings);
      if (val === undefined) continue; // no <v>/<is> — skip
      obj[refM[1]] = val;
      any = true;
    }
    rows[r] = any ? obj : undefined;
  }
  return rows;
}
