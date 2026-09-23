/**
 * The versioned report every surface renders: result page, badge, share
 * image, email and CLI. Renderers read these fields and never rescore.
 * `null` scores mean "not measured", never zero.
 */

export type Grade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';
export type PillarId = 'access' | 'answerability' | 'freshness';
export type PillarState = 'complete' | 'pending' | 'unavailable';
export type ContentProfile = 'developer-docs' | 'help-center';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info' | 'skip' | 'error';

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
  /** Host plus path root, e.g. `example.com/docs`: the result page and badge key. */
  key: string;
  domain: string;
  profile: ContentProfile;
  locale: string | null;
  version: string | null;
}

export interface ReportCheck {
  id: string;
  pillar: PillarId;
  group: string;
  title: string;
  status: CheckStatus;
  /** False for informational checks that carry no points in this methodology. */
  scored: boolean;
  source: 'afdocs' | 'agent-score';
  message: string;
  fix?: string;
  /** A few URLs or short excerpts behind the verdict. */
  evidence?: string[];
}

export interface AccessResult {
  state: PillarState;
  score: number | null;
  profile: ContentProfile;
  afdocs: {
    score: number;
    grade: Grade;
    passed: number;
    total: number;
    cap?: { value: number; checkId: string; reason: string };
  } | null;
  note?: string;
}

export interface FreshnessComponent {
  id: 'link-health' | 'markdown-parity' | 'recency';
  label: string;
  weight: number;
  score: number | null;
  checkIds: string[];
}

export interface FreshnessResult {
  state: PillarState;
  score: number | null;
  components: FreshnessComponent[];
  reason?: string;
}

export type AnswerVerdict = 'correct' | 'incorrect' | 'not-found';

export interface TranscriptEntry {
  question: string;
  sourceUrl: string;
  answer: string;
  verdict: AnswerVerdict;
  /** Plain-English reason, e.g. what the agent could not retrieve. */
  reason: string;
  pagesVisited: string[];
}

export interface AnswerabilityResult {
  state: PillarState;
  score: number | null;
  passed: number;
  total: number;
  transcript: TranscriptEntry[];
  reason?: string;
  models?: { questions: string; solver: string; judge: string };
}

export interface TopFix {
  checkId: string;
  title: string;
  fix: string;
}

export interface PlatformResult {
  id: PlatformId;
  name: string;
  confidence: number;
}

export interface AgentScoreReport {
  schemaVersion: 1;
  methodology: {
    version: string;
    engineVersion: string;
    afdocsVersion: string;
    specVersion: string;
  };
  /** `technical` while Answerability is still running; `final` once all pillars settle. */
  stage: 'technical' | 'final';
  target: ReportTarget;
  site: { name: string; title: string | null };
  platform: PlatformResult;
  overall: { score: number | null; grade: Grade | null; reason?: string };
  pillars: {
    access: AccessResult;
    answerability: AnswerabilityResult;
    freshness: FreshnessResult;
  };
  checks: ReportCheck[];
  topFixes: TopFix[];
  /** Paste-ready prompt for a coding agent, built from the failing checks. */
  fixPrompt: string;
  coverage: {
    pagesDiscovered: number;
    pagesTested: number;
    sampledUrls: string[];
    discoverySources: string[];
    requests: number;
  };
  limitations: string[];
  timings: {
    startedAt: string;
    technicalCompletedAt?: string;
    completedAt?: string;
  };
}
