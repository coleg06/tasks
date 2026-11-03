import { describe, expect, it } from 'vitest';
import { eventFactsPatchSchema } from '../src/events/schemas';
import { taskPatchSchema } from '../src/shared/schemas';

describe('bounded request collections', () => {
  it.each([
    {
      field: 'taskTypes',
      maximum: 20,
      parse: (values: unknown[]) => taskPatchSchema.safeParse({ taskTypes: values }),
    },
    {
      field: 'campuses',
      maximum: 12,
      parse: (values: unknown[]) =>
        eventFactsPatchSchema.safeParse({
          campuses: values,
          changeReason: 'Update locations',
          expectedVersion: 1,
        }),
    },
  ])('rejects oversized $field before visiting elements', ({ field, maximum, parse }) => {
    let elementVisits = 0;
    const oversized = Array.from({ length: maximum + 1 }, (_, index) => index);
    for (let index = 0; index < oversized.length; index++) {
      Object.defineProperty(oversized, index, {
        get: () => {
          elementVisits++;
          return 42;
        },
      });
    }

    const result = parse(oversized);
    expect(elementVisits).toBe(0);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Oversized collection was accepted');
    expect(result.error.issues).toEqual([
      expect.objectContaining({ code: 'too_big', maximum, path: [field] }),
    ]);

    const atLimit = Array.from({ length: maximum }, (_, index) => `  value-${index}  `);
    expect(parse(atLimit).data).toMatchObject({
      [field]: atLimit.map((value) => value.trim()),
    });
    expect(parse(['']).success).toBe(false);
  });
});
