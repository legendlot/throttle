'use client';

export const AVATAR_TINTS = ['#F2CD1A', '#7b93ff', '#4ade80', '#ff8a33', '#f5a3c7', '#8ea2ff'];

function hashTint(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length];
}

function initialsOf(name) {
  const parts = String(name || '').replace(/^@/, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Avatar: Tomorrow 700 initials, #0e1015 on a tint (hash of `seed`, else of `name`; or `index`
// cycles the tints). `square` = the 16px-radius detail-header shape. `ring` = a rating colour drawn
// as box-shadow 0 0 0 3px <bg>, 0 0 0 5px <ring>.
export function Avatar({ name, seed, index, size = 34, square = false, ring, tint, style }) {
  const bg = tint || (index != null ? AVATAR_TINTS[index % AVATAR_TINTS.length] : hashTint(seed ?? name));
  const gap = size >= 56 ? 3 : 2;
  return (
    <span aria-hidden="true" style={{
      width: size, height: size, flexShrink: 0, borderRadius: square ? 16 : '50%',
      background: bg, color: '#0e1015', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-cond)', fontWeight: 700, fontSize: Math.round(size * 0.38), lineHeight: 1,
      boxShadow: ring ? `0 0 0 ${gap}px var(--bg), 0 0 0 ${gap + 2}px ${ring}` : undefined,
      transition: 'box-shadow 300ms', ...style,
    }}>
      {initialsOf(name)}
    </span>
  );
}

export default Avatar;
