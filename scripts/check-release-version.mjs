import { readFile } from 'node:fs/promises';

const packageMetadata = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const versionSource = await readFile(new URL('../shared/version.ts', import.meta.url), 'utf8');
const sourceVersion = /TASKS_RELEASE_VERSION\s*=\s*'([^']+)'/.exec(versionSource)?.[1];

if (!sourceVersion || sourceVersion !== packageMetadata.version) {
  throw new Error(
    `Release version mismatch: package=${packageMetadata.version ?? 'missing'} source=${sourceVersion ?? 'missing'}`,
  );
}

const releaseTag = process.env.CI_COMMIT_TAG;
if (releaseTag && releaseTag !== `v${sourceVersion}`) {
  throw new Error(`Release tag mismatch: tag=${releaseTag} expected=v${sourceVersion}`);
}

console.log(`Tasks release version ${sourceVersion} is consistent.`);
