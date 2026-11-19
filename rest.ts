// REST v3 (/api/v3): repositories, git refs, branches, commits, contents, labels,
// issues, comments and pulls, GitHub-faithful shapes and status codes.
import {
  DEFAULT_BRANCH,
  type Issue,
  type IssueComment,
  type Label,
  type Pull,
  type Repo,
  VIEWER_ID,
  VIEWER_LOGIN,
  addComment,
  branchTip,
  createCommit,
  createIssue,
  createLabel,
  createPull,
  deleteRepo,
  findIssueOrPull,
  findLabel,
  flattenTree,
  getRepo,
  isAncestor,
  listReposOfViewer,
  mergeBase,
  nowIso,
  putObject,
  resolveRef,
  treeEntryAt,
  viewerSignature,
  writeTreePath,
  removeTreePath,
  createRepo,
  AlreadyExistsError,
  getObject,
} from './store.ts';
import { decodeCommit, decodeTree, encodeTree, ZERO_OID } from './git-objects.ts';

export interface ApiContext {
  method: string;
  segments: string[]; // path segments after /api/v3, percent-decoded
  query: URLSearchParams;
  body: unknown;
  bodyError: boolean;
  token: string | undefined;
  origin: string; // the request's own scheme://host, for Link headers that point back here
}

export interface ApiResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse {
  return { status, body, headers };
}

const notFound = (): ApiResponse => json(404, { message: 'Not Found' });
const badCredentials = (): ApiResponse => json(401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
const validationFailed = (message = 'Validation Failed'): ApiResponse => json(422, { message });

function percentEncode(value: string): string {
  return encodeURIComponent(value);
}

function repoPathOf(repo: Repo): string {
  return `/api/v3/repos/${percentEncode(repo.owner)}/${percentEncode(repo.name)}`;
}

// ---------------------------------------------------------------- JSON shapes

function userJson(login: string, id = VIEWER_ID): Record<string, unknown> {
  const safe = percentEncode(login);
  return {
    login,
    id,
    node_id: `MDQ6VXNlcjEwMDA=`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `https://api.github.com/users/${safe}`,
    html_url: `https://github.com/${safe}`,
    followers_url: `https://api.github.com/users/${safe}/followers`,
    following_url: `https://api.github.com/users/${safe}/following{/other_user}`,
    gists_url: `https://api.github.com/users/${safe}/gists{/gist_id}`,
    starred_url: `https://api.github.com/users/${safe}/starred{/owner}{/repo}`,
    subscriptions_url: `https://api.github.com/users/${safe}/subscriptions`,
    organizations_url: `https://api.github.com/users/${safe}/orgs`,
    repos_url: `https://api.github.com/users/${safe}/repos`,
    events_url: `https://api.github.com/users/${safe}/events{/privacy}`,
    received_events_url: `https://api.github.com/users/${safe}/received_events`,
    type: 'User',
    site_admin: false,
  };
}

export function viewerJson(): Record<string, unknown> {
  return {
    ...userJson(VIEWER_LOGIN),
    name: null,
    company: null,
    blog: '',
    location: null,
    email: null,
    hireable: null,
    bio: null,
    twitter_username: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: nowIso(),
    private_gists: 0,
    total_private_repos: 0,
    owned_private_repos: 0,
    disk_usage: 0,
    collaborators: 0,
    two_factor_authentication: false,
    plan: { name: 'free', space: 976_562_499, collaborators: 0, private_repos: 10000 },
  };
}

function openIssueCount(repo: Repo): number {
  return repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length;
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const path = repoPathOf(repo);
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(repo.owner),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com${path}`,
    forks_url: `https://api.github.com${path}/forks`,
    keys_url: `https://api.github.com${path}/keys{/key_id}`,
    collaborators_url: `https://api.github.com${path}/collaborators{/collaborator}`,
    teams_url: `https://api.github.com${path}/teams`,
    hooks_url: `https://api.github.com${path}/hooks`,
    issue_events_url: `https://api.github.com${path}/issues/events{/number}`,
    events_url: `https://api.github.com${path}/events`,
    assignees_url: `https://api.github.com${path}/assignees{/user}`,
    branches_url: `https://api.github.com${path}/branches{/branch}`,
    tags_url: `https://api.github.com${path}/tags`,
    blobs_url: `https://api.github.com${path}/git/blobs{/sha}`,
    git_tags_url: `https://api.github.com${path}/git/tags{/sha}`,
    git_refs_url: `https://api.github.com${path}/git/refs{/sha}`,
    trees_url: `https://api.github.com${path}/git/trees{/sha}`,
    statuses_url: `https://api.github.com${path}/statuses/{sha}`,
    languages_url: `https://api.github.com${path}/languages`,
    stargazers_url: `https://api.github.com${path}/stargazers`,
    contributors_url: `https://api.github.com${path}/contributors`,
    subscribers_url: `https://api.github.com${path}/subscribers`,
    subscription_url: `https://api.github.com${path}/subscription`,
    commits_url: `https://api.github.com${path}/commits{/sha}`,
    git_commits_url: `https://api.github.com${path}/git/commits{/sha}`,
    comments_url: `https://api.github.com${path}/comments{/number}`,
    issue_comment_url: `https://api.github.com${path}/issues/comments{/number}`,
    contents_url: `https://api.github.com${path}/contents/{+path}`,
    compare_url: `https://api.github.com${path}/compare/{base}...{head}`,
    merges_url: `https://api.github.com${path}/merges`,
    archive_url: `https://api.github.com${path}/{archive_format}{/ref}`,
    downloads_url: `https://api.github.com${path}/downloads`,
    issues_url: `https://api.github.com${path}/issues{/number}`,
    pulls_url: `https://api.github.com${path}/pulls{/number}`,
    milestones_url: `https://api.github.com${path}/milestones{/number}`,
    notifications_url: `https://api.github.com${path}/notifications{?since,all,participating}`,
    labels_url: `https://api.github.com${path}/labels{/name}`,
    releases_url: `https://api.github.com${path}/releases{/id}`,
    deployments_url: `https://api.github.com${path}/deployments`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    svn_url: `https://github.com/${repo.owner}/${repo.name}`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssueCount(repo),
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssueCount(repo),
    watchers: 0,
    default_branch: DEFAULT_BRANCH,
  };
}

