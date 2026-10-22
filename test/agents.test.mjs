import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAgents, parseRegistryYaml } from '../src/agents.js';

function tmpRegistry(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agents-'));
  const file = path.join(dir, 'agents.yaml');
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

function fakeConfig(file, env = {}) {
  const values = { API_SERVER_KEY: 'x'.repeat(64), HERMES_CODER_API_KEY: 'y'.repeat(64), ...env };
  return {
    agentsFile: file,
    hermesUrl: 'http://127.0.0.1:8642',
    hermesKey: values.API_SERVER_KEY,
    defaultAgentName: 'hermes',
    envLookup: (name) => values[name],
    tasksDir: '/nonexistent',
  };
}

const GOOD = `version: 1
default: hermes
agents:
  - name: hermes
    description: principal
    capabilities: [geral, navegador]
    kind: local
    profile: default
    base_url: http://127.0.0.1:8642
    key_env: API_SERVER_KEY
  - name: coder
    description: codigo
    capabilities: [codigo]
    kind: local
    profile: coder
    base_url: http://127.0.0.1:8642/p/coder
    key_env: HERMES_CODER_API_KEY
`;

test('parser aceita o schema do registro', () => {
  const parsed = parseRegistryYaml(GOOD);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.default, 'hermes');
  assert.equal(parsed.agents.length, 2);
  assert.deepEqual(parsed.agents[0].capabilities, ['geral', 'navegador']);
});

test('parser rejeita tabs, linhas soltas e duplicatas', () => {
  assert.throws(() => parseRegistryYaml('version:\t1\n'), /tab/);
  assert.throws(() => parseRegistryYaml('   solto: 1\n'), /indentação sem lista/);
  assert.throws(() => parseRegistryYaml('version: 1\nversion: 1\n'), /duplicada/);
});

test('registro válido resolve clientes e esconde as chaves', async () => {
  const agents = createAgents(fakeConfig(tmpRegistry(GOOD)));
  const coder = agents.client('coder');
  assert.equal(coder.baseUrl, 'http://127.0.0.1:8642/p/coder');
  const listed = await agents.listPublic();
  const serialized = JSON.stringify(listed);
  assert.equal(listed.count, 2);
  assert.ok(!serialized.includes('x'.repeat(64)));
  assert.ok(!serialized.includes('y'.repeat(64)));
  assert.ok(!serialized.includes('key_env'));
});

test('chave ausente deixa o agente indisponível e o client falha', async () => {
  const agents = createAgents(fakeConfig(tmpRegistry(GOOD), { HERMES_CODER_API_KEY: '' }));
  const listed = await agents.listPublic();
  const coder = listed.agents.find((item) => item.name === 'coder');
  assert.equal(coder.available, false);
  assert.equal(coder.unavailable_reason, 'missing_credentials');
  assert.throws(() => agents.client('coder'), /sem credencial/);
});

test('nome desconhecido e default inexistente', async () => {
  const agents = createAgents(fakeConfig(tmpRegistry(GOOD)));
  assert.throws(() => agents.client('naoexiste'), /não registrado/);
  const broken = GOOD.replace('default: hermes', 'default: fantasma');
  const degraded = createAgents(fakeConfig(tmpRegistry(broken)));
  const summary = degraded.summary();
  assert.equal(summary.default, 'hermes'); // mantém o sintético
  assert.ok(summary.registry_error);
});

test('endpoint remoto público é recusado', async () => {
  const bad = GOOD.replace('http://127.0.0.1:8642/p/coder', 'http://example.com:8642');
  const agents = createAgents(fakeConfig(tmpRegistry(bad)));
  assert.match(agents.summary().registry_error, /fora de loopback\/Tailscale/);
});

test('nome inválido e kind local sem profile são recusados', () => {
  const badName = GOOD.replace('- name: coder', '- name: Coder');
  assert.match(createAgents(fakeConfig(tmpRegistry(badName))).summary().registry_error, /name inválido/);
  const noProfile = GOOD.replace('    profile: coder\n', '');
  assert.match(
    createAgents(fakeConfig(tmpRegistry(noProfile))).summary().registry_error,
    /exige profile/,
  );
});

test('registro ausente degrada para o agente default sintético', () => {
  const agents = createAgents(fakeConfig('/nonexistent/agents.yaml'));
  const summary = agents.summary();
  assert.equal(summary.default, 'hermes');
  assert.equal(summary.count, 1);
  assert.equal(summary.degraded, 'no_registry');
});
