const botApi = 'https://api.telegram.org';
const ageHeader = Buffer.from('age-encryption.org/v1\n');
export const telegramDocumentLimit = 50_000_000;

export function isTelegramBackupCaption(value) {
  return value === undefined || (typeof value === 'string' && value.length > 0
    && value.length <= 1024 && value.isWellFormed());
}

export function isTelegramBackupFileName(value) {
  return typeof value === 'string'
    && /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._-]{0,127}\.tar\.gz\.age$/u.test(value);
}

export function parseTelegramChatId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('Укажите положительный числовой chat_id личного чата с ботом.');
  }
  const id = String(value).trim();
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new Error('Укажите положительный числовой chat_id личного чата с ботом.');
  }
  return id;
}

export function isTelegramBotToken(value) {
  return typeof value === 'string'
    && value === value.trim()
    && /^[1-9]\d{0,15}:[A-Za-z0-9_-]{1,128}$/.test(value);
}

function backupError(code, message) {
  return Object.assign(new Error(message), { code });
}

function unconfirmedDelivery() {
  return backupError('telegram-unconfirmed', 'Telegram не подтвердил отправку архива. Проверьте личный чат перед повтором.');
}

function matchesPrivateChat(chat, expectedId) {
  return chat?.type === 'private' && Number.isSafeInteger(chat.id) && String(chat.id) === expectedId;
}

async function requestTelegram(fetchImpl, token, method, options, timeout) {
  return fetchImpl(`${botApi}/bot${token}/${method}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
    ...options
  });
}

async function readTelegramJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function verifyPrivateChat(fetchImpl, token, chatId) {
  let response;
  try {
    response = await requestTelegram(fetchImpl, token, 'getChat', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId })
    }, 30_000);
  } catch {
    throw backupError('telegram-preflight', 'Не удалось связаться с Telegram для проверки чата.');
  }

  const chat = await readTelegramJson(response);
  if (!response.ok || chat?.ok !== true || !matchesPrivateChat(chat.result, chatId)) {
    throw backupError('telegram-preflight', 'Telegram не подтвердил личный чат. Проверьте токен бота и chat_id, затем нажмите Start в чате с ботом.');
  }
}

function validateArchive(bytes, fileName) {
  if (!Buffer.isBuffer(bytes) || bytes.length <= ageHeader.length || !bytes.subarray(0, ageHeader.length).equals(ageHeader)) {
    throw new Error('Для отправки нужен архив, зашифрованный с помощью age.');
  }
  if (bytes.length > telegramDocumentLimit) {
    throw new Error('Зашифрованный архив превышает лимит Telegram в 50 МБ.');
  }
  if (!isTelegramBackupFileName(fileName)) {
    throw new Error('Некорректное имя файла резервной копии.');
  }
}

function parseReceipt(body, chatId, fileName, byteCount, caption) {
  const result = body?.result;
  const document = result?.document;
  const normalizeLineBreaks = value => typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : undefined;
  if (body?.ok !== true || !matchesPrivateChat(result?.chat, chatId)
      || !Number.isSafeInteger(result.message_id) || result.message_id <= 0
      || typeof document?.file_id !== 'string' || !document.file_id
      || (document.file_name !== undefined && document.file_name !== fileName)
      || (document.file_size !== undefined && document.file_size !== byteCount)
      || (caption !== undefined && normalizeLineBreaks(result.caption) !== normalizeLineBreaks(caption))) {
    throw unconfirmedDelivery();
  }

  const receipt = { messageId: result.message_id };
  if (Number.isSafeInteger(result.date) && result.date > 0) {
    const date = new Date(result.date * 1000);
    if (Number.isFinite(date.getTime())) receipt.sentAt = date.toISOString();
  }
  return receipt;
}

export async function sendTelegramBackup({ token, chatId, bytes, fileName, caption, fetchImpl = fetch }) {
  if (!isTelegramBotToken(token)) throw new Error('Некорректный токен Telegram-бота.');
  const recipient = parseTelegramChatId(chatId);
  validateArchive(bytes, fileName);
  if (!isTelegramBackupCaption(caption)) throw new Error('Некорректная подпись резервной копии для Telegram.');
  await verifyPrivateChat(fetchImpl, token, recipient);

  const body = new FormData();
  body.set('chat_id', recipient);
  body.set('document', new Blob([bytes], { type: 'application/octet-stream' }), fileName);
  if (caption !== undefined) body.set('caption', caption);
  let response;
  try {
    response = await requestTelegram(fetchImpl, token, 'sendDocument', { body }, 180_000);
  } catch {
    throw unconfirmedDelivery();
  }
  const result = await readTelegramJson(response);
  if (!response.ok) {
    if (result?.ok === false && result.error_code === response.status
        && response.status >= 400 && response.status < 500 && response.status !== 408) {
      throw backupError('telegram-rejected', `Telegram отклонил отправку архива (HTTP ${response.status}).`);
    }
    throw unconfirmedDelivery();
  }

  return parseReceipt(result, recipient, fileName, bytes.length, caption);
}
