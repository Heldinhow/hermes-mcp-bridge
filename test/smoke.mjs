#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

const env = readEnv(path.join(root, '.env'));
const token = env.MCP_AUTH_TOKEN;
if (!token) throw new Error('MCP_AUTH_TOKEN missing from .env');

let base = argValue('--base') || process.env.MCP_BASE_URL;
if (!base) {
  try {
    base = fs.readFileSync(path.join(root, 'PUBLIC_URL'), 'utf8').trim();
  } catch {
    base = `http://127.0.0.1:${env.MCP_PORT || 8765}`;
  }
}
base = base.replace(/\/+$/, '');
const id = argValue('--id') || `smoke-${Date.now()}`;

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

async function request(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

async function rpc(method, params, { auth = true, id: rpcId = 1 } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (auth) headers.authorization = `Bearer ${token}`;
  return request('/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
  });
}

async function tool(name, args) {
  const { response, json } = await rpc('tools/call', { name, arguments: args }, { id: 10 });
  if (!response.ok || !json?.result) {
    throw new Error(`tools/call ${name} HTTP ${response.status}`);
  }
  const text = json.result.content?.[0]?.text || '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { result: json.result, parsed };
}

async function main() {
  console.log(`Testing ${base} (task id ${id})`);

  const health = await request('/health');
  check('health', health.response.status === 200 && health.json?.status === 'ok', String(health.response.status));

  const unauthorized = await rpc('tools/list', {}, { auth: false });
  check('unauthorized 401', unauthorized.response.status === 401, String(unauthorized.response.status));

  const init = await rpc(
    'initialize',
    {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'hermes-mcp-bridge-smoke', version: '1.0.0' },
    },
    { id: 2 },
  );
  check(
    'initialize',
    init.response.status === 200 && typeof init.json?.result?.protocolVersion === 'string',
    init.json?.result?.protocolVersion,
  );

  const list = await rpc('tools/list', {}, { id: 3 });
  const names = (list.json?.result?.tools || []).map((item) => item.name).sort();
  const expected = ['hermes_files', 'hermes_result', 'hermes_status', 'hermes_task'];
  check(
    'tools/list exactly 4',
    list.response.status === 200 && JSON.stringify(names) === JSON.stringify(expected),
    names.join(','),
  );
  check(
    'tool schemas present',
    (list.json?.result?.tools || []).every((item) => item.inputSchema?.type === 'object'),
  );

  const task = await tool('hermes_task', { task: 'responda PONG', mode: 'sync', id });
  check(
    'hermes_task sync completed',
    task.parsed.status === 'done' || task.parsed.status === 'needs_user' || task.parsed.status === 'blocked',
    `status=${task.parsed.status} summary=${String(task.parsed.summary || '').slice(0, 160)}`,
  );
  check('hermes_task returns id', task.parsed.id === id, task.parsed.id);
  check(
    'hermes_task answered PONG',
    /PONG/i.test(String(task.parsed.summary || '')),
    String(task.parsed.summary || '').slice(0, 160),
  );

  const durable = await tool('hermes_result', { id });
  check(
    'hermes_result reads result.json',
    durable.parsed.id === id && typeof durable.parsed.status === 'string',
    durable.parsed.status,
  );

  const files = await tool('hermes_files', { id });
  const entries = files.parsed.entries || [];
  check(
    'hermes_files lists result.json',
    entries.some((entry) => entry.path === 'result.json'),
    `${entries.length} entries`,
  );

  const read = await tool('hermes_files', { id, path: 'result.json' });
  let readJson = null;
  try {
    readJson = JSON.parse(read.parsed.content || '');
  } catch {
    readJson = null;
  }
  check('hermes_files reads small text file', readJson?.id === id, String(read.parsed.size));

  const traversal = await tool('hermes_files', { id, path: '../../etc/passwd' });
  check('path traversal rejected', traversal.result.isError === true, traversal.parsed.error);

  const absolute = await tool('hermes_files', { id, path: '/etc/passwd' });
  check('absolute path rejected', absolute.result.isError === true, absolute.parsed.error);

  const big = await request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping', params: { blob: 'x'.repeat(300 * 1024) } }),
  });
  check('payload limit 413', big.response.status === 413, String(big.response.status));

  if (failures > 0) {
    console.error(`SMOKE FAILED: ${failures} check(s)`);
    process.exit(1);
  }
  console.log('SMOKE PASS');
}

main().catch((error) => {
  console.error(`SMOKE ERROR: ${error.message}`);
  process.exit(1);
});
