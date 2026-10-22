#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const token = crypto.randomBytes(32).toString('hex');

let current = '';
try {
  const stat = fs.lstatSync(envPath);
  if (stat.isSymbolicLink()) {
    throw new Error('.env must not be a symlink');
  }
  current = fs.readFileSync(envPath, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const lines = current ? current.split(/\r?\n/) : [];
let replaced = false;
const updated = lines.map((line) => {
  if (/^MCP_AUTH_TOKEN\s*=/.test(line)) {
    replaced = true;
    return `MCP_AUTH_TOKEN=${token}`;
  }
  return line;
});
if (!replaced) updated.push(`MCP_AUTH_TOKEN=${token}`);
if (!updated.some((line) => /^MCP_PORT\s*=/.test(line))) updated.push('MCP_PORT=8765');

const body = `${updated.filter((line, index) => line !== '' || index < updated.length - 1).join('\n')}\n`;
const tmp = path.join(root, `.env.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
fs.chmodSync(tmp, 0o600);
fs.renameSync(tmp, envPath);
fs.chmodSync(envPath, 0o600);

console.log(`Token written to ${envPath} (mode 600). Value not printed.`);
