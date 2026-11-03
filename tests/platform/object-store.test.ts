/// <reference types="node" />

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FilesystemObjectStore } from '../../src/platform/fs-object-store';
import { describeObjectContract } from './object-contract';
import { openWorkerdBindings } from './workerd-harness';

const directories: string[] = [];
function temporaryRoot() {
  const directory = mkdtempSync(join(tmpdir(), 'tasks-objects-'));
  directories.push(directory);
  return directory;
}
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describeObjectContract('filesystem', async () => {
  const store = new FilesystemObjectStore(temporaryRoot());
  await store.initialize();
  return { store, dispose: async () => {} };
});

// Real R2 semantics via workerd; no skip path (see sql-conformance.d1.test.ts).
describeObjectContract('Cloudflare R2 (workerd)', async () => {
  const bindings = await openWorkerdBindings();
  return { store: bindings.bucket, dispose: bindings.dispose };
});

describe('filesystem object store specifics', () => {
  it('persists content type and metadata, and survives a new instance', async () => {
    const root = temporaryRoot();
    const first = new FilesystemObjectStore(root);
    await first.initialize();
    await first.put('events/E-1/D-1/file', 'hello', {
      httpMetadata: { contentType: 'text/plain', contentDisposition: 'attachment' },
      customMetadata: { originalFilename: 'hello.txt' },
    });
    const second = new FilesystemObjectStore(root);
    await second.initialize();
    const object = await second.get('events/E-1/D-1/file');
    expect(object?.httpMetadata).toEqual({
      contentType: 'text/plain',
      contentDisposition: 'attachment',
    });
    expect(object?.customMetadata).toEqual({ originalFilename: 'hello.txt' });
    expect(await object?.text()).toBe('hello');
  });

  it('rejects traversal and malformed keys without touching the filesystem', async () => {
    const root = temporaryRoot();
    const store = new FilesystemObjectStore(join(root, 'store'));
    await store.initialize();
    for (const key of [
      '../escape',
      'a/../../escape',
      '/absolute',
      'a//b',
      'a/./b',
      'a\\b',
      'a\0b',
      '',
      'x'.repeat(1_025),
    ]) {
      await expect(store.put(key, 'x'), JSON.stringify(key)).rejects.toThrow();
      await expect(store.get(key), JSON.stringify(key)).rejects.toThrow();
      await expect(store.delete(key), JSON.stringify(key)).rejects.toThrow();
    }
    expect(readdirSync(root)).toEqual(['store']);
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });

  it('writes atomically: no temp files remain and concurrent writers never mix', async () => {
    const root = temporaryRoot();
    const store = new FilesystemObjectStore(root);
    await store.initialize();
    const values = Array.from({ length: 20 }, (_, index) => String(index).repeat(50_000));
    await Promise.all(values.map((value) => store.put('events/E-1/D-1/race', value)));
    const text = await (await store.get('events/E-1/D-1/race'))?.text();
    expect(values).toContain(text);
    expect(await readdir(join(root, '.tmp'))).toEqual([]);
  });

  it('detects a corrupted object file instead of serving it', async () => {
    const root = temporaryRoot();
    const store = new FilesystemObjectStore(root);
    await store.initialize();
    await store.put('events/E-1/D-1/bad', 'payload');
    const { writeFile } = await import('node:fs/promises');
    const objects = join(root, 'objects');
    const [shard] = readdirSync(objects);
    const [file] = readdirSync(join(objects, shard as string));
    await writeFile(join(objects, shard as string, file as string), new Uint8Array([0, 0, 0, 9]));
    await expect(store.get('events/E-1/D-1/bad')).rejects.toThrow('Corrupt');
  });
});

describe('filesystem object store symlink handling', () => {
  const digest = (key: string) => createHash('sha256').update(key).digest('hex');

  it('accepts a symlinked root (volume mount point) and stores beneath its real path', async () => {
    const base = temporaryRoot();
    const real = join(base, 'real');
    mkdirSync(real);
    symlinkSync(real, join(base, 'mount'));
    const store = new FilesystemObjectStore(join(base, 'mount'));
    await store.initialize();
    await store.put('events/E-1/D-1/a', 'ok');
    expect(await (await store.get('events/E-1/D-1/a'))?.text()).toBe('ok');
    expect(readdirSync(join(real, 'objects')).length).toBe(1);
  });

  it('refuses to write outside the root through a symlinked objects directory', async () => {
    const base = temporaryRoot();
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const root = join(base, 'root');
    const store = new FilesystemObjectStore(root);
    await store.initialize();
    rmSync(join(root, 'objects'), { recursive: true });
    symlinkSync(outside, join(root, 'objects'));
    await expect(store.put('events/E-1/D-1/a', 'escaped')).rejects.toThrow('symlink');
    await expect(store.get('events/E-1/D-1/a')).rejects.toThrow('symlink');
    await expect(store.delete('events/E-1/D-1/a')).rejects.toThrow('symlink');
    await expect(store.ping()).resolves.toBeUndefined();
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a symlinked shard directory, temp directory and object file', async () => {
    const base = temporaryRoot();
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const root = join(base, 'root');
    const store = new FilesystemObjectStore(root);
    await store.initialize();
    const key = 'events/E-1/D-1/b';
    const hash = digest(key);
    symlinkSync(outside, join(root, 'objects', hash.slice(0, 2)));
    await expect(store.put(key, 'escaped')).rejects.toThrow('symlink');
    await expect(store.get(key)).rejects.toThrow('symlink');
    rmSync(join(root, 'objects', hash.slice(0, 2)));

    mkdirSync(join(root, 'objects', hash.slice(0, 2)));
    symlinkSync(join(outside, 'target'), join(root, 'objects', hash.slice(0, 2), hash));
    await expect(store.put(key, 'escaped')).rejects.toThrow('symlink');
    await expect(store.delete(key)).rejects.toThrow('symlink');

    rmSync(join(root, '.tmp'), { recursive: true });
    symlinkSync(outside, join(root, '.tmp'));
    await expect(store.put('events/E-1/D-1/c', 'escaped')).rejects.toThrow('symlink');
    await expect(store.ping()).rejects.toThrow('symlink');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('requires initialize() before use', async () => {
    const store = new FilesystemObjectStore(temporaryRoot());
    await expect(store.put('events/E-1/D-1/a', 'x')).rejects.toThrow('initialize');
  });
});
