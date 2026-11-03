import { describeSqlContract } from './sql-contract';
import { openWorkerdBindings } from './workerd-harness';

// Real D1 semantics via workerd. There is deliberately no skip path: if workerd cannot start
// in an environment, this suite must fail loudly rather than silently pass.
describeSqlContract('Cloudflare D1 (workerd)', async () => {
  const bindings = await openWorkerdBindings();
  return { db: bindings.db, dispose: bindings.dispose };
});
