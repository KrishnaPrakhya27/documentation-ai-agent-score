import { TextDecoder } from 'node:util';
import { Agent, fetch as undiciFetch } from 'undici';

import {
  RequestBudgetError,
  RobotsDisallowedError,
  ScanDeadlineError,
  TooManyRedirectsError,
} from './errors';
import { OriginScheduler } from './originScheduler';
import { createPinnedLookup } from './pinnedLookup';
import { assertFetchableUrl, isPublicAddress } from './publicAddress';
import { RobotsPolicy } from './robotsPolicy';

/**
 * The only way the scanner reaches the network. Every hop is validated and
 * pinned to a checked public address, robots.txt and Retry-After are obeyed,
 * requests to one origin are spaced, and bodies, time and request count are
 * all capped. The response shape matches AFDocs' HttpClient, so its checks run
 * through this unchanged.
 */

export interface ScanRequestInit {
  method?: string;
  headers?: Record<string, string>;
  redirect?: 'follow' | 'manual';
  signal?: AbortSignal;
  /** Lower byte cap for this request; such partial bodies are never cached. */
  maxBytes?: number;
}

export interface ScanResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  url: string;
  redirected: boolean;
  /** True when the body was cut at the byte cap. */
  truncated: boolean;
  text(): Promise<string>;
}

export interface ScanHttpClient {
  fetch(url: string, init?: ScanRequestInit): Promise<ScanResponse>;
}

export interface GuardedFetcherOptions {
  userAgent: string;
  /** Product token matched against robots.txt groups. */
  robotsToken: string;
  requestTimeoutMs: number;
  maxBodyBytes: number;
  maxRedirects: number;
  minIntervalMs: number;
  maxConcurrentPerOrigin: number;
  maxRequests: number;
  /** Longest Retry-After worth waiting for; longer ones return the 429/503. */
  maxRetryAfterMs: number;
  /** Epoch ms after which no new request starts. */
  deadline?: number;
  /** Test seams; hosted scans always use the defaults. */
  validateUrl?: (url: string | URL) => URL;
  isAllowedAddress?: (address: string) => boolean;
}

export interface FetchStats {
  requests: number;
  robotsBlocked: string[];
  retryAfterWaits: number;
}

interface RawResult {
  status: number;
  statusText: string;
  headers: Headers;
  location: string | null;
  body: string;
  truncated: boolean;
}

