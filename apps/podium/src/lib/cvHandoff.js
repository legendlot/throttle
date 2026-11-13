// C5 D4 — hands the CVs picked on an opening's "Upload CV" to the batch page. Module-level, so it survives a
// client-side router.push (the module stays loaded); a hard reload loses it harmlessly — the batch is just empty
// and its drop zone is there. take* removes the entry, so the files are taken exactly once.
const pending = new Map();

export function putPendingFiles(importId, files) {
  if (importId && files?.length) pending.set(String(importId), Array.from(files));
}

export function takePendingFiles(importId) {
  const k = String(importId || '');
  const files = pending.get(k) || [];
  pending.delete(k);
  return files;
}
