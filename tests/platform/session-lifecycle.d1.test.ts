import { describeSessionLifecycle } from './session-lifecycle';
import { openWorkerdBindings } from './workerd-harness';

describeSessionLifecycle('Cloudflare D1 (workerd)', async () => {
  const bindings = await openWorkerdBindings();
  return { db: bindings.db, dispose: bindings.dispose };
});
