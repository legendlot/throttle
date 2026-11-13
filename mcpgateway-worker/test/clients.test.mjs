import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_PROFILES, clientAllowlists, clientLabel, pageCsp, MIN_PREFIX_LEN } from '../src/clients.js';
import { OPENAI_CONNECTOR_CIDRS } from '../src/openai-cidrs.js';
import { parseCidrs, ipAllowed, redirectAllowed, registrationAllowed } from '../src/checks.js';

const envNow = {
  ALLOWED_CIDRS: '160.79.104.0/21,153.61.208.0/20',
  ALLOWED_REDIRECTS: 'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback',
  ALLOWED_CLIENT_DOMAINS: 'claude.ai,claude.com',
  ALLOWED_ORIGINS: 'https://claude.ai,https://claude.com',
};

test('Claude keeps working exactly as before', () => {
  const a = clientAllowlists(envNow);
  const cidrs = parseCidrs(a.cidrs);
  assert.ok(ipAllowed('160.79.106.17', cidrs));
  assert.ok(redirectAllowed('https://claude.ai/api/mcp/auth_callback', a.redirects));
  assert.ok(a.domains.includes('claude.ai') && a.origins.includes('https://claude.ai'));
});

test('ChatGPT is allowed: its stable redirect, chatgpt.com CIMD domain, and the IPs it was blocked from on 10 Nov', () => {
  const a = clientAllowlists(envNow);
  const cidrs = parseCidrs(a.cidrs);
  for (const ip of ['172.198.79.114', '172.198.79.117', '172.198.79.127']) assert.ok(ipAllowed(ip, cidrs), ip);
  assert.ok(redirectAllowed('https://chatgpt.com/connector_platform_oauth_redirect', a.redirects));
  assert.ok(registrationAllowed({ redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }, a.redirects));
  assert.ok(a.domains.includes('chatgpt.com'));
  assert.equal(clientLabel('https://chatgpt.com/connector_platform_oauth_redirect'), 'ChatGPT');
  assert.equal(clientLabel('https://claude.ai/api/mcp/auth_callback'), 'Claude');
});

test('still exact-match: near-miss redirects, other hosts and other IPs are refused', () => {
  const a = clientAllowlists(envNow);
  const cidrs = parseCidrs(a.cidrs);
  for (const u of ['https://chatgpt.com/connector_platform_oauth_redirect/', 'https://chatgpt.com/connector_platform_oauth_redirect?x=1',
    'http://chatgpt.com/connector_platform_oauth_redirect', 'https://evil.chatgpt.com.example/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/abc123', 'https://chat.openai.com/connector_platform_oauth_redirect']) {
    assert.equal(redirectAllowed(u, a.redirects), false, u);
  }
  assert.equal(registrationAllowed({ redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect', 'https://evil.example/cb'] }, a.redirects), false);
  for (const ip of ['8.8.8.8', '1.1.1.1', '223.188.58.245', '106.51.226.225', '::1', '']) assert.equal(ipAllowed(ip, cidrs), false, ip);
  assert.equal(clientLabel('https://evil.example/cb'), 'an AI app');
});

test('profiles are well-formed: https only, no wildcards, every CIDR parses, OpenAI list is substantial', () => {
  for (const p of CLIENT_PROFILES) {
    assert.ok(p.key && p.label);
    for (const r of p.redirects) assert.match(r, /^https:\/\/[a-z0-9.-]+\/[^\s*?#]+$/);
    for (const o of p.origins) assert.match(o, /^https:\/\/[a-z0-9.-]+$/);
    for (const d of p.domains) assert.match(d, /^[a-z0-9.-]+\.[a-z]+$/);
    assert.doesNotThrow(() => parseCidrs(p.cidrs.join(',')));
    // Feed-derived (ChatGPT) ranges: /23 or narrower. Hand-pinned vendor ranges (Anthropic /21, /20): /16 or narrower.
    for (const c of p.cidrs) assert.ok(Number(c.split('/')[1]) >= (p.key === 'chatgpt' ? MIN_PREFIX_LEN : 16), `too broad: ${c}`);
  }
  assert.ok(OPENAI_CONNECTOR_CIDRS.length >= 50);
  assert.equal(new Set(clientAllowlists(envNow).redirects).size, clientAllowlists(envNow).redirects.length);
});

test('profiles alone (no env) still admit Claude and ChatGPT', () => {
  const a = clientAllowlists({});
  const cidrs = parseCidrs(a.cidrs);
  assert.ok(ipAllowed('160.79.106.17', cidrs) && ipAllowed('172.198.79.114', cidrs));
  assert.ok(a.redirects.includes('https://claude.ai/api/mcp/auth_callback') && a.redirects.includes('https://chatgpt.com/connector_platform_oauth_redirect'));
});
test('the Microsoft /16 in OpenAI\'s feed is not allowed; a /0 could never be', () => {
  const cidrs = parseCidrs(clientAllowlists({}).cidrs);
  assert.equal(ipAllowed('9.129.10.10', cidrs), false);
  assert.ok(OPENAI_CONNECTOR_CIDRS.includes('9.129.0.0/16')); // still in the generated file, filtered at runtime
  assert.ok(ipAllowed('199.47.142.5', cidrs)); // OpenAI-registered /23 kept
});
test('consent-page CSP lets Cancel land on every app\'s callback origin', () => {
  const csp = pageCsp();
  for (const p of CLIENT_PROFILES) for (const r of p.redirects) assert.ok(csp.includes(new URL(r).origin), r);
  assert.match(csp, /form-action 'self' https:\/\/accounts\.google\.com /);
  assert.match(csp, /frame-ancestors 'none'/);
});
