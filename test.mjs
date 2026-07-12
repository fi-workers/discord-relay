// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './core.mjs';

const ENV = {
  DISCORD_SENTRY_WEBHOOK: 'https://discord.test/sentry',
  DISCORD_DEPLOY_WEBHOOK: 'https://discord.test/deploy',
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
