// Model Context Protocol endpoint (POST /mcp): JSON-RPC 2.0 over the Streamable HTTP transport,
// serving both protocol eras the suite speaks — the modern `server/discover` (2026-07-28) and the
// legacy `initialize` handshake — plus tools/list and tools/call for the six forge tools. The
// endpoint is stateless: it never issues a Mcp-Session-Id, so every request is self-contained and
// a client's session teardown is a no-op. Unauthenticated requests always answer 401.
import {
  AlreadyExistsError,
  type Repo,
  VIEWER_LOGIN,
  branchTip,
  createIssue,
  createPull,
  createRepo,
  getRepo,
} from './store.ts';
import { repoJson, squashMergePull } from './rest.ts';

interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const MCP_SERVER_INFO = { name: 'forge', version: '1.0.0' };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const prop = (type: string, description: string) => ({ type, description });

/** The six tools, in a fixed order: tools/list must answer byte-identically on every call. */
const MCP_TOOLS: readonly McpToolSpec[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: prop('string', 'The name of the repository.'),
        description: prop('string', 'A short description of the repository.'),
        private: prop('boolean', 'Whether the repository is private.'),
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: "Get a repository's metadata by its owner and name.",
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        title: prop('string', 'The issue title.'),
        body: prop('string', 'The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        state: prop('string', 'Filter issues by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        title: prop('string', 'The pull request title.'),
        head: prop('string', 'The head branch carrying the changes.'),
        base: prop('string', 'The base branch to merge into.'),
        body: prop('string', 'The pull request body.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        pull_number: prop('number', 'The number of the pull request to merge.'),
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
]);

// ---------------------------------------------------------------- JSON-RPC plumbing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class JsonRpcError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
  }
}

class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface McpHttpRequest {
  token: string | undefined;
  bodyText: string;
}

export interface McpHttpResponse {
  status: number;
  body?: unknown;
}

const rpcError = (id: unknown, code: number, message: string): McpHttpResponse => ({
  status: 200,
  body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
});

const rpcResult = (id: unknown, result: unknown): McpHttpResponse => ({
  status: 200,
  body: { jsonrpc: '2.0', id: id ?? null, result },
});

