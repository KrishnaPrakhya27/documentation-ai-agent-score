import { BlockedTargetError } from './publicAddress';

/** Why a request did not produce a response, in terms a report can state. */
export type FetchFailureCode =
  | 'blocked'
  | 'robots'
  | 'budget'
  | 'deadline'
  | 'timeout'
  | 'dns'
  | 'connection'
  | 'tls'
  | 'redirects'
  | 'other';

export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt does not allow the scanner to fetch ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

export class RequestBudgetError extends Error {
  constructor(limit: number) {
    super(`The scan reached its limit of ${limit} requests`);
    this.name = 'RequestBudgetError';
  }
}

export class ScanDeadlineError extends Error {
  constructor() {
    super('The scan ran out of time');
    this.name = 'ScanDeadlineError';
  }
}

export class TooManyRedirectsError extends Error {
  constructor(url: string, limit: number) {
    super(`${url} redirected more than ${limit} times`);
    this.name = 'TooManyRedirectsError';
  }
}

export function classifyFetchError(error: unknown): FetchFailureCode {
  if (error instanceof BlockedTargetError) return 'blocked';
  if (error instanceof RobotsDisallowedError) return 'robots';
  if (error instanceof RequestBudgetError) return 'budget';
  if (error instanceof ScanDeadlineError) return 'deadline';
  if (error instanceof TooManyRedirectsError) return 'redirects';

  const err = error as { name?: string; code?: string; cause?: unknown };
  const cause = (err?.cause ?? {}) as { code?: string; name?: string };
  const code = cause.code ?? err?.code ?? '';
  if (cause instanceof BlockedTargetError) return 'blocked';
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code.startsWith('ERR_TLS') || code.includes('CERT')) return 'tls';
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return code === 'UND_ERR_CONNECT_TIMEOUT' ? 'timeout' : 'connection';
  }
  return 'other';
}
