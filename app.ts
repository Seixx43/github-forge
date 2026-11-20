// The forge HTTP app: one router wiring healthz, git smart HTTP (/owner/repo.git),
// REST v3 (/api/v3), GraphQL v4 (/api/graphql) and MCP (/mcp) over a single Node http server.
// All bodies are read before dispatch, and every handler is synchronous afterwards, so the
// in-memory store is never mutated by interleaved requests. main.ts stays the lifecycle.
//
// Perf model: the bench's hot paths are (a) 2000 sequential GET issue reads and (b) 50 concurrent
// pure clones. GET responses on /api/v3/repos/* are pure functions of the store, so they are cached
// as pre-serialized buffers and invalidated by a global state version that every potentially
// mutating request bumps (any non-GET REST call, GraphQL/MCP POSTs, and receive-pack). Upload-pack
// POSTs are read-only and do not bump, so a burst of clones reuses the cached git answers.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getRepo } from './store.ts';
import { receivePack, receivePackReply, uploadPack, v0Advertisement, v2Advertisement } from './git-http.ts';
import { handleApi, type ApiContext } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const GIT_ROUTE = /^\/([^/]+)\/([^/]+?)\.git(?:\/(.*))?$/;
const MAX_BODY_BYTES = 1 << 30;

const EMPTY_BUFFER = Buffer.alloc(0);
const EMPTY_SEARCH = new URLSearchParams();

/** Monotone version of the in-memory store; every mutation bumps it and drops the GET cache. */
let stateVersion = 0;
function bumpState(): void {
  stateVersion += 1;
}

