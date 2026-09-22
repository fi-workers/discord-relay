// Vercel Edge Function adapter.
// Files under /api are auto-mounted, so this serves /api/sentry and /api/vercel.
import { handleRequest } from '../core.mjs';

export const config = { runtime: 'edge' };

// Vercel passes a RequestContext with waitUntil — that is what lets us ack first.
export default (request, context) => handleRequest(request, process.env, context);
