// Git smart HTTP: pkt-line framing, ref advertisements (v0 and v2), upload-pack
// (ls-refs, fetch with shallow/deepen) and receive-pack with report-status.
import {
  type GitObject,
  OID_RE,
  ZERO_OID,
  decodeCommit,
  decodeTag,
  decodeTree,
  readPack,
  writePack,
} from './git-objects.ts';
import {
  AGENT,
  DEFAULT_BRANCH,
  type Repo,
  getObject,
  nowIso,
  peelToCommit,
  putObject,
  resolveRef,
} from './store.ts';

// ---------------------------------------------------------------- pkt-line framing

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

const SIDEBAND_CHUNK = 65515; // 1 band byte + 65515 payload + 4 length = 65520 max

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

const FLUSH_PKT = Buffer.from('0000', 'ascii');
const DELIM_PKT = Buffer.from('0001', 'ascii');

export function encodePktLines(lines: ReadonlyArray<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(FLUSH_PKT);
    else if (line === 'delim') parts.push(DELIM_PKT);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export function decodePktLines(bytes: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > bytes.length) break;
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** Sideband-64k frame `data` on `band`. */
function sideband(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), data.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, data.length))])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- advertisements

interface RefLike {
  oid: string;
  name: string;
  peeled?: string;
}

export function sortedRefs(repo: Repo): RefLike[] {
  const out: RefLike[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    if (name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo, oid);
      // v2 ls-refs reads `peeled` off the tag entry itself; v0 advertisement also emits the
      // separate `<peeled> <ref>^{}` line below, which is the wire format git uses there.
      if (peeled !== undefined && peeled !== oid) {
        out.push({ oid, name, peeled });
        out.push({ oid: peeled, name: `${name}^{}` });
        continue;
      }
    }
    out.push({ oid, name });
  }
  return out;
}

function uploadPackCaps(headTarget: string): string {
  return `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:${headTarget} agent=${AGENT}`;
}

/** v0 advertisement body (service preamble + refs + flush). */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  if (repo.refs.size === 0) {
    const caps = service === 'git-upload-pack' ? uploadPackCaps(repo.symrefHead) : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    const headOid = resolveRef(repo, 'HEAD') ?? ZERO_OID;
    const caps = service === 'git-upload-pack'
      ? uploadPackCaps(repo.symrefHead)
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
    parts.push(pktLine(`${headOid} HEAD\u0000${caps}\n`));
    for (const ref of sortedRefs(repo)) {
      if (ref.name === 'HEAD') continue;
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** v2 capability advertisement for upload-pack. */
export function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine(`# service=git-upload-pack\n`),
    pktLine(`version 2\n`),
    pktLine(`agent=${AGENT}\n`),
    pktLine(`ls-refs=unborn\n`),
    pktLine(`fetch=shallow side-band-64k thin-pack ofs-delta\n`),
    pktLine(`object-format=sha1\n`),
    FLUSH_PKT,
  ]);
}

// ---------------------------------------------------------------- ls-refs (v2)

export function lsRefs(repo: Repo, request: Buffer): Buffer {
  const packets = decodePktLines(request);
  let inArgs = false;
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  if (repo.refs.size === 0) {
    if (unborn && keep('HEAD')) parts.push(pktLine(`unborn HEAD symref-target:${repo.symrefHead}\n`));
  } else {
    const headOid = resolveRef(repo, 'HEAD');
    if (headOid !== undefined && keep('HEAD')) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${repo.symrefHead}` : ''}\n`));
    }
    for (const ref of sortedRefs(repo)) {
      if (!keep(ref.name)) continue;
      if (ref.name.endsWith('^{}')) continue; // v0-only pseudo-ref; v2 carries peel via the attribute
      parts.push(pktLine(`${ref.oid} ${ref.name}${peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : ''}\n`));
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch object selection

function commitOf(repo: Repo, oid: string): string | undefined {
  if (!OID_RE.test(oid)) return undefined;
  const object = getObject(repo, oid);
  if (!object) return undefined;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') return commitOf(repo, decodeTag(object.data).object);
  return undefined;
}

interface DepthWalk {
  depths: Map<string, number>;
  included: string[];
}

/**
 * BFS from the want tips with min-distance semantics. When `deepen` is set the walk passes
 * through the client's shallow boundaries; otherwise it stops there (parents not traversed).
 */
function depthWalk(repo: Repo, wants: string[], clientShallow: Set<string>, limit: number | undefined, passThroughShallow: boolean): DepthWalk {
  const depths = new Map<string, number>();
  const order: Array<[string, number]> = [];
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    const commit = commitOf(repo, want);
    if (commit !== undefined) queue.push([commit, 1]);
  }
  while (queue.length) {
    const [oid, distance] = queue.shift()!;
    if (limit !== undefined && distance > limit) continue;
    const known = depths.get(oid);
    if (known !== undefined && known <= distance) continue;
    depths.set(oid, distance);
    order.push([oid, distance]);
    if (!passThroughShallow && clientShallow.has(oid)) continue;
    const object = getObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of decodeCommit(object.data).parents) queue.push([parent, distance + 1]);
  }
  return { depths, included: order.map(([oid]) => oid) };
}

