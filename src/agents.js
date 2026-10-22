import fs from 'node:fs';
import net from 'node:net';

import { ToolError } from './errors.js';

// Agent registry: ~/.hermes/agents.yaml (0600), flat schema, no includes.
// Nenhuma chave vive no yaml: só `key_env` (nome da variável) ou `key_file` (arquivo 0600).

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED_NAMES = new Set(['default', 'all']);
const KINDS = new Set(['local', 'remote']);
const HEALTH_CACHE_MS = 30000;
const HEALTH_TIMEOUT_MS = 2500;

function parseScalar(raw) {
  const value = raw.trim();
  if (!value) return '';
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseScalar(item));
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

// Parser YAML mínimo e restrito ao schema do registro: chaves de topo escalares, uma lista
// `agents` de mapas planos com escalares e listas inline. Qualquer outra forma é erro.
export function parseRegistryYaml(text) {
  const result = {};
  let items;
  let current;
  let itemIndent = -1;

  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const lineNo = index + 1;
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (raw.includes('\t')) {
      throw new Error(`linha ${lineNo}: tab não é permitido, use espaços`);
    }
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      const match = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
      if (!match) throw new Error(`linha ${lineNo}: esperado "chave: valor" no nível raiz`);
      const [, key, rest] = match;
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        throw new Error(`linha ${lineNo}: chave duplicada "${key}"`);
      }
      if (!rest.trim()) {
        items = [];
        result[key] = items;
        current = undefined;
        itemIndent = -1;
      } else {
        if (key === 'agents') throw new Error(`linha ${lineNo}: agents deve ser uma lista`);
        items = undefined;
        result[key] = parseScalar(rest);
      }
      continue;
    }

    if (!items) {
      throw new Error(`linha ${lineNo}: indentação sem lista aberta`);
    }

    if (line.startsWith('- ') || line === '-') {
      current = {};
      items.push(current);
      itemIndent = indent;
      const rest = line === '-' ? '' : line.slice(2).trim();
      if (rest) {
        const match = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(rest);
        if (!match) throw new Error(`linha ${lineNo}: item de lista deve começar com "chave: valor"`);
        current[match[1]] = parseScalar(match[2]);
      }
      continue;
    }

    if (!current) throw new Error(`linha ${lineNo}: propriedade sem item de lista`);
    if (indent <= itemIndent) {
      throw new Error(`linha ${lineNo}: indentação de propriedade inválida`);
    }
    const match = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!match) throw new Error(`linha ${lineNo}: esperado "chave: valor"`);
    const [, key, rest] = match;
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      throw new Error(`linha ${lineNo}: propriedade duplicada "${key}"`);
    }
    current[key] = parseScalar(rest);
  }

  return result;
}

function isLoopbackOrTailscale(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(host)) {
    if (host.startsWith('127.')) return true;
    const [a, b] = host.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10 (Tailscale/CGNAT)
  }
  if (net.isIPv6(host)) {
    if (host === '::1') return true;
    // Faixa Tailscale IPv6 (fd7a:115c:a1e0::/48).
    return host.startsWith('fd7a:115c:a1e0:');
  }
  return host === 'localhost';
}

export function validateEndpoint(rawUrl, kind, name) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`agente ${name}: base_url inválida`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`agente ${name}: base_url precisa ser http ou https`);
  }
  if (url.username || url.password) {
    throw new Error(`agente ${name}: base_url não pode conter credenciais`);
  }
  // Perfis servidos pelo multiplexer do gateway vivem em /p/<perfil>/v1 no listener compartilhado.
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname && !/^\/[A-Za-z0-9._~\-/]*$/.test(pathname)) {
    throw new Error(`agente ${name}: base_url com caminho inválido`);
  }
  if (pathname.includes('..')) {
    throw new Error(`agente ${name}: base_url com caminho inválido`);
  }
  if (kind === 'local' && url.protocol !== 'http:') {
    throw new Error(`agente ${name}: agente local usa http`);
  }
  if (!isLoopbackOrTailscale(url.hostname)) {
    throw new Error(`agente ${name}: base_url fora de loopback/Tailscale`);
  }
  return `${url.protocol}//${url.host}${pathname}`;
}

