#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../lib/service.mjs';
import { tools, validateArguments } from './tool-catalog.mjs';

/** Имя и версия сервера берутся из `package.json`: один источник для всех хостов. */
const packageInfo = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const instructions = 'VB Accounter хранит состояние отдельно от приложения. Источник VB Accounting только для чтения. Применимость, жизненный цикл, оплата и срочность различаются. Неизвестная применимость и непроверенные правила требуют внимания. accepted/paid означают сохранение предоставленного подтверждения, не автоматическую проверку кабинета. check_notifications не запускает фоновые проверки и не отправляет push. Не объявляйте отсутствие обязательств при ошибке источника или неполном покрытии.';

export function defaultDataDirectory(env = process.env, system = platform()) {
  if (env.VBACCOUNTER_DATA_DIR) {
    if (!isAbsolute(env.VBACCOUNTER_DATA_DIR)) throw new Error('VBACCOUNTER_DATA_DIR должен быть абсолютным путём.');
    return env.VBACCOUNTER_DATA_DIR;
  }
  if (system === 'darwin') return join(homedir(), 'Library', 'Application Support', 'VB Accounter');
  if (system === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'VB Accounter');
  return join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), '.local', 'share'), 'vbaccounter');
}

export function createSession(service) {
  let initialized = false;
  return async request => {
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(null, -32600, 'Invalid Request');
    if (!Object.hasOwn(request, 'id')) return null;
    const { id, method, params = {} } = request;
    if (!['string', 'number'].includes(typeof id) || (typeof id === 'number' && !Number.isFinite(id))) return error(null, -32600, 'Invalid id');
    if (method === 'ping') return success(id, {});
    if (method === 'initialize') {
      if (initialized) return error(id, -32600, 'Already initialized');
      if (!params || typeof params.protocolVersion !== 'string') return error(id, -32602, 'protocolVersion is required');
      initialized = true;
      return success(id, { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: packageInfo.name, title: 'VB Accounter', version: packageInfo.version }, instructions });
    }
    if (!initialized) return error(id, -32002, 'Initialize the MCP connection first');
    if (method === 'tools/list') {
      if (params?.cursor) return error(id, -32602, 'Unknown cursor');
      return success(id, { tools });
    }
    if (method !== 'tools/call') return error(id, -32601, 'Method not found');
    const tool = tools.find(item => item.name === params?.name);
    if (!tool) return error(id, -32602, 'Unknown tool');
    try {
      const args = params.arguments ?? {};
      validateArguments(tool.inputSchema, args);
      const result = await service.call(tool.name, args);
      return success(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
    } catch (cause) {
      return success(id, { content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'Не удалось выполнить операцию.' }], isError: true });
    }
  };
}

const success = (id, result) => ({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function runStdio(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write('VB Accounter MCP (Node.js >=22)\nUsage: node scripts/mcp-server.mjs [--data-dir /absolute/path]\nEnvironment: VBACCOUNTER_DATA_DIR\nData stays outside the installed plugin cache.\n');
    return;
  }
  if (argv.length && (argv.length !== 2 || argv[0] !== '--data-dir' || !isAbsolute(argv[1]))) throw new Error('Используйте --data-dir /абсолютный/путь.');
  const session = createSession(createService({ stateDir: argv[1] || defaultDataDirectory() }));
  let buffer = '';
  let queue = Promise.resolve();
  const send = message => { if (message) process.stdout.write(`${JSON.stringify(message)}\n`); };
  const consume = line => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > 1024 * 1024) { send(error(null, -32600, 'MCP message exceeds 1 MiB')); return; }
    queue = queue.then(async () => {
      let request;
      try { request = JSON.parse(line); } catch { send(error(null, -32700, 'Parse error')); return; }
      send(await session(request));
    }).catch(() => send(error(null, -32603, 'Internal error')));
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); consume(line); }
    if (Buffer.byteLength(buffer) > 1024 * 1024) { process.stderr.write('MCP message exceeds 1 MiB.\n'); process.exitCode = 1; process.stdin.destroy(); }
  });
  await new Promise(resolve => { process.stdin.once('end', resolve); process.stdin.once('close', resolve); });
  if (buffer.trim()) consume(buffer);
  await queue;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStdio().catch(cause => { process.stderr.write(`${cause.message}\n`); process.exitCode = 1; });
}
