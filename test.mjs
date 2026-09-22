// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './core.mjs';

const ENV = {
  DISCORD_SENTRY_WEBHOOK: 'https://discord.test/sentry',
  DISCORD_DEPLOY_WEBHOOK: 'https://discord.test/deploy',
  DISCORD_GITHUB_WEBHOOK: 'https://discord.test/github',
};

// Capture the outgoing Discord call by stubbing global fetch.
function withFetch(fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, auth: opts.headers?.authorization, embed: JSON.parse(opts.body).embeds[0] });
    return new Response('ok', { status: 200 });
  };
  return fn(calls).finally(() => { globalThis.fetch = orig; });
}

const post = (path, body, headers = {}) =>
  handleRequest(new Request('http://x' + path, {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
  }), ENV);

async function hmacHex(hash, secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

test('GET / is a health check', async () => {
  const r = await handleRequest(new Request('http://x/'), ENV);
  assert.equal(r.status, 200);
});

test('vercel production success -> green embed with commit (webhook mode)', () => withFetch(async (calls) => {
  const r = await post('/api/vercel', { type: 'deployment.succeeded', payload: {
    name: 'app', target: 'production', deployment: { url: 'app.vercel.app', meta: { githubCommitMessage: 'fix: bug' } } } });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENV.DISCORD_DEPLOY_WEBHOOK);
  assert.equal(calls[0].auth, undefined); // webhook mode: no auth header
  assert.match(calls[0].embed.title, /🟢 Ready · app/);
  assert.equal(calls[0].embed.url, 'https://app.vercel.app');
}));

test('bot mode: posts to channel REST endpoint with Bot auth', () => {
  const botEnv = { DISCORD_BOT_TOKEN: 'tok', DISCORD_DEPLOY_CHANNEL_ID: '123' };
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, auth: opts.headers?.authorization });
    return new Response('ok', { status: 200 });
  };
  return handleRequest(new Request('http://x/api/vercel', { method: 'POST', body: JSON.stringify({
    type: 'deployment.error', payload: { name: 'app', target: 'production', deployment: { url: 'x' } } }) }), botEnv)
    .then((r) => {
      assert.equal(r.status, 200);
      assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/123/messages');
      assert.equal(calls[0].auth, 'Bot tok');
    })
    .finally(() => { globalThis.fetch = orig; });
});

test('bot mode without channel id -> 500', () => {
  return handleRequest(new Request('http://x/api/sentry', { method: 'POST', body: JSON.stringify({ data: { event: { title: 't' } } }) }),
    { DISCORD_BOT_TOKEN: 'tok' }).then((r) => assert.equal(r.status, 500));
});

test('vercel preview success is filtered (no Discord call)', () => withFetch(async (calls) => {
  const r = await post('/api/vercel', { type: 'deployment.succeeded', payload: {
    name: 'app', target: 'preview', deployment: { url: 'x.vercel.app' } } });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 0);
}));

test('vercel error -> red embed', () => withFetch(async (calls) => {
  await post('/api/vercel', { type: 'deployment.error', payload: {
    name: 'app', target: 'production', deployment: { url: 'x.vercel.app' } } });
  assert.match(calls[0].embed.title, /🔴 Failed/);
}));

test('sentry event -> title + link', () => withFetch(async (calls) => {
  await post('/api/sentry', { data: { event: {
    title: 'TypeError: x', level: 'error', environment: 'production', web_url: 'https://sentry.io/i/1' } } });
  assert.match(calls[0].embed.title, /TypeError: x/);
  assert.equal(calls[0].embed.url, 'https://sentry.io/i/1');
}));

test('github push -> commit list embed', () => withFetch(async (calls) => {
  await handleRequest(new Request('http://x/api/github', {
    method: 'POST', headers: { 'x-github-event': 'push' },
    body: JSON.stringify({ ref: 'refs/heads/main', compare: 'https://gh/compare',
      repository: { full_name: 'fi/relay' }, sender: { login: 'jh' },
      commits: [{ id: 'abcdef1234', message: 'feat: x\n\nbody' }] }) }), ENV);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENV.DISCORD_GITHUB_WEBHOOK);
  assert.match(calls[0].embed.title, /1 commit · fi\/relay:main/);
  assert.match(calls[0].embed.description, /`abcdef1` feat: x/);
}));

test('github PR merged -> purple embed', () => withFetch(async (calls) => {
  await handleRequest(new Request('http://x/api/github', {
    method: 'POST', headers: { 'x-github-event': 'pull_request' },
    body: JSON.stringify({ action: 'closed', repository: { full_name: 'fi/relay' },
      pull_request: { title: 'Add X', number: 7, merged: true, html_url: 'https://gh/pr/7' } }) }), ENV);
  assert.match(calls[0].embed.title, /PR merged: Add X/);
  assert.equal(calls[0].embed.color, 0x8957e5);
}));

