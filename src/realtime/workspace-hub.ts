import type { Env } from '../env';

export class WorkspaceHub implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  fetch(): Response {
    void this.state;
    void this.env;
    return Response.json(
      {
        error: 'not_implemented',
        message: 'Realtime arrives in implementation phase 6.',
      },
      { status: 501 },
    );
  }
}
