// SSE live-watch endpoint (KODI-013 / ADR-0002 §2.5) — route handler tests.
// Covers method gating (405), same-origin/loopback gating (403), the 200 stream
// headers with NO permissive CORS (SC-6), the BARE opaque `change` event shape
// (SC-1: no ticket data crosses the wire), and abort-driven teardown.
//
// node environment (vitest default) — no jsdom docblock: this drives a real
// ReadableStream + fs.watch against a real KODI_TICKETS_DIR.

import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DELETE,
  GET,
  HEAD,
  OPTIONS,
  PATCH,
  POST,
  PUT,
} from '@/app/events/route';
import { dispose, subscribe } from '@/lib/watch/status-watch';
import { cleanup, makeTicketsRoot, statusYaml, ticketEntry } from './fixtures';

const ORIGINAL = process.env.KODI_TICKETS_DIR;
const roots: string[] = [];
const controllers: AbortController[] = [];
const decoder = new TextDecoder();

function setEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.KODI_TICKETS_DIR;
  else process.env.KODI_TICKETS_DIR = value;
}

function freshRoot(): string {
  const root = makeTicketsRoot();
  roots.push(root);
  return root;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(pred: () => boolean, timeoutMs = 2500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await delay(20);
  }
  return pred();
}

/** Temp-then-rename replacement of status.yaml — the CLI's atomic write shape. */
function atomicWriteStatus(root: string, text: string): void {
  const tmp = join(root, 'status.yaml.tmp');
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, join(root, 'status.yaml'));
}

/** A GET Request with an explicit abort signal and chosen Host/Origin headers. */
function getRequest(headers: Record<string, string>): { request: Request; ac: AbortController } {
  const ac = new AbortController();
  controllers.push(ac);
  const request = new Request('http://127.0.0.1:3000/events', {
    method: 'GET',
    headers,
    signal: ac.signal,
  });
  return { request, ac };
}

type Chunk = { kind: 'data'; text: string } | { kind: 'done' } | { kind: 'timeout' };

function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<Chunk> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    reader.read().then(
      (r) => {
        clearTimeout(t);
        resolve(r.done ? { kind: 'done' } : { kind: 'data', text: decoder.decode(r.value) });
      },
      () => {
        clearTimeout(t);
        resolve({ kind: 'done' });
      },
    );
  });
}

/** Accumulate decoded stream text until `needle` appears or the timeout elapses. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let acc = '';
  while (Date.now() < deadline) {
    const chunk = await readChunk(reader, deadline - Date.now());
    if (chunk.kind === 'timeout' || chunk.kind === 'done') break;
    acc += chunk.text;
    if (acc.includes(needle)) break;
  }
  return acc;
}

afterEach(() => {
  for (const ac of controllers.splice(0)) {
    try {
      ac.abort();
    } catch {
      /* already aborted */
    }
  }
  dispose();
  while (roots.length > 0) cleanup(roots.pop() as string);
  setEnv(ORIGINAL);
});

describe('events route — method gating (SC-8)', () => {
  const nonGet: Array<[string, () => Promise<Response>]> = [
    ['POST', POST],
    ['PUT', PUT],
    ['PATCH', PATCH],
    ['DELETE', DELETE],
    ['HEAD', HEAD],
    ['OPTIONS', OPTIONS],
  ];

  for (const [name, handler] of nonGet) {
    it(`${name} → 405 with Allow: GET`, async () => {
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
    });
  }
});

describe('events route — same-origin / loopback gating (SC-7)', () => {
  it('non-loopback Host → 403', async () => {
    const { request } = getRequest({ host: 'evil.example.com' });
    const res = await GET(request);
    expect(res.status).toBe(403);
    await res.body?.cancel().catch(() => undefined);
  });

  it('loopback Host but cross-origin Origin (Origin host ≠ Host) → 403', async () => {
    const { request } = getRequest({ host: '127.0.0.1:3000', origin: 'http://evil.example.com' });
    const res = await GET(request);
    expect(res.status).toBe(403);
    await res.body?.cancel().catch(() => undefined);
  });
});

describe('events route — accepted GET stream (SC-6)', () => {
  it('loopback Host → 200 text/event-stream with NO Access-Control-Allow-Origin', async () => {
    const { request, ac } = getRequest({ host: '127.0.0.1:3000' });
    const res = await GET(request);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // SC-6: no permissive CORS — assert the header is ABSENT, not merely empty.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.has('access-control-allow-origin')).toBe(false);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('cache-control')).toContain('no-cache');

    ac.abort();
    await res.body?.cancel().catch(() => undefined);
  });

  it('same-origin Origin matching the loopback Host → 200', async () => {
    const { request, ac } = getRequest({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' });
    const res = await GET(request);
    expect(res.status).toBe(200);
    ac.abort();
    await res.body?.cancel().catch(() => undefined);
  });
});

describe('events route — bare opaque change event (SC-1)', () => {
  it('emits `event: change` with only an opaque tick, carrying NO ticket data/path/key', async () => {
    dispose(); // clean singleton
    const root = freshRoot();
    setEnv(root); // the route's watcher binds to this dir on subscribe

    const { request, ac } = getRequest({ host: '127.0.0.1:3000' });
    const res = await GET(request);
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    // Drain the connect handshake first.
    const handshake = await readUntil(reader, ': connected', 1500);
    expect(handshake).toContain(': connected');

    // Give the watch a beat, then drive a real atomic write with KODI content in
    // the FILE — the streamed event must still leak none of it.
    await delay(150);
    atomicWriteStatus(root, statusYaml(ticketEntry('KODI-777', 'To review')));

    const changeBytes = await readUntil(reader, 'event: change', 2500);
    expect(changeBytes).toContain('event: change');
    // Opaque tick only: `data: <ms>-<n>`.
    expect(changeBytes).toMatch(/event: change\ndata: \d+-\d+\n\n/);
    // SC-1: no ticket content/key/path crosses the wire.
    expect(changeBytes).not.toContain('KODI-777');
    expect(changeBytes).not.toContain('status.yaml');
    expect(changeBytes.toLowerCase()).not.toContain('review');

    ac.abort();
    await reader.cancel().catch(() => undefined);
  });
});

describe('events route — abort tears down the subscription (no leak)', () => {
  it('AbortController.abort() releases the watcher ref (ref-count returns to 0)', async () => {
    dispose(); // clean singleton, ref-count 0
    const rootA = freshRoot();
    setEnv(rootA);

    const { request, ac } = getRequest({ host: '127.0.0.1:3000' });
    const res = await GET(request); // route subscribes → ref-count 1, watch on rootA
    expect(res.status).toBe(200);
    await res.body?.cancel().catch(() => undefined);

    ac.abort(); // must unsubscribe → ref-count back to 0
    await delay(50);

    // Proof: a fresh subscribe is now "first" (ref-count 0), so start() re-runs
    // and re-captures the env. Bind it to a DIFFERENT dir and confirm it fires —
    // only possible if the route truly released its ref (else watch stays on
    // rootA and this never fires).
    const rootB = freshRoot();
    setEnv(rootB);
    let count = 0;
    const unsubscribe = subscribe(() => {
      count += 1;
    });
    await delay(150);
    atomicWriteStatus(rootB, statusYaml(ticketEntry('KODI-778', 'Pending')));
    expect(await waitUntil(() => count >= 1)).toBe(true);

    unsubscribe();
  });
});
