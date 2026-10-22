import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from './errors.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const AGENT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export const TOOLS = [
  {
    name: 'hermes_task',
    description:
      'Send a task to the local Hermes agent. mode=sync waits and returns the contract result; ' +
      'mode=async starts a background run and returns a run_id. The bridge contract is injected ' +
      'as system instructions. Returns {id,status,summary,artifacts,next_steps,run_id?}.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What Hermes should do (required).' },
        context: { type: 'string', description: 'Relevant background, paths, or links.' },
        deliverable: { type: 'string', description: 'What to deliver and in which format.' },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description: 'Hard constraints, e.g. never send applications or delete anything.',
        },
        mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description: 'sync waits for the result; async returns immediately with a run_id.',
        },
        id: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
          description: 'Optional task id. Generated as gb-YYYYMMDD-HHMMSS-xxxx when omitted.',
        },
        session: {
          type: 'string',
          pattern: '^[a-z0-9][a-z0-9._-]{0,63}$',
          description:
            'Optional session name to reuse Hermes conversation state across tasks ' +
            '(max 64 chars, lowercase). Omit it to keep the task isolated.',
        },
        agent: {
          type: 'string',
          pattern: '^[a-z][a-z0-9_-]{0,31}$',
          description:
            'Optional target agent name from list_agents. Omit to use the registry default.',
        },
      },
      required: ['task', 'mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'hermes_status',
    description:
      'Poll the status of an asynchronous Hermes run by run_id. Terminal statuses are ' +
      'completed, failed, cancelled, or interrupted. The durable result is in hermes_result.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          pattern: '^[A-Za-z0-9_-]{1,128}$',
          description: 'The run_id returned by hermes_task with mode=async.',
        },
        agent: {
          type: 'string',
          pattern: '^[a-z][a-z0-9_-]{0,31}$',
          description:
            'Optional agent name. Omit to use the agent recorded in the task run.json.',
        },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_agents',
    description:
      'List the agents registered for this bridge (read-only, no side effects). Each entry has ' +
      'name, description, capabilities, kind, available and default. Never includes credentials.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'hermes_result',
    description:
      'Read the durable result.json for a task id from the tasks directory (<id>/result.json). ' +
      'This file is the source of truth after a run leaves the Hermes API.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
          description: 'Task id used in hermes_task.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'hermes_files',
    description:
      'Read-only access inside the tasks directory (<id>/). Omit path to list the task tree. ' +
      'Pass a relative file path to read a UTF-8 text file up to 200 KiB, or a directory path ' +
      'to list it. Symlinks, absolute paths, and path traversal are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
          description: 'Task id whose directory should be inspected.',
        },
        path: {
          type: 'string',
          description: 'Optional relative path inside the task directory. Omit to list the root.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

function assertArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolError('invalid_arguments', 'arguments deve ser um objeto.');
  }
}

function rejectExtra(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new ToolError('invalid_arguments', `Campo não suportado: ${key}`);
    }
  }
}

function requireString(args, name, { max, optional = false, pattern } = {}) {
  const value = args[name];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new ToolError('invalid_arguments', `Campo obrigatório ausente: ${name}`);
  }
  if (typeof value !== 'string') {
    throw new ToolError('invalid_arguments', `Campo ${name} deve ser string.`);
  }
  const trimmed = value.trim();
  if (!trimmed && !optional) {
    throw new ToolError('invalid_arguments', `Campo ${name} não pode ser vazio.`);
  }
  if (max && value.length > max) {
    throw new ToolError('invalid_arguments', `Campo ${name} excede ${max} caracteres.`);
  }
  if (pattern && !pattern.test(trimmed)) {
    throw new ToolError('invalid_arguments', `Campo ${name} tem formato inválido.`);
  }
  return optional && !trimmed ? undefined : trimmed;
}

function validateId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new ToolError('invalid_id', 'id de tarefa inválido.');
  }
  return id;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveTaskBase(config, id) {
  validateId(id);
  let rootReal;
  try {
    rootReal = fs.realpathSync(config.tasksDir);
  } catch {
    throw new ToolError('tasks_unavailable', 'Diretório de tarefas não existe.');
  }
  const base = path.join(rootReal, id);
  let baseReal;
  try {
    baseReal = fs.realpathSync(base);
  } catch {
    throw new ToolError('task_not_found', `Tarefa não encontrada: ${id}`);
  }
  if (!isInside(rootReal, baseReal)) {
    throw new ToolError('invalid_path', 'Diretório da tarefa fora da raiz permitida.');
  }
  return { base: baseReal, root: rootReal };
}

