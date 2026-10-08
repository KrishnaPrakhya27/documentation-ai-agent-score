/**
 * The versioned report every surface renders: result page, badge, share
 * image, email and CLI. Renderers read these fields and never rescore.
 *
 * Scoring is one points table on AFDocs' scale: every check has a maximum
 * and what the site earned, and the score is earned divided by possible.
 * A check that could not run (skipped or unverified) drops out of the
 * possible points; it is never counted as zero.
 */

export type Grade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';
export type GroupId = 'access' | 'freshness' | 'answerability';
export type GroupState = 'complete' | 'pending' | 'unavailable';
/** Label only: it names the kind of site and tailors fixes. Every site is scored the same way. */
export type ContentProfile = 'developer-docs' | 'help-center';
/**
 * `skip`: the check does not apply to this site. `unverified`: it applies,
 * but the scan could not finish it (a timeout, a blocked request, a limit).
 * Neither one moves the score.
 */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip' | 'unverified';

export type PlatformId =
  | 'mintlify'
  | 'gitbook'
  | 'readme'
  | 'docusaurus'
  | 'fern'
  | 'zendesk'
  | 'intercom'
  | 'freshdesk'
  | 'helpscout'
  | 'document360'
  | 'confluence'
  | 'documentation-ai'
  | 'nextra'
  | 'readthedocs'
  | 'mkdocs'
  | 'vitepress'
  | 'unknown';

export interface ReportTarget {
  submittedUrl: string;
  /** Where the entry URL landed after redirects. */
  resolvedUrl: string;
  /** Origin plus path root the scan stays inside, e.g. https://example.com/docs. */
  scopeRoot: string;
  /** Host plus path root, e.g. `example.com/docs`: the site key reports are stored under. */
  key: string;
  domain: string;
  profile: ContentProfile;
  locale: string | null;
  version: string | null;
  /**
   * Where the documentation seems to live when a bare domain was submitted,
   * as a site key such as `docs.example.com` or `example.com/docs`. The scan
   * still covers what was submitted; the report offers this as the address to
   * scan for a docs-only score.
   */
  docsElsewhere?: string;
}

export interface CheckPoints {
  /** What the check is worth on this site. AFDocs checks carry AFDocs' own points. */
  max: number;
  /** What the site earned; null when the check did not count. */
  earned: number | null;
}

export interface ReportCheck {
  id: string;
  group: GroupId;
  /** AFDocs' category for its checks; ours for the rest (crawler-access, maintenance, consistency, currency, agent-evaluation). */
  category: string;
  title: string;
  status: CheckStatus;
  source: 'afdocs' | 'agent-score';
  points: CheckPoints;
  message: string;
  fix?: string;
  /** A few URLs or short excerpts behind the verdict. */
  evidence?: string[];
}

/** Shown on the report but outside the score: an interface the site may offer. */
export interface AdditionalCheck {
  id: string;
  title: string;
  status: 'found' | 'missing' | 'unverified';
  message: string;
  fix?: string;
  evidence?: string[];
}

export interface GroupScore {
  id: GroupId;
  label: string;
  state: GroupState;
  earned: number;
  possible: number;
  /** earned / possible, 0 to 100; null until something in the group counts. */
  score: number | null;
  /** Why the group is thinner than usual, e.g. maintenance only, or why it is missing. */
  note?: string;
}

export interface OverallScore {
  /** 0 to 100, after AFDocs' caps; null when nothing could be measured. */
  score: number | null;
  grade: Grade | null;
  earned: number;
  possible: number;
  /** An AFDocs cap that held the score down, when one did. */
  cap?: { value: number; checkId: string; reason: string };
  /** A score the scan could not stand behind: too few pages, throttling, or too much unverified. */
  provisional: boolean;
  provisionalReasons: string[];
  /** What the score rests on, for the page: which parts counted and why the rest did not. */
  reason?: string;
}

/** AFDocs' own result for the same site, kept separate so it can be labelled as AFDocs. */
export interface AfdocsSummary {
  score: number;
  grade: string;
  passed: number;
  total: number;
  earned: number;
  possible: number;
  cap?: { value: number; checkId: string; reason: string };
}

export type AnswerVerdict = 'correct' | 'incorrect' | 'not-found';

export interface TranscriptEntry {
  question: string;
  sourceUrl: string;
  answer: string;
  verdict: AnswerVerdict;
  /** Plain-English reason, e.g. what the agent could not retrieve. */
  reason: string;
  /** Whether the agent reached the page that holds the answer. */
  retrieved: boolean;
  /** Whether the answer's claims are backed by the pages it cited; null for an answer that made none. */
  supported: boolean | null;
  pagesVisited: string[];
  citedUrls: string[];
}

export interface AnswerabilityResult {
  state: GroupState;
  reason?: string;
  models?: { questions: string; solver: string; judge: string };
  /** Questions that were graded. */
  total: number;
  correct: number;
  retrieved: number;
  /** Answers that were not "not found": the denominator for `supported`. */
  answered: number;
  supported: number;
  transcript: TranscriptEntry[];
}

export interface TopFix {
  checkId: string;
  title: string;
  fix: string;
  /** Points the fix would recover. */
  points: number;
}

export interface PlatformResult {
  id: PlatformId;
  name: string;
  confidence: number;
}

export interface AgentScoreReport {
  schemaVersion: 2;
  methodology: {
    version: string;
    engineVersion: string;
    afdocsVersion: string;
    specVersion: string;
  };
  /** `technical` while Answerability is still running; `final` once every part has settled. */
  stage: 'technical' | 'final';
  target: ReportTarget;
  site: { name: string; title: string | null };
  platform: PlatformResult;
  overall: OverallScore;
  afdocs: AfdocsSummary | null;
  groups: Record<GroupId, GroupScore>;
  answerability: AnswerabilityResult;
  /** Every scored check, AFDocs and ours, including the Answerability checks once they have run. */
  checks: ReportCheck[];
  /** Interfaces reported outside the score: MCP server, llms-full.txt, agent skills. */
  additionalChecks: AdditionalCheck[];
  topFixes: TopFix[];
  /** Paste-ready prompt for a coding agent, built from the failing checks. */
  fixPrompt: string;
  coverage: {
    pagesDiscovered: number;
    pagesTested: number;
    sampledUrls: string[];
    discoverySources: string[];
    requests: number;
    /** Requests the site still refused as too many after retries; checks that needed them may read low. */
    rateLimitedRequests: number;
  };
  limitations: string[];
  timings: {
    startedAt: string;
    technicalCompletedAt?: string;
    completedAt?: string;
  };
}
