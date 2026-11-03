import { describe, expect, it } from 'vitest';
import { resolveRuntimeFeatures } from '../shared/runtime-features';
import { tenantProfile } from '../shared/tenant-profile';

describe('runtime feature modules', () => {
  it('preserves every compiled module by default', () => {
    expect(resolveRuntimeFeatures()).toEqual({
      tasks: true,
      projects: true,
      events: true,
      eventPlanning: true,
      workflowAnalytics: true,
    });
  });

  it('keeps Tasks stable while independently disabling optional UI modules', () => {
    expect(resolveRuntimeFeatures('tasks')).toEqual({
      tasks: true,
      projects: false,
      events: false,
      eventPlanning: false,
      workflowAnalytics: false,
    });
    expect(resolveRuntimeFeatures('tasks,projects,events')).toMatchObject({
      tasks: true,
      projects: true,
      events: true,
      eventPlanning: true,
      workflowAnalytics: false,
    });
  });

  it('cannot enable a module that the compiled tenant profile does not support', () => {
    expect(
      resolveRuntimeFeatures('tasks,projects,events,workflows', {
        ...tenantProfile,
        capabilities: { ...tenantProfile.capabilities, events: false, eventPlanning: false },
      }),
    ).toMatchObject({ events: false, eventPlanning: false, workflowAnalytics: false });
  });

  it('rejects unknown modules and configurations without the Tasks core', () => {
    expect(() => resolveRuntimeFeatures('tasks,calendar')).toThrow('Unknown feature modules');
    expect(() => resolveRuntimeFeatures('projects,events')).toThrow(
      'FEATURE_MODULES must include tasks',
    );
  });
});
