import { describeAppScenario } from './app-scenario';
import { openWorkerdBindings } from './workerd-harness';

// The same application scenario on real D1 semantics (workerd). No skip path.
describeAppScenario('Cloudflare D1 (workerd)', async () => {
  const bindings = await openWorkerdBindings();
  return { db: bindings.db, dispose: bindings.dispose };
});