function resolveInside(base, relativePath) {
  if (typeof relativePath !== 'string') {
    throw new ToolError('invalid_path', 'path deve ser string.');
  }
  const raw = relativePath.trim();
  if (!raw) return base;
  if (raw.length > 1024) throw new ToolError('invalid_path', 'path muito longo.');
  if (raw.includes('\0') || raw.includes('\\') || path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new ToolError('invalid_path', 'path deve ser relativo e sem caracteres proibidos.');
  }
  const segments = raw.split('/');
  if (segments.includes('..')) {
    throw new ToolError('invalid_path', 'path traversal não é permitido.');
  }
  const candidate = path.resolve(base, raw);
  if (candidate !== base && !isInside(base, candidate)) {
    throw new ToolError('invalid_path', 'path fora do diretório da tarefa.');
  }
  return candidate;
}

function entryInfo(fullPath, relativePath) {
  const stat = fs.lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    return { path: relativePath, type: 'symlink', size: 0 };
  }
  if (stat.isDirectory()) {
    return { path: relativePath, type: 'dir', size: 0, mtime: stat.mtime.toISOString() };
  }
  if (stat.isFile()) {
    return {
      path: relativePath,
      type: 'file',
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  }
  return null;
}

function listTree(root, { maxEntries = 1000, maxDepth = 5 } = {}) {
  const entries = [];
  const stack = [{ dir: root, relative: '', depth: 0 }];
  let truncated = false;

  while (stack.length) {
    const current = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      const full = path.join(current.dir, dirent.name);
      const relative = current.relative ? `${current.relative}/${dirent.name}` : dirent.name;
      let info;
      try {
        info = entryInfo(full, relative);
      } catch {
        continue;
      }
      if (!info) continue;
      entries.push(info);
      if (info.type === 'dir' && current.depth < maxDepth) {
        stack.push({ dir: full, relative, depth: current.depth + 1 });
      }
    }
    if (truncated) break;
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, truncated };
}

