#!/bin/bash
export QWEN_STREAM_MAX_LIFETIME_MS=0
cd /home/agentuser/makefun/github-forge
exec qwen --approval-mode yolo -p "Performance-tune this GitHub-compatible forge (TypeScript, Node 22, stdlib only — no npm installs, no deps). The graded suite is /home/agentuser/makefun/github-core-clone-01-kit/program/env/server.mjs. A local trial runner exists at /tmp/forgescore/run.sh: it runs the suite against the forge (MAKEFUN_STATE_DIR=/tmp/forgescore/state, MAKEFUN_ENV_PORT=8080, MAKEFUN_SHOP_TOKEN=localtest) and prints perf.json with per-workload points. CURRENT local baseline: perf 180/200 — push 50 (p50 344ms), clone 38 (p50 126.5ms), read 47 (p50 816ms), write 45 (p50 112ms), state.json 120/120 passed.

GOAL: raise clone, read, write points locally toward 50 each (score 200) WITHOUT breaking any of the 120 conformance checks. Rules:
- Never change API behavior/semantics — only speed. The 120 checks must still all pass after every change (run.sh prints 'state.json (N/120 passed)').
- Do NOT change main.ts or src-main.ts (transcript gate). Edit app.ts, rest.ts, git-http.ts, store.ts, graphql.ts freely.
- Ideas to try: avoid per-request JSON re-serialization; cache route parsing; keep-alive friendly (no unnecessary Connection churn); for clone workload (50 concurrent shallow clones of a 200-commit repo) precompute/caches packfiles per repo+ref and reuse pack bytes; for read workload (2000 sequential GET issue calls on one keep-alive connection) make the hot issue-read path allocation-light and O(1) lookup; for write (200 issue creations) batch/queue fs writes.
- After each edit: run 'timeout 200 /tmp/forgescore/run.sh' and record points. Keep only changes that improve total points without dropping any check.
- Iterate at most 8 experiments. Finish when points >= 195 or no further gain.
- At the end: git add -A, git -c user.name=Seixx43 -c user.email=seixx43@users.noreply.github.com commit -m 'perf: hot-path tuning', and PRINT the final perf.json line, the final 120/120 status, and the commit sha. Do NOT push."
