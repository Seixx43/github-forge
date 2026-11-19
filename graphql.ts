// GraphQL v4 (/api/graphql): a targeted document parser and executor for the operations gh and
// the github-mcp-server send — viewer, repository fields, issue/pull reads and connections,
// Relay node(id:), __type introspection probes, the create/close/merge/comment mutations,
// variables, inline enums and input objects, and GitHub's operation batching (array bodies).
import {
  DEFAULT_BRANCH,
  type Issue,
  type IssueComment,
  type Pull,
  type Repo,
  VIEWER_ID,
  VIEWER_LOGIN,
  addComment,
  branchTip,
  createIssue,
  createPull,
  getRepo,
  listReposOfViewer,
  nowIso,
} from './store.ts';
import { mergeIsConflicting, pullFiles, squashMergePull } from './rest.ts';

// ---------------------------------------------------------------- the document parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string };

function tokenize(source: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) return 'an unterminated block string';
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      let terminated = false;
      while (j < source.length) {
        const ch = source[j]!;
        if (ch === '"') {
          terminated = true;
          break;
        }
        if (ch === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else if (esc !== undefined) value += esc;
          j += 2;
          continue;
        }
        if (ch === '\n') return 'an unterminated string';
        value += ch;
        j += 1;
      }
      if (!terminated) return 'an unterminated string';
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i + (c === '-' ? 1 : 0);
      if (!/[0-9]/.test(source[j] ?? '')) return `an unexpected character '${c}'`;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let kind: Token['kind'] = 'int';
      if (source[j] === '.') {
        kind = 'float';
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        kind = 'float';
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push({ kind, value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('$!():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    return `an unexpected character '${c}'`;
  }
  return tokens;
}

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

interface FieldSelection {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, GqlValue>;
  selections: Selection[] | undefined;
}

interface InlineFragmentSelection {
  kind: 'inline';
  typeCondition: string | undefined;
  selections: Selection[];
}

interface SpreadSelection {
  kind: 'spread';
  name: string;
}

type Selection = FieldSelection | InlineFragmentSelection | SpreadSelection;

interface Operation {
  type: 'query' | 'mutation';
  name: string;
  selections: Selection[];
}

interface ParsedDocument {
  operations: Operation[];
  fragments: Record<string, Selection[]>;
}

class TokenReader {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token | undefined {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  takePunct(value: string): boolean {
    if (!this.isPunct(value)) return false;
    this.next();
    return true;
  }

  takeName(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'name' && token.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  get done(): boolean {
    return this.pos >= this.tokens.length;
  }
}

/** Consume a variable type's tokens (`String!`, `[IssueState!]!`, `ID!`); values are not needed. */
function skipType(reader: TokenReader): string | undefined {
  let depth = 0;
  for (;;) {
    // The next variable's '$', the list's ')' or a default value's '=' are separators, not
    // part of the type: stop before consuming them or the variable list's parse loses its '$'.
    if (reader.isPunct('$') || reader.isPunct(')') || reader.isPunct('=')) return undefined;
    const token = reader.next();
    if (token === undefined) return undefined;
    if (token.kind === 'name') {
      // A named type or wrapper keyword; keep going until the variable list separator.
      if (!reader.isPunct('!') && !reader.isPunct(']')) return token.value;
      continue;
    }
    if (token.kind === 'punct') {
      if (token.value === '[') {
        depth += 1;
        continue;
      }
      if (token.value === ']') {
        depth -= 1;
        continue;
      }
      if (token.value === '!') continue;
      return undefined;
    }
    return undefined;
  }
  void depth;
}

function parseSelectionSet(reader: TokenReader): Selection[] | string {
  if (!reader.takePunct('{')) return "expected '{'";
  const selections: Selection[] = [];
  while (!reader.takePunct('}')) {
    if (reader.done) return "an unclosed selection set";
    const token = reader.peek()!;
    if (token.kind === 'punct' && token.value === '...') {
      reader.next();
      const after = reader.peek();
      if (after !== undefined && after.kind === 'punct' && after.value === '{') {
        const selectionsOf = parseSelectionSet(reader);
        if (typeof selectionsOf === 'string') return selectionsOf;
        selections.push({ kind: 'inline', typeCondition: undefined, selections: selectionsOf });
        continue;
      }
      if (after !== undefined && after.kind === 'name' && after.value === 'on') {
        reader.next();
        const typeToken = reader.next();
        if (typeToken === undefined || typeToken.kind !== 'name') return 'an inline fragment without a type condition';
        skipDirectives(reader);
        const fragmentSelections = parseSelectionSet(reader);
        if (typeof fragmentSelections === 'string') return fragmentSelections;
        selections.push({ kind: 'inline', typeCondition: typeToken.value, selections: fragmentSelections });
        continue;
      }
      const spread = reader.next();
      if (spread === undefined || spread.kind !== 'name') return 'a fragment spread without a name';
      skipDirectives(reader);
      selections.push({ kind: 'spread', name: spread.value });
      continue;
    }
    if (token.kind !== 'name') return `an unexpected ${token.kind} in a selection set`;
    reader.next();
    let alias = token.value;
    let name = token.value;
    if (reader.takePunct(':')) {
      const fieldToken = reader.next();
      if (fieldToken === undefined || fieldToken.kind !== 'name') return 'an alias without a field name';
      name = fieldToken.value;
    }
    const args = parseArguments(reader);
    if (typeof args === 'string') return args;
    skipDirectives(reader);
    let childSelections: Selection[] | undefined;
    if (reader.isPunct('{')) {
      const parsed = parseSelectionSet(reader);
      if (typeof parsed === 'string') return parsed;
      childSelections = parsed;
    }
    selections.push({ kind: 'field', alias, name, args, selections: childSelections });
  }
  return selections;
}

function parseArguments(reader: TokenReader): Record<string, GqlValue> | string {
  if (!reader.takePunct('(')) return {};
  const args: Record<string, GqlValue> = {};
  while (!reader.takePunct(')')) {
    if (reader.done) return 'an unclosed argument list';
    const nameToken = reader.next();
    if (nameToken === undefined || nameToken.kind !== 'name') return 'an argument without a name';
    if (!reader.takePunct(':')) return "expected ':' after an argument name";
    const value = parseValue(reader);
    if (typeof value === 'string') return value;
    args[nameToken.value] = value;
  }
  return args;
}

function skipDirectives(reader: TokenReader): string | undefined {
  while (reader.takePunct('@')) {
    const nameToken = reader.next();
    if (nameToken === undefined || nameToken.kind !== 'name') return 'a directive without a name';
    const args = parseArguments(reader);
    if (typeof args === 'string') return args;
  }
  return undefined;
}

function parseValue(reader: TokenReader): GqlValue | string {
  const token = reader.next();
  if (token === undefined) return 'a missing value';
  if (token.kind === 'punct' && token.value === '$') {
    const nameToken = reader.next();
    if (nameToken === undefined || nameToken.kind !== 'name') return 'a variable without a name';
    return { kind: 'variable', name: nameToken.value };
  }
  if (token.kind === 'string') return { kind: 'string', value: token.value };
  if (token.kind === 'int' || token.kind === 'float') return { kind: 'number', value: token.value };
  if (token.kind === 'name') {
    if (token.value === 'true') return { kind: 'boolean', value: true };
    if (token.value === 'false') return { kind: 'boolean', value: false };
    if (token.value === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token.value };
  }
  if (token.kind === 'punct' && token.value === '[') {
    const items: GqlValue[] = [];
    while (!reader.takePunct(']')) {
      if (reader.done) return 'an unclosed list value';
      const item = parseValue(reader);
      if (typeof item === 'string') return item;
      items.push(item);
    }
    return { kind: 'list', items };
  }
  if (token.kind === 'punct' && token.value === '{') {
    const fields: Record<string, GqlValue> = {};
    while (!reader.takePunct('}')) {
      if (reader.done) return 'an unclosed object value';
      const nameToken = reader.next();
      if (nameToken === undefined || nameToken.kind !== 'name') return 'an object value field without a name';
      if (!reader.takePunct(':')) return "expected ':' in an object value";
      const value = parseValue(reader);
      if (typeof value === 'string') return value;
      fields[nameToken.value] = value;
    }
    return { kind: 'object', fields };
  }
  return `an unexpected ${token.kind} where a value was expected`;
}

function parseDocument(source: string): ParsedDocument | string {
  const tokens = tokenize(source);
  if (typeof tokens === 'string') return tokens;
  const reader = new TokenReader(tokens);
  const document: ParsedDocument = { operations: [], fragments: {} };
  while (!reader.done) {
    const token = reader.peek()!;
    if (token.kind === 'punct' && token.value === '{') {
      const selections = parseSelectionSet(reader);
      if (typeof selections === 'string') return selections;
      document.operations.push({ type: 'query', name: '', selections });
      continue;
    }
    if (token.kind !== 'name') return `an unexpected ${token.kind} at the document level`;
    if (token.value === 'query' || token.value === 'mutation') {
      reader.next();
      let name = '';
      const nameToken = reader.peek();
      if (nameToken !== undefined && nameToken.kind === 'name' && nameToken.value !== 'on') {
        reader.next();
        name = nameToken.value;
      }
      if (reader.takePunct('(')) {
        while (!reader.takePunct(')')) {
          if (reader.done) return 'an unclosed variable definition list';
          if (!reader.takePunct('$')) return 'a variable definition without a $';
          const variableToken = reader.next();
          if (variableToken === undefined || variableToken.kind !== 'name') return 'a variable definition without a name';
          if (!reader.takePunct(':')) return "expected ':' in a variable definition";
          skipType(reader);
          if (reader.takePunct('=')) {
            const defaultValue = parseValue(reader);
            if (typeof defaultValue === 'string') return defaultValue;
          }
        }
      }
      const bad = skipDirectives(reader);
      if (bad !== undefined) return bad;
      const selections = parseSelectionSet(reader);
      if (typeof selections === 'string') return selections;
      document.operations.push({ type: token.value, name, selections });
      continue;
    }
    if (token.value === 'fragment') {
      reader.next();
      const nameToken = reader.next();
      if (nameToken === undefined || nameToken.kind !== 'name') return 'a fragment without a name';
      if (!reader.takeName('on')) return "expected 'on' in a fragment definition";
      const typeToken = reader.next();
      if (typeToken === undefined || typeToken.kind !== 'name') return 'a fragment without a type condition';
      const bad = skipDirectives(reader);
      if (bad !== undefined) return bad;
      const selections = parseSelectionSet(reader);
      if (typeof selections === 'string') return selections;
      document.fragments[nameToken.value] = selections;
      continue;
    }
    return `an unexpected '${token.value}' at the document level`;
  }
  return document;
}

function evaluateValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return value.name in variables ? variables[value.name] : null;
    case 'string':
    case 'number':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => evaluateValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.fields)) out[key] = evaluateValue(item, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- resolver nodes

export interface GqlNode {
  readonly __typename: string;
  readonly fields: Record<string, (args: Record<string, unknown>) => unknown>;
}

function isGqlNode(value: unknown): value is GqlNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as GqlNode).__typename === 'string' &&
    typeof (value as GqlNode).fields === 'object' &&
    (value as GqlNode).fields !== null
  );
}