/** Reachability with a cutoff: shallow boundary commits are included but their parents are not traversed. */
function reachableWithShallowCutoff(repo: Repo, roots: readonly string[], shallow: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots].filter((sha) => OID_RE.test(sha));
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = getObject(repo, oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      if (shallow.has(oid)) continue;
      for (const parent of decodeCommit(object.data).parents) if (!seen.has(parent)) queue.push(parent);
      const tree = decodeCommit(object.data).tree;
      if (!seen.has(tree)) queue.push(tree);
    } else if (object.type === 'tag') {
      const target = decodeTag(object.data).object;
      if (!seen.has(target)) queue.push(target);
    } else if (object.type === 'tree') {
      for (const entry of decodeTree(object.data)) {
        if (entry.mode === '160000') continue;
        if (!seen.has(entry.sha)) queue.push(entry.sha);
      }
    }
  }
  return seen;
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function planFetch(repo: Repo, wants: string[], haves: string[], deepen: number | undefined, clientShallowLines: string[]): FetchPlan {
  const clientShallow = new Set(clientShallowLines.filter((sha) => OID_RE.test(sha)));
  const haveClosure = reachableWithShallowCutoff(repo, haves, clientShallow);

  // Which commits the client should end up with.
  const commitSet = new Set<string>();
  let boundary = new Set<string>();
  const unshallow: string[] = [];

  if (deepen !== undefined) {
    // Deepen: walk from wants through the client's shallow boundaries up to the new depth.
    const walk = depthWalk(repo, wants, clientShallow, deepen, true);
    for (const oid of walk.included) commitSet.add(oid);
    for (const oid of commitSet) {
      const object = getObject(repo, oid);
      if (!object || object.type !== 'commit') continue;
      const parents = decodeCommit(object.data).parents;
      if (parents.length === 0) continue;
      if (parents.some((parent) => (walk.depths.get(parent) ?? deepen + 1) > deepen)) boundary.add(oid);
    }
    for (const old of clientShallow) {
      if (!commitSet.has(old) || boundary.has(old)) continue;
      const object = getObject(repo, old);
      if (!object || object.type !== 'commit') continue;
      const parents = decodeCommit(object.data).parents;
      if (parents.length > 0 && parents.every((parent) => (walk.depths.get(parent) ?? deepen + 1) <= deepen)) unshallow.push(old);
    }
  } else if (clientShallow.size > 0) {
    // Incremental shallow fetch: keep the client shallow at its own boundaries.
    const walk = depthWalk(repo, wants, clientShallow, undefined, false);
    for (const oid of walk.included) commitSet.add(oid);
    for (const oid of commitSet) {
      const object = getObject(repo, oid);
      if (!object || object.type !== 'commit') continue;
      if (decodeCommit(object.data).parents.length === 0) continue;
      if (clientShallow.has(oid) || decodeCommit(object.data).parents.some((parent) => !commitSet.has(parent))) {
        boundary.add(oid);
      }
    }
  } else {
    // Full fetch: the client gets every object reachable from the wants — parents included.
    const closure = reachableWithShallowCutoff(repo, wants, clientShallow);
    for (const oid of closure) commitSet.add(oid);
  }

  // Trees and blobs of the included commits, minus the client's closure.
  const objects: GitObject[] = [];
  const sent = new Set<string>();
  const enqueue = (sha: string): void => {
    if (!haveClosure.has(sha) && !sent.has(sha)) pending.push(sha);
  };
  const pending: string[] = [];
  for (const oid of commitSet) {
    if (!haveClosure.has(oid)) pending.push(oid);
    for (const want of wants) void want;
    const object = getObject(repo, oid);
    if (object?.type === 'commit') enqueue(decodeCommit(object.data).tree);
  }
  for (const want of wants) {
    const object = getObject(repo, want);
    if (object?.type === 'tag') enqueue(want);
  }
  while (pending.length) {
    const sha = pending.pop()!;
    if (sent.has(sha) || haveClosure.has(sha)) continue;
    const object = getObject(repo, sha);
    if (!object) continue;
    sent.add(sha);
    objects.push(object);
    if (object.type === 'tree') {
      for (const entry of decodeTree(object.data)) {
        if (entry.mode === '160000') continue;
        enqueue(entry.sha);
      }
    } else if (object.type === 'tag') {
      enqueue(decodeTag(object.data).object);
    } else if (object.type === 'commit') {
      enqueue(decodeCommit(object.data).tree);
    }
  }
  return { objects, shallow: [...boundary], unshallow };
}

