// The AI apps allowed to connect to lotmcp. Each is ONE profile here: its exact OAuth redirect URIs,
// its verified client-metadata domains (CIMD), its browser Origins, and the published IP ranges its
// servers call from. Every list is exact-match (no patterns). Adding an app = a profile + tests +
// /hostile-review + Codex, never a wildcard. The wrangler.toml ALLOWED_* vars are still honoured (merged in).
import { OPENAI_CONNECTOR_CIDRS } from './openai-cidrs.js';

// No published range broader than this is accepted: OpenAI's feed carries 9.129.0.0/16, which is Microsoft
// address space (RIPE UK-MICROSOFT, hostile review 2026-11-13) and would be 95% of the addresses it adds.
// If ChatGPT is ever seen calling from a dropped block, store.mcp_audit shows ip_blocked rows from it.
export const MIN_PREFIX_LEN = 23;
const notTooBroad = c => Number(c.split('/')[1]) >= MIN_PREFIX_LEN;

export const CLIENT_PROFILES = [
  {
    key: 'claude', label: 'Claude',
    redirects: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'],
    domains: ['claude.ai', 'claude.com'],
    origins: ['https://claude.ai', 'https://claude.com'],
    cidrs: ['160.79.104.0/21', '153.61.208.0/20'], // Anthropic's published outbound ranges
  },
  {
    // ChatGPT custom connector (developer mode). lotmcp meets RFC 9207 issuer identification, so ChatGPT
    // uses its stable redirect + CIMD client https://chatgpt.com/oauth/client.json (fetched 2026-11-13).
    key: 'chatgpt', label: 'ChatGPT',
    redirects: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    domains: ['chatgpt.com'],
    origins: ['https://chatgpt.com'],
    cidrs: OPENAI_CONNECTOR_CIDRS.filter(notTooBroad), // openai.com/chatgpt-connectors.json; refresh: scripts/refresh-openai-cidrs.mjs
  },
];

const uniq = a => [...new Set(a)];
const listOf = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

// The merged allowlists the gateway enforces.
export function clientAllowlists(env = {}) {
  return {
    redirects: uniq([...CLIENT_PROFILES.flatMap(p => p.redirects), ...listOf(env.ALLOWED_REDIRECTS)]),
    domains: uniq([...CLIENT_PROFILES.flatMap(p => p.domains), ...listOf(env.ALLOWED_CLIENT_DOMAINS)]),
    origins: uniq([...CLIENT_PROFILES.flatMap(p => p.origins), ...listOf(env.ALLOWED_ORIGINS)]),
    cidrs: uniq([...CLIENT_PROFILES.flatMap(p => p.cidrs), ...listOf(env.ALLOWED_CIDRS)]).join(','),
  };
}

// Which app a redirect URI belongs to (exact match), for page and Slack wording. 'an AI app' if none.
export function clientLabel(redirectUri) {
  const p = CLIENT_PROFILES.find(x => x.redirects.includes(redirectUri));
  return p ? p.label : 'an AI app';
}
export const CLIENT_NAMES = CLIENT_PROFILES.map(p => p.label).join(' or ');

// The consent pages' CSP: forms may post to us and Google, and land (after a redirect) on any app's callback origin.
export function pageCsp() {
  const origins = [...new Set(CLIENT_PROFILES.flatMap(p => p.redirects).map(u => new URL(u).origin))];
  return `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com ${origins.join(' ')}; frame-ancestors 'none'`;
}
