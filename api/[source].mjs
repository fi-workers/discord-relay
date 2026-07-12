// Vercel Edge Function adapter.
// Files under /api are auto-mounted, so this serves /api/sentry and /api/vercel.
import { handleRequest } from '../core.mjs';

export const config = { runtime: 'edge' };

export default (request) => handleRequest(request, process.env);