const planCache = new Map<string, FetchPlan>();
const PLAN_CACHE_LIMIT = 128;

/**
 * The fetch plan cache: a pure clone plan (no haves, no shallow lines) depends only on the
 * repository, the wants and the depth, so a concurrent burst of depth-1 clones reuses one plan.
 * Plans hold immutable object snapshots, and pushes never mutate stored objects, so a cached
 * plan stays correct even as the repository grows.
 */
function planFetchCached(repo: Repo, args: FetchArgs): FetchPlan {
  if (args.haves.length > 0 || args.shallow.length > 0) {
    return planFetch(repo, args.wants, args.haves, args.deepen, args.shallow);
  }
  const key = `${repo.owner}/${repo.name}|${[...args.wants].sort().join(',')}|${args.deepen ?? 'full'}`;
  const hit = planCache.get(key);
  if (hit !== undefined) return hit;
  const plan = planFetch(repo, args.wants, args.haves, args.deepen, args.shallow);
  if (planCache.size >= PLAN_CACHE_LIMIT) planCache.clear();
  planCache.set(key, plan);
  return plan;
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | undefined;
}

function parseFetchArgs(request: Buffer, v2: boolean): FetchArgs {
  const packets = decodePktLines(request);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: undefined };
  let inArgs = false;
  let section: 'wants' | 'negotiation' = 'wants';
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') {
      if (v2) break;
      section = 'negotiation';
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (v2 && !inArgs) continue;
    const nul = text.indexOf('\u0000');
    const line = nul >= 0 ? text.slice(0, nul) : text;
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      args.wants.push(space < 0 ? rest : rest.slice(0, space));
    } else if (line.startsWith('have ')) args.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7));
  }
  return args;
}

function buildFetchResponse(repo: Repo, args: FetchArgs, v2: boolean): Buffer {
  const parts: Buffer[] = [];
  const plan = planFetchCached(repo, args);
  if (v2) {
    if (args.haves.length > 0) parts.push(pktLine(`acknowledgments\n`), pktLine(`NAK\n`), FLUSH_PKT);
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine(`shallow-info\n`));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(FLUSH_PKT);
    }
    parts.push(pktLine(`packfile\n`));
  } else {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktLine(`NAK\n`));
  }
  parts.push(sideband(1, writePack(plan.objects)));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// The wire response for a pure clone fetch (no haves, no shallow lines) is byte-deterministic:
// cache the fully packed buffer so a burst of identical clones deflates the pack once.
const responseCache = new Map<string, Buffer>();
const RESPONSE_CACHE_LIMIT = 128;

function fetchResponse(repo: Repo, args: FetchArgs, v2: boolean): Buffer {
  if (args.haves.length > 0 || args.shallow.length > 0) return buildFetchResponse(repo, args, v2);
  const key = `${v2 ? 'v2' : 'v0'}|${repo.owner}/${repo.name}|${[...args.wants].sort().join(',')}|${args.deepen ?? 'full'}`;
  const hit = responseCache.get(key);
  if (hit !== undefined) return hit;
  const built = buildFetchResponse(repo, args, v2);
  if (responseCache.size >= RESPONSE_CACHE_LIMIT) responseCache.clear();
  responseCache.set(key, built);
  return built;
}

