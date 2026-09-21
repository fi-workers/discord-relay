// Cloudflare Workers adapter.
import { handleRequest } from '../core.mjs';

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
};