async function readTextFile(fullPath, maxBytes) {
  let handle;
  try {
    handle = await fs.promises.open(
      fullPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new ToolError('not_a_file', 'O caminho não é um arquivo regular.');
    }
    if (stat.size > maxBytes) {
      throw new ToolError(
        'file_too_large',
        `Arquivo tem ${stat.size} bytes; limite é ${maxBytes} bytes.`,
      );
    }
    const buffer = await handle.readFile();
    if (buffer.length > maxBytes) {
      throw new ToolError('file_too_large', `Arquivo excede ${maxBytes} bytes.`);
    }
    if (buffer.includes(0)) {
      throw new ToolError('binary_file', 'Arquivo binário não é suportado.');
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new ToolError('invalid_utf8', 'Arquivo não é UTF-8 válido.');
    }
    return { text, size: buffer.length, mtime: stat.mtime.toISOString() };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export function createToolHandlers(config, hermes, agents) {
  async function hermesTask(args) {
    assertArgs(args);
    rejectExtra(args, [
      'task',
      'context',
      'deliverable',
      'constraints',
      'mode',
      'id',
      'session',
      'agent',
    ]);
    const task = requireString(args, 'task', { max: 20000 });
    const context = requireString(args, 'context', { max: 100000, optional: true });
    const deliverable = requireString(args, 'deliverable', { max: 10000, optional: true });
    const mode = requireString(args, 'mode');
    if (mode !== 'sync' && mode !== 'async') {
      throw new ToolError('invalid_arguments', 'mode deve ser sync ou async.');
    }
    let constraints;
    if (args.constraints !== undefined) {
      if (!Array.isArray(args.constraints)) {
        throw new ToolError('invalid_arguments', 'constraints deve ser um array de strings.');
      }
      if (args.constraints.length > 20) {
        throw new ToolError('invalid_arguments', 'constraints aceita no máximo 20 itens.');
      }
      constraints = [];
      for (const item of args.constraints) {
        if (typeof item !== 'string' || item.length > 2000) {
          throw new ToolError(
            'invalid_arguments',
            'Cada constraint deve ser string de até 2000 caracteres.',
          );
        }
        if (item.trim()) constraints.push(item.trim());
      }
    }
    let id;
    if (args.id !== undefined) {
      if (typeof args.id !== 'string' || !ID_PATTERN.test(args.id)) {
        throw new ToolError('invalid_id', 'id de tarefa inválido.');
      }
      id = args.id;
    }
    let session;
    if (args.session !== undefined) {
      session = requireString(args, 'session', {
        max: 64,
        optional: true,
        pattern: SESSION_PATTERN,
      });
      if (session === undefined) {
        throw new ToolError('invalid_arguments', 'Campo session não pode ser vazio.');
      }
      if (session.startsWith('agent-task-')) {
        throw new ToolError(
          'invalid_arguments',
          'Campo session usa um prefixo reservado (agent-task-).',
        );
      }
    }
    let agent;
    if (args.agent !== undefined) {
      agent = requireString(args, 'agent', {
        max: 32,
        optional: true,
        pattern: AGENT_PATTERN,
      });
      if (agent === undefined) {
        throw new ToolError('invalid_arguments', 'Campo agent não pode ser vazio.');
      }
    }
    return hermes.task({ task, context, deliverable, constraints, mode, id, session, agent });
  }

  async function hermesStatus(args) {
    assertArgs(args);
    rejectExtra(args, ['run_id', 'agent']);
    const runId = requireString(args, 'run_id', { max: 128, pattern: RUN_ID_PATTERN });
    let agent;
    if (args.agent !== undefined) {
      agent = requireString(args, 'agent', {
        max: 32,
        optional: true,
        pattern: AGENT_PATTERN,
      });
      if (agent === undefined) {
        throw new ToolError('invalid_arguments', 'Campo agent não pode ser vazio.');
      }
    }
    return hermes.status(runId, agent);
  }

  async function listAgents(args) {
    assertArgs(args);
    rejectExtra(args, []);
    return agents.listPublic();
  }

  async function hermesResult(args) {
    assertArgs(args);
    rejectExtra(args, ['id']);
    const id = validateId(requireString(args, 'id', { max: 128 }));
    const { base } = resolveTaskBase(config, id);
    const target = path.join(base, 'result.json');
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      throw new ToolError('result_not_found', `result.json não encontrado para ${id}.`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ToolError('invalid_path', 'result.json não é um arquivo regular.');
    }
    if (stat.size > config.maxResultBytes) {
      throw new ToolError('result_too_large', 'result.json excede o limite de leitura.');
    }
    const real = fs.realpathSync(target);
    if (!isInside(base, real)) {
      throw new ToolError('invalid_path', 'result.json fora do diretório da tarefa.');
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(real, 'utf8'));
    } catch {
      throw new ToolError('invalid_result', 'result.json não contém JSON válido.');
    }
    return data;
  }

  async function hermesFiles(args) {
    assertArgs(args);
    rejectExtra(args, ['id', 'path']);
    const id = validateId(requireString(args, 'id', { max: 128 }));
    const { base } = resolveTaskBase(config, id);
    const candidate = resolveInside(base, args.path === undefined ? '' : args.path);

    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      throw new ToolError('path_not_found', 'Caminho não encontrado na tarefa.');
    }
    if (stat.isSymbolicLink()) {
      throw new ToolError('symlink_rejected', 'Symlinks não são permitidos.');
    }

    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      throw new ToolError('path_not_found', 'Caminho não encontrado na tarefa.');
    }
    if (real !== base && !isInside(base, real)) {
      throw new ToolError('invalid_path', 'Caminho fora do diretório da tarefa.');
    }

    if (fs.statSync(real).isDirectory()) {
      const listing = listTree(real);
      const relative = path.relative(base, real).split(path.sep).join('/');
      return {
        id,
        path: relative || '.',
        entries: listing.entries,
        count: listing.entries.length,
        truncated: listing.truncated,
      };
    }

    const file = await readTextFile(real, config.maxFileBytes);
    return {
      id,
      path: path.relative(base, real).split(path.sep).join('/'),
      size: file.size,
      mtime: file.mtime,
      encoding: 'utf-8',
      content: file.text,
    };
  }

  return {
    hermes_task: hermesTask,
    hermes_status: hermesStatus,
    list_agents: listAgents,
    hermes_result: hermesResult,
    hermes_files: hermesFiles,
  };
}
