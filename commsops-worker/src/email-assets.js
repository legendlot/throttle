// Pure helpers for the relay-email-assets image bucket. No I/O — unit-testable.

// Email images only. The bucket carries the same limits (file_size_limit +
// allowed_mime_types) — that is the load-bearing check, because a signed upload URL
// is issued before the file exists, so the worker can only vet the CLAIMED type.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ALLOWED_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

// validateAsset({fileName, mimeType}) → {ok:true} | {ok:false, error}
function validateAsset({ fileName, mimeType } = {}) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (!mime) return { ok: false, error: 'mime_type_required' };
  if (!ALLOWED_MIME.includes(mime)) return { ok: false, error: `mime_not_allowed:${mime}` };
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  if (!ALLOWED_EXT.includes(ext)) return { ok: false, error: `extension_not_allowed:${ext || 'none'}` };
  return { ok: true };
}

function safeSeg(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned || 'upload';
}
function assetPath(fileName, nowMs) {
  return `email/${nowMs}_${safeSeg(fileName)}`;
}
function signToUrls(env, bucket, path, signData) {
  const rel = String(signData?.url || '');
  const m = rel.match(/token=([^&]+)/);
  return {
    storage_path: path,
    token: m ? decodeURIComponent(m[1]) : null,
    public_url: `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`,
  };
}
module.exports = { safeSeg, assetPath, signToUrls, validateAsset, MAX_UPLOAD_BYTES, ALLOWED_MIME };
