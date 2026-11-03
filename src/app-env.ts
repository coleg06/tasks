import type { SessionClaims } from './auth/session';
import type { Env } from './env';
import type { McpClientIdentity } from './mcp/auth';

/** Legacy runtime identity retained while handlers migrate to the portable core identity. */
export type TaskIdentity = {
  session: SessionClaims;
  user: { id: number; email: string; status: string };
  /** Actual actor for immutable audit records; differs from user.id during impersonation. */
  auditUserId: number;
};

export type TaskAppEnv = {
  Bindings: Env;
  Variables: {
    taskIdentity?: TaskIdentity;
    mobileAdapter?: boolean;
    mcpClient?: McpClientIdentity;
    requestId?: string;
  };
};
