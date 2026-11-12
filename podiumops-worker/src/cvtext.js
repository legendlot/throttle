// Hiring C4 — local text extraction (D3). PDF via unpdf (pdf.js serverless build), DOCX via fflate.
// Returns { text, pages } — text '' when nothing readable (a scan, a legacy .doc, an image).
import { extractText, getDocumentProxy } from 'unpdf';
import { unzipSync, strFromU8 } from 'fflate';
import { docxXmlToText } from './cvimport.js';

export async function cvText(bytes, ext) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (ext === 'pdf') {
    // pdf.js transfers (detaches) the buffer it is given — hand it a copy, or the caller's bytes go to length 0
    // (S447 live smoke: the scan fallback sent OpenAI an empty file and the 5 MB scan cap read 0).
    const pdf = await getDocumentProxy(u8.slice());
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    return { text: Array.isArray(text) ? text.join('\n') : String(text || ''), pages: totalPages || 0 };
  }
  if (ext === 'docx') {
    // Zip-bomb guard: refuse to inflate a document.xml claiming more than 5 MB.
    const files = unzipSync(u8, { filter: f => {
      if (f.name !== 'word/document.xml') return false;
      if (f.originalSize > 5 * 1024 * 1024) throw new Error('docx too large to read');
      return true;
    } });
    const xml = files['word/document.xml'];
    return { text: xml ? docxXmlToText(strFromU8(xml)) : '', pages: 0 };
  }
  return { text: '', pages: 0 };
}
