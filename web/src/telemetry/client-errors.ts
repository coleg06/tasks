import { api } from '../api/client';

type ClientFailure = {
  event: 'ui.render_error' | 'ui.unhandled_error' | 'ui.unhandled_rejection';
  message: string;
  componentStack?: string;
};

const reported = new Set<string>();

export function reportClientFailure(failure: ClientFailure) {
  const route = `${window.location.pathname}${window.location.search}`;
  const fingerprint = `${route}:${failure.message}`;
  if (reported.has(fingerprint) || reported.size >= 10) return;
  reported.add(fingerprint);
  void api.reportClientError({ ...failure, route });
}

export function installGlobalErrorReporting() {
  window.addEventListener('error', (event) => {
    reportClientFailure({
      event: 'ui.unhandled_error',
      message: event.error instanceof Error ? event.error.message : event.message,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportClientFailure({
      event: 'ui.unhandled_rejection',
      message: event.reason instanceof Error ? event.reason.message : String(event.reason),
    });
  });
}
