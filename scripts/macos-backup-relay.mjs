import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isTelegramBotToken } from '../lib/backup-telegram.mjs';
import { ensurePrivateDirectory, readRegular, writeAtomic } from '../lib/storage.mjs';
import { createTelegramBackupRelay } from './telegram-backup-relay.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const label = 'dev.vbaccounter.telegram-relay';
const host = '127.0.0.1';
const port = 8787;
const localUrl = `http://${host}:${port}`;
const telegramApi = 'https://api.telegram.org';
const runCommand = promisify(execFile);

function parsePublicUrl(value) {
  const url = URL.parse(value ?? '');
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port
      || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Укажите публичный HTTPS-адрес сервиса без пути, параметров и порта.');
  }
  return url.origin;
}

function optionalPublicUrl(value) {
  return value == null ? null : parsePublicUrl(value);
}

async function privateDirectory(path) {
  await ensurePrivateDirectory(path, 'Каталог службы должен быть обычным каталогом.');
  const info = await lstat(path);
  if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error('Каталог службы должен принадлежать текущему пользователю и иметь права 0700.');
  }
}

export async function readMacRelayConfig(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) {
    throw new Error('Файл настроек службы должен принадлежать текущему пользователю и иметь права 0600.');
  }
  let config;
  try {
    config = JSON.parse(await readRegular(path, 4096));
  } catch {
    throw new Error('Не удалось прочитать настройки службы.');
  }
  if (!isTelegramBotToken(config?.token) || !/^[A-Za-z0-9_-]{43}$/.test(config?.webhookSecret ?? '')) {
    throw new Error('Файл настроек службы содержит неверные секреты.');
  }
  return { ...config, publicUrl: optionalPublicUrl(config.publicUrl) };
}

export async function configureMacRelay({ configPath, publicUrl, token }) {
  const origin = optionalPublicUrl(publicUrl);
  if (!isTelegramBotToken(token)) throw new Error('Введите действительный токен бота Telegram через stdin.');
  await privateDirectory(dirname(configPath));
  const previous = await readMacRelayConfig(configPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const webhookSecret = previous?.webhookSecret ?? randomBytes(32).toString('base64url');
  const config = { publicUrl: origin ?? previous?.publicUrl ?? null, token, webhookSecret };
  await writeAtomic(configPath, JSON.stringify(config, null, 2) + '\n');
  return config;
}

const escapeXml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const xmlString = value => `<string>${escapeXml(value)}</string>`;

export function launchAgentPlist({ nodePath, scriptPath: entry, relayDir }) {
  const args = [nodePath, entry, 'serve'].map(xmlString).join('\n    ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${xmlString(label)}
  <key>ProgramArguments</key>
  <array>
    ${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>StandardErrorPath</key>
  ${xmlString(join(relayDir, 'relay.log'))}
</dict>
</plist>
`;
}

async function checkHealth(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${url}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    return response.ok && health?.ok === true && health?.service === 'vbaccounter-telegram-relay'
      && typeof health.instance === 'string' ? health.instance : null;
  } catch {
    return null;
  }
}

async function requestTelegram(token, method, fetchImpl, data = {}) {
  try {
    const response = await fetchImpl(`${telegramApi}/bot${token}/${method}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
    });
    const result = await response.json();
    if (response.ok && result?.ok === true) return result.result;
    if (response.status === 401) throw new Error('unauthorized');
  } catch (error) {
    if (error.message === 'unauthorized') throw new Error('Telegram отклонил токен бота. Проверьте настройки.');
  }
  throw new Error(`Telegram не подтвердил запрос ${method}.`);
}

export async function registerWebhook(config, { fetchImpl = fetch, replace = false } = {}) {
  if (!config.publicUrl) throw new Error('Для регистрации webhook укажите публичный HTTPS-адрес.');
  const origin = parsePublicUrl(config.publicUrl);
  const [local, publicEndpoint] = await Promise.all([checkHealth(localUrl, fetchImpl), checkHealth(origin, fetchImpl)]);
  if (!local) throw new Error(`Сервис не отвечает по ${localUrl}/healthz. Сначала запустите его.`);
  if (!publicEndpoint) throw new Error(`Сервис не отвечает по ${origin}/healthz. Проверьте публичный HTTPS-туннель.`);
  if (local !== publicEndpoint) throw new Error('Публичный HTTPS-адрес указывает на другой экземпляр сервиса.');
  const [bot, current] = await Promise.all([
    requestTelegram(config.token, 'getMe', fetchImpl), requestTelegram(config.token, 'getWebhookInfo', fetchImpl)
  ]);
  if (typeof bot?.username !== 'string' || !/^[A-Za-z0-9_]{2,29}bot$/i.test(bot.username)
      || typeof current?.url !== 'string') throw new Error('Telegram вернул неверные данные бота или webhook.');
  const url = `${origin}/v1/telegram/webhook`;
  if (current.url && current.url !== url && !replace) {
    throw new Error('У бота уже настроен другой webhook. Для переноса укажите --replace.');
  }
  const registered = await requestTelegram(config.token, 'setWebhook', fetchImpl, {
    url, secret_token: config.webhookSecret, allowed_updates: ['message']
  });
  if (registered !== true) throw new Error('Telegram не подтвердил регистрацию webhook.');
  return { botUsername: bot.username, relayUrl: origin, webhookUrl: url };
}

