// The in-memory forge store: repos (objects, refs, issues, labels, pulls), the viewer
// identity, and the git-level operations the REST/GraphQL/MCP surfaces are built on.
import {
  type GitObject,
  type ObjectType,
  type Signature,
  ZERO_OID,
  OID_RE,
  decodeCommit,
  decodeTree,
  encodeCommit,
  encodeTree,
  hashObject,
  makeObject,
} from './git-objects.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const DEFAULT_BRANCH = 'main';
export const AGENT = 'forge/1.0';

export interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  pull: false;
}

export interface PullRef {
  ref: string;
  label: string;
  sha: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  headRef: string;
  headLabel: string;
  baseRef: string;
  headShaAtCreate: string | null;
  baseShaAtCreate: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
  pull: true;
}

export type IssueOrPull = Issue | Pull;

export interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  objects: Map<string, StoredObject>;
  refs: Map<string, string>; // refs/heads/* and refs/tags/* -> sha
  symrefHead: string; // HEAD -> this ref
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
}

let repoIdCounter = 1000;
let issueIdCounter = 5000;
let commentIdCounter = 9000;
let labelIdCounter = 4000;

const repos = new Map<string, Repo>();

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function viewerSignature(): Signature {
  return { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@users.noreply.github.com`, when: Math.floor(Date.now() / 1000) };
}

// ---------------------------------------------------------------- repos

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function createRepo(name: string, opts: { private?: boolean; description?: string | null } = {}): Repo {
  const owner = VIEWER_LOGIN;
  const key = repoKey(owner, name);
  if (repos.has(key)) throw new AlreadyExistsError();
  const now = nowIso();
  const repo: Repo = {
    id: repoIdCounter++,
    owner,
    name,
    private: opts.private ?? false,
    description: opts.description ?? null,
    objects: new Map(),
    refs: new Map(),
    symrefHead: `refs/heads/${DEFAULT_BRANCH}`,
    issues: [],
    pulls: [],
    labels: [],
    nextNumber: 1,
    createdAt: now,
    updatedAt: now,
    pushedAt: now,
  };
  repos.set(key, repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

export function listReposOfViewer(): Repo[] {
  const out: Repo[] = [];
  for (const repo of repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  return out;
}

export class AlreadyExistsError extends Error {
  constructor() {
    super('already exists');
  }
}

// ---------------------------------------------------------------- auth

/** Every bearer token maps to the scenario viewer; an absent token is unauthenticated. */
export function loginForToken(token: string | undefined): string | null {
  if (token === undefined || token === '') return null;
  return VIEWER_LOGIN;
}

// ---------------------------------------------------------------- objects and refs

export function putObject(repo: Repo, type: ObjectType, data: Buffer): GitObject {
  const object = makeObject(type, data);
  const existing = repo.objects.get(object.sha);
  if (existing) return { type: existing.type, data: existing.data, sha: object.sha };
  repo.objects.set(object.sha, { type, data });
  return object;
}

export function getObject(repo: Repo, sha: string): GitObject | undefined {
  const stored = repo.objects.get(sha);
  if (!stored) return undefined;
  return { type: stored.type, data: stored.data, sha };
}

/** Resolve a ref name: full ref, HEAD, branch short name, tag short name. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (ref === 'HEAD' || ref === '') return repo.refs.get(repo.symrefHead);
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  return undefined;
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Peel a ref value through tag objects down to a commit. */
export function peelToCommit(repo: Repo, sha: string): string | undefined {
  let current = sha;
  for (let i = 0; i < 8; i++) {
    const object = getObject(repo, current);
    if (!object) return undefined;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = decodeCommitless(object.data);
      continue;
    }
    return undefined;
  }
  return undefined;
}

function decodeCommitless(data: Buffer): string {
  const text = data.toString('utf8');
  const m = /^object ([0-9a-f]{40})/m.exec(text);
  return m ? m[1]! : '';
}

export function isAncestor(repo: Repo, ancestorSha: string, descendantSha: string): boolean {
  if (ancestorSha === descendantSha) return true;
  const seen = new Set<string>();
  const queue = [descendantSha];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestorSha) return true;
    const object = getObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    queue.push(...decodeCommit(object.data).parents);
  }
  return false;
}

/** The merge base of two commits: the deepest common ancestor (good approximation of git's). */
export function mergeBase(repo: Repo, aSha: string, bSha: string): string | undefined {
  const ancestorsOf = (start: string): Map<string, number> => {
    const distances = new Map<string, number>();
    const queue: Array<[string, number]> = [[start, 0]];
    while (queue.length) {
      const [oid, distance] = queue.shift()!;
      const known = distances.get(oid);
      if (known !== undefined && known <= distance) continue;
      distances.set(oid, distance);
      const object = getObject(repo, oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of decodeCommit(object.data).parents) queue.push([parent, distance + 1]);
    }
    return distances;
  };
  const distA = ancestorsOf(aSha);
  const distB = ancestorsOf(bSha);
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [oid, distance] of distA) {
    if (!distB.has(oid)) continue;
    const total = distance + distB.get(oid)!;
    if (total < bestDistance) {
      bestDistance = total;
      best = oid;
    }
  }
  return best;
}

// ---------------------------------------------------------------- tree helpers

export function readTree(repo: Repo, treeSha: string): Array<{ mode: string; name: string; sha: string }> {
  const object = getObject(repo, treeSha);
  if (!object || object.type !== 'tree') return [];
  return decodeTree(object.data);
}

/** Walk a path from a tree; returns the entry found or undefined. */
export function treeEntryAt(
  repo: Repo,
  treeSha: string,
  segments: readonly string[],
): { mode: string; name: string; sha: string } | undefined {
  let current = treeSha;
  for (let i = 0; i < segments.length; i++) {
    const entries = readTree(repo, current);
    const entry = entries.find((e) => e.name === segments[i]);
    if (!entry) return undefined;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return undefined;
    current = entry.sha;
  }
  return undefined;
}

/**
 * Rebuild trees along `segments` so that the leaf holds `leafSha`, starting from `baseTree`
 * (or building a fresh tree when base is empty). Returns the sha of the new root tree.
 */
export function writeTreePath(
  repo: Repo,
  baseTree: string | undefined,
  segments: readonly string[],
  leafSha: string,
  leafMode: string,
): string {
  if (segments.length === 0) return leafSha;
  const baseEntries = baseTree ? readTree(repo, baseTree) : [];
  const head = segments[0]!;
  const filtered = baseEntries.filter((e) => e.name !== head);
  if (segments.length === 1) {
    filtered.push({ mode: leafMode, name: head, sha: leafSha });
  } else {
    const childBase = baseEntries.find((e) => e.name === head && e.mode === '40000')?.sha;
    const childSha = writeTreePath(repo, childBase, segments.slice(1), leafSha, leafMode);
    filtered.push({ mode: '40000', name: head, sha: childSha });
  }
  return putObject(repo, 'tree', encodeTree(filtered)).sha;
}

/** Remove `segments` from the tree; returns the new root tree sha (undefined when the tree became empty at root). */
export function removeTreePath(
  repo: Repo,
  baseTree: string | undefined,
  segments: readonly string[],
): string | undefined {
  if (!baseTree) return undefined;
  if (segments.length === 0) return undefined;
  const baseEntries = readTree(repo, baseTree);
  const head = segments[0]!;
  const kept = baseEntries.filter((e) => e.name !== head);
  if (segments.length > 1) {
    const child = baseEntries.find((e) => e.name === head && e.mode === '40000');
    if (child) {
      const newChild = removeTreePath(repo, child.sha, segments.slice(1));
      if (newChild) kept.push({ mode: '40000', name: head, sha: newChild });
    }
  }
  if (kept.length === 0) return undefined;
  return putObject(repo, 'tree', encodeTree(kept)).sha;
}

/** Walk a tree recursively; yields {path, mode, sha, type} for every blob and subtree. */
export function walkTree(
  repo: Repo,
  treeSha: string,
  prefix: string,
  visit: (path: string, mode: string, sha: string, isTree: boolean) => void,
): void {
  for (const entry of readTree(repo, treeSha)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const isTree = entry.mode === '40000';
    visit(path, entry.mode, entry.sha, isTree);
    if (isTree) walkTree(repo, entry.sha, path, visit);
  }
}

export function flattenTree(repo: Repo, treeSha: string): Map<string, { mode: string; sha: string }> {
  const files = new Map<string, { mode: string; sha: string }>();
  walkTree(repo, treeSha, '', (path, mode, sha, isTree) => {
    if (!isTree) files.set(path, { mode, sha });
  });
  return files;
}

// ---------------------------------------------------------------- commits

export function commitInfo(repo: Repo, sha: string): { sha: string; commit: ReturnType<typeof decodeCommit>; object: GitObject } | undefined {
  const object = getObject(repo, sha);
  if (!object || object.type !== 'commit') return undefined;
  return { sha, commit: decodeCommit(object.data), object };
}

export interface CreateCommitOptions {
  tree: string;
  parents: string[];
  message: string;
  author?: Signature;
  committer?: Signature;
}

export function createCommit(repo: Repo, options: CreateCommitOptions): string {
  const author = options.author ?? viewerSignature();
  const committer = options.committer ?? author;
  const data = encodeCommit({ tree: options.tree, parents: options.parents, author, committer, message: options.message });
  return putObject(repo, 'commit', data).sha;
}

/** List commits reachable from `start`, newest first (parents walked in order). */
export function listCommits(repo: Repo, start: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid) || !OID_RE.test(oid)) continue;
    seen.add(oid);
    const object = getObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    queue.push(...decodeCommit(object.data).parents);
  }
  return out;
}

// ---------------------------------------------------------------- issues / labels / pulls

export function findLabel(repo: Repo, name: string): Label | undefined {
  const lower = name.toLowerCase();
  return repo.labels.find((label) => label.name.toLowerCase() === lower);
}

export function createLabel(repo: Repo, name: string, color: string, description?: string | null): Label {
  const label: Label = { id: labelIdCounter++, name, color, description: description ?? null };
  repo.labels.push(label);
  return label;
}

export function nextIssueNumber(repo: Repo): number {
  return repo.nextNumber++;
}

export function createIssue(repo: Repo, fields: { title: string; body: string | null; labels: Label[] }): Issue {
  const now = nowIso();
  const issue: Issue = {
    id: issueIdCounter++,
    number: nextIssueNumber(repo),
    title: fields.title,
    body: fields.body,
    state: 'open',
    labels: fields.labels,
    user: VIEWER_LOGIN,
    comments: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    pull: false,
  };
  repo.issues.push(issue);
  return issue;
}

export function createPull(repo: Repo, fields: {
  title: string;
  body: string | null;
  headRef: string;
  headLabel: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
}): Pull {
  const now = nowIso();
  const pull: Pull = {
    id: issueIdCounter++,
    number: nextIssueNumber(repo),
    title: fields.title,
    body: fields.body,
    state: 'open',
    merged: false,
    draft: false,
    headRef: fields.headRef,
    headLabel: fields.headLabel,
    baseRef: fields.baseRef,
    headShaAtCreate: fields.headSha,
    baseShaAtCreate: fields.baseSha,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    user: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
    pull: true,
  };
  repo.pulls.push(pull);
  return pull;
}

export function findIssueOrPull(repo: Repo, number: number): IssueOrPull | undefined {
  const issue = repo.issues.find((i) => i.number === number);
  if (issue) return issue;
  return repo.pulls.find((p) => p.number === number);
}

export function addComment(repo: Repo, issue: Issue, body: string): IssueComment {
  const now = nowIso();
  const comment: IssueComment = { id: commentIdCounter++, body, user: VIEWER_LOGIN, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  issue.updatedAt = now;
  return comment;
}

export { ZERO_OID, OID_RE };
