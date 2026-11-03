import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectStore } from '../../src/platform/ports';

export interface ObjectBackendHandle {
  store: ObjectStore;
  dispose(): Promise<void>;
}

async function readAll(stream: ReadableStream) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The behaviour src/events/api.ts relies on, run identically against every object store. */
export function describeObjectContract(label: string, open: () => Promise<ObjectBackendHandle>) {
  describe(`Object store contract: ${label}`, () => {
    let handle: ObjectBackendHandle;
    let store: ObjectStore;
    beforeAll(async () => {
      handle = await open();
      store = handle.store;
    }, 120_000);
    afterAll(async () => {
      await handle?.dispose();
    });

    it('round-trips bytes with size, etag and a readable body stream', async () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);
      await store.put('events/E-1/D-1/one', bytes.buffer, {
        httpMetadata: {
          contentType: 'application/octet-stream',
          contentDisposition: 'attachment; filename="a.bin"',
        },
        customMetadata: { eventKey: 'E-1', version: '1' },
      });
      const object = await store.get('events/E-1/D-1/one');
      expect(object).not.toBeNull();
      expect(object?.size).toBe(bytes.byteLength);
      expect(typeof object?.httpEtag).toBe('string');
      expect(object?.httpEtag.length).toBeGreaterThan(2);
      expect(await readAll(object?.body as ReadableStream)).toEqual(bytes);
    });

    it('accepts string values and overwrites existing keys', async () => {
      await store.put('events/E-2/D-1/text', 'first');
      await store.put('events/E-2/D-1/text', 'second value');
      const object = await store.get('events/E-2/D-1/text');
      expect(new TextDecoder().decode(await readAll(object?.body as ReadableStream))).toBe(
        'second value',
      );
      expect(object?.size).toBe('second value'.length);
    });

    it('returns null for missing keys and delete is idempotent', async () => {
      expect(await store.get('events/missing/none/none')).toBeNull();
      await store.put('events/E-3/D-1/gone', new Uint8Array([9]).buffer);
      await store.delete('events/E-3/D-1/gone');
      expect(await store.get('events/E-3/D-1/gone')).toBeNull();
      await expect(store.delete('events/E-3/D-1/gone')).resolves.toBeUndefined();
    });

    it('keeps distinct keys independent', async () => {
      await store.put('events/E-4/a', 'A');
      await store.put('events/E-4/b', 'B');
      expect(await readAll((await store.get('events/E-4/a'))?.body as ReadableStream)).toEqual(
        new TextEncoder().encode('A'),
      );
      await store.delete('events/E-4/a');
      expect(await store.get('events/E-4/b')).not.toBeNull();
    });
  });
}