function issueLabelJson(label: Label, repoUrl: string): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${label.id}`).toString('base64'),
    url: `https://api.github.com${repoUrl}/labels/${percentEncode(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const path = repoPathOf(repo);
  const n = issue.number;
  return {
    url: `https://api.github.com${path}/issues/${n}`,
    repository_url: `https://api.github.com${path}`,
    labels_url: `https://api.github.com${path}/issues/${n}/labels{/name}`,
    comments_url: `https://api.github.com${path}/issues/${n}/comments`,
    events_url: `https://api.github.com${path}/issues/${n}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${n}`,
    id: issue.id,
    node_id: Buffer.from(`Issue:${issue.id}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    user: userJson(issue.user),
    labels: issue.labels.map((label) => issueLabelJson(label, path)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    active_lock_reason: null,
    body: issue.body,
    closed_by: null,
    reactions: { url: `https://api.github.com${path}/issues/${n}/reactions`, total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    timeline_url: `https://api.github.com${path}/issues/${n}/timeline`,
    performed_via_github_app: null,
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function refSummary(repo: Repo, refName: string): Record<string, unknown> {
  const sha = branchTip(repo, refName) ?? ZERO_OID;
  return { label: `${repo.owner}:${refName}`, ref: refName, sha, repo: repoJson(repo) as Record<string, unknown>, user: userJson(VIEWER_LOGIN) };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const path = repoPathOf(repo);
  const n = pull.number;
  const headSha = pull.state === 'open' ? (branchTip(repo, pull.headRef) ?? pull.headShaAtCreate ?? ZERO_OID) : (pull.headShaAtCreate ?? ZERO_OID);
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate ?? ZERO_OID;
  return {
    url: `https://api.github.com${path}/pulls/${n}`,
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${pull.id}`).toString('base64'),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${n}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${n}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${n}.patch`,
    issue_url: `https://api.github.com${path}/issues/${n}`,
    number: n,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(pull.user),
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: pull.draft,
    commits_url: `https://api.github.com${path}/pulls/${n}/commits`,
    review_comments_url: `https://api.github.com${path}/pulls/${n}/comments`,
    review_comment_url: `https://api.github.com/repos/{owner}/{repo}/pulls/comments{/number}`,
    comments_url: `https://api.github.com${path}/issues/${n}/comments`,
    statuses_url: `https://api.github.com${path}/statuses/${headSha}`,
    head: { ...refSummary(repo, pull.headRef), sha: headSha },
    base: { ...refSummary(repo, pull.baseRef), sha: baseSha },
    _links: {
      self: { href: `https://api.github.com${path}/pulls/${n}` },
      html: { href: `https://github.com/${repo.owner}/${repo.name}/pull/${n}` },
      issue: { href: `https://api.github.com${path}/issues/${n}` },
      comments: { href: `https://api.github.com${path}/issues/${n}/comments` },
      review_comments: { href: `https://api.github.com${path}/pulls/${n}/comments` },
      review_comment: { href: `https://api.github.com/repos/{owner}/{repo}/pulls/comments{/number}` },
      commits: { href: `https://api.github.com${path}/pulls/${n}/commits` },
      statuses: { href: `https://api.github.com${path}/statuses/${headSha}` },
    },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? (mergeIsConflicting(repo, pull) ? false : true) : null,
    rebaseable: pull.state === 'open' ? !mergeIsConflicting(repo, pull) : null,
    mergeable_state: pull.state === 'open' ? (mergeIsConflicting(repo, pull) ? 'dirty' : 'clean') : 'unknown',
    merged_by: pull.merged ? userJson(VIEWER_LOGIN) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    allow_auto_merge: false,
    allow_update_branch: true,
    delete_branch_on_merge: false,
  };
}

function commentJson(repo: Repo, issue: IssueOrPull, comment: IssueComment): Record<string, unknown> {
  const path = repoPathOf(repo);
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
    url: `https://api.github.com${path}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
    issue_url: `https://api.github.com${path}/issues/${issue.number}`,
    reactions: {},
  };
}

function labelJson(label: Label, repoUrl: string): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${label.id}`).toString('base64'),
    url: `https://api.github.com${repoUrl}/labels/${percentEncode(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function branchJson(repo: Repo, name: string): Record<string, unknown> | null {
  const sha = branchTip(repo, name);
  if (sha === undefined) return null;
  const info = commitInfoJson(repo, sha);
  if (info === null) return null;
  return {
    name,
    commit: {
      sha,
      commit: (info as { commit: Record<string, unknown> }).commit,
      tree: (info as { commit: { tree: unknown } }).commit.tree,
      url: `https://api.github.com${repoPathOf(repo)}/commits/${sha}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
      comments_url: `https://api.github.com${repoPathOf(repo)}/commits/${sha}/comments`,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    _links: {
      self: `https://api.github.com${repoPathOf(repo)}/branches/${percentEncode(name)}`,
      html: `https://github.com/${repo.owner}/${repo.name}/tree/${percentEncode(name)}`,
    },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
    protection_url: `https://api.github.com${repoPathOf(repo)}/branches/${percentEncode(name)}/protection`,
  };
}

function commitInfoJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = getObject(repo, sha);
  if (!object || object.type !== 'commit') return null;
  const commit = decodeCommit(object.data);
  const iso = (when: number): string => new Date(when * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const path = repoPathOf(repo);
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
    commit: {
      author: { name: commit.author.name, email: commit.author.email, date: iso(commit.author.when) },
      committer: { name: commit.committer.name, email: commit.committer.email, date: iso(commit.committer.when) },
      message: commit.message,
      tree: { sha: commit.tree, url: `https://api.github.com${path}/git/trees/${commit.tree}` },
      url: `https://api.github.com${path}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `https://api.github.com${path}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `https://api.github.com${path}/commits/${sha}/comments`,
    author: userJson(VIEWER_LOGIN),
    committer: userJson(VIEWER_LOGIN),
    parents: commit.parents.map((parent) => ({
      sha: parent,
      url: `https://api.github.com${path}/commits/${parent}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${parent}`,
    })),
  };
}

