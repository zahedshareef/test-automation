/** Shared types for scopes, test selection and results. */

export interface JiraIssue {
  key: string;
  summary: string;
  type: string;
  status: string;
  components: string[];
  labels: string[];
  description: string;
  acceptanceCriteria: string;
  url: string;
}

export interface ScopeInput {
  environment?: string;
  /** Issue keys, e.g. ["APP-123", "APP-456"]. */
  jiraKeys?: string[];
  jql?: string;
  octopus?: { project: string; release: string };
  tags?: string[];
  freeText?: string;
  /** Add the configured always-included tags (e.g. @smoke). Default true. */
  includeAlwaysTags?: boolean;
}

export interface ResolvedScope {
  input: ScopeInput;
  issues: JiraIssue[];
  tags: string[];
  release?: OctopusReleaseInfo;
  notes: string[];
}

export interface OctopusReleaseInfo {
  projectId: string;
  projectName: string;
  releaseId: string;
  version: string;
  releaseNotes: string;
  workItemKeys: string[];
  deploymentTaskId?: string;
  environment?: string;
}

/** A test discovered with `playwright test --list`. */
export interface CatalogTest {
  id: string;
  file: string;
  line: number;
  titlePath: string[];
  title: string;
  project: string;
  tags: string[];
  issueKeys: string[];
}

export interface SelectedTest extends CatalogTest {
  reasons: string[];
}

export type TestOutcome = 'passed' | 'failed' | 'flaky' | 'skipped' | 'timedOut' | 'interrupted';

export interface TestResultSummary {
  id: string;
  title: string;
  titlePath: string[];
  file: string;
  line: number;
  project: string;
  tags: string[];
  issueKeys: string[];
  outcome: TestOutcome;
  durationMs: number;
  retries: number;
  error?: string;
  steps: string[];
  attachments: { name: string; path: string; contentType: string }[];
  /** Annotations of type "metric", e.g. "ready:/=1234ms". */
  metrics: string[];
  aiAnalysis?: string;
}

export interface RunSummary {
  id: string;
  createdAt: string;
  finishedAt?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  environment: string;
  baseUrl: string;
  scope?: ResolvedScope;
  selected: SelectedTest[];
  uncoveredIssues: string[];
  results: TestResultSummary[];
  totals: { passed: number; failed: number; flaky: number; skipped: number; total: number; durationMs: number };
  aiSummary?: string;
  error?: string;
  published?: { jiraComments: string[]; jiraBugs: string[]; octopus?: string };
}
