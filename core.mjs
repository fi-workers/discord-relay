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
  const raw = await request.text(); // read once — needed for signature verification

  try {
    if (source === 'sentry') {
      if (env.SENTRY_SECRET && !(await verify('SHA-256', env.SENTRY_SECRET, raw,
          request.headers.get('sentry-hook-signature'))))
        return new Response('bad signature', { status: 401 });
      const embed = sentryToEmbed(JSON.parse(raw));
      if (embed) await postDiscord(env.DISCORD_SENTRY_WEBHOOK, embed);
      return new Response('ok');
    }

    if (source === 'vercel') {
      if (env.VERCEL_SECRET && !(await verify('SHA-1', env.VERCEL_SECRET, raw,
          request.headers.get('x-vercel-signature'))))
        return new Response('bad signature', { status: 401 });
      const embed = vercelToEmbed(JSON.parse(raw));
      if (embed) await postDiscord(env.DISCORD_DEPLOY_WEBHOOK, embed);
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  } catch (e) {
    return new Response('error: ' + (e?.message ?? e), { status: 500 });
  }
}

// ── HMAC signature verification (Web Crypto) ──
async function verify(hash, secret, body, sigHeader) {
  if (!sigHeader) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const got = sigHeader.trim();
  if (hex.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0; // constant-time compare
}

async function postDiscord(webhook, embed) {
  if (!webhook) throw new Error('missing Discord webhook URL (check env)');
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok) throw new Error(`discord ${res.status} ${await res.text()}`);
}

// ── Sentry payload -> Discord embed ──
function sentryToEmbed(body) {
  const d = body?.data ?? {};
  const ev = d.event ?? d.issue ?? body?.event ?? {};
  const title = ev.title || ev.metadata?.value || body?.message || 'Sentry alert';
  const level = String(ev.level || 'error').toLowerCase();
  const link = ev.web_url || ev.issue_url || d.issue?.web_url || body?.url;
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
