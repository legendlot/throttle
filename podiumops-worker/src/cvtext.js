// Hiring C4 — local text extraction (D3). PDF via unpdf (pdf.js serverless build), DOCX via fflate.
// Returns { text, pages } — text '' when nothing readable (a scan, a legacy .doc, an image).
import { extractText, getDocumentProxy } from 'unpdf';
import { unzipSync, strFromU8 } from 'fflate';
import { docxXmlToText } from './cvimport.js';

export async function cvText(bytes, ext) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (ext === 'pdf') {
    const pdf = await getDocumentProxy(u8);
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    return { text: Array.isArray(text) ? text.join('\n') : String(text || ''), pages: totalPages || 0 };
  }
  if (ext === 'docx') {
    const files = unzipSync(u8, { filter: f => f.name === 'word/document.xml' });
    const xml = files['word/document.xml'];
    return { text: xml ? docxXmlToText(strFromU8(xml)) : '', pages: 0 };
  }
  return { text: '', pages: 0 };
}
