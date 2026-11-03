import { Component, type ErrorInfo, type ReactNode } from 'react';
import { tenantProfile } from '../../../shared/tenant-profile';
import { reportClientFailure } from './client-errors';

type State = { failed: boolean };

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientFailure({
      event: 'ui.render_error',
      message: error.message || error.name,
      ...(info.componentStack ? { componentStack: info.componentStack } : {}),
    });
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="fatal-error" role="alert">
          <h1>{tenantProfile.productName} hit an unexpected problem</h1>
          <p>The error was recorded for the IT team. Reload the page to try again.</p>
          <button className="button-primary" onClick={() => window.location.reload()} type="button">
            Reload {tenantProfile.productName}
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
