import { Entry } from '@napi-rs/keyring';

/**
 * Secrets are stored in the OS credential store of the signed-in tester
 * (Windows Credential Manager / macOS Keychain), never in config files,
 * never in run output, and never sent to the browser UI.
 *
 * For unattended use, each secret can also come from an environment variable.
 */
export const SECRET_NAMES = ['jiraToken', 'octopusApiKey', 'githubToken', 'testUserPassword'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const ENV_FALLBACK: Record<SecretName, string> = {
  jiraToken: 'QA_JIRA_TOKEN',
  octopusApiKey: 'QA_OCTOPUS_API_KEY',
  githubToken: 'QA_GITHUB_TOKEN',
  testUserPassword: 'QA_TEST_USER_PASSWORD',
};

const SERVICE = 'qa-automation-tool';
const entry = (name: SecretName) => new Entry(SERVICE, name);

export function isSecretName(n: string): n is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(n);
}

export function getSecret(name: SecretName): string | undefined {
  const fromEnv = process.env[ENV_FALLBACK[name]];
  if (fromEnv) return fromEnv;
  try {
    return entry(name).getPassword() ?? undefined;
  } catch {
    return undefined;
  }
}

export function requireSecret(name: SecretName): string {
  const v = getSecret(name);
  if (!v) throw new Error(`Secret "${name}" is not set. Add it in Settings (or set ${ENV_FALLBACK[name]}).`);
  return v;
}

export function setSecret(name: SecretName, value: string): void {
  if (value === '') {
    try {
      entry(name).deletePassword();
    } catch {
      /* already absent */
    }
    return;
  }
  entry(name).setPassword(value);
}

/** Only reports whether each secret is present. Values are never returned. */
export function secretStatus(): Record<SecretName, boolean> {
  return Object.fromEntries(SECRET_NAMES.map((n) => [n, Boolean(getSecret(n))])) as Record<SecretName, boolean>;
}

/** Removes any secret values from text before it is logged or written to a report. */
export function redact(text: string): string {
  let out = text;
  for (const n of SECRET_NAMES) {
    const v = getSecret(n);
    if (v && v.length >= 4) out = out.split(v).join('***');
  }
  return out;
}
