import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A deployed environment the tests can target (e.g. "Test", "UAT"). */
export interface EnvironmentConfig {
  name: string;
  baseUrl: string;
  /** "duende" signs in through the IdentityServer login page; "none" skips sign-in. */
  authMode: 'duende' | 'none';
  /** Octopus environment name, used to find the deployment for a release. */
  octopusEnvironment?: string;
}

export interface AppConfig {
  environments: EnvironmentConfig[];
  defaultEnvironment: string;
  testUser: { username: string };
  /** Optional CSS selectors if the Duende login page is customised. Defaults find fields by label. */
  login: { usernameSelector?: string; passwordSelector?: string; submitSelector?: string };
  jira: {
    baseUrl: string;
    deployment: 'cloud' | 'datacenter';
    /** Cloud only: the account email that owns the API token. */
    email: string;
    projectKey: string;
    bugIssueType: string;
    bugLabels: string[];
    /** Custom field id holding acceptance criteria, e.g. "customfield_10050". Empty = use description. */
    acceptanceCriteriaField: string;
    /** Maps Jira components/labels to Playwright tags, e.g. { "Invoicing": "@invoicing" }. */
    componentTagMap: Record<string, string>;
  };
  octopus: {
    serverUrl: string;
    space: string;
    /** How results are recorded against a release. */
    publishMode: 'artifact' | 'releaseNotes' | 'none';
  };
  github: {
    enterpriseUrl: string;
    /** OpenAI-compatible chat completions endpoint (GitHub Models / Copilot). */
    aiEndpoint: string;
    aiModel: string;
  };
  run: {
    workers: number;
    retries: number;
    headed: boolean;
    timeoutMs: number;
    /** Tags always added to a run, e.g. ["@smoke"]. */
    alwaysIncludeTags: string[];
  };
  server: { port: number };
}

export const DEFAULT_CONFIG: AppConfig = {
  environments: [{ name: 'Test', baseUrl: 'https://test.example.local', authMode: 'duende', octopusEnvironment: 'Test' }],
  defaultEnvironment: 'Test',
  testUser: { username: '' },
  login: {},
  jira: {
    baseUrl: '',
    deployment: 'datacenter',
    email: '',
    projectKey: '',
    bugIssueType: 'Bug',
    bugLabels: ['qa-automation'],
    acceptanceCriteriaField: '',
    componentTagMap: {},
  },
  octopus: { serverUrl: '', space: 'Spaces-1', publishMode: 'artifact' },
  github: {
    enterpriseUrl: '',
    aiEndpoint: 'https://models.github.ai/inference/chat/completions',
    aiModel: 'openai/gpt-4.1',
  },
  run: { workers: 2, retries: 1, headed: false, timeoutMs: 60_000, alwaysIncludeTags: ['@smoke'] },
  server: { port: 4870 },
};

/** Per-user data folder: %LOCALAPPDATA%\QaTool on Windows, ~/.qa-tool elsewhere. */
export function dataDir(): string {
  const dir =
    process.env.QA_DATA_DIR ??
    (process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'QaTool')
      : path.join(os.homedir(), '.qa-tool'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const runsDir = (): string => {
  const dir = path.join(dataDir(), 'runs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const configPath = (): string => path.join(dataDir(), 'config.json');

function deepMerge<T>(base: T, override: unknown): T {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return (override ?? base) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (override && typeof override === 'object') {
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      out[k] = k in out && typeof out[k] === 'object' && !Array.isArray(out[k]) && out[k] !== null ? deepMerge(out[k], v) : v;
    }
  }
  return out as T;
}

export function loadConfig(): AppConfig {
  try {
    return deepMerge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** Config holds no secrets: tokens and passwords live in the OS credential store (see secrets.ts). */
export function saveConfig(cfg: AppConfig): void {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

export function getEnvironment(cfg: AppConfig, name?: string): EnvironmentConfig {
  const wanted = name ?? cfg.defaultEnvironment;
  const env = cfg.environments.find((e) => e.name.toLowerCase() === wanted.toLowerCase());
  if (!env) throw new Error(`Unknown environment "${wanted}". Configure it in Settings.`);
  return env;
}

export const trimSlash = (u: string): string => u.replace(/\/+$/, '');