// ---------------------------------------------------------------- line diff

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiff(base: string, head: string): { additions: number; deletions: number } {
  const a = splitLines(base);
  const b = splitLines(head);
  // LCS dynamic programming, capped for pathological inputs.
  const cap = 4000;
  if (a.length * b.length > cap * cap) {
    return { additions: Math.max(0, b.length - a.length), deletions: Math.max(0, a.length - b.length) };
  }
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const common = table[0]![0]!;
  return { additions: m - common, deletions: n - common };
}

// ---------------------------------------------------------------- pull request files / merge

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

function treeShaOf(repo: Repo, sha: string): string | undefined {
  const object = getObject(repo, sha);
  if (!object) return undefined;
  if (object.type === 'commit') return decodeCommit(object.data).tree;
  if (object.type === 'tag') {
    const target = getObject(repo, decodeCommitlessSha(object.data));
    return target && target.type === 'commit' ? decodeCommit(target.data).tree : undefined;
  }
  return undefined;
}

function decodeCommitlessSha(data: Buffer): string {
  const m = /^object ([0-9a-f]{40})/m.exec(data.toString('utf8'));
  return m ? m[1]! : ZERO_OID;
}

export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
  if (headSha === undefined || baseSha === undefined) return [];
  const mb = mergeBase(repo, headSha, baseSha) ?? baseSha;
  const headTree = treeShaOf(repo, headSha);
  const baseTree = treeShaOf(repo, baseSha);
  const mbTree = treeShaOf(repo, mb);
  if (headTree === undefined || mbTree === undefined) return [];
  const headFiles = flattenTree(repo, headTree);
  const baseFiles = mbTree ? flattenTree(repo, mbTree) : new Map();
  const out: PullFile[] = [];
  for (const [path, entry] of headFiles) {
    const before = baseFiles.get(path);
    if (before === undefined) {
      const content = getObject(repo, entry.sha)?.data.toString('utf8') ?? '';
      out.push({ filename: path, status: 'added', additions: splitLines(content).length, deletions: 0, changes: splitLines(content).length, sha: entry.sha });
    } else if (before.sha !== entry.sha) {
      const baseContent = getObject(repo, before.sha)?.data.toString('utf8') ?? '';
      const headContent = getObject(repo, entry.sha)?.data.toString('utf8') ?? '';
      const diff = lineDiff(baseContent, headContent);
      out.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions, changes: diff.additions + diff.deletions, sha: entry.sha });
    }
  }
  if (baseTree !== undefined) {
    for (const [path, entry] of baseFiles) {
      if (headFiles.has(path)) continue;
      const content = getObject(repo, entry.sha)?.data.toString('utf8') ?? '';
      out.push({ filename: path, status: 'removed', additions: 0, deletions: splitLines(content).length, changes: splitLines(content).length, sha: entry.sha });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

function changedPaths(repo: Repo, fromSha: string, toSha: string): Set<string> {
  const fromTree = treeShaOf(repo, fromSha);
  const toTree = treeShaOf(repo, toSha);
  const fromFiles = fromTree ? flattenTree(repo, fromTree) : new Map<string, { mode: string; sha: string }>();
  const toFiles = toTree ? flattenTree(repo, toTree) : new Map<string, { mode: string; sha: string }>();
  const changed = new Set<string>();
  for (const [path, entry] of toFiles) {
    const before = fromFiles.get(path);
    if (before === undefined || before.sha !== entry.sha) changed.add(path);
  }
  for (const path of fromFiles.keys()) if (!toFiles.has(path)) changed.add(path);
  return changed;
}

export function mergeIsConflicting(repo: Repo, pull: Pull): boolean {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
  if (headSha === undefined || baseSha === undefined) return false;
  if (headSha === baseSha) return false;
  const mb = mergeBase(repo, headSha, baseSha);
  if (mb === undefined) return false;
  if (mb === headSha) return false;
  const baseChanges = changedPaths(repo, mb, baseSha);
  const headChanges = changedPaths(repo, mb, headSha);
  for (const path of headChanges) if (baseChanges.has(path)) return true;
  return false;
}

export function squashMergePull(repo: Repo, pull: Pull): { sha: string } | { conflict: true } {
  if (mergeIsConflicting(repo, pull)) return { conflict: true };
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
  const headSha = branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  if (baseSha === undefined || headSha === undefined) return { conflict: true };
  const headObject = getObject(repo, headSha);
  const tree = headObject ? decodeCommit(headObject.data).tree : undefined;
  if (tree === undefined) return { conflict: true };
  // GitHub's squash merge always parents the new commit on the base tip: the history stays
  // connected, so later conflict detection (merge-base against other branches) still works.
  const parents = [baseSha];
  const message = `${pull.title}${pull.body ? `\n\n${pull.body}` : ''}\n`;
  const sha = createCommit(repo, { tree, parents, message, author: viewerSignature(), committer: viewerSignature() });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  repo.pushedAt = nowIso();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso();
  pull.closedAt = pull.mergedAt;
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { sha };
}

// ---------------------------------------------------------------- contents helpers

function b64decode(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function b64encodeWrap(data: Buffer): string {
  const text = data.toString('base64');
  return (text.match(/.{1,60}/g) ?? []).join('\n') + (text.length > 0 ? '\n' : '');
}

function tipForBranch(repo: Repo, branch: string | undefined): { tip: string | undefined; created: boolean } {
  const name = branch ?? DEFAULT_BRANCH;
  const existing = branchTip(repo, name);
  if (existing !== undefined) return { tip: existing, created: false };
  const fallback = branchTip(repo, DEFAULT_BRANCH);
  if (fallback !== undefined && name !== DEFAULT_BRANCH) {
    repo.refs.set(`refs/heads/${name}`, fallback);
    return { tip: fallback, created: true };
  }
  return { tip: undefined, created: false };
}

function contentsFileJson(repo: Repo, path: string, sha: string, refName: string): Record<string, unknown> | null {
  const object = getObject(repo, sha);
  if (!object || object.type !== 'blob') return null;
  const segments = path.split('/').filter((segment) => segment !== '');
  const name = segments[segments.length - 1] ?? path;
  const encoded = percentEncode(path).replace(/%2F/gu, '/');
  return {
    name,
    path,
    sha,
    size: object.data.length,
    url: `https://api.github.com${repoPathOf(repo)}/contents/${encoded}?ref=${percentEncode(refName)}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${percentEncode(refName)}/${encoded}`,
    git_url: `https://api.github.com${repoPathOf(repo)}/git/blobs/${sha}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${percentEncode(refName)}/${encoded}`,
    type: 'file',
    content: b64encodeWrap(object.data),
    encoding: 'base64',
    _links: {
      self: `https://api.github.com${repoPathOf(repo)}/contents/${encoded}?ref=${percentEncode(refName)}`,
      git: `https://api.github.com${repoPathOf(repo)}/git/blobs/${sha}`,
      html: `https://github.com/${repo.owner}/${repo.name}/blob/${percentEncode(refName)}/${encoded}`,
    },
  };
}

function contentsEntryJson(repo: Repo, path: string, mode: string, sha: string, refName: string): Record<string, unknown> {
  const object = getObject(repo, sha);
  const isTree = mode === '40000';
  const segments = path.split('/').filter((segment) => segment !== '');
  const name = segments[segments.length - 1] ?? path;
  const encoded = percentEncode(path).replace(/%2F/gu, '/');
  return {
    name,
    path,
    sha,
    size: isTree ? 0 : object?.data.length ?? 0,
    url: `https://api.github.com${repoPathOf(repo)}/contents/${encoded}?ref=${percentEncode(refName)}`,
    html_url: isTree
      ? `https://github.com/${repo.owner}/${repo.name}/tree/${percentEncode(refName)}/${encoded}`
      : `https://github.com/${repo.owner}/${repo.name}/blob/${percentEncode(refName)}/${encoded}`,
    git_url: `https://api.github.com${repoPathOf(repo)}/git/${isTree ? 'trees' : 'blobs'}/${sha}`,
    download_url: isTree ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${percentEncode(refName)}/${encoded}`,
    type: isTree ? 'dir' : 'file',
    _links: {
      self: `https://api.github.com${repoPathOf(repo)}/contents/${encoded}?ref=${percentEncode(refName)}`,
      git: `https://api.github.com${repoPathOf(repo)}/git/${isTree ? 'trees' : 'blobs'}/${sha}`,
      html: isTree
        ? `https://github.com/${repo.owner}/${repo.name}/tree/${percentEncode(refName)}/${encoded}`
        : `https://github.com/${repo.owner}/${repo.name}/blob/${percentEncode(refName)}/${encoded}`,
    },
  };
}

function commitJsonForContents(repo: Repo, sha: string, message: string): Record<string, unknown> {
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
    url: `https://api.github.com${repoPathOf(repo)}/git/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@users.noreply.github.com`, date: nowIso() },
    committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@users.noreply.github.com`, date: nowIso() },
    message,
    tree: { sha: (() => { const o = getObject(repo, sha); return o ? decodeCommit(o.data).tree : ZERO_OID; })(), url: `https://api.github.com${repoPathOf(repo)}/git/trees/x` },
    parents: (() => { const o = getObject(repo, sha); return o ? decodeCommit(o.data).parents.map((p) => ({ sha: p, url: `https://api.github.com${repoPathOf(repo)}/git/commits/${p}`, html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${p}` })) : []; })(),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  };
}

// ---------------------------------------------------------------- the router

function asRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function handleApi(ctx: ApiContext): ApiResponse {
  if (ctx.token === undefined) return badCredentials();
  const [route, repo, rest] = splitRoute(ctx);
  void repo;
  void rest;
  return route;
}

function splitRoute(ctx: ApiContext): [ApiResponse, null, null] {
  return [routeApi(ctx), null, null];
}

function routeApi(ctx: ApiContext): ApiResponse {
  const segments = ctx.segments;
  const method = ctx.method;

  if (segments.length === 0) {
    if (method === 'GET') {
      return json(200, { current_user_url: 'https://api.github.com/user', authorizations_url: 'https://api.github.com/authorizations', code_search_url: 'https://api.github.com/search/code?q={query}{&page,per_page,sort,order}', emails_url: 'https://api.github.com/user/emails', events_url: 'https://api.github.com/events', feeds_url: 'https://api.github.com/feeds', followers_url: 'https://api.github.com/user/followers', following_url: 'https://api.github.com/user/following{/target}', issues_url: 'https://api.github.com/issues', user_repositories_url: 'https://api.github.com/user/repos{?type,page,per_page,sort}', repository_url: 'https://api.github.com/repos/{owner}/{repo}', repository_search_url: 'https://api.github.com/search/repositories?q={query}{&page,per_page,sort,order}', rate_limit_url: 'https://api.github.com/rate_limit', user_url: 'https://api.github.com/user' }, { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': '', 'x-github-media-type': 'github.v3; format=json' });
    }
    return notFound();
  }

  switch (segments[0]) {
    case 'meta':
      if (method === 'GET' && segments.length === 1) return json(200, { installed_version: '1.0.0' });
      return notFound();
    case 'user': {
      if (segments.length === 1 && method === 'GET') return json(200, viewerJson());
      if (segments.length === 2 && segments[1] === 'repos' && method === 'GET') return listUserRepos(ctx);
      if (segments.length === 2 && segments[1] === 'repos' && method === 'POST') return createUserRepo(ctx);
      return notFound();
    }
    case 'repos': {
      if (segments.length < 3) return notFound();
      const owner = segments[1]!;
      const name = segments[2]!;
      const repo = getRepo(owner, name);
      const tail = segments.slice(3);
      if (repo === undefined) {
        // Another owner's namespace never exposes another viewer's repositories.
        if (tail.length === 0 && method === 'GET') return notFound();
        return notFound();
      }
      if (tail.length === 0) {
        if (method === 'GET') return json(200, repoJson(repo));
        if (method === 'PATCH') return patchRepo(ctx, repo);
        if (method === 'DELETE') {
          deleteRepo(repo.owner, repo.name);
          return { status: 204 };
        }
        return notFound();
      }
      return routeRepo(ctx, repo, tail);
    }
    default:
      return notFound();
  }
}

function listUserRepos(ctx: ApiContext): ApiResponse {
  const repos = listReposOfViewer();
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
  const start = (page - 1) * perPage;
  const slice = repos.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < repos.length) {
    const nextUrl = `${ctx.origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    headers.Link = `<${nextUrl}>; rel="next"`;
  }
  return json(200, slice.map(repoJson), headers);
}

function createUserRepo(ctx: ApiContext): ApiResponse {
  if (ctx.bodyError) return json(400, { message: 'Problems parsing JSON' });
  const body = asRecord(ctx.body);
  if (body === null) return validationFailed('Body should be a JSON object');
  const name = stringField(body, 'name');
  if (name === undefined || name.trim() === '') return validationFailed();
  try {
    const repo = createRepo(name, {
      private: typeof body.private === 'boolean' ? body.private : false,
      description: typeof body.description === 'string' ? body.description : null,
    });
    return json(201, repoJson(repo));
  } catch (error) {
    if (error instanceof AlreadyExistsError) {
      return json(422, { message: `name already exists on this account` });
    }
    throw error;
  }
}

function patchRepo(ctx: ApiContext, repo: Repo): ApiResponse {
  if (ctx.bodyError) return json(400, { message: 'Problems parsing JSON' });
  const body = asRecord(ctx.body);
  if (body === null) return validationFailed('Body should be a JSON object');
  if (typeof body.description === 'string' || body.description === null) repo.description = body.description as string | null;
  if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
    const renamed = createRepo(body.name, { private: repo.private, description: repo.description });
    // Move git state to the renamed repository.
    renamed.objects = repo.objects;
    renamed.refs = repo.refs;
    renamed.issues = repo.issues;
    renamed.pulls = repo.pulls;
    renamed.labels = repo.labels;
    renamed.nextNumber = repo.nextNumber;
    renamed.createdAt = repo.createdAt;
    renamed.updatedAt = nowIso();
    renamed.pushedAt = repo.pushedAt;
    deleteRepo(repo.owner, repo.name);
    return json(200, repoJson(renamed));
  }
  repo.updatedAt = nowIso();
  return json(200, repoJson(repo));
}

function routeRepo(ctx: ApiContext, repo: Repo, tail: string[]): ApiResponse {
  const method = ctx.method;
  const head = tail[0]!;
  switch (head) {
    case 'git':
      return routeGitData(ctx, repo, tail.slice(1));
    case 'branches':
      return routeBranches(ctx, repo, tail.slice(1));
    case 'commits':
      return routeCommits(ctx, repo);
    case 'contents':
      return routeContents(ctx, repo, tail.slice(1));
    case 'labels':
      return routeLabels(ctx, repo, tail.slice(1));
    case 'issues':
      return routeIssues(ctx, repo, tail.slice(1));
    case 'pulls':
      return routePulls(ctx, repo, tail.slice(1));
    default:
      return notFound();
  }
}

// ---------------------------------------------------------------- git data API

function routeGitData(ctx: ApiContext, repo: Repo, tail: string[]): ApiResponse {
  const method = ctx.method;
  if (tail[0] === 'refs') {
    if (tail.length === 1 && method === 'POST') return createRef(ctx, repo);
    if (tail.length === 3 && method === 'GET' && (tail[1] === 'heads' || tail[1] === 'tags')) {
      const refName = `${tail[1]}/${tail[2]}`;
      const sha = repo.refs.get(refName);
      if (sha === undefined) return notFound();
      return json(200, {
        ref: `refs/${refName}`,
        node_id: Buffer.from(`Ref:${repo.id}:${refName}`).toString('base64'),
        url: `https://api.github.com${repoPathOf(repo)}/git/refs/${refName}`,
        object: { sha, type: 'commit', url: `https://api.github.com${repoPathOf(repo)}/git/commits/${sha}` },
      });
    }
    if (tail.length === 1 && method === 'GET') {
      return json(200, [...repo.refs.entries()].map(([refName, sha]) => ({
        ref: refName,
        node_id: Buffer.from(`Ref:${repo.id}:${refName}`).toString('base64'),
        url: `https://api.github.com${repoPathOf(repo)}/git/refs/${refName}`,
        object: { sha, type: 'commit', url: `https://api.github.com${repoPathOf(repo)}/git/commits/${sha}` },
      })));
    }
    return notFound();
  }
  return notFound();
}

function createRef(ctx: ApiContext, repo: Repo): ApiResponse {
  if (ctx.bodyError) return json(400, { message: 'Problems parsing JSON' });
  const body = asRecord(ctx.body);
  if (body === null) return validationFailed('Body should be a JSON object');
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  if (ref === undefined || sha === undefined) return validationFailed();
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return validationFailed('Reference name is not valid');
  if (!repo.objects.has(sha)) return json(422, { message: 'Object does not exist' });
  if (repo.refs.has(ref)) return json(422, { message: 'Reference already exists' });
  repo.refs.set(ref, sha);
  repo.pushedAt = nowIso();
  return json(201, {
    ref,
    node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'),
    url: `https://api.github.com${repoPathOf(repo)}/git/refs/${ref.slice(5)}`,
    object: { sha, type: 'commit', url: `https://api.github.com${repoPathOf(repo)}/git/commits/${sha}` },
  });
}

// ---------------------------------------------------------------- branches / commits

function routeBranches(ctx: ApiContext, repo: Repo, tail: string[]): ApiResponse {
  const method = ctx.method;
  if (tail.length === 0 && method === 'GET') {
    const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
    const branches: Array<Record<string, unknown>> = [];
    for (const ref of names) {
      const branch = branchJson(repo, ref.slice('refs/heads/'.length));
      if (branch !== null) branches.push(branch);
    }
    return json(200, branches);
  }
  if (tail.length === 1 && method === 'GET') {
    const branch = branchJson(repo, tail[0]!);
    if (branch === null) return notFound();
    return json(200, branch);
  }
  return notFound();
}

function routeCommits(ctx: ApiContext, repo: Repo): ApiResponse {
  if (ctx.method !== 'GET') return notFound();
  const shaParam = ctx.query.get('sha');
  const start = shaParam !== null ? (resolveRef(repo, shaParam) ?? (repo.objects.has(shaParam) ? shaParam : undefined)) : resolveRef(repo, 'HEAD');
  if (start === undefined || start === ZERO_OID) {
    if (shaParam !== null) return json(409, { message: `No commit found for SHA: ${shaParam}` });
    return json(409, { message: 'Git Repository is empty.' });
  }
  const commits = listCommitsOf(repo, start);
  return json(200, commits);
}

function listCommitsOf(repo: Repo, start: string): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const queue = [start];
  const out: Array<Record<string, unknown>> = [];
  while (queue.length && out.length < 500) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const info = commitInfoJson(repo, oid);
    if (info === null) continue;
    out.push(info);
    const object = getObject(repo, oid)!;
    queue.push(...decodeCommit(object.data).parents);
  }
  return out;
}

// ---------------------------------------------------------------- contents

function routeContents(ctx: ApiContext, repo: Repo, tail: string[]): ApiResponse {
  const path = tail.join('/').replace(/^\/+/, '');
  const refParam = ctx.query.get('ref');
  if (ctx.method === 'GET') return getContents(repo, path, refParam);
  if (ctx.method === 'PUT') return putContents(ctx, repo, path);
  if (ctx.method === 'DELETE') return deleteContents(ctx, repo, path);
  return notFound();
}

function resolveContentsRef(repo: Repo, refParam: string | null): { refName: string; sha: string | undefined } {
  if (refParam !== null) {
    const resolved = resolveRef(repo, refParam);
    return { refName: refParam, sha: resolved };
  }
  return { refName: DEFAULT_BRANCH, sha: resolveRef(repo, 'HEAD') };
}

function getContents(repo: Repo, path: string, refParam: string | null): ApiResponse {
  const { refName, sha } = resolveContentsRef(repo, refParam);
  if (sha === undefined) {
    if (refParam !== null && !branchTip(repo, refParam.startsWith('refs/') ? refParam.slice(11) : refParam) && !repo.refs.has(refParam.startsWith('refs/') ? refParam : `refs/heads/${refParam}`)) {
      return json(404, { message: `No commit found for SHA: ${refParam}` });
    }
    if (path === '') return json(200, []);
    return notFound();
  }
  const object = getObject(repo, sha);
  if (object === undefined) return json(404, { message: 'Not Found' });
  const rootTree = object.type === 'commit' ? decodeCommit(object.data).tree : object.sha;
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) {
    const entries = decodeTree(getObject(repo, rootTree)?.data ?? Buffer.alloc(0));
    return json(200, entries.map((entry) => contentsEntryJson(repo, entry.name, entry.mode, entry.sha, refName)));
  }
  const entry = treeEntryAt(repo, rootTree, segments);
  if (entry === undefined) return notFound();
  if (entry.mode === '40000') {
    const entries = decodeTree(getObject(repo, entry.sha)?.data ?? Buffer.alloc(0));
    return json(200, entries.map((child) => contentsEntryJson(repo, [...segments, child.name].join('/'), child.mode, child.sha, refName)));
  }
  const file = contentsFileJson(repo, path, entry.sha, refName);
  if (file === null) return notFound();
  return json(200, file);
}

function putContents(ctx: ApiContext, repo: Repo, path: string): ApiResponse {
  if (ctx.bodyError) return json(400, { message: 'Problems parsing JSON' });
  const body = asRecord(ctx.body);
  if (body === null) return validationFailed('Body should be a JSON object');
  const message = stringField(body, 'message');
  const content = stringField(body, 'content');
  const branchParam = stringField(body, 'branch');
  const shaParam = stringField(body, 'sha');
  if (message === undefined || content === undefined) return validationFailed();
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return validationFailed('path is empty');
  let data: Buffer;
  try {
    data = b64decode(content);
    if (content.replace(/[\r\n\t ]+/g, '').length % 4 !== 0) throw new Error('bad padding');
  } catch {
    return validationFailed('content is not valid base64');
  }

  const branchName = branchParam ?? DEFAULT_BRANCH;
  const { tip } = tipForBranch(repo, branchName);
  const refKey = `refs/heads/${branchName}`;
  const baseTip = branchTip(repo, branchName);
  const baseTree = baseTip !== undefined ? decodeCommit(getObject(repo, baseTip)!.data).tree : undefined;

  const existing = baseTree !== undefined ? treeEntryAt(repo, baseTree, segments) : undefined;
  const isUpdate = existing !== undefined && existing.mode !== '40000';
  if (isUpdate) {
    if (shaParam === undefined) return json(422, { message: 'sha must be provided to update an existing file' });
    if (shaParam !== existing!.sha) return json(409, { message: `${path} does not match ${shaParam}` });
  } else if (shaParam !== undefined) {
    return json(404, { message: `${path} was not found at ${branchName}` });
  }

  const blob = putObject(repo, 'blob', data);
  const tree = writeTreePath(repo, baseTree, segments, blob.sha, '100644');
  const parents = baseTip !== undefined ? [baseTip] : [];
  const commitSha = createCommit(repo, { tree, parents, message });
  repo.refs.set(refKey, commitSha);
  repo.pushedAt = nowIso();
  void tip;
  const file = contentsFileJson(repo, path, blob.sha, branchName)!;
  return json(isUpdate ? 200 : 201, { content: file, commit: commitJsonForContents(repo, commitSha, message) });
}

function deleteContents(ctx: ApiContext, repo: Repo, path: string): ApiResponse {
  if (ctx.bodyError) return json(400, { message: 'Problems parsing JSON' });
  const body = asRecord(ctx.body);
  if (body === null) return validationFailed('Body should be a JSON object');
  const shaParam = stringField(body, 'sha');
  const branchParam = stringField(body, 'branch');
  const message = stringField(body, 'message') ?? `Delete ${path}`;
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return validationFailed('path is empty');
  const branchName = branchParam ?? DEFAULT_BRANCH;
  const baseTip = branchTip(repo, branchName);
  if (baseTip === undefined) return notFound();
  const baseTree = decodeCommit(getObject(repo, baseTip)!.data).tree;
  const existing = treeEntryAt(repo, baseTree, segments);
  if (existing === undefined || existing.mode === '40000') return json(404, { message: 'Not Found' });
  if (shaParam !== undefined && shaParam !== existing.sha) return json(409, { message: `${path} does not match ${shaParam}` });
  const tree = removeTreePath(repo, baseTree, segments);
  const commitSha = createCommit(repo, { tree: tree ?? EMPTY_TREE(repo), parents: [baseTip], message });
  repo.refs.set(`refs/heads/${branchName}`, commitSha);
  repo.pushedAt = nowIso();
  return json(200, { content: null, commit: commitJsonForContents(repo, commitSha, message) });
}

function EMPTY_TREE(repo: Repo): string {
  const empty = encodeTree([]);
  return putObject(repo, 'tree', empty).sha;
}

// ---------------------------------------------------------------- labels / issues / pulls

function routeLabels(ctx: ApiContext, repo: Repo, tail: string[]): ApiResponse {
  const method = ctx.method;
  if (tail.length === 0 && method === 'GET') return json(200, repo.labels.map((label) => labelJson(label, repoPathOf(repo))));
  if (tail.length === 0 && method === 'POST') {
    if (ctx.bodyError) return json(400, { message: 'Problems parsing JSON' });
    const body = asRecord(ctx.body);
    if (body === null) return validationFailed('Body should be a JSON object');
    const name = stringField(body, 'name');
    if (name === undefined || name.trim() === '') return validationFailed();
    if (findLabel(repo, name) !== undefined) return json(422, { message: 'Label already exists' });
    const label = createLabel(repo, name, stringField(body, 'color') ?? 'ededed', stringField(body, 'description') ?? null);
    return json(201, labelJson(label, repoPathOf(repo)));
  }
  if (tail.length === 1 && method === 'GET') {
    const label = findLabel(repo, tail[0]!);
    if (label === undefined) return notFound();
    return json(200, labelJson(label, repoPathOf(repo)));
  }
  return notFound();
}

function issueOrPullJson(repo: Repo, entry: Issue | Pull): Record<string, unknown> {
  return entry.pull ? pullJson(repo, entry) : issueJson(repo, entry);
}

function routeIssues(ctx: ApiContext, repo: Repo, tail: string[]): ApiResponse {
  const method = ctx.method;
  if (tail.length === 0) {
    if (method === 'GET') return listIssues(ctx, repo);
    if (method === 'POST') return createIssueRoute(ctx, repo);
    return notFound();
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound();
  const entry = findIssueOrPull(repo, number);
  if (entry === undefined || entry.pull) {
    // Pull request numbers under /issues are still addressable in GitHub; keep the JSON right.
    if (entry !== undefined) return json(200, issueOrPullJson(repo, entry));
    return notFound();
  }
  if (tail.length === 1) {
    if (method === 'GET') return json(200, issueJson(repo, entry));
    if (method === 'PATCH') return patchIssue(ctx, repo, entry);
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') return json(200, entry.comments.map((comment) => commentJson(repo, entry, comment)));
    if (method === 'POST') {
      if (ctx.bodyError) return json(400, { message: 'Problems parsing JSON' });
      const body = asRecord(ctx.body);
      if (body === null) return validationFailed('Body should be a JSON object');
      const text = stringField(body, 'body');
      if (text === undefined) return validationFailed();
      return json(201, commentJson(repo, entry, addComment(repo, entry, text)));
    }
    return notFound();
  }
  return notFound();
}

function listIssues(ctx: ApiContext, repo: Repo): ApiResponse {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  const labelsParam = ctx.query.get('labels');
  let entries: Issue[] = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
  if (labelsParam !== null && labelsParam !== '') {
    const wanted = labelsParam.split(',').map((name) => name.trim().toLowerCase());
    entries = entries.filter((issue) => issue.labels.some((label) => wanted.includes(label.name.toLowerCase())));
  }
  entries = [...entries].sort((a, b) => {
    const key = sort === 'updated' ? 'updatedAt' : sort === 'comments' ? 'comments' : 'createdAt';
    let cmp = 0;
    if (key === 'comments') cmp = a.comments.length - b.comments.length;
    else cmp = String(a[key as 'createdAt' | 'updatedAt']).localeCompare(String(b[key as 'createdAt' | 'updatedAt']));
    if (cmp === 0) cmp = a.number - b.number;
    return direction === 'asc' ? cmp : -cmp;
  });
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
  const start = (page - 1) * perPage;
  const headers: Record<string, string> = {};
  if (start + perPage < entries.length) {
    headers.Link = `<${ctx.origin}${repoPathOf(repo)}/issues?per_page=${perPage}&page=${page + 1}>; rel="next"`;
  }
  return json(200, entries.slice(start, start + perPage).map((issue) => issueJson(repo, issue)), headers);
}

function createIssueRoute(ctx: ApiContext, repo: Repo): ApiResponse {
  if (ctx.bodyError) return json(400, { message: 'Problems parsing JSON' });
  const body = asRecord(ctx.body);
  if (body === null) return validationFailed('Body should be a JSON object');
  const title = stringField(body, 'title');
  if (title === undefined || title === '') return validationFailed();
  const labelNames = Array.isArray(body.labels) ? body.labels.filter((name): name is string => typeof name === 'string') : [];
  const labels: Label[] = [];
  for (const labelName of labelNames) {
    const label = findLabel(repo, labelName);
    if (label === undefined) return json(422, { message: `Validation Failed: label "${labelName}" does not exist` });
    labels.push(label);
  }
  const issue = createIssue(repo, { title, body: stringField(body, 'body') ?? null, labels });
  return json(201, issueJson(repo, issue));
}

function patchIssue(ctx: ApiContext, repo: Repo, issue: Issue): ApiResponse {
  if (ctx.bodyError) return json(400, { message: 'Problems parsing JSON' });
  const body = asRecord(ctx.body);
  if (body === null) return validationFailed('Body should be a JSON object');
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string' || body.body === null) issue.body = body.body as string | null;
  if (typeof body.state === 'string') {
    if (body.state !== 'open' && body.state !== 'closed') return validationFailed('state must be open or closed');
    if (issue.state !== body.state) {
      issue.state = body.state;
      issue.closedAt = body.state === 'closed' ? nowIso() : null;
      issue.updatedAt = nowIso();
    }
  }
  if (Array.isArray(body.labels)) {
    const labels: Label[] = [];
    for (const labelName of body.labels) {
      if (typeof labelName !== 'string') return validationFailed();
      const label = findLabel(repo, labelName);
      if (label === undefined) return json(422, { message: `Validation Failed: label "${labelName}" does not exist` });
      labels.push(label);
    }
    issue.labels = labels;
    issue.updatedAt = nowIso();
  }
  return json(200, issueJson(repo, issue));
}

function routePulls(ctx: ApiContext, repo: Repo, tail: string[]): ApiResponse {
  const method = ctx.method;
  if (tail.length === 0) {
    if (method === 'GET') return listPulls(ctx, repo);
    if (method === 'POST') return createPullRoute(ctx, repo);
    return notFound();
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number <= 0) return notFound();
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return notFound();
  if (tail.length === 1) {
    if (method === 'GET') return json(200, pullJson(repo, pull));
    if (method === 'PATCH') {
      if (ctx.bodyError) return json(400, { message: 'Problems parsing JSON' });
      const body = asRecord(ctx.body);
      if (body === null) return validationFailed('Body should be a JSON object');
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string' || body.body === null) pull.body = body.body as string | null;
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
        if (pull.state !== body.state && !(pull.merged && body.state === 'open')) {
          pull.state = body.state;
          pull.closedAt = body.state === 'closed' ? nowIso() : null;
          pull.updatedAt = nowIso();
        }
      }
      return json(200, pullJson(repo, pull));
    }
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    return json(200, pullFiles(repo, pull).map((file) => ({
      sha: file.sha,
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${percentEncode(pull.headRef)}/${percentEncode(file.filename).replace(/%2F/gu, '/')}`,
      raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${percentEncode(pull.headRef)}/${percentEncode(file.filename).replace(/%2F/gu, '/')}`,
      contents_url: `https://api.github.com${repoPathOf(repo)}/contents/${percentEncode(file.filename).replace(/%2F/gu, '/')}?ref=${percentEncode(pull.headRef)}`,
      patch: null,
    })));
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (ctx.bodyError) return json(400, { message: 'Problems parsing JSON' });
    const body = asRecord(ctx.body) ?? {};
    const mergeMethod = stringField(body, 'merge_method') ?? 'merge';
    if (!['merge', 'squash', 'rebase'].includes(mergeMethod)) return validationFailed('merge_method must be merge, squash or rebase');
    if (pull.merged) return json(405, { message: 'Pull Request is already merged' });
    if (pull.state === 'closed') return json(405, { message: 'Pull Request is closed' });
    const result = squashMergePull(repo, pull);
    if ('conflict' in result) return json(405, { message: 'Pull Request is not mergeable: conflicts with the base branch' });
    return json(200, {
      sha: result.sha,
      merged: true,
      message: 'Pull Request successfully merged',
    });
  }
  return notFound();
}

function listPulls(ctx: ApiContext, repo: Repo): ApiResponse {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state));
  pulls = [...pulls].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number);
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
  const start = (page - 1) * perPage;
  const headers: Record<string, string> = {};
  if (start + perPage < pulls.length) {
    headers.Link = `<${ctx.origin}${repoPathOf(repo)}/pulls?per_page=${perPage}&page=${page + 1}>; rel="next"`;
  }
  return json(200, pulls.slice(start, start + perPage).map((pull) => pullJson(repo, pull)), headers);
}

