import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http';
import { serverlessHandler, type PilotService } from './runtime.js';

/** Exported factory permits HTTP tests without starting a long-lived server on Vercel. */
export function createVercelHandler(load: (service: PilotService) => Promise<RequestListener> = serverlessHandler) {
  const handlers = new Map<PilotService, Promise<RequestListener>>();
  return async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      // vercel.json passes the original route explicitly; do not depend on URL rewrite behavior.
      const routes = url.searchParams.getAll('pilotRoute');
      if (routes.length > 1) { response.statusCode = 400; response.end(JSON.stringify({ error: 'Invalid route' })); return; }
      const path = routes[0] === undefined ? url.pathname : '/api/' + routes[0];
      const service = path.split('/')[2];
      if (!['pilot', 'social', 'paymaster'].includes(service ?? '') || !path.startsWith('/api/')) {
        response.statusCode = 404; response.end(JSON.stringify({ error: 'Not found' })); return;
      }
      url.searchParams.delete('pilotRoute');
      request.url = path + (url.searchParams.size ? '?' + url.searchParams.toString() : '');
      const key = service as PilotService;
      let handler = handlers.get(key);
      if (!handler) {
        handler = load(key).catch(error => { handlers.delete(key); throw error; });
        handlers.set(key, handler);
      }
      await (await handler)(request, response);
    } catch {
      // Neither credentials, provider errors nor private signed bytes belong in HTTP errors/logs.
      if (!response.headersSent) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: 'Pilot backend unavailable; retry the saved request shortly' }));
      } else if (!response.writableEnded) response.end();
    }
  };
}
