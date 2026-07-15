'use client';
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { insertMergeTag } from '@/components/email-editor/mergeTags.js';

// TEMPORARY verification harness — reproduces the exact /templates pattern
// (next/dynamic ssr:false + ref to the forwardRef EmailEditor) to prove the
// ref forwards and the export/merge-tag round-trip works. Deleted after verify.
const EmailEditor = dynamic(() => import('@/components/email-editor/EmailEditor.js'),
  { ssr: false, loading: () => <div>loading…</div> });

export default function VerifyEE() {
  const edRef = useRef(null);
  const [out, setOut] = useState({ status: 'init' });
  useEffect(() => {
    const t = setTimeout(async () => {
      const res = { status: 'ran' };
      res.ref_current_nonnull = !!edRef.current;
      const ed = edRef.current && edRef.current.getEditor && edRef.current.getEditor();
      res.getEditor_ok = !!ed;
      if (edRef.current && edRef.current.export) {
        const ex1 = edRef.current.export();
        res.export_keys = Object.keys(ex1 || {}).join(',');
        res.html_len = (ex1.html || '').length;
        res.html_is_doc = (ex1.html || '').slice(0, 15).toLowerCase().includes('doctype');
        res.text_sample = (ex1.text || '').slice(0, 50);
        res.design_ok = !!ex1.design;
        if (ed) {
          try {
            const comps = ed.getWrapper().find('mj-text');
            res.mj_text_count = comps.length;
            if (comps[0]) ed.select(comps[0]);
            res.insert_result = await insertMergeTag(ed, 'first');
            const ex2 = edRef.current.export();
            res.html_has_token_after = (ex2.html || '').includes('{first}');
          } catch (e) { res.insert_err = String(e && e.message || e); }
        }
      } else {
        res.export_missing = true;
      }
      setOut(res);
    }, 1600);
    return () => clearTimeout(t);
  }, []);
  return (
    <div style={{ padding: 20 }}>
      <h1>verify email editor</h1>
      <EmailEditor onReady={(api)=>{edRef.current=api;}} initialDesign={null} session={null} />
      <pre id="ee-out" style={{ background: '#111', color: '#0f0', padding: 12, whiteSpace: 'pre-wrap', fontSize: 12 }}>
        {JSON.stringify(out, null, 2)}
      </pre>
    </div>
  );
}
