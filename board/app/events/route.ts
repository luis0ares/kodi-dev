// SSE live-watch endpoint (KODI-013 / ADR-0002 §2.5).
//
// GET-only, same-origin, localhost-only Server-Sent Events stream. On connect it
// subscribes to the directory watcher (lib/watch/status-watch) and, on each
// debounced change signal, enqueues a BARE `change` event whose only data is an
// opaque monotonic tick. NO ticket data ever crosses the wire (SC-1): the stream
// is a trigger, the browser re-reads via the getBoard() server action.
//
// This route does NO fs writes and NO query/body-driven path reads. fs.watch
// needs the Node runtime (NOT edge), and the stream must never be cached.

import { subscribe, DEBOUNCE_MS } from '@/lib/watch/status-watch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

/**
 * Defense-in-depth (SC-7). Localhost bind is the primary control (the CLI binds
 * the server to 127.0.0.1 — ADR-0002 §2.4); this is the second layer:
 *  - Host header, if present, must be loopback (127.0.0.1 / [::1] / localhost),
 *  - Origin header, if present, must be same-origin as Host.
 * Anything else → reject before opening the stream.
 */
function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  // Strip an optional :port. Handles IPv6 literal `[::1]:port` too.
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0];
  return (
    hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost'
  );
}

function originIsSameHost(origin: string | null, host: string | null): boolean {
  // Origin is optional on same-origin GETs (EventSource omits it same-origin);
  // when absent we don't reject on it — Host loopback already gates.
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    return host !== null && originHost === host;
  } catch {
    return false;
  }
}

export async function GET(request: Request): Promise<Response> {
  const host = request.headers.get('host');
  const origin = request.headers.get('origin');

  if (!isLoopbackHost(host) || !originIsSameHost(origin, host)) {
    return new Response('Forbidden', { status: 403 });
  }

  let unsubscribe: (() => void) | null = null;
  let closed = false;
  let tick = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Client vanished between the abort signal and this write — never let
          // a write to a dead controller throw uncaught (SC-14). Tear down.
          teardown();
        }
      };

      const teardown = (): void => {
        if (closed) return;
        closed = true;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          /* already closed/errored */
        }
      };

      // Initial comment so the connection is established immediately, plus the
      // reconnect hint. No ticket data — just a heartbeat comment.
      safeEnqueue(`retry: ${DEBOUNCE_MS}\n`);
      safeEnqueue(': connected\n\n');

      // On each debounced change, push a bare tick. The data is opaque — the
      // client uses it only as a "refetch now" signal, never parses board data.
      unsubscribe = subscribe(() => {
        tick += 1;
        safeEnqueue(`event: change\ndata: ${Date.now()}-${tick}\n\n`);
      });

      // Symmetric teardown: unsubscribe on client abort AND on stream cancel.
      if (request.signal.aborted) {
        teardown();
      } else {
        request.signal.addEventListener('abort', teardown, { once: true });
      }
    },

    cancel() {
      // Stream consumer went away — release the subscription. Do NOT retain any
      // reference to the closed response.
      closed = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // NO permissive CORS: no Access-Control-Allow-Origin, no origin
      // reflection, no Allow-Credentials (SC-6). Same-origin only.
      'X-Accel-Buffering': 'no',
    },
  });
}

/** Any non-GET method → 405 (SC-8). */
export async function POST(): Promise<Response> {
  return methodNotAllowed();
}
export async function PUT(): Promise<Response> {
  return methodNotAllowed();
}
export async function PATCH(): Promise<Response> {
  return methodNotAllowed();
}
export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
export async function HEAD(): Promise<Response> {
  return methodNotAllowed();
}
export async function OPTIONS(): Promise<Response> {
  return methodNotAllowed();
}

function methodNotAllowed(): Response {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: 'GET' },
  });
}
