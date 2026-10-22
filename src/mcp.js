import { HermesError, ToolError } from './errors.js';

const SUPPORTED_PROTOCOL_FALLBACK = '2025-03-26';
const MAX_BATCH = 20;

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

function toolErrorResult(error) {
  const payload = { error: error.code, message: error.message };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function toolSuccessResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function dispatchOne(message, ctx) {
  if (!isPlainObject(message)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  if (message.jsonrpc !== '2.0') {
    return rpcError(message.id, -32600, 'Invalid Request: jsonrpc must be "2.0"');
  }
  if (typeof message.method !== 'string' || !message.method) {
    return rpcError(message.id, -32600, 'Invalid Request: missing method');
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const id = hasId ? message.id : null;
  const method = message.method;
  ctx.meta.rpc.add(method);

  if (!hasId) {
    // MCP initialization/cancellation notifications are accepted and need no body.
    return null;
  }

  if (method === 'initialize') {
    const params = isPlainObject(message.params) ? message.params : {};
    const requested = params.protocolVersion;
    const protocolVersion =
      typeof requested === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requested)
        ? requested
        : SUPPORTED_PROTOCOL_FALLBACK;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'hermes-mcp-bridge',
          version: ctx.version,
        },
        instructions:
          'Bridge para o Hermes local. Use hermes_task para enviar tarefas, hermes_status ' +
          'para runs assíncronos, hermes_result para o result.json durável e hermes_files ' +
          'para inspecionar artefatos da tarefa.',
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: ctx.tools } };
  }

  if (method === 'tools/call') {
    const params = message.params;
    if (!isPlainObject(params) || typeof params.name !== 'string' || !params.name) {
      return rpcError(id, -32602, 'Invalid params: tools/call requires a tool name');
    }
    const handler = ctx.handlers[params.name];
    if (!handler) {
      return rpcError(id, -32602, `Unknown tool: ${params.name}`);
    }
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isPlainObject(args)) {
      return rpcError(id, -32602, 'Invalid params: arguments must be an object');
    }
    ctx.meta.tools.add(params.name);
    try {
      const result = await handler(args);
      return { jsonrpc: '2.0', id, result: toolSuccessResult(result) };
    } catch (error) {
      if (error instanceof ToolError) {
        ctx.meta.errors.add(error.code);
        return { jsonrpc: '2.0', id, result: toolErrorResult(error) };
      }
      if (error instanceof HermesError) {
        ctx.meta.errors.add(error.code);
        return {
          jsonrpc: '2.0',
          id,
          result: toolErrorResult({
            code: error.code,
            message: error.message,
          }),
        };
      }
      ctx.meta.errors.add('internal_error');
      console.error('[bridge] tool handler error:', error && error.stack ? error.stack : error);
      return {
        jsonrpc: '2.0',
        id,
        result: toolErrorResult({
          code: 'internal_error',
          message: 'Erro interno ao executar a ferramenta.',
        }),
      };
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

export async function dispatchRpc(message, ctx) {
  if (Array.isArray(message)) {
    if (message.length === 0) {
      return rpcError(null, -32600, 'Invalid Request: empty batch');
    }
    if (message.length > MAX_BATCH) {
      return rpcError(null, -32600, `Batch too large (max ${MAX_BATCH})`);
    }
    const responses = [];
    for (const item of message) {
      const response = await dispatchOne(item, ctx);
      if (response !== null) responses.push(response);
    }
    return responses.length ? responses : null;
  }
  return dispatchOne(message, ctx);
}