test('github ping -> 200, no post', () => withFetch(async (calls) => {
  const r = await handleRequest(new Request('http://x/api/github', {
    method: 'POST', headers: { 'x-github-event': 'ping' }, body: JSON.stringify({ zen: 'hi' }) }), ENV);
  assert.equal(r.status, 200);
  assert.equal(calls.length, 0);
}));

test('github workflow_run success is filtered', () => withFetch(async (calls) => {
  await handleRequest(new Request('http://x/api/github', {
    method: 'POST', headers: { 'x-github-event': 'workflow_run' },
    body: JSON.stringify({ action: 'completed', repository: { full_name: 'fi/relay' },
      workflow_run: { name: 'CI', conclusion: 'success' } }) }), ENV);
  assert.equal(calls.length, 0);
}));

test('sentry issue resolved is filtered (no post)', () => withFetch(async (calls) => {
  await post('/api/sentry', { action: 'resolved', data: { issue: { title: 'x', web_url: 'https://s' } } });
  assert.equal(calls.length, 0);
}));

test('sentry issue created posts', () => withFetch(async (calls) => {
  await post('/api/sentry', { action: 'created', data: { issue: { title: 'NewError', web_url: 'https://s' } } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].embed.title, /NewError/);
}));

test('signature required but missing -> 401', () => withFetch(async (calls) => {
  const r = await handleRequest(new Request('http://x/api/vercel', { method: 'POST', body: '{}' }),
    { ...ENV, VERCEL_SECRET: 'sek' });
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
}));

test('valid HMAC signature passes (case-insensitive)', () => withFetch(async (calls) => {
  const body = JSON.stringify({ type: 'deployment.error', payload: { name: 'app', target: 'production', deployment: { url: 'x' } } });
  const sig = (await hmacHex('SHA-1', 'sek', body)).toUpperCase(); // sender uppercase
  const r = await handleRequest(new Request('http://x/api/vercel', {
    method: 'POST', headers: { 'x-vercel-signature': sig }, body }), { ...ENV, VERCEL_SECRET: 'sek' });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
}));

test('tampered body with signature -> 401', () => withFetch(async (calls) => {
  const sig = await hmacHex('SHA-1', 'sek', '{"a":1}');
  const r = await handleRequest(new Request('http://x/api/vercel', {
    method: 'POST', headers: { 'x-vercel-signature': sig }, body: '{"a":2}' }), { ...ENV, VERCEL_SECRET: 'sek' });
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
}));

// ── Ack before delivery ──
// Sentry gives a webhook a few seconds and does not retry. post() sleeps up to 5s
// to honor a Discord 429, so waiting on delivery burns that budget: 7 of 56
// issue.created deliveries were recorded as resp=0 (no response), while every
// filtered action — which never calls Discord — returned 200.

// A fetch stub whose completion we control, so we can look at the moment
// between "responded" and "delivered".
function withSlowFetch(fn) {
  const calls = [];
  const state = { delivered: false };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, embed: JSON.parse(opts.body).embeds[0] });
    await new Promise((r) => setTimeout(r, 50));
    state.delivered = true;
    return new Response('ok', { status: 200 });
  };
  return fn(calls, state).finally(() => { globalThis.fetch = orig; });
}

const sentryIssue = { action: 'created', data: { event: {
  title: 'TypeError: x', level: 'error', web_url: 'https://sentry.io/i/1' } } };

test('with waitUntil, the ack does not wait on Discord', () => withSlowFetch(async (calls, state) => {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };

  const r = await handleRequest(new Request('http://x/api/sentry', {
    method: 'POST', body: JSON.stringify(sentryIssue) }), ENV, ctx);

  assert.equal(r.status, 200);
  assert.equal(state.delivered, false, 'responded before Discord finished');

  await Promise.all(pending);
  assert.equal(state.delivered, true, 'delivery still completes in the background');
  assert.equal(calls.length, 1);
}));

test('background delivery failure does not reject the waitUntil promise', () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  return handleRequest(new Request('http://x/api/sentry', {
    method: 'POST', body: JSON.stringify(sentryIssue) }), ENV, ctx)
    .then(async (r) => {
      assert.equal(r.status, 200);
      // An unhandled rejection would tear down the isolate on some runtimes.
      await Promise.all(pending);
    })
    .finally(() => { globalThis.fetch = orig; });
});

test('without waitUntil, delivery still awaits so failures surface', () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  return handleRequest(new Request('http://x/api/sentry', {
    method: 'POST', body: JSON.stringify(sentryIssue) }), ENV)
    .then((r) => assert.equal(r.status, 500))
    .finally(() => { globalThis.fetch = orig; });
});
