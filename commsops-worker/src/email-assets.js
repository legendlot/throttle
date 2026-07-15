// Pure helpers for the relay-email-assets image bucket. No I/O — unit-testable.
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
module.exports = { safeSeg, assetPath, signToUrls };
