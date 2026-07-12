// Node / Bun / Deno adapter — for self-hosting. Zero dependencies.
import { handleRequest } from './core.mjs';

const PORT = Number(process.env.PORT || 3000);

// Node 18+ (global Request/Response/fetch via undici)
import { createServer } from 'node:http';
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  // req.headers may hold arrays for repeated headers — the Headers ctor rejects those.
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else if (v != null) headers.set(k, v);
  }
  const request = new Request('http://localhost' + req.url, {
    method: req.method,
    headers,
    body: /^(GET|HEAD)$/.test(req.method) ? undefined : Buffer.concat(chunks),
  });
  const out = await handleRequest(request, process.env);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(await out.text());
}).listen(PORT, () => console.log(`discord-relay on :${PORT}`));

// Bun:  Bun.serve({ port: PORT, fetch: (r) => handleRequest(r, Bun.env) });
// Deno: Deno.serve({ port: PORT }, (r) => handleRequest(r, Deno.env.toObject()));