function node(
  typename: string,
  fields: Record<string, (args: Record<string, unknown>) => unknown>,
): GqlNode {
  return { __typename: typename, fields };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

// ---------------------------------------------------------------- global ids

function encodeNodeId(type: string, dbId: number): string {
  return Buffer.from(`${type}:${dbId}`, 'utf8').toString('base64');
}

function decodeNodeId(id: unknown, expected?: string): { type: string; dbId: number } {
  if (typeof id !== 'string' || id === '') throw new GraphQLError('a global id was expected');
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    throw new GraphQLError(`could not decode the global id '${id}'`);
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) throw new GraphQLError(`could not decode the global id '${id}'`);
  const type = decoded.slice(0, separator);
  const dbId = Number(decoded.slice(separator + 1));
  if (!Number.isInteger(dbId)) throw new GraphQLError(`could not decode the global id '${id}'`);
  if (expected !== undefined && type !== expected) {
    throw new GraphQLError(`expected a ${expected} id, got a ${type} id`);
  }
  return { type, dbId };
}

// ---------------------------------------------------------------- cursors

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(decoded);
    return m ? Number(m[1]!) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- node builders

function userNode(login: string): GqlNode {
  return node('User', {
    login: () => login,
    id: () => encodeNodeId('User', login === VIEWER_LOGIN ? VIEWER_ID : 0),
    databaseId: () => (login === VIEWER_LOGIN ? VIEWER_ID : null),
    url: () => `https://github.com/${login}`,
    name: () => null,
    createdAt: () => '2026-01-01T00:00:00Z',
  });
}

