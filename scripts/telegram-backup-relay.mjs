#!/usr/bin/env node
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDirectory, readRegular, writeAtomic } from '../lib/storage.mjs';
import {
  isTelegramBotToken, parseTelegramChatId, sendTelegramBackup, telegramDocumentLimit
} from '../lib/backup-telegram.mjs';

const proofPattern = /^[A-Za-z0-9_-]{43}$/;
const archiveNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz\.age$/;
const ageHeader = Buffer.from('age-encryption.org/v1\n');
const maxUploadBody = telegramDocumentLimit + 65_536;
const maxParallelUploads = 4;
const pairLifetime = 10 * 60_000;
const minUploadInterval = 60_000;
const maxDailyAttempts = 5;
const day = 24 * 60 * 60_000;

const hashProof = proof => createHash('sha256').update(proof).digest('base64url');

function requestError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

const invalidRequest = () => requestError(400, 'relay-invalid-request');
const unpaired = () => requestError(401, 'relay-unpaired');
const rateLimited = () => requestError(429, 'relay-rate-limited');

function jsonReply(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(status >= 400 ? { connection: 'close' } : {})
  });
  response.end(JSON.stringify(value));
}

async function readBody(request, maxBytes) {
  const advertisedSize = request.headers['content-length'];
  if (advertisedSize !== undefined && Number(advertisedSize) > maxBytes) {
    throw requestError(413, 'relay-invalid-request');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) throw requestError(413, 'relay-invalid-request');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw invalidRequest();
  }
  const body = await readBody(request, maxBytes);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw invalidRequest();
  }
}

function readChatId(value) {
  try {
    return parseTelegramChatId(value);
  } catch {
    throw invalidRequest();
  }
}

async function readUpload(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw invalidRequest();
  const body = await readBody(request, maxUploadBody);
  let form;
  try {
    form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw invalidRequest();
  }
  if (form.getAll('chat_id').length !== 1 || form.getAll('document').length !== 1) {
    throw invalidRequest();
  }
  const chatId = readChatId(form.get('chat_id'));
  const document = form.get('document');
  if (!(document instanceof File) || !archiveNamePattern.test(document.name)) throw invalidRequest();
  if (document.size > telegramDocumentLimit) throw requestError(413, 'relay-invalid-request');
  const bytes = Buffer.from(await document.arrayBuffer());
  if (bytes.length <= ageHeader.length || !bytes.subarray(0, ageHeader.length).equals(ageHeader)) {
    throw invalidRequest();
  }
  return { chatId, bytes, fileName: document.name };
}

function readPairingUpdate(message, receivedAt) {
  if (message?.chat?.type !== 'private' || message.from?.is_bot !== false
      || !Number.isSafeInteger(message.chat.id) || message.chat.id < 1
      || message.chat.id !== message.from.id) {
    return null;
  }
  if (!Number.isSafeInteger(message.message_id) || message.message_id < 1
      || !Number.isSafeInteger(message.date)
      || Math.abs(receivedAt - message.date * 1000) > pairLifetime) {
    return null;
  }
  const match = typeof message.text === 'string' && /^\/start ([A-Za-z0-9_-]{43})$/.exec(message.text);
  if (!match) return null;
  return { chatId: String(message.chat.id), proofHash: match[1], messageId: message.message_id, date: message.date };
}

