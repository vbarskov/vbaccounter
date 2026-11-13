import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { createBackupArchive } from '../lib/backup-archive.mjs';

const recipient = 'age1gde3ncmahlqd9gg50tanl99r960llztrhfapnmx853s4tjum03uqfssgdh';
const withShellFixture = { skip: process.platform === 'win32' };

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'vb-backup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'local plugin');
  const accountingDir = join(root, 'local accounting');
  const workspacePath = join(root, 'export.json');
  await mkdir(stateDir);
  await mkdir(join(accountingDir, 'documents', 'account'), { recursive: true });
  await writeFile(join(stateDir, 'state.json'), '{"version":1}');
  await writeFile(workspacePath, '{"version":6,"journal":["entry"]}');
  await writeFile(join(accountingDir, 'documents', 'account', 'receipt.pdf'), 'receipt');
  const bin = join(root, 'bin');
  await mkdir(bin);
  // The real tar payload reaches the encryption command without a shell or plaintext output file.
  await writeFile(join(bin, 'age'), `#!/bin/sh\n[ "$1" = '-r' ] && [ "$2" = '${recipient}' ] || exit 1\nexec cat\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  return { root, stateDir, accountingDir, workspacePath, recipient };
}

function tar(bytes, ...args) {
  const result = spawnSync('tar', args, { input: bytes, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('backup archives the selected accounting file and both document stores at their restore paths', withShellFixture, async t => {
  const options = await setup(t);
  await mkdir(join(options.stateDir, 'documents'));
  await writeFile(join(options.stateDir, 'documents', 'evidence.bin'), 'evidence');
  await writeFile(join(options.stateDir, 'credentials'), 'excluded');
  const { bytes, fileName } = await createBackupArchive({ ...options, now: new Date('2026-11-13T10:00:00Z') });

  assert.match(fileName, /2026-11-13.*\.tar\.gz\.age$/);
  const files = tar(bytes, '-tzf', '-').split('\n').filter(name => name && !name.endsWith('/'));
  assert.deepEqual(files.sort(), [
    'VB Accounter/documents/evidence.bin',
    'VB Accounter/state.json',
    'VB Accounting/documents/account/receipt.pdf',
    'VB Accounting/vb-accounting.json'
  ].sort());
  assert.equal(tar(bytes, '-xOzf', '-', 'VB Accounting/vb-accounting.json'), '{"version":6,"journal":["entry"]}');
  assert.equal(tar(bytes, '-xOzf', '-', 'VB Accounter/documents/evidence.bin'), 'evidence');
});

test('backup accepts empty document stores but fails if required accounting data is missing or a document is a symlink', withShellFixture, async t => {
  const options = await setup(t);
  const { stateDir, accountingDir, workspacePath, root } = options;
  assert.doesNotMatch(tar((await createBackupArchive(options)).bytes, '-tzf', '-'), /VB Accounter\/documents\//);
  await assert.rejects(createBackupArchive({ ...options, workspacePath: undefined }), /vb-accounting\.json/);
  await mkdir(join(stateDir, 'documents'));
  await symlink(workspacePath, join(stateDir, 'documents', 'link.json'));
  await assert.rejects(createBackupArchive(options), /ссылк/i);
  await rm(join(stateDir, 'documents', 'link.json'));
  await writeFile(join(accountingDir, 'vb-accounting.json'), '{"version":6}');
  await assert.rejects(createBackupArchive({ ...options, workspacePath: root }), /файл/i);
});

test('a company backup has its BIN in the filename and only its files inside', withShellFixture, async t => {
  const options = await setup(t);
  const { stateDir, accountingDir, workspacePath } = options;
  const bin = '123456789012';
  const otherBin = '234567890123';
  const documentId = 'ba9b4131-94c9-4aef-82a0-3c11b6d92888';
  const otherDocumentId = 'a32c098a-4ecf-4cf0-99fb-366f553fc90d';
  const accounts = [
    { id: 'first', name: 'First', data: { company: { bin } } },
    { id: 'second', name: 'Second', data: { company: { bin: otherBin } } }
  ];
  const localDocuments = join(stateDir, 'documents');
  await mkdir(localDocuments);
  for (const id of [documentId, otherDocumentId]) await writeFile(join(localDocuments, `${id}.bin`), id);
  await writeFile(join(stateDir, 'state.json'), JSON.stringify({
    version: 1, accounts, obligations: [], notifications: [], audit: [], settings: { enabled: true, leadDays: [14] },
    overrides: {
      'first\nmanual:one': { evidence: { path: join(localDocuments, `${documentId}.bin`) } },
      'second\nmanual:two': { evidence: { path: join(localDocuments, `${otherDocumentId}.bin`) } }
    }
  }));
  await writeFile(workspacePath, JSON.stringify({ version: 6, activeAccountId: 'second', accounts }));
  const staleDocDir = join(accountingDir, 'documents', createHash('sha256').update('second').digest('hex'));
  await mkdir(staleDocDir);
  await writeFile(join(staleDocDir, 'foreign.pdf'), 'another company');
  const { bytes, fileName } = await createBackupArchive({ ...options, bin, now: new Date('2026-11-13T10:00:00Z') });
  assert.equal(fileName, `vb-backup-${bin}-2026-11-13.tar.gz.age`);
  const files = tar(bytes, '-tzf', '-').split('\n').filter(name => name && !name.endsWith('/'));
  assert.deepEqual(files.sort(), [
    `VB Accounter/documents/${documentId}.bin`, 'VB Accounter/state.json', 'VB Accounting/vb-accounting.json'
  ].sort());
  const restored = JSON.parse(tar(bytes, '-xOzf', '-', 'VB Accounting/vb-accounting.json'));
  assert.deepEqual(restored.accounts.map(account => account.id), ['first']);
  assert.equal(restored.activeAccountId, 'first');
});
