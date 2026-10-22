import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function positiveInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}`);
  }
  return parsed;
}

function resolveMaybeRelative(value, fallback) {
  const chosen = value || fallback;
  return path.isAbsolute(chosen) ? chosen : path.resolve(ROOT, chosen);
}

function hostForUrl(host) {
  const clean = host.trim();
  if (!clean || clean === '0.0.0.0' || clean === '::' || clean === '[::]') {
    return '127.0.0.1';
  }
  if (clean.includes(':') && !clean.startsWith('[')) return `[${clean}]`;
  return clean;
}

export function loadConfig() {
  const envPath = resolveMaybeRelative(process.env.BRIDGE_ENV_PATH, '.env');
  const env = { ...parseEnvFile(envPath), ...process.env };

  const token = env.MCP_AUTH_TOKEN;
  if (!token || token.length < 48) {
    throw new Error(
      'MCP_AUTH_TOKEN missing or shorter than 48 characters; run node scripts/gen-token.mjs',
    );
  }

  const port = positiveInt(env.MCP_PORT, 8765, 'MCP_PORT');
  if (port > 65535) throw new Error('Invalid MCP_PORT');

  const hermesEnvPath = resolveMaybeRelative(
    env.HERMES_ENV_PATH,
    path.join(os.homedir(), '.hermes', '.env'),
  );
  const hermesEnv = parseEnvFile(hermesEnvPath);
  const hermesKey = hermesEnv.API_SERVER_KEY;
  if (!hermesKey) {
    throw new Error(`API_SERVER_KEY not found in ${hermesEnvPath}`);
  }
  const hermesHost = hermesEnv.API_SERVER_HOST || '127.0.0.1';
  const hermesPort = positiveInt(hermesEnv.API_SERVER_PORT, 8642, 'API_SERVER_PORT');
  const hermesUrl = `http://${hostForUrl(hermesHost)}:${hermesPort}`;

  // Chaves de agentes vêm só de variável de ambiente ou de arquivo 0600 já carregado aqui:
  // process.env → .env da bridge → .env do Hermes. O registro guarda apenas o NOME da variável.
  const envLookup = (name) => {
    for (const source of [process.env, env, hermesEnv]) {
      const value = source[name];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };

  const agentsFile = resolveMaybeRelative(env.AGENTS_FILE, path.join(os.homedir(), '.hermes', 'agents.yaml'));
  const tasksDir = resolveMaybeRelative(env.TASKS_DIR, path.join(os.homedir(), 'bridge-tasks'));
  const contractPath = resolveMaybeRelative(
    env.HERMES_CONTRACT_PATH,
    path.join(os.homedir(), '.hermes', 'mcp-bridge-contract.md'),
  );

  return {
    root: ROOT,
    envPath,
    port,
    token,
    hermesEnvPath,
    hermesUrl,
    hermesKey,
    defaultAgentName: 'hermes',
    agentsFile,
    envLookup,
    tasksDir,
    contractPath,
    auditLog: resolveMaybeRelative(env.AUDIT_LOG, 'logs/audit.log'),
    publicUrlFile: resolveMaybeRelative(env.PUBLIC_URL_FILE, 'PUBLIC_URL'),
    rateLimitPerMin: positiveInt(env.RATE_LIMIT_PER_MIN, 30, 'RATE_LIMIT_PER_MIN'),
    maxBodyBytes: positiveInt(env.MAX_BODY_BYTES, 256 * 1024, 'MAX_BODY_BYTES'),
    maxFileBytes: positiveInt(env.MAX_FILE_BYTES, 200 * 1024, 'MAX_FILE_BYTES'),
    maxResultBytes: positiveInt(env.MAX_RESULT_BYTES, 1024 * 1024, 'MAX_RESULT_BYTES'),
    maxUpstreamBytes: positiveInt(
      env.MAX_UPSTREAM_BYTES,
      8 * 1024 * 1024,
      'MAX_UPSTREAM_BYTES',
    ),
    hermesTimeoutMs: positiveInt(env.HERMES_TIMEOUT_MS, 120000, 'HERMES_TIMEOUT_MS'),
  };
}