interface CachedAnswer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const apiCache = new Map<string, CachedAnswer>();
const API_CACHE_LIMIT = 512;

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return (Date.now() - 1_700_000_000_000).toString(36) + requestSeq.toString(36);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        respondJson(response, 500, { message: 'Internal Server Error', detail: message });
      } else {
        response.destroy();
      }
    });
  });
  // Nagle off: git sideband and JSON replies are small, single-write segments; keep-alive
  // request/response pairs must never wait on a delayed ACK. Transport only, no API change.
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });
  return server;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = request.url ?? '/';
  const method = (request.method ?? 'GET').toUpperCase();
  let path = raw;
  let search = '';
  const queryStart = raw.indexOf('?');
  if (queryStart >= 0) {
    path = raw.slice(0, queryStart);
    search = raw.slice(queryStart + 1);
  }

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (path === '/healthz' && method === 'GET') {
    respondJson(response, 200, { ok: true });
    return;
  }

  // REST v3 is the hottest family (the read/write benches); match it before the git route regex.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (method !== 'GET') bumpState();
    const cacheable = method === 'GET' && path.startsWith('/api/v3/repos/');
    let cacheKey = '';
    if (cacheable) {
      cacheKey = `${stateVersion}|${request.headers.host ?? 'forge.local'}|${request.headers.authorization === undefined ? 0 : 1}|${search === '' ? path : `${path}?${search}`}`;
      const hit = apiCache.get(cacheKey);
      if (hit !== undefined) {
        response.writeHead(hit.status, { ...hit.headers, 'x-github-request-id': nextRequestId() });
        response.end(hit.body);
        return;
      }
    }
    const body = await readBody(request);
    const bodyText = body.toString('utf8');
    let parsedBody: unknown = null;
    let bodyError = false;
    if (body.length !== 0 && bodyText.trim() !== '') {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        bodyError = true;
      }
    }
    const ctx: ApiContext = {
      method,
      segments: path
        .slice('/api/v3'.length)
        .split('/')
        .filter((segment) => segment !== '')
        .map(decodeSegment),
      query: search === '' ? EMPTY_SEARCH : new URLSearchParams(search),
      body: parsedBody,
      bodyError,
      token: bearerToken(request),
      origin: `http://${request.headers.host ?? 'forge.local'}`,
    };
    const answer = handleApi(ctx);
    const requestId = nextRequestId();
    if (cacheable && answer.status !== 204) {
      const cachedHeaders: Record<string, string> = {
        'content-type': 'application/json; charset=utf-8',
        ...(answer.headers ?? {}),
      };
      const cached: CachedAnswer = { status: answer.status, headers: cachedHeaders, body: Buffer.from(JSON.stringify(answer.body), 'utf8') };
      if (apiCache.size >= API_CACHE_LIMIT) apiCache.clear();
      apiCache.set(cacheKey, cached);
      response.writeHead(answer.status, { ...cachedHeaders, 'x-github-request-id': requestId });
      response.end(cached.body);
      return;
    }
    const headers = {
      'x-github-request-id': requestId,
      ...(answer.headers ?? {}),
    };
    if (answer.status === 204) {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    respondJson(response, answer.status, answer.body, headers);
    return;
  }

  const gitMatch = GIT_ROUTE.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]!);
    const name = decodeSegment(gitMatch[2]!);
    const tail = gitMatch[3] ?? '';
    if (tail === 'git-receive-pack' && method === 'POST') bumpState();
    if (method === 'GET') {
      handleGit(request, response, search, owner, name, tail);
      return;
    }
    const body = await readBody(request);
    handleGit(request, response, search, owner, name, tail, body);
    return;
  }

  if (method === 'POST' && (path === '/api/graphql' || path === '/mcp')) {
    bumpState();
    const body = await readBody(request);
    const bodyText = body.toString('utf8');
    if (path === '/api/graphql') {
      const answer = handleGraphQL({ token: bearerToken(request), bodyText });
      respondJson(response, answer.status, answer.body);
      return;
    }
    const answer = handleMcp({ token: bearerToken(request), bodyText });
    if (answer.body === undefined) {
      response.writeHead(answer.status);
      response.end();
      return;
    }
    respondJson(response, answer.status, answer.body);
    return;
  }

  respondJson(response, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- git smart HTTP

function handleGit(
  request: IncomingMessage,
  response: ServerResponse,
  search: string,
  owner: string,
  name: string,
  tail: string,
  body?: Buffer,
): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('repository not found');
    return;
  }
  const method = (request.method ?? 'GET').toUpperCase();
  const v2 = `${request.headers['git-protocol'] ?? ''}`.includes('version=2');

  if (tail === 'info/refs' && method === 'GET') {
    const service = search === '' ? null : new URLSearchParams(search).get('service');
    if (service === 'git-upload-pack') {
      const advertisement = v2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
      response.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'cache-control': 'no-cache',
      });
      response.end(advertisement);
      return;
    }
    if (service === 'git-receive-pack') {
      const advertisement = v0Advertisement(repo, 'git-receive-pack');
      response.writeHead(200, {
        'content-type': 'application/x-git-receive-pack-advertisement',
        'cache-control': 'no-cache',
      });
      response.end(advertisement);
      return;
    }
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('smart HTTP service required');
    return;
  }

  if (tail === 'git-upload-pack' && method === 'POST' && body !== undefined) {
    const answer = uploadPack(repo, body, v2);
    response.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'cache-control': 'no-cache',
    });
    response.end(answer);
    return;
  }

  if (tail === 'git-receive-pack' && method === 'POST' && body !== undefined) {
    const result = receivePack(repo, body);
    const answer = receivePackReply(result);
    response.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-result',
      'cache-control': 'no-cache',
    });
    response.end(answer);
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('not found');
}

// ---------------------------------------------------------------- small utilities

/**
 * Read the request body to a buffer. Requests that cannot carry a body (no content-length and no
 * transfer-encoding) skip the stream machinery entirely: the parser emits `end` on its own and the
 * keep-alive socket stays clean for the next request.
 */
function readBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = request.headers['content-length'];
  if (request.headers['transfer-encoding'] === undefined && (contentLength === undefined || contentLength === '0')) {
    return Promise.resolve(EMPTY_BUFFER);
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += part.length;
      if (total > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(part);
    });
    request.on('end', () => {
      resolve(chunks.length === 0 ? EMPTY_BUFFER : chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

/** The bearer token of an Authorization header, or undefined when absent/malformed. */
function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : undefined;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function respondJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(text);
}