interface CachedResult extends RawResult {
  url: string;
  redirected: boolean;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_RETRIES = 2;
const MAX_CACHE_CHARS = 40 * 1024 * 1024;
const DEFAULT_ACCEPT =
  'text/html,application/xhtml+xml,text/markdown;q=0.9,text/plain;q=0.8,*/*;q=0.5';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GuardedFetcher implements ScanHttpClient {
  readonly robots: RobotsPolicy;
  private readonly agent: Agent;
  private readonly scheduler: OriginScheduler;
  private readonly validateUrl: (url: string | URL) => URL;
  private readonly cache = new Map<string, CachedResult>();
  private cachedChars = 0;
  private readonly slowedOrigins = new Set<string>();
  private readonly counters: FetchStats = {
    requests: 0,
    robotsBlocked: [],
    retryAfterWaits: 0,
  };

  constructor(private readonly options: GuardedFetcherOptions) {
    this.validateUrl = options.validateUrl ?? assertFetchableUrl;
    this.agent = new Agent({
      connect: {
        lookup: createPinnedLookup(options.isAllowedAddress ?? isPublicAddress),
        timeout: options.requestTimeoutMs,
      },
      headersTimeout: options.requestTimeoutMs,
      bodyTimeout: options.requestTimeoutMs,
    });
    this.scheduler = new OriginScheduler(
      options.minIntervalMs,
      options.maxConcurrentPerOrigin,
    );
    this.robots = new RobotsPolicy(options.robotsToken, (url) =>
      this.fetchWithoutRobots(url),
    );
  }

  stats(): FetchStats {
    return { ...this.counters, robotsBlocked: [...this.counters.robotsBlocked] };
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  async fetch(rawUrl: string, init: ScanRequestInit = {}): Promise<ScanResponse> {
    return this.fetchUrl(rawUrl, init, true);
  }

  private async fetchWithoutRobots(url: string) {
    const response = await this.fetchUrl(url, {}, false);
    return { status: response.status, body: await response.text() };
  }

  private async fetchUrl(
    rawUrl: string,
    init: ScanRequestInit,
    obeyRobots: boolean,
  ): Promise<ScanResponse> {
    const method = (init.method ?? 'GET').toUpperCase();
    const mode = init.redirect ?? 'follow';
    const headers = buildHeaders(this.options.userAgent, init.headers);
    const maxBytes = Math.min(
      init.maxBytes ?? this.options.maxBodyBytes,
      this.options.maxBodyBytes,
    );
    const cacheKey =
      method === 'GET' && init.maxBytes === undefined
        ? `${mode} ${headers.accept} ${rawUrl}`
        : null;
    const hit = cacheKey ? this.cache.get(cacheKey) : undefined;
    if (hit) return toResponse(hit);

    let url = this.validateUrl(rawUrl);
    let currentMethod = method;
    let redirected = false;

    for (let hop = 0; ; hop++) {
      if (obeyRobots) await this.assertRobotsAllow(url);
      const raw = await this.request(
        url,
        currentMethod,
        headers,
        maxBytes,
        init.signal,
      );

      if (mode === 'follow' && REDIRECT_STATUSES.has(raw.status) && raw.location) {
        if (hop >= this.options.maxRedirects) {
          throw new TooManyRedirectsError(rawUrl, this.options.maxRedirects);
        }
        url = this.validateUrl(new URL(raw.location, url));
        redirected = true;
        if (raw.status === 303 && currentMethod !== 'HEAD') currentMethod = 'GET';
        continue;
      }

      const result: CachedResult = { ...raw, url: url.href, redirected };
      if (cacheKey) this.remember(cacheKey, result);
      return toResponse(result);
    }
  }

  private async assertRobotsAllow(url: URL): Promise<void> {
    const decision = await this.robots.decide(url);
    if (!this.slowedOrigins.has(url.origin)) {
      this.slowedOrigins.add(url.origin);
      if (decision.crawlDelayMs > 0) {
        this.scheduler.slowDown(url.origin, decision.crawlDelayMs);
      }
    }
    if (!decision.allowed) {
      this.counters.robotsBlocked.push(url.href);
      throw new RobotsDisallowedError(url.href);
    }
  }

  private async request(
    url: URL,
    method: string,
    headers: Record<string, string>,
    maxBytes: number,
    callerSignal?: AbortSignal,
  ): Promise<RawResult> {
    return this.scheduler.run(url.origin, async () => {
      for (let attempt = 0; ; attempt++) {
        this.consumeBudget();
        const signals = [AbortSignal.timeout(this.timeoutMs())];
        if (callerSignal) signals.push(callerSignal);
        const signal = AbortSignal.any(signals);

        const response = await undiciFetch(url.href, {
          method,
          headers,
          redirect: 'manual',
          signal,
          dispatcher: this.agent,
        });
        const { text, truncated } =
          method === 'HEAD'
            ? { text: '', truncated: false }
            : await readCappedText(response, maxBytes);

        const waitMs = retryAfterMs(response.headers.get('retry-after'));
        const shouldWait =
          (response.status === 429 || response.status === 503) &&
          waitMs !== null &&
          waitMs <= this.options.maxRetryAfterMs &&
          attempt < MAX_RETRIES;
        if (shouldWait) {
          this.counters.retryAfterWaits++;
          this.scheduler.pause(url.origin, waitMs);
          await sleep(waitMs);
          continue;
        }

        return {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers([...response.headers.entries()]),
          location: response.headers.get('location'),
          body: text,
          truncated,
        };
      }
    });
  }

  private consumeBudget(): void {
    if (this.options.deadline && Date.now() >= this.options.deadline) {
      throw new ScanDeadlineError();
    }
    if (this.counters.requests >= this.options.maxRequests) {
      throw new RequestBudgetError(this.options.maxRequests);
    }
    this.counters.requests++;
  }

  private timeoutMs(): number {
    if (!this.options.deadline) return this.options.requestTimeoutMs;
    const remaining = this.options.deadline - Date.now();
    return Math.max(1_000, Math.min(this.options.requestTimeoutMs, remaining));
  }

  private remember(key: string, result: CachedResult): void {
    if (this.cachedChars + result.body.length > MAX_CACHE_CHARS) return;
    this.cachedChars += result.body.length;
    this.cache.set(key, result);
  }
}

function buildHeaders(
  userAgent: string,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    accept: DEFAULT_ACCEPT,
  };
  for (const [name, value] of Object.entries(extra ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

function toResponse(result: CachedResult): ScanResponse {
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    url: result.url,
    redirected: result.redirected,
    truncated: result.truncated,
    text: async () => result.body,
  };
}

/** Seconds or an HTTP date, as RFC 9110 allows; null when absent or unusable. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

async function readCappedText(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        // The body is being abandoned anyway.
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const bytes = Buffer.concat(chunks, total);
  return {
    text: decoderFor(response.headers.get('content-type')).decode(bytes),
    truncated,
  };
}

function decoderFor(contentType: string | null): TextDecoder {
  const charset = /charset=([^;]+)/i.exec(contentType ?? '')?.[1]?.trim();
  try {
    return new TextDecoder(charset || 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}