function normalizeAgent(raw, index, env, config) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`agents[${index}]: item precisa ser um mapa`);
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error(`agents[${index}]: name inválido (^[a-z][a-z0-9_-]{0,31}$)`);
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`agente ${name}: nome reservado`);
  }
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : 'local';
  if (!KINDS.has(kind)) {
    throw new Error(`agente ${name}: kind precisa ser local ou remote`);
  }
  const profile = typeof raw.profile === 'string' ? raw.profile.trim() : undefined;
  if (kind === 'local' && !profile) {
    throw new Error(`agente ${name}: kind local exige profile`);
  }
  const rawBaseUrl = typeof raw.base_url === 'string' ? raw.base_url.trim() : '';
  const fallbackBaseUrl = name === config.defaultAgentName ? config.hermesUrl : undefined;
  if (!rawBaseUrl && !fallbackBaseUrl) {
    throw new Error(`agente ${name}: base_url é obrigatória`);
  }
  const baseUrl = validateEndpoint(rawBaseUrl || fallbackBaseUrl, kind, name);

  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities
        .filter((item) => typeof item === 'string' && item.trim())
        .slice(0, 32)
        .map((item) => item.trim())
    : [];
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';

  const keyEnv = typeof raw.key_env === 'string' ? raw.key_env.trim() : '';
  const keyFile = typeof raw.key_file === 'string' ? raw.key_file.trim() : '';
  if (!keyEnv && !keyFile) {
    throw new Error(`agente ${name}: informe key_env ou key_file`);
  }
  if (keyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) {
    throw new Error(`agente ${name}: key_env inválido`);
  }

  let key;
  if (keyEnv) {
    const value = env(keyEnv);
    if (typeof value === 'string' && value.trim()) key = value.trim();
  } else {
    try {
      const stat = fs.statSync(keyFile);
      if (stat.isFile() && stat.size <= 4096) {
        key = fs.readFileSync(keyFile, 'utf8').trim() || undefined;
      }
    } catch {
      key = undefined;
    }
  }

  return {
    name,
    description,
    capabilities,
    kind,
    profile,
    baseUrl,
    keyEnv: keyEnv || undefined,
    keyFile: keyFile || undefined,
    key,
    available: Boolean(key),
    unavailableReason: key ? undefined : 'missing_credentials',
  };
}

function validateRegistry(parsed, env, config) {
  if (!parsed || typeof parsed !== 'object') throw new Error('registro vazio');
  if (parsed.version !== 1) throw new Error('version precisa ser 1');
  const list = parsed.agents;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('agents precisa ser uma lista não vazia');
  }
  if (list.length > 64) throw new Error('agents aceita no máximo 64 itens');

  const agents = new Map();
  for (const [index, raw] of list.entries()) {
    const agent = normalizeAgent(raw, index, env, config);
    if (agents.has(agent.name)) throw new Error(`agente duplicado: ${agent.name}`);
    agents.set(agent.name, agent);
  }

  const defaultName =
    typeof parsed.default === 'string' ? parsed.default.trim() : config.defaultAgentName;
  if (!AGENT_NAME_PATTERN.test(defaultName)) throw new Error('default inválido');
  if (!agents.has(defaultName)) {
    throw new Error(`default aponta para agente inexistente: ${defaultName}`);
  }

  return { version: 1, defaultName, agents };
}

function syntheticRegistry(config) {
  const agent = {
    name: config.defaultAgentName,
    description: 'Hermes principal (perfil default).',
    capabilities: [],
    kind: 'local',
    profile: 'default',
    baseUrl: config.hermesUrl,
    key: config.hermesKey,
    available: Boolean(config.hermesKey),
    unavailableReason: config.hermesKey ? undefined : 'missing_credentials',
  };
  return {
    version: 1,
    defaultName: agent.name,
    agents: new Map([[agent.name, agent]]),
    degraded: 'no_registry',
  };
}

