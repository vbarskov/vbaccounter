import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { createBackupArchive, isBackupRecipient, verifyBackupRecipient } from './backup-archive.mjs';
import { isCompanyBin, listBackupCompanies } from './backup-company.mjs';
import { createBackupRelayClient } from './backup-relay-client.mjs';
import { isTelegramBotToken, parseTelegramChatId, sendTelegramBackup } from './backup-telegram.mjs';
import { readRegular } from './storage.mjs';

const activeAttemptMs = 10 * 60_000;

async function readPrivateToken(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 512 || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) return null;
    const buffer = Buffer.alloc(513);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead > 512) return null;
    const value = buffer.toString('utf8', 0, bytesRead).trim();
    return isTelegramBotToken(value) ? value : null;
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

function isRegularFile(path) {
  return path ? lstat(path).then(stat => stat.isFile(), () => false) : false;
}

async function readCompanies(path) {
  let workspace;
  try {
    workspace = JSON.parse(await readRegular(path));
  } catch {
    throw new Error('Не удалось прочитать файл VB Accounting для резервного копирования.');
  }
  return listBackupCompanies(workspace);
}

function deliverySummary(delivery) {
  if (!delivery) return null;
  const { status, month, bin, messageId, sentAt, fileName } = delivery;
  return { status, month, bin, messageId, sentAt, fileName };
}

function assertAvailable(delivery, now) {
  if (delivery?.status === 'sending' && now.getTime() - Date.parse(delivery.startedAt) < activeAttemptMs) {
    throw new Error('Резервная копия уже отправляется. Дождитесь результата.');
  }
}

