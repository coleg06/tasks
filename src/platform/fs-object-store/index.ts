import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { ObjectStore, ObjectStoreBody, ObjectStoreWriteOptions } from '../ports';

/**
 * Filesystem implementation of the ObjectStore port.
 *
 * Layout: `<root>/objects/<hh>/<sha256(key)>`; the caller's key is never used as a path, so
 * traversal is impossible by construction (and keys are validated and the resolved path is
 * re-checked as defense in depth). Each file is `[uint32 header length][JSON header][body]`
 * written to `<root>/.tmp`, fsynced, then renamed into place, so a reader sees either the old
 * object or the complete new one, never a partial write. Objects are read fully into memory.
 */

const MAX_KEY_LENGTH = 1_024;
const HEADER_LIMIT = 64 * 1_024;

interface StoredHeader {
  key: string;
  size: number;
  etag: string;
  httpMetadata: NonNullable<ObjectStoreWriteOptions['httpMetadata']>;
  customMetadata: Record<string, string>;
  uploaded: string;
}

export interface FilesystemObjectStoreObject extends ObjectStoreBody {
  readonly key: string;
  readonly httpMetadata: StoredHeader['httpMetadata'];
  readonly customMetadata: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export function assertSafeObjectKey(key: string) {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new Error('Invalid object key length');
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(key) || key.startsWith('/')) {
    throw new Error('Invalid object key');
  }
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..')
      throw new Error('Invalid object key');
  }
}

function toBytes(value: ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export class FilesystemObjectStore implements ObjectStore {
  private root: string;
  private objects: string;
  private temporary: string;
  private initialized = false;

  constructor(root: string) {
    if (!root.trim()) throw new Error('Object store root path is required');
    this.root = resolve(root);
    this.objects = join(this.root, 'objects');
    this.temporary = join(this.root, '.tmp');
  }

  /**
   * Create the root, resolve it once with realpath (a symlinked volume mount point is fine), then
   * create and verify the directories beneath it. From here on every operation rejects symlinks in
   * any component below the root.
   */
  async initialize() {
    await mkdir(this.root, { recursive: true });
    this.root = await realpath(this.root);
    this.objects = join(this.root, 'objects');
    this.temporary = join(this.root, '.tmp');
    this.initialized = true;
    await this.ensureDirectory(this.objects);
    await this.ensureDirectory(this.temporary);
    await this.ping();
  }

  /** Readiness probe: the root is intact and writable. */
  async ping() {
    this.assertInitialized();
    await this.ensureDirectory(this.temporary);
    const probe = join(this.temporary, `ready-${randomUUID()}`);
    await (await open(probe, 'wx', 0o600)).close();
    await rm(probe);
  }

  private assertInitialized() {
    if (!this.initialized) throw new Error('Object store used before initialize()');
  }

  /**
   * Walk every component between the real root and `target`. Existing components must be real
   * directories (not symlinks); missing ones are created when `create` is set.
   */
  private async ensureDirectory(target: string, create = true) {
    const parts = relative(this.root, target).split(sep).filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      if (part === '..') throw new Error('Invalid object path');
      current = join(current, part);
      let stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stats) {
        if (!create) return false;
        await mkdir(current).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error; // a concurrent writer created it
        });
        stats = await lstat(current);
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error('Object store path contains a symlink or non-directory');
      }
    }
    return true;
  }

  /** The object file itself must not be a symlink either. */
  private async assertRegularOrMissing(path: string) {
    const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stats && (stats.isSymbolicLink() || !stats.isFile())) {
      throw new Error('Object store path contains a symlink or non-directory');
    }
    return stats !== null;
  }

  private pathFor(key: string) {
    this.assertInitialized();
    assertSafeObjectKey(key);
    const digest = createHash('sha256').update(key).digest('hex');
    const path = resolve(this.objects, digest.slice(0, 2), digest);
    if (!path.startsWith(`${this.objects}${sep}`)) throw new Error('Invalid object key');
    return path;
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options: ObjectStoreWriteOptions = {},
  ) {
    const path = this.pathFor(key);
    const body = toBytes(value);
    const header: StoredHeader = {
      key,
      size: body.byteLength,
      etag: createHash('sha256').update(body).digest('hex').slice(0, 32),
      httpMetadata: { ...options.httpMetadata },
      customMetadata: { ...options.customMetadata },
      uploaded: new Date().toISOString(),
    };
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    if (headerBytes.byteLength > HEADER_LIMIT) throw new Error('Object metadata too large');
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, headerBytes.byteLength);
    await this.ensureDirectory(this.temporary);
    await this.ensureDirectory(join(path, '..'));
    await this.assertRegularOrMissing(path);
    const temporary = join(this.temporary, `${randomUUID()}.part`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.write(prefix);
        await handle.write(headerBytes);
        await handle.write(body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return { key, size: header.size, etag: header.etag };
  }

  async get(key: string): Promise<FilesystemObjectStoreObject | null> {
    const path = this.pathFor(key);
    let file: Uint8Array;
    try {
      if (!(await this.ensureDirectory(join(path, '..'), false))) return null;
      if (!(await this.assertRegularOrMissing(path))) return null;
      file = new Uint8Array(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (file.byteLength < 4) throw new Error('Corrupt object file');
    const headerLength = new DataView(file.buffer, file.byteOffset, 4).getUint32(0);
    if (headerLength > HEADER_LIMIT || 4 + headerLength > file.byteLength) {
      throw new Error('Corrupt object file');
    }
    const header = JSON.parse(
      new TextDecoder().decode(file.subarray(4, 4 + headerLength)),
    ) as StoredHeader;
    const body = file.slice(4 + headerLength);
    if (header.key !== key || body.byteLength !== header.size)
      throw new Error('Corrupt object file');
    return {
      key,
      size: header.size,
      httpEtag: `"${header.etag}"`,
      httpMetadata: header.httpMetadata,
      customMetadata: header.customMetadata,
      body: new Response(body).body as ReadableStream,
      arrayBuffer: async () => body.slice().buffer,
      text: async () => new TextDecoder().decode(body),
    };
  }

  async delete(key: string) {
    const path = this.pathFor(key);
    try {
      if (!(await this.ensureDirectory(join(path, '..'), false))) return;
      await this.assertRegularOrMissing(path);
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
