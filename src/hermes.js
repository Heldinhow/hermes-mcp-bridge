import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HermesError, ToolError } from './errors.js';

const CONTRACT_TASK_FIELDS = ['task', 'context', 'deliverable', 'constraints'];
const ALLOWED_STATUSES = new Set(['done', 'blocked', 'needs_user', 'accepted']);
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const STATUS_ALIASES = new Map([
  ['completed', 'done'],
  ['complete', 'done'],
  ['success', 'done'],
  ['failed', 'blocked'],
  ['error', 'blocked'],
  ['cancelled', 'blocked'],
  ['canceled', 'blocked'],
  ['interrupted', 'blocked'],
  ['accepted', 'accepted'],
  ['needs_user', 'needs_user'],
  ['blocked', 'blocked'],
  ['done', 'done'],
]);

function truncate(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

function extractJson(text) {
  let candidate = text.trim().replace(/^\uFEFF/, '');
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1].trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function stringList(value, maxItems = 50, maxLength = 1000) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .slice(0, maxItems)
    .map((item) => truncate(item.trim(), maxLength));
}

function normalizeResult(parsed, id, extra = {}) {
  const rawStatus = typeof parsed?.status === 'string' ? parsed.status.trim() : '';
  let status;
  if (ALLOWED_STATUSES.has(rawStatus)) {
    status = rawStatus;
  } else if (STATUS_ALIASES.has(rawStatus)) {
    status = STATUS_ALIASES.get(rawStatus);
  } else if (parsed && (parsed.summary || parsed.artifacts)) {
    status = 'done';
  } else {
    status = 'blocked';
  }

  let summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
  if (!summary && typeof parsed?.message === 'string') summary = parsed.message.trim();
  if (!summary) {
    summary =
      status === 'done'
        ? 'Tarefa concluída pelo Hermes.'
        : 'Hermes não retornou um resumo utilizável.';
  }

  const result = {
    id,
    status,
    summary: truncate(summary, 4000),
    artifacts: stringList(parsed?.artifacts),
    next_steps: stringList(parsed?.next_steps),
  };
  if (typeof parsed?.details === 'string' && parsed.details.trim()) {
    result.details = truncate(parsed.details.trim(), 8000);
  }
  Object.assign(result, extra);
  return result;
}

