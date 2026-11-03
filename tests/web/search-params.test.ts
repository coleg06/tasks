import { describe, expect, it } from 'vitest';
import { validateSearch } from '../../web/src/search-params';

describe('task search params', () => {
  it('defaults to the open view when none is given', () => {
    expect(validateSearch({})).toEqual({ view: 'open' });
  });

  it('rejects a view that is not one of the four', () => {
    expect(validateSearch({ view: 'archived' })).toEqual({ view: 'open' });
  });

  it('carries project, query and the open task through', () => {
    expect(validateSearch({ view: 'mine', project: 'IT', q: 'dns', task: 'TASK-1' })).toEqual({
      view: 'mine',
      project: 'IT',
      q: 'dns',
      task: 'TASK-1',
    });
  });

  it('drops blank values so they do not linger in the URL', () => {
    expect(validateSearch({ view: 'open', q: '   ', project: '' })).toEqual({ view: 'open' });
  });

  it('ignores non-string values', () => {
    expect(validateSearch({ view: 'open', task: 42, project: null })).toEqual({ view: 'open' });
  });

  it('keeps supported task sorting and drops unknown values', () => {
    expect(validateSearch({ view: 'open', sort: 'due_asc' })).toEqual({
      view: 'open',
      sort: 'due_asc',
    });
    expect(validateSearch({ view: 'open', sort: 'surprise' })).toEqual({ view: 'open' });
  });

  it('keeps only the explicit hide-Agent toggle value', () => {
    expect(validateSearch({ view: 'open', hideAgent: '1' })).toEqual({
      view: 'open',
      hideAgent: '1',
    });
    expect(validateSearch({ view: 'open', hideAgent: 'true' })).toEqual({ view: 'open' });
  });
});