export function handleMcp(request: McpHttpRequest): McpHttpResponse {
  // Authentication is decided before anything about the request is parsed.
  if (request.token === undefined) return { status: 401, body: { message: 'Bad credentials' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const id = parsed.id;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  if (method.startsWith('notifications/')) return { status: 202 };
  if (method === '') return rpcError(id, -32600, 'Invalid Request: method is required');
  const params = isRecord(parsed.params) ? parsed.params : {};
  try {
    return rpcResult(id, dispatch(method, params));
  } catch (error) {
    if (error instanceof JsonRpcError) return rpcError(id, error.code, error.message);
    return rpcError(id, -32603, 'Internal error');
  }
}

function dispatch(method: string, params: Record<string, unknown>): unknown {
  if (method === 'server/discover') {
    return {
      resultType: 'tools',
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      serverInfo: { ...MCP_SERVER_INFO },
      capabilities: { tools: {} },
    };
  }
  if (method === 'initialize') {
    const offered = params.protocolVersion;
    const negotiated = typeof offered === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
    return {
      protocolVersion: negotiated,
      serverInfo: { ...MCP_SERVER_INFO },
      capabilities: { tools: {} },
    };
  }
  if (method === 'tools/list') {
    return { tools: MCP_TOOLS };
  }
  if (method === 'tools/call') {
    return callTool(params);
  }
  throw new JsonRpcError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------- tools/call

function callTool(params: Record<string, unknown>): unknown {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = MCP_TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) {
    throw new JsonRpcError(-32602, `Invalid params: unknown tool '${name}'`);
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined);
  if (missing.length > 0) {
    throw new JsonRpcError(-32602, `Invalid params: missing required arguments: ${missing.join(', ')}`);
  }
  try {
    const payload = runTool(tool.name, args);
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  } catch (error) {
    if (error instanceof ToolError) {
      const payload = { error: error.message };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: true,
      };
    }
    throw error;
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new ToolError(`${key} must be a non-empty string`);
  return value;
}

function repoArg(args: Record<string, unknown>): Repo {
  const owner = stringArg(args, 'owner');
  const name = stringArg(args, 'repo');
  const repo = getRepo(owner, name);
  if (repo === undefined) throw new ToolError(`Not Found: repository ${owner}/${name} does not exist`);
  return repo;
}

function repoPayload(repo: Repo): Record<string, unknown> {
  return repoJson(repo);
}

function runTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      const isPrivate = args.private === true;
      const description = typeof args.description === 'string' ? args.description : null;
      try {
        const repo = createRepo(repoName, { private: isPrivate, description });
        return repoPayload(repo);
      } catch (error) {
        if (error instanceof AlreadyExistsError) {
          throw new ToolError(`name already exists on this account (owner ${VIEWER_LOGIN})`);
        }
        throw error;
      }
    }
    case 'get_repo': {
      return repoPayload(repoArg(args));
    }
    case 'create_issue': {
      const repo = repoArg(args);
      const title = stringArg(args, 'title');
      const body = typeof args.body === 'string' ? args.body : null;
      const issue = createIssue(repo, { title, body, labels: [] });
      return {
        id: issue.id,
        node_id: Buffer.from(`Issue:${issue.id}`).toString('base64'),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        user: { login: issue.user },
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
        html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
        url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
      };
    }
    case 'list_issues': {
      const repo = repoArg(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      if (!['open', 'closed', 'all'].includes(state)) {
        throw new ToolError(`state must be one of open, closed, all (got '${state}')`);
      }
      const issues = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      return {
        owner: repo.owner,
        repo: repo.name,
        state,
        total_count: issues.length,
        issues: issues.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          user: { login: issue.user },
          comments: issue.comments.length,
          created_at: issue.createdAt,
          updated_at: issue.updatedAt,
          html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
        })),
      };
    }
    case 'create_pull_request': {
      const repo = repoArg(args);
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      const body = typeof args.body === 'string' ? args.body : null;
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === undefined) throw new ToolError(`Validation Failed: head branch ${head} does not exist`);
      if (baseSha === undefined) throw new ToolError(`Validation Failed: base branch ${base} does not exist`);
      if (head === base) throw new ToolError('Validation Failed: head and base must be different branches');
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) {
        throw new ToolError(`Validation Failed: a pull request from ${head} already exists (#${duplicate.number})`);
      }
      const pull = createPull(repo, {
        title,
        body,
        headRef: head,
        headLabel: `${repo.owner}:${head}`,
        baseRef: base,
        headSha,
        baseSha,
      });
      return {
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        headRefName: pull.headRef,
        baseRefName: pull.baseRef,
        head: { ref: pull.headRef, label: pull.headLabel, sha: headSha },
        base: { ref: pull.baseRef, label: `${repo.owner}:${pull.baseRef}`, sha: baseSha },
        created_at: pull.createdAt,
        html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
        url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      };
    }
    case 'merge_pull_request': {
      const repo = repoArg(args);
      const pullNumber = args.pull_number;
      if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber) || pullNumber <= 0) {
        throw new ToolError('pull_number must be an integer');
      }
      const pull = repo.pulls.find((entry) => entry.number === pullNumber);
      if (pull === undefined) throw new ToolError(`Not Found: pull request #${pullNumber} does not exist`);
      if (pull.merged) throw new ToolError(`Pull Request #${pullNumber} is already merged`);
      if (pull.state === 'closed') throw new ToolError(`Pull Request #${pullNumber} is closed`);
      const result = squashMergePull(repo, pull);
      if ('conflict' in result) {
        throw new ToolError(`Pull Request #${pullNumber} is not mergeable: conflicts with the base branch`);
      }
      return {
        merged: true,
        sha: result.sha,
        number: pull.number,
        state: pull.state,
        message: 'Pull Request successfully merged',
      };
    }
    default:
      throw new JsonRpcError(-32602, `Invalid params: unknown tool '${name}'`);
  }
}