function viewerNode(): GqlNode {
  const base = userNode(VIEWER_LOGIN);
  return node('Viewer', base.fields);
}

function refNode(repo: Repo): GqlNode | null {
  const sha = getRepo(repo.owner, repo.name) !== undefined ? undefined : undefined;
  void sha;
  const headSha = repo.refs.get(repo.symrefHead);
  const branchName = repo.symrefHead.startsWith('refs/heads/') ? repo.symrefHead.slice('refs/heads/'.length) : repo.symrefHead;
  if (headSha === undefined) return null;
  return node('Ref', {
    id: () => encodeNodeId('Ref', repo.id),
    name: () => branchName,
    target: () => commitNode(repo, headSha),
  });
}

function commitNode(repo: Repo, sha: string): GqlNode {
  return node('Commit', {
    id: () => encodeNodeId('Commit', repo.id),
    oid: () => sha,
    abbreviatedOid: () => sha.slice(0, 7),
    message: () => {
      void repo;
      return '';
    },
    committedDate: () => '1970-01-01T00:00:00Z',
  });
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return node('Issue', {
    id: () => encodeNodeId('Issue', issue.id),
    databaseId: () => issue.id,
    number: () => issue.number,
    title: () => issue.title,
    state: () => (issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    body: () => issue.body,
    author: () => userNode(issue.user),
    createdAt: () => issue.createdAt,
    updatedAt: () => issue.updatedAt,
    closedAt: () => issue.closedAt,
    url: () => `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository: () => repositoryNode(repo),
    comments: (args) => commentsConnection(issue.comments, args),
  });
}

function commentsConnection(comments: IssueComment[], args: Record<string, unknown>): GqlNode {
  const first = firstOf(args.first, 100);
  const page = comments.slice(0, first);
  return node('IssueCommentConnection', {
    nodes: () => page.map((comment) => commentNode(comment)),
    totalCount: () => comments.length,
    pageInfo: () => pageInfoOf(page.length < comments.length, page.length > 0 ? encodeCursor(commentNumberOf(page[page.length - 1]!)) : null),
  });
}

function commentNumberOf(comment: IssueComment): number {
  return comment.id;
}

function commentNode(comment: IssueComment): GqlNode {
  return node('IssueComment', {
    id: () => encodeNodeId('IssueComment', comment.id),
    databaseId: () => comment.id,
    body: () => comment.body,
    author: () => userNode(comment.user),
    createdAt: () => comment.createdAt,
    updatedAt: () => comment.updatedAt,
  });
}

function pullRequestNode(repo: Repo, pull: Pull): GqlNode {
  return node('PullRequest', {
    id: () => encodeNodeId('PullRequest', pull.id),
    databaseId: () => pull.id,
    number: () => pull.number,
    title: () => pull.title,
    state: () => (pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'),
    body: () => pull.body,
    author: () => userNode(pull.user),
    createdAt: () => pull.createdAt,
    updatedAt: () => pull.updatedAt,
    closedAt: () => pull.closedAt,
    mergedAt: () => pull.mergedAt,
    merged: () => pull.merged,
    url: () => `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    headRefName: () => pull.headRef,
    baseRefName: () => pull.baseRef,
    headRefOid: () => repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate ?? null,
    baseRefOid: () => repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate ?? null,
    mergeable: () => (pull.state !== 'open' ? 'UNKNOWN' : mergeIsConflicting(repo, pull) ? 'CONFLICTING' : 'MERGEABLE'),
    repository: () => repositoryNode(repo),
    files: (args) => {
      const files = pullFiles(repo, pull);
      const first = firstOf(args.first, 100);
      const page = files.slice(0, first);
      return node('PullRequestChangedFileConnection', {
        nodes: () => page.map((file) => node('PullRequestChangedFile', { path: () => file.filename, additions: () => file.additions, deletions: () => file.deletions })),
        totalCount: () => files.length,
        pageInfo: () => pageInfoOf(files.length > page.length, page.length > 0 ? encodeCursor(Number.parseInt(page[page.length - 1]!.filename.length.toString(), 10)) : null),
      });
    },
  });
}

function repositoryNode(repo: Repo): GqlNode {
  return node('Repository', {
    id: () => encodeNodeId('Repository', repo.id),
    databaseId: () => repo.id,
    name: () => repo.name,
    nameWithOwner: () => `${repo.owner}/${repo.name}`,
    owner: () => userNode(repo.owner),
    description: () => repo.description,
    url: () => `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: () => repo.createdAt,
    updatedAt: () => repo.updatedAt,
    pushedAt: () => repo.pushedAt,
    isPrivate: () => repo.private,
    visibility: () => (repo.private ? 'PRIVATE' : 'PUBLIC'),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasWikiEnabled: () => true,
    isEmpty: () => repo.refs.size === 0,
    defaultBranchRef: () => refNode(repo),
    issue: (args) => {
      const number = args.number;
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (args) => issuesConnection(repo, args),
    pullRequest: (args) => {
      const number = args.number;
      const pull = repo.pulls.find((entry) => entry.number === number);
      return pull === undefined ? null : pullRequestNode(repo, pull);
    },
    pullRequests: (args) => pullRequestsConnection(repo, args),
  });
}

interface IssueOrder {
  field: 'CREATED_AT' | 'UPDATED_AT' | 'COMMENTS';
  direction: 'ASC' | 'DESC';
}

function orderOf(value: unknown): IssueOrder {
  const record = isRecord(value) ? value : {};
  const field = record.field === 'UPDATED_AT' || record.field === 'COMMENTS' ? (record.field as IssueOrder['field']) : 'CREATED_AT';
  const direction = record.direction === 'ASC' ? 'ASC' : 'DESC';
  return { field, direction };
}

function stateFilterOf(value: unknown, fallback: 'open' | 'closed'): Set<'open' | 'closed'> {
  if (!Array.isArray(value) || value.length === 0) return new Set([fallback]);
  const states = new Set<'open' | 'closed'>();
  for (const entry of value) {
    if (entry === 'OPEN') states.add('open');
    else if (entry === 'CLOSED') states.add('closed');
  }
  return states.size > 0 ? states : new Set([fallback]);
}

function firstOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function pageInfoOf(hasNextPage: boolean, endCursor: string | null): GqlNode {
  return node('PageInfo', {
    hasNextPage: () => hasNextPage,
    endCursor: () => endCursor,
    hasPreviousPage: () => false,
    startCursor: () => null,
  });
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  const states = stateFilterOf(args.states, 'open');
  const order = orderOf(args.orderBy);
  const first = firstOf(args.first, 100);
  let list = repo.issues.filter((issue) => states.has(issue.state));
  list = [...list].sort((a, b) => {
    let cmp = 0;
    if (order.field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
    else if (order.field === 'UPDATED_AT') cmp = a.updatedAt.localeCompare(b.updatedAt);
    else cmp = a.createdAt.localeCompare(b.createdAt);
    if (cmp === 0) cmp = a.number - b.number;
    return order.direction === 'ASC' ? cmp : -cmp;
  });
  const after = decodeCursor(args.after);
  if (after !== null) {
    const index = list.findIndex((issue) => issue.number === after);
    list = index < 0 ? [] : list.slice(index + 1);
  }
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  return node('IssueConnection', {
    nodes: () => page.map((issue) => issueNode(repo, issue)),
    edges: () => page.map((issue) => node('IssueEdge', { node: () => issueNode(repo, issue), cursor: () => encodeCursor(issue.number) })),
    pageInfo: () => pageInfoOf(hasNextPage, endCursor),
    totalCount: () => list.length,
  });
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  const states = stateFilterOf(args.states, 'open');
  const first = firstOf(args.first, 100);
  let list = repo.pulls.filter((pull) => (pull.merged ? states.has('closed') : states.has(pull.state)));
  list = [...list].sort((a, b) => {
    let cmp = a.createdAt.localeCompare(b.createdAt);
    if (cmp === 0) cmp = a.number - b.number;
    return -cmp;
  });
  const after = decodeCursor(args.after);
  if (after !== null) {
    const index = list.findIndex((pull) => pull.number === after);
    list = index < 0 ? [] : list.slice(index + 1);
  }
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  return node('PullRequestConnection', {
    nodes: () => page.map((pull) => pullRequestNode(repo, pull)),
    edges: () => page.map((pull) => node('PullRequestEdge', { node: () => pullRequestNode(repo, pull), cursor: () => encodeCursor(pull.number) })),
    pageInfo: () => pageInfoOf(hasNextPage, endCursor),
    totalCount: () => list.length,
  });
}

// ---------------------------------------------------------------- introspection

const INTROSPECTION_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'url', 'createdAt', 'updatedAt', 'pushedAt',
    'isPrivate', 'visibility', 'viewerPermission', 'hasIssuesEnabled', 'hasWikiEnabled', 'isEmpty', 'defaultBranchRef',
    'issue', 'issues', 'pullRequest', 'pullRequests',
  ],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository', 'comments'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'state', 'merged', 'mergeable', 'body', 'author', 'createdAt', 'updatedAt',
    'closedAt', 'mergedAt', 'url', 'headRefName', 'headRefOid', 'baseRefName', 'baseRefOid', 'repository', 'files',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  User: ['login', 'databaseId', 'url', 'name', 'createdAt', 'avatarUrl'],
  Viewer: ['login', 'databaseId', 'url', 'name', 'createdAt', 'avatarUrl'],
  Ref: ['id', 'name', 'target'],
  Commit: ['id', 'oid', 'abbreviatedOid', 'message', 'committedDate'],
  Node: ['id'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
};

const INTROSPECTION_ENUMS: Record<string, readonly string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  IssueCommentOrderField: ['CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryAffiliation: ['OWNER', 'COLLABORATOR', 'ORGANIZATION_MEMBER'],
};

function introspectionTypeNode(name: unknown): GqlNode | null {
  if (typeof name !== 'string') return null;
  const fields = INTROSPECTION_FIELDS[name];
  const enums = INTROSPECTION_ENUMS[name];
  if (fields === undefined && enums === undefined) return null;
  return node('__Type', {
    kind: () => (enums !== undefined ? 'ENUM' : 'OBJECT'),
    name: () => name,
    description: () => null,
    fields: () =>
      fields === undefined
        ? null
        : fields.map((field) =>
            node('__Field', {
              name: () => field,
              description: () => null,
              args: () => [],
              type: () => null,
              isDeprecated: () => false,
              deprecationReason: () => null,
            }),
          ),
    enumValues: () =>
      enums === undefined
        ? null
        : enums.map((value) =>
            node('__EnumValue', {
              name: () => value,
              description: () => null,
              isDeprecated: () => false,
              deprecationReason: () => null,
            }),
          ),
    inputFields: () => null,
    interfaces: () => null,
    possibleTypes: () => null,
    ofType: () => null,
  });
}

function schemaNode(): GqlNode {
  const allTypes = [...Object.keys(INTROSPECTION_FIELDS), ...Object.keys(INTROSPECTION_ENUMS)];
  return node('__Schema', {
    queryType: () => introspectionTypeNode('Query'),
    mutationType: () => introspectionTypeNode('Mutation'),
    types: () => allTypes.map((name) => introspectionTypeNode(name)),
    directives: () => [],
    description: () => null,
  });
}

// ---------------------------------------------------------------- lookups across the forge

function repoByDatabaseId(dbId: number): Repo | undefined {
  return listReposOfViewer().find((repo) => repo.id === dbId);
}

function issueByDatabaseId(dbId: number): { repo: Repo; issue: Issue } | undefined {
  for (const repo of listReposOfViewer()) {
    const issue = repo.issues.find((entry) => entry.id === dbId);
    if (issue !== undefined) return { repo, issue };
  }
  return undefined;
}

function pullByDatabaseId(dbId: number): { repo: Repo; pull: Pull } | undefined {
  for (const repo of listReposOfViewer()) {
    const pull = repo.pulls.find((entry) => entry.id === dbId);
    if (pull !== undefined) return { repo, pull };
  }
  return undefined;
}

function nodeByGlobalId(id: unknown): GqlNode | null {
  let decoded: { type: string; dbId: number };
  try {
    decoded = decodeNodeId(id);
  } catch {
    return null;
  }
  if (decoded.type === 'Repository') {
    const repo = repoByDatabaseId(decoded.dbId);
    return repo === undefined ? null : repositoryNode(repo);
  }
  if (decoded.type === 'Issue') {
    const found = issueByDatabaseId(decoded.dbId);
    return found === undefined ? null : issueNode(found.repo, found.issue);
  }
  if (decoded.type === 'PullRequest') {
    const found = pullByDatabaseId(decoded.dbId);
    return found === undefined ? null : pullRequestNode(found.repo, found.pull);
  }
  if (decoded.type === 'User') return null;
  return null;
}

// ---------------------------------------------------------------- mutations

const pullComments = new Map<number, IssueComment[]>();

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  if (!isRecord(input)) throw new GraphQLError('an input object was expected');
  return input;
}

function clientMutationIdOf(input: Record<string, unknown>): unknown {
  return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
}

function repoFromRepositoryId(value: unknown): Repo {
  const decoded = decodeNodeId(value, 'Repository');
  const repo = repoByDatabaseId(decoded.dbId);
  if (repo === undefined) throw new GraphQLError(`could not resolve to a Repository with the global id '${String(value)}'`);
  return repo;
}

function titleOf(input: Record<string, unknown>): string {
  const title = input.title;
  if (typeof title !== 'string' || title === '') throw new GraphQLError('a non-empty title was expected');
  return title;
}

function mutateCreateIssue(args: Record<string, unknown>): GqlNode {
  const input = inputOf(args);
  const repo = repoFromRepositoryId(input.repositoryId);
  const title = titleOf(input);
  const body = typeof input.body === 'string' ? input.body : null;
  const issue = createIssue(repo, { title, body, labels: [] });
  return node('CreateIssuePayload', {
    issue: () => issueNode(repo, issue),
    clientMutationId: () => clientMutationIdOf(input),
  });
}

function mutateCloseIssue(args: Record<string, unknown>): GqlNode {
  const input = inputOf(args);
  const decoded = decodeNodeId(input.issueId, 'Issue');
  const found = issueByDatabaseId(decoded.dbId);
  if (found === undefined) {
    throw new GraphQLError(`could not resolve to an Issue with the global id '${String(input.issueId)}'`);
  }
  if (found.issue.state !== 'closed') {
    found.issue.state = 'closed';
    found.issue.closedAt = nowIso();
    found.issue.updatedAt = found.issue.closedAt;
  }
  return node('CloseIssuePayload', {
    issue: () => issueNode(found.repo, found.issue),
    clientMutationId: () => clientMutationIdOf(input),
  });
}

function mutateCreatePullRequest(args: Record<string, unknown>): GqlNode {
  const input = inputOf(args);
  const repo = repoFromRepositoryId(input.repositoryId);
  const title = titleOf(input);
  const headRefName = input.headRefName;
  const baseRefName = input.baseRefName;
  if (typeof headRefName !== 'string' || headRefName === '') throw new GraphQLError('headRefName was expected');
  if (typeof baseRefName !== 'string' || baseRefName === '') throw new GraphQLError('baseRefName was expected');
  const headSha = branchTip(repo, headRefName);
  const baseSha = branchTip(repo, baseRefName);
  if (headSha === undefined) throw new GraphQLError(`Head branch ${headRefName} does not exist`);
  if (baseSha === undefined) throw new GraphQLError(`Base branch ${baseRefName} does not exist`);
  if (headRefName === baseRefName) throw new GraphQLError('head and base must name different branches');
  const duplicate = repo.pulls.find(
    (pull) => pull.state === 'open' && pull.headRef === headRefName && pull.baseRef === baseRefName,
  );
  if (duplicate !== undefined) {
    throw new GraphQLError(`A pull request from ${headRefName} already exists (#${duplicate.number})`);
  }
  const pull = createPull(repo, {
    title,
    body: typeof input.body === 'string' ? input.body : null,
    headRef: headRefName,
    headLabel: `${repo.owner}:${headRefName}`,
    baseRef: baseRefName,
    headSha,
    baseSha,
  });
  return node('CreatePullRequestPayload', {
    pullRequest: () => pullRequestNode(repo, pull),
    clientMutationId: () => clientMutationIdOf(input),
  });
}

function mutateMergePullRequest(args: Record<string, unknown>): GqlNode {
  const input = inputOf(args);
  const decoded = decodeNodeId(input.pullRequestId, 'PullRequest');
  const found = pullByDatabaseId(decoded.dbId);
  if (found === undefined) {
    throw new GraphQLError(`could not resolve to a PullRequest with the global id '${String(input.pullRequestId)}'`);
  }
  const method = input.mergeMethod;
  if (method !== undefined && method !== null && !['MERGE', 'SQUASH', 'REBASE'].includes(String(method))) {
    throw new GraphQLError(`mergeMethod '${String(method)}' is not a PullRequestMergeMethod`);
  }
  if (found.pull.merged) throw new GraphQLError(`Pull Request #${found.pull.number} is already merged`);
  if (found.pull.state === 'closed') throw new GraphQLError(`Pull Request #${found.pull.number} is closed`);
  const result = squashMergePull(found.repo, found.pull);
  if ('conflict' in result) {
    throw new GraphQLError(`Pull Request #${found.pull.number} is not mergeable: conflicts with the base branch`);
  }
  return node('MergePullRequestPayload', {
    pullRequest: () => pullRequestNode(found.repo, found.pull),
    clientMutationId: () => clientMutationIdOf(input),
  });
}

function mutateAddComment(args: Record<string, unknown>): GqlNode {
  const input = inputOf(args);
  const body = input.body;
  if (typeof body !== 'string' || body === '') throw new GraphQLError('a non-empty body was expected');
  let decoded: { type: string; dbId: number };
  try {
    decoded = decodeNodeId(input.subjectId);
  } catch (error) {
    throw error instanceof GraphQLError ? error : new GraphQLError('a subjectId was expected');
  }
  let comment: IssueComment | null = null;
  if (decoded.type === 'Issue') {
    const found = issueByDatabaseId(decoded.dbId);
    if (found === undefined) throw new GraphQLError(`could not resolve to an Issue with the global id '${String(input.subjectId)}'`);
    comment = addComment(found.repo, found.issue, body);
  } else if (decoded.type === 'PullRequest') {
    const found = pullByDatabaseId(decoded.dbId);
    if (found === undefined) throw new GraphQLError(`could not resolve to a PullRequest with the global id '${String(input.subjectId)}'`);
    const list = pullComments.get(found.pull.id) ?? [];
    comment = {
      id: Math.max(0, ...list.map((entry) => entry.id)) + 1,
      body,
      user: VIEWER_LOGIN,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    list.push(comment);
    pullComments.set(found.pull.id, list);
  } else {
    throw new GraphQLError(`a ${decoded.type} cannot be commented on`);
  }
  return node('AddCommentPayload', {
    commentEdge: () =>
      node('CommentEdge', {
        node: () => commentNode(comment!),
        cursor: () => encodeCursor(comment!.id),
      }),
    clientMutationId: () => clientMutationIdOf(input),
  });
}

// ---------------------------------------------------------------- the walker

function mergeSelections(
  selections: readonly Selection[],
  typename: string,
  fragments: Record<string, Selection[]>,
  out: FieldSelection[],
  depth: number,
): void {
  if (depth > 16) return;
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push(selection);
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === undefined || selection.typeCondition === typename) {
        mergeSelections(selection.selections, typename, fragments, out, depth + 1);
      }
      continue;
    }
    const fragment = fragments[selection.name];
    if (fragment !== undefined) mergeSelections(fragment, typename, fragments, out, depth + 1);
  }
}

function walkSelections(
  selections: readonly Selection[],
  value: unknown,
  variables: Record<string, unknown>,
  fragments: Record<string, Selection[]>,
  errors: string[],
): { value: unknown; errored: boolean } {
  if (value === null || value === undefined) return { value: null, errored: false };
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    let errored = false;
    for (const item of value) {
      const walked = walkSelections(selections, item, variables, fragments, errors);
      items.push(walked.value);
      errored = errored || walked.errored;
    }
    return { value: items, errored };
  }
  if (!isGqlNode(value)) return { value: null, errored: false };
  const fields: FieldSelection[] = [];
  mergeSelections(selections, value.__typename, fragments, fields, 0);
  const result: Record<string, unknown> = {};
  let errored = false;
  for (const field of fields) {
    const key = field.alias === '' ? field.name : field.alias;
    if (field.name === '__typename') {
      result[key] = value.__typename;
      continue;
    }
    const resolver = value.fields[field.name];
    if (resolver === undefined) {
      errors.push(`Field '${field.name}' doesn't exist on type '${value.__typename}'`);
      result[key] = null;
      errored = true;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(field.args)) args[name] = evaluateValue(raw, variables);
    let child: unknown;
    try {
      child = resolver(args);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      result[key] = null;
      errored = true;
      continue;
    }
    if (field.selections === undefined) {
      result[key] = child === undefined ? null : isGqlNode(child) ? null : child;
      continue;
    }
    const walked = walkSelections(field.selections, child, variables, fragments, errors);
    result[key] = walked.errored ? null : walked.value;
    errored = errored || walked.errored;
  }
  return { value: result, errored };
}

