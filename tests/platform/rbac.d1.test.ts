import { describeRbacScenario } from './rbac-scenario';
import { openWorkerdBindings } from './workerd-harness';

// The same scenarios on real D1 semantics (workerd). No skip path.
describeRbacScenario('Cloudflare D1 (workerd)', async () => {
  const bindings = await openWorkerdBindings();
  return { db: bindings.db, dispose: bindings.dispose };
});
