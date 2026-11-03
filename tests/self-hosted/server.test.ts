/// <reference types="node" />

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAssetFetcher, createSelfHostedEnv } from '../../src/self-hosted/server';

describe('self-hosted runtime', () => {
  it('requires explicit deployment identity without exposing unrelated values', () => {
    expect(() => createSelfHostedEnv({ ENVIRONMENT: 'production' })).toThrow(
      'RELEASE_SHA is required',
    );
    expect(() => createSelfHostedEnv({ ENVIRONMENT: 'invalid', RELEASE_SHA: 'abc' })).toThrow(
      'ENVIRONMENT must be local, dev, or production',
    );
    const env = createSelfHostedEnv({ ENVIRONMENT: 'dev', RELEASE_SHA: 'abc', CUSTOM: 'value' });
    expect(env.ENVIRONMENT).toBe('dev');
    expect(env.RELEASE_SHA).toBe('abc');
    expect((env as unknown as Record<string, string>).CUSTOM).toBe('value');
  });

  it('serves hashed assets, SPA fallbacks, HEAD, and rejects traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tasks-assets-'));
    await writeFile(join(root, 'index.html'), '<main>Tasks</main>');
    await writeFile(join(root, 'app.js'), 'export {};');
    const assets = createAssetFetcher(root);

    const script = await assets.fetch(new Request('https://tasks.example/app.js'));
    expect(script.status).toBe(200);
    expect(script.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(await script.text()).toBe('export {};');

    const fallback = await assets.fetch(new Request('https://tasks.example/project/TEAM'));
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain('Tasks');

    const head = await assets.fetch(new Request('https://tasks.example/', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    const traversal = await assets.fetch(new Request('https://tasks.example/%2e%2e/package.json'));
    expect(traversal.status).toBe(404);
  });
});