function createPullRoute(ctx: ApiContext, repo: Repo): ApiResponse {
  if (ctx.bodyError) return json(400, { message: 'Problems parsing JSON' });
  const body = asRecord(ctx.body);
  if (body === null) return validationFailed('Body should be a JSON object');
  const title = stringField(body, 'title');
  const headRef = stringField(body, 'head');
  const baseRef = stringField(body, 'base');
  if (title === undefined || headRef === undefined || baseRef === undefined) return validationFailed();
  const headSha = branchTip(repo, headRef);
  const baseSha = branchTip(repo, baseRef);
  if (headSha === undefined) return json(422, { message: `Validation Failed: head branch ${headRef} does not exist` });
  if (baseSha === undefined) return json(422, { message: `Validation Failed: base branch ${baseRef} does not exist` });
  if (headRef === baseRef) return json(422, { message: 'Validation Failed: head and base must be different branches' });
  const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
  if (existing !== undefined) {
    return json(422, { message: `Validation Failed: a pull request from ${headRef} already exists`, pull: pullJson(repo, existing) });
  }
  const pull = createPull(repo, {
    title,
    body: stringField(body, 'body') ?? null,
    headRef,
    headLabel: `${repo.owner}:${headRef}`,
    baseRef,
    headSha,
    baseSha,
  });
  return json(201, pullJson(repo, pull));
}

void resolveRef;