function matchesWebhookSecret(request, expected) {
  const value = request.headers['x-telegram-bot-api-secret-token'];
  if (typeof value !== 'string') return false;
  const provided = Buffer.from(value);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function createPairings(stateDir) {
  await ensurePrivateDirectory(stateDir, 'Каталог состояния Telegram relay должен быть обычным каталогом.');
  const file = join(stateDir, 'telegram-relay.json');
  let rows = [];
  try {
    rows = JSON.parse(await readRegular(file));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Не удалось прочитать состояние Telegram relay.');
  }
  const byChat = new Map(rows.map(row => [row.chatId, row]));
  const byProof = new Map(rows.map(row => [row.proofHash, row.chatId]));
  let queue = Promise.resolve();

  function write(chatId, update) {
    const next = queue.then(async () => {
      const previous = byChat.get(chatId);
      const current = update(previous);
      if (!current) return;
      const snapshot = new Map(byChat).set(chatId, current);
      await writeAtomic(file, JSON.stringify([...snapshot.values()]) + '\n');
      byChat.set(chatId, current);
      if (previous) byProof.delete(previous.proofHash);
      byProof.set(current.proofHash, chatId);
    });
    queue = next.catch(() => {});
    return next;
  }

  function getChatId(request) {
    const header = request.headers.authorization;
    const proof = typeof header === 'string' && header.startsWith('Bearer ') && header.slice(7);
    if (!proof || !proofPattern.test(proof)) throw unpaired();
    const chatId = byProof.get(hashProof(proof));
    if (!chatId) throw unpaired();
    return chatId;
  }

  return {
    getChatId,
    pair(update) {
      return write(update.chatId, previous => {
        if (byProof.has(update.proofHash) && byProof.get(update.proofHash) !== update.chatId) return null;
        if (previous && (update.date < previous.date
            || (update.date === previous.date && update.messageId <= previous.messageId))) return null;
        return { ...update, attempts: previous?.attempts ?? [] };
      });
    },
    reserve(request, chatId, time) {
      return write(chatId, previous => {
        if (getChatId(request) !== chatId) throw unpaired();
        const attempts = previous.attempts.filter(attempt => time - attempt < day);
        const lastAttempt = attempts.at(-1);
        if (attempts.length >= maxDailyAttempts || (lastAttempt !== undefined && time - lastAttempt < minUploadInterval)) {
          throw rateLimited();
        }
        return { ...previous, attempts: [...attempts, time] };
      });
    }
  };
}

function telegramFailure(error) {
  if (error?.code === 'telegram-preflight' || error?.code === 'telegram-rejected') {
    return requestError(502, error.code);
  }
  return requestError(502, 'telegram-unconfirmed');
}

export async function createTelegramBackupRelay({ token, webhookSecret, stateDir, now = () => new Date(), sendBackup = sendTelegramBackup }) {
  if (!isTelegramBotToken(token)) throw new Error('Задайте токен общего бота в настройках Telegram relay.');
  if (typeof webhookSecret !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new Error('Задайте секрет webhook Telegram relay.');
  }
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) {
    throw new Error('Задайте абсолютный путь каталога состояния Telegram relay.');
  }
  const secret = Buffer.from(webhookSecret);
  const pairings = await createPairings(stateDir);
  const uploading = new Set();
  const instance = randomUUID();

  async function handle(request) {
    if (request.method === 'GET' && request.url === '/healthz') {
      return { ok: true, service: 'vbaccounter-telegram-relay', instance };
    }
    if (request.method !== 'POST') throw requestError(404, 'relay-not-found');
    switch (request.url) {
      case '/v1/telegram/webhook': {
        if (!matchesWebhookSecret(request, secret)) throw unpaired();
        const update = await readJson(request, 65_536);
        const start = readPairingUpdate(update?.message, now().getTime());
        if (start) await pairings.pair(start);
        return { ok: true };
      }
      case '/v1/pair': {
        const chatId = pairings.getChatId(request);
        const body = await readJson(request, 4_096);
        if (readChatId(body?.chat_id) !== chatId || pairings.getChatId(request) !== chatId) throw unpaired();
        return { ok: true };
      }
      case '/v1/backups': {
        const chatId = pairings.getChatId(request);
        if (uploading.size >= maxParallelUploads || uploading.has(chatId)) throw rateLimited();
        uploading.add(chatId);
        try {
          const upload = await readUpload(request);
          if (upload.chatId !== chatId) throw unpaired();
          await pairings.reserve(request, chatId, now().getTime());
          try {
            const { messageId, sentAt } = await sendBackup({ token, ...upload });
            return { ok: true, messageId, sentAt };
          } catch (error) {
            throw telegramFailure(error);
          }
        } finally {
          uploading.delete(chatId);
        }
      }
      default:
        throw requestError(404, 'relay-not-found');
    }
  }

  const server = createServer({ requestTimeout: 120_000 }, async (request, response) => {
    try {
      jsonReply(response, 200, await handle(request));
    } catch (error) {
      jsonReply(response, error.status ?? 503, { ok: false, code: error.code?.startsWith?.('relay-')
        || error.code?.startsWith?.('telegram-') ? error.code : 'relay-unavailable' });
    }
  });
  server.maxConnections = 64;
  return server;
}

async function run() {
  const server = await createTelegramBackupRelay({
    token: process.env.VBACCOUNTER_TELEGRAM_DEFAULT_BOT_TOKEN,
    webhookSecret: process.env.VBACCOUNTER_TELEGRAM_WEBHOOK_SECRET,
    stateDir: process.env.VBACCOUNTER_TELEGRAM_RELAY_STATE_DIR
  });
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Некорректный порт Telegram relay.');
  server.on('error', () => {
    process.stderr.write('Не удалось открыть порт Telegram relay.\n');
    process.exitCode = 1;
  });
  server.listen(port, process.env.VBACCOUNTER_TELEGRAM_RELAY_HOST || '127.0.0.1');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(() => {
    process.stderr.write('Не удалось запустить Telegram relay. Проверьте настройки, порт и каталог состояния.\n');
    process.exitCode = 1;
  });
}