export function uploadPack(repo: Repo, request: Buffer, v2: boolean): Buffer {
  if (v2) {
    let command = '';
    for (const packet of decodePktLines(request)) {
      if (packet.kind !== 'data') break;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('command=')) {
        command = line.slice('command='.length);
        break;
      }
    }
    if (command === 'ls-refs') return lsRefs(repo, request);
    if (command === 'fetch') return fetchResponse(repo, parseFetchArgs(request, true), true);
    return Buffer.concat([pktLine(`ERR unsupported command\n`), FLUSH_PKT]);
  }
  const args = parseFetchArgs(request, false);
  if (args.wants.length === 0) return Buffer.concat([pktLine(`NAK\n`), FLUSH_PKT]);
  return fetchResponse(repo, args, false);
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface ReceivePackResult {
  commands: PushCommand[];
  unpackOk: boolean;
  reports: Array<{ ref: string; ok: boolean; reason: string }>;
  sideband: boolean;
  touched: boolean;
}

export function receivePack(repo: Repo, request: Buffer): ReceivePackResult {
  const packets = decodePktLines(request);
  const commands: PushCommand[] = [];
  let sideband = false;
  let commandsDone = false;
  let consumed = 0;
  let packStart = -1;
  for (const packet of packets) {
    const size = packet.kind === 'data' ? packet.payload.length + 4 : 4;
    if (!commandsDone) {
      if (packet.kind === 'flush') {
        commandsDone = true;
        consumed += size;
        if (consumed < request.length) packStart = consumed;
        continue;
      }
      const text = packet.payload.toString('utf8');
      const nul = text.indexOf('\u0000');
      const line = nul >= 0 ? text.slice(0, nul) : text;
      const caps = nul >= 0 ? text.slice(nul + 1).replace(/\n$/, '') : '';
      if (caps.split(' ').includes('side-band-64k')) sideband = true;
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+?)\n?$/.exec(line);
      if (m) commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
    }
    consumed += size;
  }

  const reports: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  const hasPack = packStart >= 0 && request.subarray(packStart, packStart + 4).toString('ascii') === 'PACK';
  if (hasPack) {
    try {
      const read = readPack(request.subarray(packStart), (oid) => {
        const stored = repo.objects.get(oid);
        return stored ? { type: stored.type, data: stored.data, sha: oid } : undefined;
      });
      for (const object of read.objects) putObject(repo, object.type, object.data);
    } catch {
      unpackOk = false;
    }
  } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
    unpackOk = false; // a ref update always rides a pack
  }

  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined || (command.oldOid !== ZERO_OID && command.oldOid !== current)) {
        reports.push({ ref: command.ref, ok: false, reason: 'failed to delete ref' });
        continue;
      }
      repo.refs.delete(command.ref);
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!OID_RE.test(command.newOid) || !repo.objects.has(command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'missing necessary objects' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'ref already exists' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== command.oldOid) {
      reports.push({ ref: command.ref, ok: false, reason: 'failed to update ref' });
      continue;
    }
    if (!isFastForward(repo, command.oldOid, command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reports.push({ ref: command.ref, ok: true, reason: '' });
  }

  const touched = reports.some((report) => report.ok);
  if (touched) repo.pushedAt = nowIso();
  return { commands, unpackOk, reports, sideband, touched };
}

/** Fast-forward: `newOid` must have `oldOid` somewhere in its ancestry. */
function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const seen = new Set<string>();
  const queue = [newOid];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === oldOid) return true;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    queue.push(...decodeCommit(object.data).parents);
  }
  return false;
}

/** Build the report-status reply for a receive-pack result. */
export function receivePackReply(result: ReceivePackResult): Buffer {
  const lines: string[] = [`unpack ${result.unpackOk ? 'ok' : 'unpacker error'}\n`];
  for (const report of result.reports) {
    lines.push(!result.unpackOk ? `ng ${report.ref} n/a (unpacker error)\n` : report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`);
  }
  const band1 = Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH_PKT]);
  if (result.sideband) return Buffer.concat([sideband(1, band1), FLUSH_PKT]);
  return band1;
}

void DEFAULT_BRANCH;
