import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultBackupBotUsername, defaultBackupRelayUrl } from './backup-relay-config.mjs';
import { telegramDocumentLimit } from './backup-telegram.mjs';
import { writeAtomic } from './storage.mjs';

const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const definitiveFailures = new Set([
  'relay-unpaired', 'relay-rate-limited', 'relay-invalid-request', 'telegram-preflight', 'telegram-rejected'
]);

function relayError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function readProof(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== 43 || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Неверные права или формат локального ключа привязки бота.');
    }
    const buffer = Buffer.alloc(44);
    const { bytesRead } = await file.read(buffer);
    const proof = buffer.toString('utf8', 0, bytesRead);
    if (!secretPattern.test(proof)) throw new Error('Некорректный локальный ключ привязки бота.');
    return proof;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  } finally {
    await file?.close();
  }
}

export function createBackupRelayClient({ stateDir, env = process.env, fetchImpl = fetch }) {
  const configuredUrl = env.VBACCOUNTER_TELEGRAM_RELAY_URL ?? defaultBackupRelayUrl;
  const username = (env.VBACCOUNTER_TELEGRAM_DEFAULT_BOT_USERNAME ?? defaultBackupBotUsername).replace(/^@/, '');
  let origin = null;
  if (configuredUrl) {
    const url = URL.parse(configuredUrl);
    if (url?.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) {
      origin = url.origin;
    }
  }
  const available = Boolean(origin && /^[A-Za-z0-9_]{2,29}bot$/i.test(username));
  const proofPath = join(stateDir, 'telegram-default-pairing-key');

  async function pair(reset) {
    if (!available) throw new Error('Общий сервис отправки резервных копий пока недоступен.');
    let proof = reset ? null : await readProof(proofPath);
    if (proof === null) {
      proof = randomBytes(32).toString('base64url');
      if (reset) await writeAtomic(proofPath, proof);
      else await writeFile(proofPath, proof, { flag: 'wx', mode: 0o600 });
    }
    const challenge = createHash('sha256').update(proof).digest('base64url');
    return { url: `https://t.me/${username}?start=${challenge}`, botUsername: `@${username}` };
  }

  async function request(route, options, timeout) {
    const proof = available && await readProof(proofPath);
    if (!proof) throw relayError('relay-unpaired', 'Сначала привяжите личный чат к боту по умолчанию.');
    let response;
    try {
      response = await fetchImpl(`${origin}${route}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
        body: options.body, headers: { ...options.headers, authorization: `Bearer ${proof}` }
      });
      const result = await response.json();
      return { response, result };
    } catch {
      throw relayError('relay-unavailable', 'Общий сервис отправки резервных копий не ответил.');
    }
  }

  async function verify(chatId) {
    const { response, result } = await request('/v1/pair', {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId })
    }, 30_000);
    if (!response.ok || result?.ok !== true) {
      throw new Error('Привязка личного чата не подтверждена. Нажмите Start по ссылке плагина и проверьте chat_id.');
    }
  }

  async function send({ chatId, bytes, fileName }) {
    if (bytes.length > telegramDocumentLimit) throw relayError('relay-invalid-request', 'Архив превышает 50 МБ.');
    const body = new FormData();
    body.set('chat_id', chatId);
    body.set('document', new Blob([bytes], { type: 'application/octet-stream' }), fileName);
    const { response, result } = await request('/v1/backups', { body }, 360_000);
    if (!response.ok || result?.ok !== true) {
      const code = result?.code;
      if (definitiveFailures.has(code)) {
        const message = code === 'relay-unpaired'
          ? 'Привязка личного чата больше не действует. Повторите настройку бота по умолчанию.'
          : `Сервис отклонил отправку архива (${code}).`;
        throw relayError(code, message);
      }
      throw relayError('telegram-unconfirmed', 'Сервис не подтвердил отправку архива.');
    }
    if (!Number.isSafeInteger(result.messageId) || result.messageId <= 0) {
      throw relayError('telegram-unconfirmed', 'Сервис не вернул номер сообщения.');
    }
    return { messageId: result.messageId, sentAt: result.sentAt };
  }

  return { available, username: available ? `@${username}` : null, pair, verify, send,
    hasProof: async () => Boolean(available && await readProof(proofPath)) };
}
