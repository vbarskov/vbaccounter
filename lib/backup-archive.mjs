import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { projectCompanyBackup } from './backup-company.mjs';
import { telegramDocumentLimit } from './backup-telegram.mjs';
import { readRegular } from './storage.mjs';

export function isBackupRecipient(value) {
  return typeof value === 'string'
    && /^age1(?:[023456789acdefghjklmnpqrstuvwxyz]{58}|pq1[023456789acdefghjklmnpqrstuvwxyz]{100,2500})$/.test(value);
}

async function readBackupFile(path) {
  try {
    return await readRegular(path);
  } catch (error) {
    throw new Error(`Не удалось прочитать файл для резервной копии: ${path}.`, { cause: error });
  }
}

async function stageDocuments(source, destination) {
  const stat = await lstat(source).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error(`Каталог документов должен быть обычным каталогом: ${source}.`);
  await mkdir(destination, { mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const input = join(source, entry.name);
    const output = join(destination, entry.name);
    if (entry.isDirectory()) {
      await stageDocuments(input, output);
    } else if (entry.isFile()) {
      await writeFile(output, await readBackupFile(input), { mode: 0o600 });
    } else {
      throw new Error(`В каталоге документов есть ссылка или специальный файл: ${input}.`);
    }
  }
}

async function readSnapshot(source) {
  const data = await readBackupFile(source);
  try {
    return { source, data, json: JSON.parse(data) };
  } catch (error) {
    throw new Error(`Не удалось прочитать JSON для резервной копии: ${source}.`, { cause: error });
  }
}

async function stageSelectedDocuments(source, destination, files) {
  if (!files.length) return;
  const directories = new Set();
  for (const file of files) {
    const parent = dirname(file);
    for (const relative of new Set(['.', parent])) {
      if (directories.has(relative)) continue;
      const input = join(source, relative);
      if (!(await lstat(input)).isDirectory()) throw new Error(`Каталог документов должен быть обычным каталогом: ${input}.`);
      directories.add(relative);
    }
    const output = join(destination, parent, basename(file));
    await mkdir(dirname(output), { mode: 0o700, recursive: true });
    await writeFile(output, await readBackupFile(join(source, file)), { mode: 0o600 });
  }
}

async function stageApplication(root, name, dataFile, data, documentDir, files) {
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, dataFile), data, { mode: 0o600 });
  const source = join(documentDir, 'documents');
  const target = join(directory, 'documents');
  if (files) await stageSelectedDocuments(source, target, files);
  else await stageDocuments(source, target);
}

function runBackupCommand(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      encoding: 'buffer',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, COPYFILE_DISABLE: '1' },
      maxBuffer: telegramDocumentLimit,
      timeout: 120_000,
      windowsHide: true
    }, (error, output) => {
      if (!error) return resolve(output);
      if (error.code === 'ENOENT') {
        return reject(new Error(`Для создания резервной копии установите ${command}.`, { cause: error }));
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return reject(new Error('Резервная копия превышает лимит Telegram в 50 МБ.', { cause: error }));
      }
      reject(new Error(`Не удалось создать резервную копию: ошибка ${command}.`, { cause: error }));
    });
    child.stdin.on('error', error => {
      // An early process exit can close stdin before Node finishes writing the archive.
      if (error.code !== 'EPIPE') reject(new Error(`Не удалось передать данные в ${command}.`, { cause: error }));
    });
    child.stdin.end(input);
  });
}

function encryptBackup(recipient, archive) {
  if (!isBackupRecipient(recipient)) throw new Error('Укажите публичный ключ age в формате age1…');
  return runBackupCommand('age', ['-r', recipient], archive);
}

export async function verifyBackupRecipient(recipient) {
  await encryptBackup(recipient, Buffer.alloc(0));
}

export async function createBackupArchive({ stateDir, accountingDir, workspacePath, recipient, bin, now = new Date() }) {
  if (!isBackupRecipient(recipient)) throw new Error('Укажите публичный ключ age в формате age1…');
  if (![stateDir, accountingDir, workspacePath ?? accountingDir].every(path => typeof path === 'string' && isAbsolute(path))) {
    throw new Error('Для резервной копии требуются абсолютные пути к данным VB Accounter и VB Accounting.');
  }
  const date = now.toISOString().slice(0, 10);
  const sourcePath = workspacePath ?? join(accountingDir, 'vb-accounting.json');
  const snapshots = [await readSnapshot(join(stateDir, 'state.json')), await readSnapshot(sourcePath)];
  const [state, workspace] = snapshots;
  const company = bin === undefined ? null : projectCompanyBackup({
    state: state.json, workspace: workspace.json, bin, stateDir, workspacePath: sourcePath
  });
  let fileName = `vb-backup-${date}.tar.gz.age`;
  let caption;
  if (company) {
    const companyName = (company.state.accounts[0]?.name?.trim() || company.workspace.accounts[0].name)
      .toWellFormed().trim().replace(/\s+/gu, ' ');
    const slug = companyName.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^[^\p{L}\p{N}]+/u, '');
    const nameInFile = [...slug].slice(0, 48).join('').replace(/-$/g, '') || 'company';
    fileName = `${nameInFile}-${bin}-${date}.tar.gz.age`;
    const nameInCaption = [...companyName].slice(0, 200).join('');
    caption = `${nameInCaption} · БИН ${bin}`;
  }
  const root = await mkdtemp(join(tmpdir(), 'vb-backup-'));
  try {
    await stageApplication(root, 'VB Accounter', 'state.json', company ? JSON.stringify(company.state) : state.data,
      stateDir, company?.pluginDocuments);
    await stageApplication(root, 'VB Accounting', 'vb-accounting.json', company ? JSON.stringify(company.workspace) : workspace.data,
      accountingDir, company?.accountingDocuments);
    for (const { source, data } of snapshots) {
      if (!data.equals(await readBackupFile(source))) {
        throw new Error('Данные изменились во время создания резервной копии. Повторите запуск.');
      }
    }
    const archive = await runBackupCommand('tar', ['-czf', '-', '-C', root, 'VB Accounter', 'VB Accounting']);
    const bytes = await encryptBackup(recipient, archive);
    return { bytes, fileName, ...(caption ? { caption } : {}) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
