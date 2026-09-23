import robotsParser from 'robots-parser';

import { RequestBudgetError, ScanDeadlineError } from './errors';

/**
 * robots.txt rules per origin, read once per scan (RFC 9309). A missing file
 * (4xx) allows everything; a server error or timeout means complete disallow,
 * which the report states as a block rather than a score.
 */

export type RobotsFetchState = 'ok' | 'missing' | 'unreachable';

export interface RobotsFile {
  origin: string;
  state: RobotsFetchState;
  text: string;
  parser: ReturnType<typeof robotsParser> | null;
}

export interface RobotsDecision {
  allowed: boolean;
  crawlDelayMs: number;
  state: RobotsFetchState;
}

/** Google's documented limit; anything beyond it is ignored. */
const MAX_ROBOTS_CHARS = 500 * 1024;

export type RobotsDownload = (
  url: string,
) => Promise<{ status: number; body: string } | null>;

export class RobotsPolicy {
  private readonly files = new Map<string, Promise<RobotsFile>>();

  constructor(
    private readonly token: string,
    private readonly download: RobotsDownload,
  ) {}

  async decide(url: URL): Promise<RobotsDecision> {
    if (url.pathname === '/robots.txt') {
      return { allowed: true, crawlDelayMs: 0, state: 'ok' };
    }
    const file = await this.fileFor(url.origin);
    if (file.state === 'unreachable') {
      return { allowed: false, crawlDelayMs: 0, state: file.state };
    }
    if (!file.parser) return { allowed: true, crawlDelayMs: 0, state: file.state };

    const allowed = file.parser.isAllowed(url.href, this.token) !== false;
    const delaySeconds = file.parser.getCrawlDelay(this.token) ?? 0;
    return {
      allowed,
      crawlDelayMs: Math.max(0, delaySeconds * 1000),
      state: file.state,
    };
  }

  /** Whether another crawler's token may fetch a URL; used to report AI crawler access. */
  async allowsAgent(url: URL, agentToken: string): Promise<boolean | null> {
    const file = await this.fileFor(url.origin);
    if (file.state === 'unreachable') return null;
    if (!file.parser) return true;
    return file.parser.isAllowed(url.href, agentToken) !== false;
  }

  fileFor(origin: string): Promise<RobotsFile> {
    let file = this.files.get(origin);
    if (!file) {
      file = this.load(origin);
      this.files.set(origin, file);
    }
    return file;
  }

  private async load(origin: string): Promise<RobotsFile> {
    const robotsUrl = `${origin}/robots.txt`;
    let response: { status: number; body: string } | null;
    try {
      response = await this.download(robotsUrl);
    } catch (error) {
      // Our own time or request limit says nothing about the site's rules.
      if (error instanceof ScanDeadlineError || error instanceof RequestBudgetError) {
        this.files.delete(origin);
        throw error;
      }
      response = null;
    }
    if (!response || response.status >= 500 || response.status === 429) {
      return { origin, state: 'unreachable', text: '', parser: null };
    }
    if (response.status >= 400) {
      return { origin, state: 'missing', text: '', parser: null };
    }
    const text = response.body.slice(0, MAX_ROBOTS_CHARS);
    return { origin, state: 'ok', text, parser: robotsParser(robotsUrl, text) };
  }
}
