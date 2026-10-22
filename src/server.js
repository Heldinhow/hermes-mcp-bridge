#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { createAudit } from './audit.js';
import { loadConfig } from './config.js';
import { createAgents } from './agents.js';
import { createHermes } from './hermes.js';
import { dispatchRpc } from './mcp.js';
import { TOOLS, createToolHandlers } from './tools.js';

const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent) return;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function clientIp(req) {
  const raw = req.socket.remoteAddress || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function cloudflareIp(req) {
  const value = req.headers['cf-connecting-ip'];
  if (typeof value !== 'string' || value.length > 64) return undefined;
  return /^[0-9a-fA-F:.]+$/.test(value) ? value : undefined;
}

function createRateLimiter(perMinute) {
  const capacity = perMinute;
  const refillPerMs = perMinute / 60000;
  let tokens = capacity;
  let last = Date.now();
  return function take() {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + (now - last) * refillPerMs);
    last = now;
    if (tokens >= 1) {
      tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000));
  };
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function createTokenCheck(expected) {
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return function isAuthorized(req) {
    const provided = bearerToken(req);
    if (!provided) return false;
    const providedHash = crypto.createHash('sha256').update(provided, 'utf8').digest();
    return crypto.timingSafeEqual(expectedHash, providedHash);
  };
}

function readLimitedBody(req, limit) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    const chunks = [];

    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      const error = new Error(message);
      error.code = code;
      reject(error);
    };

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      fail('PAYLOAD_TOO_LARGE', 'Payload too large');
      req.resume();
      return;
    }

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        fail('PAYLOAD_TOO_LARGE', 'Payload too large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      fail('REQUEST_ERROR', 'Request error');
    });
  });
}

function isJsonContentType(req) {
  const value = req.headers['content-type'];
  if (typeof value !== 'string') return false;
  return /^application\/json(?:\s*;|$)/i.test(value.trim());
}

function warnIfEnvIsOpen(envPath) {
  try {
    const stat = fs.statSync(envPath);
    if (stat.mode & 0o077) {
      console.warn(`[bridge] warning: ${envPath} is accessible by group/others; run chmod 600`);
    }
  } catch {
    // loadConfig already validated the token.
  }
}

function main() {
  const config = loadConfig();
  fs.mkdirSync(path.dirname(config.auditLog), { recursive: true, mode: 0o700 });
  const audit = createAudit(config.auditLog);
  const agents = createAgents(config);
  const hermes = createHermes(config, agents);
  const handlers = createToolHandlers(config, hermes, agents);
  const isAuthorized = createTokenCheck(config.token);
  const takeRateLimit = createRateLimiter(config.rateLimitPerMin);

  warnIfEnvIsOpen(config.envPath);

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const meta = { rpc: new Set(), tools: new Set(), errors: new Set() };
    let audited = false;
    let statusOverride;

    const recordAudit = () => {
      if (audited) return;
      audited = true;
      audit({
        event: 'http',
        ip: clientIp(req),
        cf_ip: cloudflareIp(req),
        method: req.method,
        path: req.url ? req.url.split('?')[0] : '',
        status: statusOverride || res.statusCode,
        ms: Date.now() - started,
        rpc: [...meta.rpc].join(','),
        tool: [...meta.tools].join(','),
        error: [...meta.errors].join(','),
      });
    };
    res.on('finish', recordAudit);
    res.on('close', recordAudit);

    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname;

      if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        const body = {
          status: 'ok',
          service: 'hermes-mcp-bridge',
          version: VERSION,
          uptime_s: Math.floor(process.uptime()),
          tools: TOOLS.length,
          agents: agents.summary(),
        };
        if (req.method === 'HEAD') {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end();
        } else {
          sendJson(res, 200, body);
        }
        return;
      }

      if (pathname === '/mcp') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
          return;
        }

        const retryAfter = takeRateLimit();
        if (retryAfter > 0) {
          statusOverride = 429;
          meta.errors.add('rate_limited');
          sendJson(
            res,
            429,
            { error: 'rate_limited', message: 'Too many requests; retry later.' },
            { 'retry-after': String(retryAfter) },
          );
          return;
        }

        if (!isAuthorized(req)) {
          statusOverride = 401;
          meta.errors.add('unauthorized');
          sendJson(
            res,
            401,
            { error: 'unauthorized' },
            { 'www-authenticate': 'Bearer realm="hermes-mcp-bridge"' },
          );
          return;
        }

        if (!isJsonContentType(req)) {
          statusOverride = 415;
          meta.errors.add('unsupported_media_type');
          sendJson(res, 415, { error: 'unsupported_media_type' });
          return;
        }

        let raw;
        try {
          raw = await readLimitedBody(req, config.maxBodyBytes);
        } catch (error) {
          if (error.code === 'PAYLOAD_TOO_LARGE') {
            statusOverride = 413;
            meta.errors.add('payload_too_large');
            sendJson(res, 413, { error: 'payload_too_large' });
            return;
          }
          throw error;
        }

        if (!raw.trim()) {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error: empty body' },
          });
          return;
        }

        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          });
          return;
        }

        const response = await dispatchRpc(message, {
          tools: TOOLS,
          handlers,
          version: VERSION,
          meta,
        });

        if (response === null) {
          res.writeHead(202, { 'cache-control': 'no-store' });
          res.end();
        } else {
          sendJson(res, 200, response);
        }
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error && error.code === 'PAYLOAD_TOO_LARGE') {
        statusOverride = 413;
        meta.errors.add('payload_too_large');
        sendJson(res, 413, { error: 'payload_too_large' });
        return;
      }
      meta.errors.add('internal_error');
      console.error('[bridge] request error:', error && error.stack ? error.stack : error);
      sendJson(res, 500, { error: 'internal_error' });
    }
  });

  server.headersTimeout = 15000;
  server.requestTimeout = 300000;
  server.keepAliveTimeout = 65000;

  server.on('clientError', (error, socket) => {
    if (!socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  server.on('error', (error) => {
    console.error(`[bridge] server error: ${error.code || 'unknown'}`);
    process.exit(1);
  });

  server.listen(config.port, '127.0.0.1', () => {
    console.log(`[bridge] listening on 127.0.0.1:${config.port}`);
    console.log(`[bridge] hermes=${config.hermesUrl} contract=${config.contractPath}`);
    console.log(`[bridge] audit=${config.auditLog} tools=${TOOLS.length}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('uncaughtException', (error) => {
    console.error('[bridge] uncaught exception:', error && error.stack ? error.stack : error);
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    console.error('[bridge] unhandled rejection:', error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

main();