export function generateTaskId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `gb-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

export function sessionIdFor(args, id, agentName = 'hermes') {
  // O agente faz parte do namespace: a mesma sessão lógica em agentes diferentes não colide.
  return args.session ? `gb-sess-${agentName}-${args.session}` : `agent-task-${id}`;
}

export function publicResult(result) {
  const output = {
    id: result.id,
    status: result.status,
    summary: result.summary,
    artifacts: result.artifacts,
    next_steps: result.next_steps,
  };
  if (result.run_id) output.run_id = result.run_id;
  return output;
}

export function createHermes(config, agents) {
  const registry = agents;
  const chains = new Map();

  function withSessionLock(key, fn) {
    const previous = chains.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    chains.set(key, current);
    return current.finally(() => {
      if (chains.get(key) === current) chains.delete(key);
    });
  }

  function readContract() {
    let text;
    try {
      text = fs.readFileSync(config.contractPath, 'utf8');
    } catch {
      throw new ToolError(
        'contract_unavailable',
        'Contrato do bridge não encontrado ou ilegível.',
      );
    }
    if (!text.trim()) {
      throw new ToolError('contract_empty', 'Contrato do bridge está vazio.');
    }
    return text;
  }

  function systemInstructions(contract) {
    return (
      `${contract}\n\n` +
      '--- INSTRUÇÕES DO BRIDGE MCP ---\n' +
      'Você está atendendo uma tarefa enviada por um agente cliente através do bridge MCP. ' +
      'Siga o contrato acima. Responda SOMENTE com um objeto JSON válido, sem markdown, ' +
      'sem texto antes ou depois, usando exatamente as chaves id, status, summary, ' +
      'artifacts, next_steps e, opcionalmente, details. ' +
      'Use status done, blocked ou needs_user. O campo id deve ser o id da tarefa recebida. ' +
      'Escreva summary em pt-BR. Artefatos devem ser caminhos absolutos existentes quando possível.'
    );
  }

  function defaultDest() {
    if (registry && typeof registry.client === 'function') {
      try {
        return registry.client(registry.defaultName());
      } catch {
        // Registro degradado sem chave do default: cai na config global (comportamento antigo).
      }
    }
    return { name: config.defaultAgentName || 'hermes', baseUrl: config.hermesUrl, key: config.hermesKey };
  }

  async function requestJson(
    route,
    { method = 'GET', body, headers = {}, timeoutMs = 30000, dest } = {},
  ) {
    const target = dest || defaultDest();
    const requestHeaders = {
      authorization: `Bearer ${target.key}`,
      accept: 'application/json',
      'content-type': 'application/json',
    };
    for (const [name, value] of Object.entries(headers || {})) {
      const key = name.toLowerCase();
      if (key === 'authorization' || key === 'accept' || key === 'content-type') continue;
      if (value === undefined || value === null) continue;
      requestHeaders[name] = String(value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetch(`${target.baseUrl}${route}`, {
          method,
          headers: requestHeaders,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (error) {
        if (error && error.name === 'AbortError') {
          throw new HermesError('hermes_timeout', 'Hermes API não respondeu dentro do limite.');
        }
        throw new HermesError('hermes_unreachable', 'Falha de comunicação com a Hermes API.');
      }

      let text = '';
      try {
        text = await response.text();
      } catch (error) {
        if (error && error.name === 'AbortError') {
          throw new HermesError('hermes_timeout', 'Hermes API não respondeu dentro do limite.');
        }
        throw new HermesError('hermes_read_error', 'Falha ao ler a resposta da Hermes API.');
      }
      if (text.length > config.maxUpstreamBytes) {
        throw new HermesError(
          'hermes_response_too_large',
          'Resposta da Hermes API muito grande.',
        );
      }

      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          if (response.ok) {
            throw new HermesError('hermes_invalid_json', 'Hermes API retornou JSON inválido.');
          }
        }
      }

      if (!response.ok) {
        let code = `http_${response.status}`;
        if (data && typeof data === 'object') {
          const upstreamCode =
            data?.error?.code || data?.error?.type || data?.code || data?.error;
          if (typeof upstreamCode === 'string') code = upstreamCode;
        }
        throw new HermesError(
          truncate(code, 80),
          `Hermes API respondeu HTTP ${response.status}.`,
          response.status,
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function resultPath(id) {
    return path.join(config.tasksDir, id, 'result.json');
  }

  function persistResult(id, result, { onlyIfAbsent = false } = {}) {
    const dir = path.join(config.tasksDir, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    const target = resultPath(id);
    if (onlyIfAbsent && fs.existsSync(target)) return target;
    const tmp = path.join(
      dir,
      `.result.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
    fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });
    try {
      fs.chmodSync(tmp, 0o644);
    } catch {
      // Best effort; the rename below is what matters.
    }
    fs.renameSync(tmp, target);
    return target;
  }

  function persistSafe(id, result, options = {}) {
    try {
      persistResult(id, result, options);
    } catch (error) {
      const code = error && error.code ? error.code : 'unknown';
      console.error(`[bridge] could not persist result.json for ${id}: ${code}`);
      result.next_steps = [
        ...(Array.isArray(result.next_steps) ? result.next_steps : []),
        'Aviso: falha ao gravar result.json; use a resposta imediata desta chamada.',
      ];
    }
    return result;
  }

  function persistRunRecord(id, record) {
    const dir = path.join(config.tasksDir, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    const target = path.join(dir, 'run.json');
    const tmp = path.join(
      dir,
      `.run.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
    try {
      fs.chmodSync(tmp, 0o644);
    } catch {
      // Best effort; the rename below is what matters.
    }
    fs.renameSync(tmp, target);
    return target;
  }

  function persistRunRecordSafe(id, record) {
    try {
      persistRunRecord(id, record);
    } catch (error) {
      const code = error && error.code ? error.code : 'unknown';
      console.error(`[bridge] could not persist run.json for ${id}: ${code}`);
    }
  }

  function buildTaskPayload(args, id) {
    const payload = { id, task: args.task };
    for (const field of CONTRACT_TASK_FIELDS.slice(1)) {
      if (args[field] !== undefined) payload[field] = args[field];
    }
    payload.reply_language = 'pt-BR';
    payload.mode = args.mode;
    return payload;
  }

  function blockedResult(id, summary, extra = {}) {
    return {
      id,
      status: 'blocked',
      summary,
      artifacts: [],
      next_steps: [],
      ...extra,
    };
  }

  async function task(args) {
    const contract = readContract();
    const instructions = systemInstructions(contract);
    const agentName = args.agent || (registry ? registry.defaultName() : config.defaultAgentName || 'hermes');
    // resolve() lança unknown_agent / agent_unavailable antes de qualquer chamada upstream.
    const dest = registry && typeof registry.client === 'function' ? registry.client(agentName) : defaultDest();
    const id = args.id || generateTaskId();
    const payload = buildTaskPayload(args, id);
    const sessionId = sessionIdFor(args, id, dest.name);

    if (args.id && args.mode === 'async') assertNoDuplicateId(id, dest.name);

    if (args.mode === 'async') {
      let runId;
      try {
        const data = await withSessionLock(sessionId, () =>
          requestJson('/v1/runs', {
            method: 'POST',
            timeoutMs: Math.min(config.hermesTimeoutMs, 60000),
            headers: { 'Idempotency-Key': id },
            dest,
            body: {
              input: JSON.stringify(payload),
              instructions,
              session_id: sessionId,
            },
          }),
        );
        runId = data && typeof data.run_id === 'string' ? data.run_id : undefined;
        if (!runId) {
          throw new HermesError('hermes_missing_run_id', 'Hermes não retornou run_id.');
        }
      } catch (error) {
        if (!(error instanceof HermesError)) throw error;
        const result = blockedResult(
          id,
          `Não foi possível iniciar a tarefa assíncrona: ${error.message}`,
        );
        persistSafe(id, result);
        return publicResult(result);
      }

      persistRunRecordSafe(id, {
        run_id: runId,
        session_id: sessionId,
        task_id: id,
        agent: dest.name,
        agent_base_url: dest.baseUrl,
        created_at: new Date().toISOString(),
      });

      const result = {
        id,
        status: 'accepted',
        summary: `Tarefa aceita pelo Hermes. Acompanhe pelo run_id ${runId}.`,
        artifacts: [],
        next_steps: [
          'Use hermes_status com o run_id para acompanhar a execução.',
          `Ao terminar, use hermes_result com id ${id} para ler o resultado durável.`,
        ],
        run_id: runId,
      };
      // Registra o ack accepted apenas se ainda não houver um result.json (evita corrida
      // com o resultado final que o Hermes grava ao terminar a run).
      persistSafe(id, result, { onlyIfAbsent: true });
      return publicResult(result);
    }

    let parsed = null;
    let text = '';
    try {
      const request = () =>
        requestJson('/v1/chat/completions', {
          method: 'POST',
          timeoutMs: config.hermesTimeoutMs,
          headers: args.session ? { 'X-Hermes-Session-Id': sessionId } : undefined,
          dest,
          body: {
            messages: [
              { role: 'system', content: instructions },
              { role: 'user', content: JSON.stringify(payload) },
            ],
            stream: false,
          },
        });
      const data = args.session ? await withSessionLock(sessionId, request) : await request();
      text = normalizeContent(data?.choices?.[0]?.message?.content);
      if (text) parsed = extractJson(text);
    } catch (error) {
      if (!(error instanceof HermesError)) throw error;
      const result = blockedResult(id, `A tarefa não foi executada: ${error.message}`);
      persistSafe(id, result);
      return publicResult(result);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const result = blockedResult(
        id,
        'Hermes respondeu fora do formato JSON exigido pelo contrato; resultado não utilizável.',
      );
      if (text) result.details = truncate(text, 4000);
      persistSafe(id, result);
      return publicResult(result);
    }

    const result = normalizeResult(parsed, id);
    persistSafe(id, result);
    return publicResult(result);
  }

  function findRunRecord(runId) {
    let entries;
    try {
      entries = fs.readdirSync(config.tasksDir, { withFileTypes: true });
    } catch (error) {
      const code = error && error.code ? error.code : 'unknown';
      console.error(`[bridge] could not scan tasks dir for run ${runId}: ${code}`);
      return undefined;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const recordPath = path.join(config.tasksDir, entry.name, 'run.json');
      let record;
      try {
        record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      } catch (error) {
        const code = error && error.code ? error.code : 'invalid-json';
        if (code !== 'ENOENT') {
          console.error(`[bridge] ignoring ${entry.name}/run.json: ${code}`);
        }
        continue;
      }
      if (
        record &&
        typeof record === 'object' &&
        record.run_id === runId &&
        typeof record.task_id === 'string' &&
        TASK_ID_PATTERN.test(record.task_id)
      ) {
        return record;
      }
    }
    return undefined;
  }

  function findTaskIdByRunId(runId) {
    const record = findRunRecord(runId);
    return record ? record.task_id : undefined;
  }

  // Um id de tarefa pertence a um único agente: o mesmo id em outro agente é recusado.
  function assertNoDuplicateId(id, agentName) {
    const recordPath = path.join(config.tasksDir, id, 'run.json');
    let record;
    try {
      record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    } catch {
      return;
    }
    if (record && typeof record.agent === 'string' && record.agent !== agentName) {
      throw new ToolError(
        'duplicate_id',
        `Tarefa ${id} já foi aceita pelo agente ${record.agent}; use outro id para ${agentName}.`,
      );
    }
  }

  async function status(runId, agentName) {
    const record = findRunRecord(runId);
    const name =
      agentName ||
      (record && typeof record.agent === 'string' ? record.agent : undefined) ||
      (registry ? registry.defaultName() : config.defaultAgentName || 'hermes');
    const dest = registry && typeof registry.client === 'function' ? registry.client(name) : defaultDest();
    const data = await requestJson(`/v1/runs/${encodeURIComponent(runId)}`, {
      timeoutMs: 30000,
      dest,
    });
    if (!data || typeof data !== 'object') {
      throw new HermesError('hermes_invalid_status', 'Hermes retornou status inválido.');
    }
    const output = {
      run_id: typeof data.run_id === 'string' ? data.run_id : runId,
      status: typeof data.status === 'string' ? data.status : 'unknown',
      agent: dest.name,
    };
    if (agentName && record && typeof record.agent === 'string' && record.agent !== agentName) {
      output.agent_mismatch = `run pertence ao agente ${record.agent}`;
    }
    for (const field of [
      'completed',
      'partial',
      'interrupted',
      'created_at',
      'updated_at',
      'error',
      'last_event',
    ]) {
      if (data[field] !== undefined) output[field] = data[field];
    }

    let taskId = findTaskIdByRunId(runId);
    if (!taskId && typeof data.session_id === 'string') {
      const match = /^agent-task-(.+)$/.exec(data.session_id);
      if (match && TASK_ID_PATTERN.test(match[1])) taskId = match[1];
    }
    if (taskId && TERMINAL_RUN_STATUSES.has(output.status)) {
      try {
        let parsed = null;
        if (data.output && typeof data.output === 'object') {
          parsed = data.output;
        } else if (typeof data.output === 'string' && data.output.trim()) {
          parsed = extractJson(data.output);
          if (!parsed) {
            parsed = {
              status: output.status === 'completed' ? 'done' : 'blocked',
              summary: data.output.trim().slice(0, 4000),
            };
          }
        }
        if (!parsed) {
          parsed = {
            status: output.status === 'completed' ? 'done' : 'blocked',
            summary:
              typeof data.error === 'string'
                ? data.error
                : `Run ${output.status} sem output utilizável.`,
          };
        }
        const durable = normalizeResult(parsed, taskId);
        if (output.status !== 'completed' && !['blocked', 'needs_user'].includes(durable.status)) {
          durable.status = 'blocked';
        }
        persistResult(taskId, durable);
        output.task_id = taskId;
        output.result_updated = true;
      } catch (error) {
        const code = error && error.code ? error.code : 'unknown';
        console.error(`[bridge] could not persist run result for ${taskId}: ${code}`);
      }
    }

    if (data.output !== undefined) {
      const serialized = typeof data.output === 'string' ? data.output : JSON.stringify(data.output);
      if (serialized && serialized.length > 200000) {
        output.output_truncated = true;
        output.output = serialized.slice(0, 200000);
      } else {
        output.output = data.output;
      }
    }
    return output;
  }

  return { task, status, readContract, resultPath };
}
