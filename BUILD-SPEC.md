# BUILD SPEC — GitHub-compatible git forge (github-core-clone-01)

Build a standalone forge server in this repository. Node 22, `node --experimental-strip-types`,
**stdlib only** (node:http, node:zlib, node:crypto, node:events, node:util). No npm install, no git
binary. Entry point `main.ts` at the repo root (already exists — keep its lifecycle logic), grow
`app.ts` and add modules beside it.

## Lifecycle (main.ts already does this — do not break it)
Bind ephemeral port (never 8080), POST {port} to $MAKEFUN_ENV_URL/register, long-poll
GET $MAKEFUN_ENV_URL/done until {"done":true}, exit 0.

## Surfaces to implement

### 1. In-memory git store (per repo)
- Loose object store in memory: map sha→{type, data}. Objects addressed by real git sha1.
- Refs: map refname→sha (refs/heads/*, refs/tags/*), HEAD symref → refs/heads/main by default.
- Repo: { owner, name, private, description, defaultBranch: "main", issues, labels, pulls, objects, refs }.
- Keyed by owner/name. Auth token maps to viewer login "adaiversen" (from scenario; but read it
  dynamically — see "Auth" below).

### 2. Git smart HTTP (the hard part) — /{owner}/{repo}.git
Paths: GET/POST /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack,
POST /{owner}/{repo}.git/git-upload-pack, POST /{owner}/{repo}.git/git-receive-pack.

**info/refs**: content-type application/x-git-upload-pack-advertisement (or receive-pack-).
- v2 (when Git-Protocol: version=2 header present, upload-pack only): pkt-lines:
  `version 2\n`, `agent=forge/1.0\n`, then capability lines `ls-refs=unborn\n`, `fetch=shallow
  side-band-64k thin-pack ofs-delta\n`, `object-format=sha1\n`, flush `0000`.
  Note: the suite's v2 probe sends Git-Protocol: version=2 on info/refs — MUST answer v2 then.
- v0 (receive-pack always, and upload-pack without the v2 header): pkt `# service=git-upload-pack\n`
  flush, then `<oid> <ref>\0report-status side-band-64k delete-refs ofs-delta agent=forge/1.0\n`
  (receive-pack adds shallow multi_ack_detailed? keep: `report-status side-band-64k delete-refs
  ofs-delta agent=forge/1.0`), refs each on own pkt, peeled tags as `<oid> <ref>^{}\n`, HEAD as
  symref, unborn repo: `<zero-oid> capabilities^{}\0<caps>\n`. Missing repo → 404.

**upload-pack v2 POST**: parse pkt-lines. command=ls-refs: answer pkt per ref matching prefixes:
`<oid> <ref>[ symref-target:HEAD-target][ peeled:commit-oid]\n`, unborn HEAD → `unborn HEAD
symref-target:refs/heads/main`. command=fetch with want/have/shallow/deepen/done lines:
- Compute wants closure minus haves closure (objects client already has).
- Shallow: depth N → include commits until depth reached; boundary commits reported in
  `shallow-info` section as `shallow <oid>`; deepen on existing shallow: unshallow line.
- Reply sections (v2): `acknowledgments\n` (when haves given: `NAK\n` unless complete) flush,
  `shallow-info\n` lines flush, `wanted-refs\n` (empty ok — skip), `packfile\n` then pack bytes in
  side-band-64k frames: band 1 = pack data (≤65515 per frame), flush, then response-end `0002`?
  (v2 ends with flush). Pack = packfile v2, all plain objects (no deltas needed), sha1 trailer.
- The fetch=shallow capability MUST be advertised for depth requests.

**v0 upload-pack POST** (used when suite forces v0): want lines w/ caps, flush, have lines, done.
Answer: `NAK\n` pkt (after done), then shallow lines (from shallow computation), then packfile in
side-band frames (band 1), flush.

**receive-pack POST**: command list pkt-lines `<old> <new> <ref>\0caps`, flush, then packfile raw
(no sideband in request). Read pack: parse entries (type 1-4 plain + ofs-delta type 6 + ref-delta
type 7 — implement delta application: base + delta instructions copy/insert). Store objects.
For each command: create (old=zero): ok; delete (new=zero, allowed, delete-refs): ok; update:
fast-forward check (old must be ancestor of new) else `ng <ref> non-fast-forward`.
Reply: side-band-64k frames: band 1 = pkt-lines `unpack ok\n`, `ok <ref>\n` / `ng <ref> non-fast-forward\n`... then flush. If client didn't request sideband, plain pkt-lines.

### 3. REST v3 (/api/v3) — application/json always, X-GitHub-Request-Id header always
- Bearer token required: no/unknown token → 401 {"message":"Bad credentials"}.
- `GET /api/v3/` → 200 + X-OAuth-Scopes: repo, read:org
- `GET /api/v3/meta` → {"installed_version":"1.0.0"}
- `GET /api/v3/user` → viewer {login:"adaiversen", id:1000, ...}
- `GET /api/v3/user/repos?per_page&page` → list, Link header rel="next" when more pages
- `POST /api/v3/user/repos` {name, private, description} → 201 repo object; 422 "already exists"
- `GET/PATCH/DELETE /api/v3/repos/{o}/{r}` (PATCH updates description; DELETE → 204, later 404)
  - same name under another owner → 404 (never 403)
- `POST /api/v3/repos/{o}/{r}/git/refs` {ref:"refs/heads/x", sha} → 201 {ref, object:{sha}}
- `GET /api/v3/repos/{o}/{r}/branches` → [{name, commit:{sha}, ...}]
- `GET /api/v3/repos/{o}/{r}/commits[?sha=]` → [{sha, commit:{message,...}}]
- `PUT /api/v3/repos/{o}/{r}/contents/{path}` {message, content(b64), branch?, sha?} →
  201 create/200 update {content:{sha,encoding:"base64",...}, commit:{sha,...}}; stale sha → 409.
  Real git commit: build blob, update tree(s) along path, commit on branch tip.
- `GET /api/v3/repos/{o}/{r}/contents/{path}[?ref=]` → file {type:"file",encoding:"base64",
  content,sha,size,name,path} or dir listing array [{type:"dir"|"file",name,path,sha,size}]
- `DELETE .../contents/{path}` → 200 {commit:{sha}}, file gone after
- `POST /api/v3/repos/{o}/{r}/labels` {name,color} → 201; `GET .../labels`
- `POST .../issues` {title, body, labels?} → 201 issue {number,title,body,state:"open",
  labels:[{name}],created_at,...}; unknown label → 422
- `GET .../issues?state=&sort=&direction=` filter+sort (created default); issue numbers per-repo,
  shared counter with pulls (GitHub shares numbering — issues and pulls one number space? GitHub:
  yes, issues and PRs share the number counter. Implement shared counter.)
- `GET/PATCH .../issues/{n}` (PATCH state closed)
- `POST/GET .../issues/{n}/comments` {id, body}
- `POST .../pulls` {title,head,base,body} → 201 {number,state:"open",head:{ref,sha,repo?},base:{...},merged:false,...}
  head.sha = current tip of head branch. Unknown branches → 422.
- `GET .../pulls?state=all|open|closed`, `GET .../pulls/{n}` (404 unknown),
  `GET .../pulls/{n}/files` → [{filename,status:"added"/"modified",additions,deletions,changes}]
  (diff = compare head tree vs merge-base tree; walk trees)
- `PUT .../pulls/{n}/merge` {merge_method:"squash"} → 200 {sha,merged:true,message}; PR merged:
  squash-merge head tree onto base → new commit on base branch, PR state closed, merged true,
  merge_commit_sha set. Conflict (both branches changed same path since base) → 405.
- Unknown /api/v3 route → 404 {"message":"Not Found"}; malformed JSON body → 400.

### 4. GraphQL v4 POST /api/graphql
{query, variables} JSON; no auth → 401. Implement a tiny GraphQL executor — the suite sends
documents from `gh`/github-mcp-server; DON'T try to write a full parser: implement a targeted
parser that handles the shapes (operation definitions, fields, arguments incl. variables, inline
objects/enums, aliases, fragments `... on X`, batched array body). Support:
- Query: viewer{login}, repository(owner:,name:){id,databaseId,name,nameWithOwner,owner{login},
  defaultBranchRef{name},viewerPermission,hasIssuesEnabled,issue(number:){...},issues(first,states,
  orderBy,after){nodes,pageInfo{hasNextPage,endCursor}},pullRequests(first){nodes{...}},
  pullRequest(number:){...}}, node(id:){... on Repository{name,nameWithOwner}}, __type(name:),
  __schema maybe.
- Issue{id,number,title,state,body}, PullRequest{id,number,state,merged,headRefName,baseRefName,
  mergeable,files(first){nodes{path}}}
- Mutations: createIssue(input:{repositoryId,title,body})→{issue{number,id}},
  closeIssue(input:{issueId})→{issue{number,id,state}}, createPullRequest(input:{repositoryId,
  baseRefName,headRefName,title})→{pullRequest{number,id,state,headRefName,baseRefName}},
  mergePullRequest(input:{pullRequestId,mergeMethod})→{pullRequest{number,merged,state}},
  addComment(input:{subjectId,body})→{commentEdge{node{id,body}}}
- Global ids: base64("repo:<id>") style, stable across reads (node(id:) round-trips).
- Unknown field in query → HTTP 200 with errors[] naming it. Unknown repository →
  data.repository = null, no errors. Batch: array body → array of results in order.
- Introspection: __type(name:"Issue") → fields id,number,title,state,body (+description);
  "PullRequest" → id,number,headRefName,baseRefName,mergeable,state,merged,files;
  "Repository" → id,databaseId,name,nameWithOwner,owner,defaultBranchRef,viewerPermission,
  hasIssuesEnabled,issue,issues,pullRequests,pullRequest; SearchType enumValues include ISSUE;
  also IssueState, MergeableState(MERGEABLE/CONFLICTING/UNKNOWN), PullRequestState, IssueOrderField,
  OrderDirection, PullRequestMergeMethod, RepositoryPermission.
- Issues ordering: orderBy CREATED_AT DESC → numbers descending, ties by number DESC; states:[OPEN]
  omits closed.

### 5. MCP POST /mcp (JSON-RPC 2.0)
- No Authorization → 401. Non-JSON body → HTTP 400 body {jsonrpc,error:{code:-32700}}.
- `server/discover` → {protocolVersion:"2026-07-28", serverInfo:{name,version}, capabilities:{tools:{}},
  supportedVersions:["2026-07-28", ...legacy]}. Unknown method → -32601 (never HTTP 500).
- tools/list → same byte-identical array every call; ≥6 tools: create_repo, get_repo, create_issue,
  list_issues, create_pull_request, merge_pull_request; each {name, description, inputSchema:{type:"object",
  properties..., required...}} — required props exactly the documented args: create_repo{name},
  get_repo{owner,repo}, create_issue{owner,repo,title}, list_issues{owner,repo},
  create_pull_request{owner,repo,title,head,base}, merge_pull_request{owner,repo,pull_number}.
  (Body?/state? optional.) Make "full_name" an OPTIONAL property (suite fills it) — do not require it.
- tools/call: dispatch to the same store as REST. Missing required arg → {isError:true} or -32602.
  Unknown tool → -32602/-32601. Result: {content:[{type:"text",text:JSON.stringify(obj)}]} with the
  object also accessible — the checks parse text or structuredContent: return
  {content:[...], structuredContent:{...the object}} safest.
- Concurrency: answer each request with its own id (stateless is fine).
- Every request may carry _meta with protocolVersion — accept 2026-07-28 style (no session needed)
  AND legacy initialize/notifications/initialized handshake (answer initialize echoing a revision
  from the client's protocols list, then tools/list works without session).

### 6. Auth
- MAKEFUN_SHOP_TOKEN env holds the suite's token. Map ANY bearer token: repo ownership check uses
  the token's login. Simplest: maintain token→login map; the suite's token maps to scenario viewer
  login. Trick: the suite may present different tokens? Rules say one token, the viewer's. Map
  unknown tokens: token "adaiversen-token"? — read the scenario: viewer login from
  buildScenario().viewer.login is FIXED for this contest: "adaiversen". Map every bearer token to
  login "adaiversen". No token → 401.
- View: repo list is the viewer's own repos only. GET /api/v3/user → viewer.

## Performance notes (scored, 200 pts)
- Keep everything in RAM, precompute nothing expensive per request; keep-alive friendly.
- push workload: 200 sequential pushes ~8ms each budget — handle receive-pack synchronously, avoid
  re-zlib: store objects as deflated on arrival? Simpler: inflate on receive, store plain, deflate
  on fetch (clone workload: 50 concurrent depth-1 clones of 200-commit repo in ~267ms budget — that
  means each clone ~5ms: caching the packed bytes for the tip's history helps: cache pack per
  (repo, tip, depth-1) — the same pack is served 50x; cache it).
- read: 2000 GET issue in ~2760ms — trivial.
- write: 200 issue creates ~349ms — trivial.

## Verification
Run the kit's suite locally: from ~/makefun/github-core-clone-01-kit:
  node --experimental-strip-types main.ts &  (with MAKEFUN_ENV_URL unset it exits — instead:)
  Start the server standalone: `node --experimental-strip-types -e "import('./app.ts').then(m=>{const s=m.createApp();s.listen(8123)})"`
  Then: `node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8123 --token testtok --perf`
Iterate until all checks pass. The token for local runs: any string (map to adaiversen).