const launchctl = (...args) => runCommand('/bin/launchctl', args, { timeout: 15_000 });

async function isLoaded(target) {
  try {
    await launchctl('print', target);
    return true;
  } catch {
    return false;
  }
}

async function startMacRelay({ configPath, plistPath, domain, target }) {
  await readMacRelayConfig(configPath);
  const loaded = await isLoaded(target);
  if (loaded) {
    await launchctl('bootout', target);
  } else if (await checkHealth(localUrl)) {
    throw new Error(`На ${localUrl} уже отвечает другой процесс.`);
  }
  await ensurePrivateDirectory(dirname(plistPath), 'Каталог LaunchAgents должен быть обычным каталогом.');
  const plist = launchAgentPlist({ nodePath: process.execPath, scriptPath, relayDir: dirname(configPath) });
  await writeAtomic(plistPath, plist);
  await launchctl('enable', target);
  await launchctl('bootstrap', domain, plistPath);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await checkHealth(localUrl)) return { localUrl, running: true };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Служба загружена, но не отвечает по ${localUrl}. Проверьте relay.log.`);
}

async function readTokenInput(input) {
  let value = '';
  for await (const chunk of input) {
    value += chunk;
    if (value.length > 512) throw new Error('Неверный формат токена.');
  }
  return value.trim();
}

async function runMacRelay(command, args) {
  const home = homedir();
  const relayDir = join(home, 'Library', 'Application Support', 'VB Accounter Telegram Relay');
  const configPath = join(relayDir, 'config.json');
  const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${label}`;
  if (command === 'configure' && args.length <= 1) {
    if (process.stdin.isTTY) throw new Error('Передайте токен в stdin через скрытый ввод. См. docs/USAGE.md.');
    const config = await configureMacRelay({ configPath, publicUrl: args[0], token: await readTokenInput(process.stdin) });
    return { configPath, relayUrl: config.publicUrl };
  }
  if (command === 'set-url' && args.length === 1) {
    const previous = await readMacRelayConfig(configPath);
    const config = await configureMacRelay({ configPath, publicUrl: args[0], token: previous.token });
    return { relayUrl: config.publicUrl };
  }
  if (command === 'start' && !args.length) return startMacRelay({ configPath, plistPath, domain, target });
  if (command === 'stop' && !args.length) {
    if (await isLoaded(target)) await launchctl('bootout', target);
    await unlink(plistPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return { running: false };
  }
  if (command === 'status' && !args.length) {
    const config = await readMacRelayConfig(configPath).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const [loaded, local, publicEndpoint] = await Promise.all([
      isLoaded(target), checkHealth(localUrl), config?.publicUrl ? checkHealth(config.publicUrl) : null
    ]);
    return { configured: Boolean(config), loaded, local: Boolean(local),
      publicEndpoint: Boolean(local && publicEndpoint === local), relayUrl: config?.publicUrl ?? null };
  }
  if (command === 'register-webhook' && (!args.length || args.length === 1 && args[0] === '--replace')) {
    return registerWebhook(await readMacRelayConfig(configPath), { replace: args[0] === '--replace' });
  }
  if (command === 'serve' && !args.length) {
    const { token, webhookSecret } = await readMacRelayConfig(configPath);
    const server = await createTelegramBackupRelay({ token, webhookSecret, stateDir: relayDir });
    server.on('error', () => {
      process.stderr.write(`Не удалось открыть ${localUrl}.\n`);
      process.exitCode = 1;
    });
    server.listen(port, host);
    return null;
  }
  throw new Error('Команды: configure [https://адрес], set-url https://адрес, start, status, register-webhook [--replace], stop.');
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (platform() !== 'darwin') {
    process.stderr.write('Служба launchd доступна на macOS.\n');
    process.exitCode = 1;
  } else {
    process.umask(0o077);
    runMacRelay(process.argv[2], process.argv.slice(3)).then(result => {
      if (result) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }).catch(error => {
      const message = error.cmd ? 'Не удалось изменить состояние службы launchd.' : error.message;
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
  }
}
