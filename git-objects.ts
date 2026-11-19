// Git object store primitives: sha1 addressing, blob/tree/commit/tag codecs, and
// packfile reading (ofs/ref deltas) and writing (plain objects) with node:zlib.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
  readonly sha: string;
}

export function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Hash one git object the way git does: "<type> <size>\0<data>". */
export function hashObject(type: ObjectType, data: Buffer): string {
  return sha1hex(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]));
}

export function makeObject(type: ObjectType, data: Buffer): GitObject {
  return { type, data, sha: hashObject(type, data) };
}

export const ZERO_OID = '0'.repeat(40);
export const OID_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------- tree encoding

export interface TreeEntry {
  readonly mode: string; // "100644" | "100755" | "40000" | "120000" | "160000"
  readonly name: string;
  readonly sha: string;
}

export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function decodeTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(i, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode: mode === '040000' ? '40000' : mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commit / tag encoding

export interface Signature {
  readonly name: string;
  readonly email: string;
  readonly when: number; // unix seconds
}

export interface CommitObject {
  readonly tree: string;
  readonly parents: string[];
  readonly author: Signature;
  readonly committer: Signature;
  readonly message: string;
}

const SIG_RE = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/;

function parseSignature(line: string): Signature | undefined {
  const m = SIG_RE.exec(line);
  if (!m) return undefined;
  return { name: m[1] ?? '', email: m[2] ?? '', when: Number(m[3] ?? 0) };
}

export function decodeCommit(data: Buffer): CommitObject {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author: Signature = { name: '', email: '', when: 0 };
  let committer: Signature = { name: '', email: '', when: 0 };
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const sig = parseSignature(line.slice(7));
      if (sig) author = sig;
    } else if (line.startsWith('committer ')) {
      const sig = parseSignature(line.slice(10));
      if (sig) committer = sig;
    }
  }
  return { tree, parents, author, committer, message };
}

function signatureString(sig: Signature): string {
  return `${sig.name} <${sig.email}> ${sig.when} +0000`;
}

export function encodeCommit(commit: CommitObject): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${signatureString(commit.author)}`);
  lines.push(`committer ${signatureString(commit.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

export interface TagObject {
  readonly object: string;
  readonly type: ObjectType;
  readonly tag: string;
  readonly tagger: Signature;
  readonly message: string;
}

export function decodeTag(data: Buffer): TagObject {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger: Signature = { name: '', email: '', when: 0 };
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) {
      const sig = parseSignature(line.slice(7));
      if (sig) tagger = sig;
    }
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packfile reading

function parseObjectHeader(buf: Buffer, start: number): { type: number; size: number; next: number; first: number } {
  const first = buf[start]!;
  let type = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let i = start + 1;
  let byte = first;
  while (byte & 0x80) {
    byte = buf[i++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  void type;
  return { type, size, next: i, first };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

export interface PackReadResult {
  objects: GitObject[];
  objectCount: number;
  checksumOk: boolean;
}

/**
 * Read a packfile (v2): resolve plain objects, ofs-deltas and ref-deltas into full objects.
 * `lookupBase` supplies a base object a thin pack leaves out.
 */
export function readPack(pack: Buffer, lookupBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack does not start with a valid PACK header');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = sha1hex(pack.subarray(0, trailerStart));
  const checksumOk = trailer === computed;

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = parseObjectHeader(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[offset++]!;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++]!;
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      const baseOffset = entryOffset - value;
      if (baseOffset < 12) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (typeCode < 1 || typeCode > 4) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects: GitObject[] = [];
  const resolvedByOid = new Map<string, { type: ObjectType; data: Buffer }>();
  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer } => {
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const inPack = resolvedByOid.get(wanted);
      if (inPack) {
        const data = applyDelta(inPack.data, entry.data);
        return { type: inPack.type, data };
      }
      const external = lookupBase?.(wanted);
      if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
      const data = applyDelta(external.data, entry.data);
      return { type: external.type, data };
    }
    const names = ['commit', 'tree', 'blob', 'tag'] as const;
    return { type: names[entry.typeCode - 1]!, data: entry.data };
  };

  // Resolve in two passes so ref-deltas can see earlier plain resolutions too.
  for (const entry of raw) {
    const { type, data } = resolve(entry);
    const sha = hashObject(type, data);
    resolvedByOid.set(sha, { type, data });
    objects.push(makeObject(type, data));
  }
  return { objects, objectCount: declaredCount, checksumOk };
}

// ---------------------------------------------------------------- packfile writing

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (TYPE_CODES[type] << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile (v2) from plain objects, no deltas. Trailer is sha1 over the body. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** The objects reachable from `roots` (commit→tree+parents, tree→entries, tag→target); blob stops. */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (sha: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (OID_RE.test(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = decodeCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(decodeTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of decodeTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}
