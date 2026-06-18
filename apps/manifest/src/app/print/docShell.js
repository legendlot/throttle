'use client';
// Shared formal-document shell + print CSS for Manifest generated docs (China PO, SF Invoice).
import React from 'react';

export function DocShell({ children }) {
  return <div className="doc-root">{children}</div>;
}

export function Loading() {
  return <div style={{ fontFamily: 'Arial, sans-serif', color: '#666', padding: 40, textAlign: 'center' }}>Preparing document…</div>;
}

export const DOC_CSS = `
  .doc-root { background:#fff; color:#111; font-family: Arial, Helvetica, sans-serif; max-width: 820px; margin: 0 auto; padding: 28px 30px; font-size: 12px; line-height: 1.45; }
  .doc-root .doc-title { text-align:center; font-size:18px; font-weight:700; letter-spacing:2px; margin-bottom:14px; }
  .doc-root .lbl { display:block; font-size:9px; color:#666; text-transform:uppercase; letter-spacing:.06em; margin-bottom:2px; }
  .doc-root table.meta { width:100%; border:1px solid #333; border-collapse:collapse; margin-bottom:14px; }
  .doc-root table.meta td { padding:6px 9px; border-right:1px solid #333; vertical-align:top; font-weight:600; }
  .doc-root table.meta td:last-child { border-right:none; }
  .doc-root .parties { display:flex; gap:0; border:1px solid #333; margin-bottom:14px; }
  .doc-root .party { flex:1; padding:9px 11px; border-right:1px solid #333; }
  .doc-root .party:last-child { border-right:none; }
  .doc-root .party .pname { font-weight:700; font-size:13px; margin-bottom:3px; }
  .doc-root table.lines { width:100%; border:1px solid #333; border-collapse:collapse; margin-bottom:12px; }
  .doc-root table.lines th { background:#f2f2f2; text-align:left; padding:7px 9px; border:1px solid #333; font-size:10px; text-transform:uppercase; letter-spacing:.04em; }
  .doc-root table.lines td { padding:6px 9px; border:1px solid #333; vertical-align:top; }
  .doc-root .c-no { width:28px; text-align:center; }
  .doc-root .c-num { text-align:right; white-space:nowrap; }
  .doc-root table.totals { width:48%; margin-left:auto; border-collapse:collapse; margin-bottom:14px; }
  .doc-root table.totals td { padding:5px 9px; }
  .doc-root table.totals td.lbl { display:table-cell; color:#333; text-transform:none; font-size:12px; }
  .doc-root table.totals tr.grand td { border-top:2px solid #333; font-weight:700; font-size:13px; }
  .doc-root .words { border:1px solid #333; padding:8px 11px; margin-bottom:14px; font-style:italic; }
  .doc-root .terms { font-size:11px; color:#333; margin-bottom:6px; }
  .doc-root .foot { margin-top:22px; padding-top:8px; border-top:1px solid #ccc; font-size:10px; color:#777; text-align:center; }
  @media screen { body { background:#525659; } .doc-root { margin:24px auto; box-shadow:0 2px 16px rgba(0,0,0,.4); } }
  @media print { @page { margin: 14mm; } body { background:#fff; } .doc-root { box-shadow:none; margin:0 auto; padding:0; } }
`;