export function createAgents(config) {
  const envLookup =
    typeof config.envLookup === 'function' ? config.envLookup : (name) => process.env[name];
  const healthCache = new Map();
  let state = { registry: syntheticRegistry(config), mtimeMs: -1, error: null };

  function reloadIfChanged() {
    let stat;
    try {
      stat = fs.statSync(config.agentsFile);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        state = { registry: syntheticRegistry(config), mtimeMs: -1, error: null };
        return state;
      }
      console.error(
        '[bridge] agents registry stat failed:',
        error && error.code ? error.code : 'unknown',
      );
      return state;
    }
    if (stat.mtimeMs === state.mtimeMs) return state;
    try {
      const text = fs.readFileSync(config.agentsFile, 'utf8');
      const registry = validateRegistry(parseRegistryYaml(text), envLookup, config);
      state = { registry, mtimeMs: stat.mtimeMs, error: null };
      console.log(
        `[bridge] agents registry loaded: ${registry.agents.size} agent(s), default=${registry.defaultName}`,
      );
    } catch (error) {
      // yaml inválido: mantém o último estado bom (ou o sintético) e reporta em /health.
      state = { ...state, mtimeMs: stat.mtimeMs, error: error.message || 'invalid_registry' };
      console.error(`[bridge] agents registry invalid, keeping previous state: ${state.error}`);
    }
    return state;
  }

  async function probe(agent) {
    if (!agent.key) return { ok: false, reason: 'missing_credentials' };
    const cached = healthCache.get(agent.name);
    const now = Date.now();
    if (cached && now - cached.at < HEALTH_CACHE_MS && cached.baseUrl === agent.baseUrl) {
      return cached.result;
    }
    let result;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(`${agent.baseUrl}/health`, {
          method: 'GET',
          headers: { authorization: `Bearer ${agent.key}`, accept: 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      result = response.ok ? { ok: true } : { ok: false, reason: 'unhealthy' };
    } catch {
      result = { ok: false, reason: 'unreachable' };
    }
    healthCache.set(agent.name, { at: now, baseUrl: agent.baseUrl, result });
    return result;
  }

  function current() {
    return reloadIfChanged();
  }

  function client(name) {
    const { registry } = current();
    const agent = registry.agents.get(name);
    if (!agent) {
      throw new ToolError(
        'unknown_agent',
        `Agente não registrado: ${name}. Use list_agents para ver os disponíveis.`,
      );
    }
    if (!agent.key) {
      throw new ToolError('agent_unavailable', `Agente ${name} sem credencial configurada.`);
    }
    return { name: agent.name, baseUrl: agent.baseUrl, key: agent.key };
  }

  async function listPublic() {
    const { registry, error } = current();
    const agents = [...registry.agents.values()];
    const probes = await Promise.all(agents.map((agent) => probe(agent)));
    const items = agents.map((agent, index) => {
      const item = {
        name: agent.name,
        description: agent.description,
        capabilities: agent.capabilities,
        kind: agent.kind,
        available: probes[index].ok,
        default: agent.name === registry.defaultName,
      };
      if (agent.kind === 'local' && agent.profile) item.local_profile = agent.profile;
      if (!probes[index].ok && probes[index].reason) item.unavailable_reason = probes[index].reason;
      return item;
    });
    const output = { agents: items, default: registry.defaultName, count: items.length };
    if (registry.degraded) output.degraded = registry.degraded;
    if (error) output.registry_error = error;
    return output;
  }

  function summary() {
    const { registry, error } = current();
    const output = {
      default: registry.defaultName,
      count: registry.agents.size,
      available: [...registry.agents.values()].filter((agent) => agent.key).length,
    };
    if (registry.degraded) output.degraded = registry.degraded;
    if (error) output.registry_error = error;
    return output;
  }

  function defaultName() {
    return current().registry.defaultName;
  }

  return { client, listPublic, summary, defaultName, current };
}
