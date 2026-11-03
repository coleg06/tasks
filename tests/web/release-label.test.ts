import { describe, expect, it } from 'vitest';
import { releaseLabel } from '../../shared/release-label';

describe('releaseLabel', () => {
  it('shows the version and the first seven characters of the release', () => {
    const sha = '638b9a6f0e1d2c3b4a5968778695a4b3c2d1e0f9';
    expect(releaseLabel('Tasks', '1.8.2', sha)).toEqual({
      text: 'Tasks 1.8.2 · 638b9a6',
      title: `Tasks 1.8.2\nBuild ${sha}`,
    });
  });

  it.each([undefined, null, '', '   ', 'local', 'LOCAL'])(
    'shows only the version when the release is %j',
    (release) => {
      expect(releaseLabel('Tasks', '1.8.2', release)).toEqual({
        text: 'Tasks 1.8.2',
        title: undefined,
      });
    },
  );

  it('keeps short non-SHA release names whole', () => {
    expect(releaseLabel('Tasks', '1.8.2', 'smoke').text).toBe('Tasks 1.8.2 · smoke');
  });
});
