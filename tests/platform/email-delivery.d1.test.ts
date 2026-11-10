import { describeEmailDelivery } from './email-delivery-scenario';
import { openWorkerdBindings } from './workerd-harness';

describeEmailDelivery('Cloudflare D1 (local workerd)', async () => {
  const backend = await openWorkerdBindings();
  return { db: backend.db, dispose: backend.dispose };
});
