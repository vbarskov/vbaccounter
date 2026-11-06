import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { join, isAbsolute, resolve, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readRegular(path, maxBytes = 50 * 1024 * 1024) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error('Укажите абсолютный путь к обычному файлу.');
  }
  // Opening a FIFO must not block before we can reject it with stat().
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error(`Нужен обычный regular file размером до ${maxBytes} байт.`);
    }
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error('Файл слишком большой.');
    return bytes;
  } finally {
    await handle.close();
  }
}

const initial = () => ({
  version: 1,
  accounts: [],
  workspace: null,
  obligations: [],
  overrides: {},
  notifications: [],
  settings: { enabled: true, leadDays: [30, 14, 7, 1, 0] },
  audit: []
});

function parseState(bytes) {
  let state;
  try {
    state = JSON.parse(bytes);
  } catch {
    throw new Error('Повреждён JSON состояния плагина. Исходный файл сохранён; восстановите его из своей резервной копии.');
  }
  const requiredArrays = ['accounts', 'obligations', 'notifications', 'audit'];
  const valid = state?.version === 1
    && requiredArrays.every(key => Array.isArray(state[key]))
    && state.settings
    && typeof state.settings.enabled === 'boolean'
    && Array.isArray(state.settings.leadDays)
    && state.overrides
    && typeof state.overrides === 'object'
    && !Array.isArray(state.overrides);
  if (!valid) throw new Error('Повреждено состояние плагина.');
  return state;
}

async function removeIfExists(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function ensurePrivateDirectory(path, message) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(message);
}

async function writeExclusive(path, bytes, sync = false) {
  const handle = await open(path, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      if (sync) await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await removeIfExists(path);
    throw error;
  }
}

export function createStorage(stateDir) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) {
    throw new Error('stateDir должен быть абсолютным путём.');
  }
  const dir = resolve(stateDir);
  const file = join(dir, 'state.json');
  const lock = join(dir, '.state.lock');

  async function ensureDir() {
    await ensurePrivateDirectory(dir, 'Каталог состояния не должен быть символической ссылкой.');
  }

  async function acquire() {
    const start = Date.now();
    for (;;) {
      try {
        const metadata = { pid: process.pid, createdAt: new Date().toISOString() };
        await writeExclusive(lock, JSON.stringify(metadata));
        return () => unlink(lock);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() - start > 10000) {
          throw new Error(`Состояние занято другим процессом. Если он завершился аварийно, проверьте PID в ${lock} перед ручным удалением блокировки.`);
        }
        await pause(20 + Math.random() * 30);
      }
    }
  }

  async function readState() {
    try {
      return parseState(await readRegular(file));
    } catch (error) {
      if (error.code === 'ENOENT') return initial();
      throw error;
    }
  }

  async function writeState(state) {
    const temp = join(dir, `.state-${randomUUID()}.tmp`);
    try {
      await writeExclusive(temp, JSON.stringify(state, null, 2) + '\n', true);
      await rename(temp, file);
    } finally {
      await removeIfExists(temp);
    }
  }

  async function transaction(action) {
    await ensureDir();
    const release = await acquire();
    try {
      const state = await readState();
      const previous = JSON.stringify(state);
      const result = await action(state);
      if (JSON.stringify(state) !== previous) await writeState(state);
      return result;
    } finally {
      await release();
    }
  }

  async function saveEvidence(path, now) {
    const bytes = await readRegular(path, 10 * 1024 * 1024);
    const hash = sha256(bytes);
    const documents = join(dir, 'documents');
    await ensurePrivateDirectory(documents, 'Каталог документов не должен быть символической ссылкой.');
    const output = join(documents, `${randomUUID()}.bin`);
    await writeExclusive(output, bytes, true);
    return {
      path: output,
      name: basename(path),
      sha256: hash,
      size: bytes.length,
      savedAt: now.toISOString(),
      verification: 'user-supplied',
      notice: 'Файл предоставлен пользователем; государственный приём или платёж автоматически не проверялся.'
    };
  }

  return { transaction, saveEvidence, stateDir: dir };
}
