// The forge HTTP app: one router wiring healthz, git smart HTTP (/owner/repo.git),
// REST v3 (/api/v3), GraphQL v4 (/api/graphql) and MCP (/mcp) over a single Node http server.
// All bodies are read before dispatch, and every handler is synchronous afterwards, so the
// in-memory store is never mutated by interleaved requests. main.ts stays the lifecycle.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { getRepo } from './store.ts';
import { receivePack, receivePackReply, uploadPack, v0Advertisement, v2Advertisement } from './git-http.ts';
import { handleApi, type ApiContext } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const GIT_ROUTE = /^\/([^/]+)\/([^/]+?)\.git(?:\/(.*))?$/;
const MAX_BODY_BYTES = 1 << 30;

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        respondJson(response, 500, { message: 'Internal Server Error', detail: message });
      } else {
        response.destroy();
      }
    });
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://forge.local');
  const path = url.pathname;
  const method = (request.method ?? 'GET').toUpperCase();

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (path === '/healthz' && method === 'GET') {
    respondJson(response, 200, { ok: true });
    return;
  }

  const gitMatch = GIT_ROUTE.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]!);
    const name = decodeSegment(gitMatch[2]!);
    const tail = gitMatch[3] ?? '';
    if (method === 'GET') {
      handleGit(request, response, url, owner, name, tail);
      return;
    }
    const body = await readBody(request);
    handleGit(request, response, url, owner, name, tail, body);
    return;
  }

  const body = await readBody(request);
  const bodyText = body.toString('utf8');

  if (path === '/api/graphql' && method === 'POST') {
    const answer = handleGraphQL({ token: bearerToken(request), bodyText });
    respondJson(response, answer.status, answer.body);
    return;
  }

  if (path === '/mcp' && method === 'POST') {
    const answer = handleMcp({ token: bearerToken(request), bodyText });
    if (answer.body === undefined) {
      response.writeHead(answer.status);
      response.end();
      return;
    }
    respondJson(response, answer.status, answer.body);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    let parsedBody: unknown = null;
    let bodyError = false;
    if (bodyText.trim() !== '') {
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
      query: url.searchParams,
      body: parsedBody,
      bodyError,
      token: bearerToken(request),
      origin: `http://${request.headers.host ?? 'forge.local'}`,
    };
    const answer = handleApi(ctx);
    const headers = {
      'x-github-request-id': randomUUID().replaceAll('-', '').slice(0, 16),
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

  respondJson(response, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- git smart HTTP

function handleGit(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
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
    const service = url.searchParams.get('service');
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

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += part.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(part);
  }
  return Buffer.concat(chunks);
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
