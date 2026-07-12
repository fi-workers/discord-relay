// core.mjs — runtime-agnostic webhook relay.
// Depends only on Web-standard APIs (Request/Response, fetch, crypto.subtle),
// so the same file runs on Cloudflare Workers, Vercel Edge, Node 18+, Bun, Deno.
//
// Routes:
//   POST .../sentry  -> Sentry Internal Integration webhook  -> Discord embed
//   POST .../vercel  -> Vercel team Webhook                   -> Discord embed
//
// Secrets come from `env` (never hard-coded):
//   DISCORD_SENTRY_WEBHOOK, DISCORD_DEPLOY_WEBHOOK   (required)
//   SENTRY_SECRET, VERCEL_SECRET                     (optional; enable HMAC verify)

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET') return new Response('discord-relay: ok', { status: 200 });
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const source = url.pathname.split('/').filter(Boolean).pop(); // "sentry" | "vercel"
  // Read raw bytes once: sign over the exact bytes the sender signed, decode for JSON.
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  const raw = new TextDecoder().decode(rawBytes);

  try {
    if (source === 'sentry') {
      if (env.SENTRY_SECRET && !(await verify('SHA-256', env.SENTRY_SECRET, rawBytes,
          request.headers.get('sentry-hook-signature'))))
        return new Response('bad signature', { status: 401 });
      const embed = sentryToEmbed(JSON.parse(raw));
      if (embed) await sendToDiscord(env, 'sentry', embed);
      return new Response('ok');
    }

    if (source === 'vercel') {
      if (env.VERCEL_SECRET && !(await verify('SHA-1', env.VERCEL_SECRET, rawBytes,
          request.headers.get('x-vercel-signature'))))
        return new Response('bad signature', { status: 401 });
      const embed = vercelToEmbed(JSON.parse(raw));
      if (embed) await sendToDiscord(env, 'deploy', embed);
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  } catch (e) {
    return new Response('error: ' + (e?.message ?? e), { status: 500 });
  }
}

// ── HMAC signature verification (Web Crypto) ──
// `bodyBytes` are the exact received bytes; sign over those, not a re-encoded string.
async function verify(hash, secret, bodyBytes, sigHeader) {
  if (!sigHeader) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, bodyBytes);
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // Providers send bare lowercase hex; normalize case and strip an optional "algo=" prefix.
  const got = sigHeader.trim().toLowerCase().replace(/^[a-z0-9]+=/, '');
  if (hex.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0; // constant-time compare
}

// Pick destination by kind. Two modes, chosen by which env vars are set:
//   Bot mode     (DISCORD_BOT_TOKEN set): REST call to the channel — stateless
//                HTTP, no Gateway/session needed, fine on serverless.
//   Webhook mode (default): POST straight to the channel webhook URL.
async function sendToDiscord(env, kind, embed) {
  const body = JSON.stringify({ embeds: [embed] });
  if (env.DISCORD_BOT_TOKEN) {
    const channelId = kind === 'sentry' ? env.DISCORD_SENTRY_CHANNEL_ID : env.DISCORD_DEPLOY_CHANNEL_ID;
    if (!channelId) throw new Error(`missing Discord channel id for "${kind}" (check env)`);
    return post(`https://discord.com/api/v10/channels/${channelId}/messages`, body, `Bot ${env.DISCORD_BOT_TOKEN}`);
  }
  const webhook = kind === 'sentry' ? env.DISCORD_SENTRY_WEBHOOK : env.DISCORD_DEPLOY_WEBHOOK;
  return post(webhook, body);
}

async function post(url, body, auth) {
  if (!url) throw new Error('missing Discord destination (check env)');
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  const send = () => fetch(url, { method: 'POST', headers, body });
  let res = await send();
  if (res.status === 429) { // rate limited — honor Retry-After once, then retry
    const wait = Math.min(Number(res.headers.get('retry-after')) || 1, 5);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await send();
  }
  if (!res.ok) throw new Error(`discord ${res.status} ${await res.text()}`);
}

// ── Sentry payload -> Discord embed ──
function sentryToEmbed(body) {
  const d = body?.data ?? {};
  const ev = d.event ?? d.issue ?? d.error ?? body?.event ?? {};
  const title = ev.title || ev.metadata?.value || ev.message || body?.message || 'Sentry alert';
  const level = String(ev.level || 'error').toLowerCase();
  const link = ev.web_url || ev.issue_url || ev.url || d.issue?.web_url || d.web_url || body?.url;
  const color = { fatal: 0xc24036, error: 0xc24036, warning: 0xe0a03a, info: 0x5a6379 }[level] ?? 0xc24036;
  return {
    title: `🔴 ${title}`.slice(0, 256),
    url: link,
    color,
    fields: [
      { name: 'Level', value: level, inline: true },
      { name: 'Env', value: ev.environment || 'unknown', inline: true },
      ev.culprit ? { name: 'Culprit', value: String(ev.culprit).slice(0, 1024) } : null,
    ].filter(Boolean),
  };
}

// ── Vercel payload -> Discord embed (noise filter: skip preview successes) ──
function vercelToEmbed(body) {
  const type = body?.type || '';
  const p = body?.payload ?? {};
  const dep = p.deployment ?? {};
  const target = p.target || dep.target || 'preview';

  if (type === 'deployment.succeeded' && target !== 'production') return null;

  const name = p.name || dep.name || p.project?.id || 'project';
  const rawUrl = dep.url || p.url;
  const link = rawUrl ? (rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl) : p.links?.deployment;
  const commit = dep.meta?.githubCommitMessage || p.meta?.githubCommitMessage;

  const map = {
    'deployment.succeeded': ['🟢', 'Ready', 0x3ba55d],
    'deployment.error': ['🔴', 'Failed', 0xc24036],
    'deployment.canceled': ['⚪', 'Canceled', 0x5a6379],
    'deployment.created': ['🔵', 'Started', 0x5865f2],
  };
  const [emoji, label, color] = map[type] || ['📦', type || 'Deployment', 0x5a6379];

  return {
    title: `${emoji} ${label} · ${name}`.slice(0, 256),
    url: link,
    color,
    description: commit ? '`' + String(commit).slice(0, 300) + '`' : undefined,
    fields: [
      { name: 'Target', value: target, inline: true },
      { name: 'Event', value: String(type).replace('deployment.', '') || '-', inline: true },
    ],
  };
}