// ---------------------------------------------------------------- the root

function rootNode(): GqlNode {
  return node('Query', {
    viewer: () => viewerNode(),
    repository: (args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = getRepo(owner, name);
      return repo === undefined ? null : repositoryNode(repo);
    },
    node: (args) => nodeByGlobalId(args.id),
    __type: (args) => introspectionTypeNode(args.name),
    __schema: () => schemaNode(),
    createIssue: (args) => mutateCreateIssue(args),
    closeIssue: (args) => mutateCloseIssue(args),
    createPullRequest: (args) => mutateCreatePullRequest(args),
    mergePullRequest: (args) => mutateMergePullRequest(args),
    addComment: (args) => mutateAddComment(args),
  });
}

function executeOne(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) return { errors: [{ message: 'the request entry is not a JSON object' }] };
  const query = typeof entry.query === 'string' ? entry.query : undefined;
  if (query === undefined) return { errors: [{ message: 'a query attribute must be specified and must be a string' }] };
  const variables = isRecord(entry.variables) ? { ...entry.variables } : {};
  const parsed = parseDocument(query);
  if (typeof parsed === 'string') return { errors: [{ message: `the document could not be parsed: ${parsed}` }] };
  const operationName = typeof entry.operationName === 'string' && entry.operationName !== '' ? entry.operationName : undefined;
  const operation =
    operationName !== undefined
      ? parsed.operations.find((candidate) => candidate.name === operationName)
      : parsed.operations[0];
  if (operation === undefined) {
    return {
      errors: [{ message: operationName === undefined ? 'the document carries no operation' : `no operation named '${operationName}'` }],
    };
  }
  const errors: string[] = [];
  const walked = walkSelections(operation.selections, rootNode(), variables, parsed.fragments, errors);
  const body: Record<string, unknown> = { data: walked.value ?? null };
  if (errors.length > 0) body.errors = errors.map((message) => ({ message }));
  return body;
}

export interface GraphQLHttpRequest {
  token: string | undefined;
  bodyText: string;
}

export interface GraphQLHttpResponse {
  status: number;
  body: unknown;
}

export function handleGraphQL(request: GraphQLHttpRequest): GraphQLHttpResponse {
  if (request.token === undefined) {
    return { status: 401, body: { message: 'Bad credentials', documentation_url: 'https://docs.github.com/graphql' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.bodyText);
  } catch {
    return { status: 400, body: { message: 'Problems parsing JSON' } };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { status: 400, body: { message: 'an empty operation batch' } };
    return { status: 200, body: parsed.map((entry) => executeOne(entry)) };
  }
  return { status: 200, body: executeOne(parsed) };
}

void DEFAULT_BRANCH;
