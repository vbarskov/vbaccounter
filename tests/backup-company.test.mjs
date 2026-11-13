import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { sha256 } from '../lib/storage.mjs';
import { listBackupCompanies, projectCompanyBackup } from '../lib/backup-company.mjs';

const bin = '100000000001';
const foreignBin = '100000000002';
const stateDir = resolve('sample VB Accounter');
const workspacePath = resolve('sample VB Accounting', 'vb-accounting.json');
const connectedId = `workspace:${sha256(workspacePath).slice(0, 12)}:accounting-company`;
const ownDocument = '10000000-0000-4000-a000-000000000001.bin';
const linkedDocument = '10000000-0000-4000-a000-000000000002.bin';
const foreignDocument = '10000000-0000-4000-a000-000000000003.bin';
const accountingDocumentId = '10000000-0000-4000-a000-000000000004';
const ownPath = join(stateDir, 'documents', ownDocument);
const linkedPath = join(stateDir, 'documents', linkedDocument);
const foreignPath = join(stateDir, 'documents', foreignDocument);

const account = (id, companyBin, data = {}, isDemo = false) => ({
  id, name: id, isDemo, data: { company: { bin: companyBin }, ...data }
});

function sample() {
  const state = {
    version: 1,
    accounts: [account('local-company', bin), account('foreign-company', foreignBin), account('demo', bin, {}, true)],
    workspace: { path: workspacePath, connectedAt: '2026-11-13T00:00:00Z' },
    obligations: [{ id: 'own', accountId: 'local-company' }, { id: 'connected', accountId: connectedId }, { id: 'foreign', accountId: 'foreign-company' }],
    overrides: {
      'local-company\nown': { evidence: { path: ownPath } },
      [`${connectedId}\nconnected`]: { notes: `[сохранённый документ](<${linkedPath}>)` },
      'foreign-company\nforeign': { evidence: { path: foreignPath } }
    },
    notifications: [{ id: 'own-notice', accountId: connectedId }, { id: 'foreign-notice', accountId: 'foreign-company' }],
    settings: { enabled: true, leadDays: [14, 7], foreign: 'sensitive' },
    audit: [
      { id: 'created', action: 'create-company', accountId: 'local-company' },
      { id: 'linked', action: 'update-obligation', accountId: connectedId },
      { id: 'foreign-event', action: 'update-obligation', accountId: 'foreign-company', notes: 'sensitive' },
      { id: 'generated', action: 'produce-notifications', notificationIds: ['own-notice', 'foreign-notice'] },
      { id: 'ack', action: 'ack-notification', notificationId: 'own-notice' },
      { id: 'global', action: 'connect-workspace', path: 'sensitive' }
    ],
    backup: { config: { chatId: '12345', bin: foreignBin } }
  };
  const workspace = {
    version: 6, activeAccountId: 'foreign-accounting-company', privateSetting: 'sensitive',
    accounts: [
      account('foreign-accounting-company', foreignBin, { transactions: ['foreign-transaction'] }),
      account('accounting-company', bin, {
        journal: [{ id: 'selected-journal-entry' }],
        bankStatements: [{ id: accountingDocumentId, ext: '.xls' }],
        reporting: { documents: [{ id: 'embedded-document', base64: 'dGVzdA==' }] }
      }),
      account('accounting-demo', bin, {}, true)
    ]
  };
  return { state, workspace, bin, stateDir, workspacePath };
}

test('projects one company across both databases, audit, notifications and document references', () => {
  const input = sample();
  const projected = projectCompanyBackup(input);
  assert.deepEqual(listBackupCompanies(input.workspace), [
    { bin: foreignBin, name: 'foreign-accounting-company' }, { bin, name: 'accounting-company' }
  ]);
  assert.deepEqual(projected.state.accounts.map(row => row.id), ['local-company']);
  assert.deepEqual(projected.state.obligations.map(row => row.id), ['own', 'connected']);
  assert.deepEqual(Object.keys(projected.state.overrides), ['local-company\nown', `${connectedId}\nconnected`]);
  assert.deepEqual(projected.state.notifications.map(row => row.id), ['own-notice']);
  assert.deepEqual(projected.state.audit.map(row => row.id), ['created', 'linked', 'generated', 'ack']);
  assert.deepEqual(projected.state.audit[2].notificationIds, ['own-notice']);
  assert.deepEqual(projected.state.workspace, input.state.workspace);
  assert.deepEqual(projected.state.settings, { enabled: true, leadDays: [14, 7] });
  assert.equal(projected.state.backup, undefined);
  assert.deepEqual(projected.workspace, { version: 6, activeAccountId: 'accounting-company', accounts: [input.workspace.accounts[1]] });
  assert.deepEqual(projected.pluginDocuments, [ownDocument, linkedDocument]);
  assert.deepEqual(projected.accountingDocuments, [join(sha256('accounting-company'), `${accountingDocumentId}.xls`)]);
  assert.ok(!JSON.stringify(projected).includes('sensitive'));
  assert.equal(input.state.audit[3].notificationIds.length, 2);
});

test('ignores duplicate BINs, refuses ambiguous backup, and supports connected company without local card', () => {
  const input = sample();
  input.state.accounts = [];
  const connected = projectCompanyBackup(input);
  assert.deepEqual(connected.state.accounts, []);
  assert.deepEqual(connected.state.obligations.map(row => row.id), ['connected']);
  assert.deepEqual(connected.pluginDocuments, [linkedDocument]);

  input.workspace.accounts.push(account('duplicate', bin));
  assert.deepEqual(listBackupCompanies(input.workspace), [{ bin: foreignBin, name: 'foreign-accounting-company' }]);
  assert.throws(() => projectCompanyBackup(input), /БИН/);
});

test('rejects mixed ownership and unsafe attachment metadata', () => {
  const input = sample();
  input.state.accounts[1].id = input.state.accounts[0].id;
  assert.throws(() => projectCompanyBackup(input), /Неоднозначная карточка/);
  input.state.accounts[1].id = 'foreign-company';
  input.state.overrides['foreign-company\nforeign'].evidence.path = ownPath;
  assert.throws(() => projectCompanyBackup(input), /несколькими ТОО/);
  input.state.overrides['foreign-company\nforeign'].evidence.path = foreignPath;
  input.workspace.accounts[1].data.bankStatements[0].id = '../some-other-company';
  assert.throws(() => projectCompanyBackup(input), /вложения/);
});