export function createBackupService(storage, {
  env = process.env,
  accountingPath = platform() === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'VB Accounting', 'vb-accounting.json') : null,
  verifyRecipient = verifyBackupRecipient,
  createArchive = createBackupArchive,
  sendArchive = sendTelegramBackup,
  relay = createBackupRelayClient({ stateDir: storage.stateDir, env })
} = {}) {
  const ownBotTokenPath = join(storage.stateDir, 'telegram-bot-token');

  function context(state, bin) {
    const { companies = {}, deliveries = [] } = state.backup ?? {};
    const config = companies[bin] ?? null;
    const delivery = deliveries.find(item => item.bin === bin && item.bot === config?.bot && item.chatId === config?.chatId) ?? null;
    return { bin, config, delivery, deliveries, companies, source: state.workspace?.path ?? accountingPath };
  }

  async function describe({ bin, config, delivery, source, companies }) {
    const bot = config?.bot ?? 'disabled';
    const [credential, sourceExists] = await Promise.all([
      bot === 'default' ? relay.hasProof() : bot === 'own' ? readPrivateToken(ownBotTokenPath) : null,
      isRegularFile(source)
    ]);
    const availableCompanies = sourceExists ? await readCompanies(source) : [];
    const accountingReady = bin === undefined ? sourceExists : availableCompanies.some(item => item.bin === bin);
    return {
      bin: bin ?? null, bot, chatId: config?.chatId ?? null, recipient: config?.recipient ?? null,
      defaultBotAvailable: relay.available, defaultBotUsername: relay.username,
      ownBotTokenPath, tokenReady: Boolean(credential), accountingPath: source, accountingReady,
      availableCompanies, configuredCompanies: Object.keys(companies).sort(),
      lastDelivery: deliverySummary(delivery), ready: Boolean(config && credential && accountingReady)
    };
  }

  async function settings(args, now) {
    const { bin } = args;
    if ((bin !== undefined || args.bot !== undefined) && !isCompanyBin(bin)) {
      throw new Error('Выберите юрлицо и укажите БИН из 12 цифр.');
    }
    if (args.bot === undefined && (args.chatId !== undefined || args.recipient !== undefined)) {
      throw new Error('Для настройки укажите тип бота.');
    }
    const snapshot = await storage.transaction(state => context(state, bin));
    if (args.bot === undefined) return describe(snapshot);
    let chatId;
    if (args.bot === 'own' || args.bot === 'default') {
      chatId = parseTelegramChatId(args.chatId);
      if (!isBackupRecipient(args.recipient)) throw new Error('Укажите публичный ключ age в формате age1…');
      if (args.bot === 'default') {
        if (!relay.available) throw new Error('Общий сервис бота по умолчанию пока недоступен.');
      }
      if (!(await readCompanies(snapshot.source)).some(item => item.bin === bin)) {
        throw new Error('В VB Accounting нет однозначной рабочей карточки с указанным БИН.');
      }
      if (args.bot === 'default') await relay.verify(chatId);
      await verifyRecipient(args.recipient);
    }
    const saved = await storage.transaction(state => {
      const previous = context(state, bin);
      if (previous.source !== snapshot.source) throw new Error('Источник изменился во время настройки. Повторите настройку.');
      for (const delivery of previous.deliveries) assertAvailable(delivery, now);
      const companies = { ...previous.companies };
      if (args.bot === 'disabled') {
        if (args.chatId !== undefined || args.recipient !== undefined) {
          throw new Error('Для отключения укажите БИН и bot: disabled.');
        }
        delete companies[bin];
      } else {
        if (args.bot !== 'default' && args.bot !== 'own') throw new Error('Выберите бота: default, own или disabled.');
        companies[bin] = { bot: args.bot, chatId, recipient: args.recipient };
      }
      state.backup = { companies, deliveries: previous.deliveries };
      return context(state, bin);
    });
    return describe(saved);
  }

  function skipDelivery({ delivery, deliveries }, month, now, retryUnconfirmed) {
    for (const attempt of deliveries) assertAvailable(attempt, now);
    if (delivery?.month !== month) return null;
    if (delivery.status === 'sent') return { ...deliverySummary(delivery), status: 'already-sent' };
    if (!retryUnconfirmed) throw new Error('Исход прошлой отправки неизвестен. Проверьте личный чат перед повтором.');
    return null;
  }

  async function send(args, now) {
    const { bin } = args;
    if (!isCompanyBin(bin)) throw new Error('Для отправки укажите БИН юрлица из 12 цифр.');
    if (args.retryUnconfirmed !== undefined && typeof args.retryUnconfirmed !== 'boolean') {
      throw new Error('retryUnconfirmed должен быть true или false.');
    }
    const month = now.toISOString().slice(0, 7);
    const snapshot = await storage.transaction(state => context(state, bin));
    const { config, source } = snapshot;
    if (!config) return { status: 'disabled', month, bin };
    const skipped = skipDelivery(snapshot, month, now, args.retryUnconfirmed);
    if (skipped) return skipped;
    const token = config.bot === 'own' ? await readPrivateToken(ownBotTokenPath) : null;
    if (config.bot === 'own' && !token) throw new Error('Токен выбранного Telegram-бота отсутствует или недоступен.');
    if (config.bot === 'default') await relay.verify(config.chatId);
    if (!(await isRegularFile(source))) throw new Error('Файл VB Accounting недоступен. Укажите источник в настройках плагина.');
    const archive = await createArchive({
      stateDir: storage.stateDir, accountingDir: dirname(source), workspacePath: source, recipient: config.recipient, bin, now
    });

    const target = { bot: config.bot, chatId: config.chatId, bin };
    const attempt = { status: 'sending', month, ...target, startedAt: now.toISOString(), id: randomUUID() };
    const prior = await storage.transaction(state => {
      const latest = context(state, bin);
      if (JSON.stringify(latest.config) !== JSON.stringify(config) || latest.source !== source) {
        throw new Error('Настройки изменились во время создания архива. Запустите резервное копирование снова.');
      }
      const skipped = skipDelivery(latest, month, now, args.retryUnconfirmed);
      if (skipped) return { skipped };
      state.backup.deliveries = latest.deliveries.filter(item => item.month === month && item !== latest.delivery);
      state.backup.deliveries.push(attempt);
      return { delivery: latest.delivery };
    });
    if (prior.skipped) return prior.skipped;

    const finish = delivery => storage.transaction(state => {
      const index = state.backup.deliveries.findIndex(item => item.id === attempt.id);
      if (index < 0) throw new Error('Запись об отправке изменилась. Проверьте личный чат.');
      state.backup.deliveries.splice(index, 1, ...(delivery ? [delivery] : []));
    });
    let receipt;
    try {
      const payload = { chatId: config.chatId, ...archive };
      receipt = config.bot === 'default' ? await relay.send(payload) : await sendArchive({ token, ...payload });
    } catch (error) {
      if (['telegram-rejected', 'telegram-preflight', 'relay-unpaired', 'relay-rate-limited', 'relay-invalid-request'].includes(error.code)) {
        await finish(prior.delivery);
        throw error;
      }
      await finish({ ...attempt, status: 'unconfirmed' });
      throw new Error('Telegram не подтвердил отправку архива. Проверьте личный чат перед повтором.');
    }
    const delivered = { status: 'sent', month, ...target, messageId: receipt.messageId,
      sentAt: receipt.sentAt ?? now.toISOString(), fileName: archive.fileName };
    await finish(delivered);
    return delivered;
  }

  async function pair(args, now) {
    if (args.reset !== undefined && typeof args.reset !== 'boolean') throw new Error('reset должен быть true или false.');
    return storage.transaction(state => {
      if (args.reset) {
        for (const delivery of context(state).deliveries) assertAvailable(delivery, now);
      }
      return relay.pair(args.reset);
    });
  }

  return { settings, send, pair };
}
