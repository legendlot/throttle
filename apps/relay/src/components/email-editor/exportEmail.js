import mjml2html from 'mjml-browser';
import { htmlToPlain } from './htmlToPlain.js';

export function exportEmail(editor) {
  const mjml = editor.getHtml();
  const compile = mjml2html.default || mjml2html;
  const { html, errors } = compile(mjml, { validationLevel: 'soft', minify: false });
  if (errors && errors.length) console.warn('[email-editor] MJML warnings', errors);
  return { mjml, html: html || '', text: htmlToPlain(html || ''), design: editor.getProjectData() };
}
