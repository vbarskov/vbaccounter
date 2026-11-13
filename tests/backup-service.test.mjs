import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createService } from '../lib/service.mjs';

const recipient = `age1${'q'.repeat(58)}`;
const token = '123456789:example-test-token';
const bin = '123456789012';
const otherBin = '234567890123';
const scope = { bin };
const settings = { ...scope, bot: 'default', chatId: '123456789', recipient };

async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'vb-backup-service-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const accountingPath = join(stateDir, 'book.json');
  await writeFile(accountingPath, JSON.stringify({ version: 6, accounts: [
    { id: 'one', name: 'First', data: { company: { bin } } },
    { id: 'two', name: 'Second', data: { company: { bin: otherBin } } }
  ] }));
  let now = '2026-11-13T07:00:00.000Z';
  const deliveries = [];
  const relay = {
    available: true, username: '@backup_test_bot', hasProof: async () => true,
    pair: async () => ({ url: 'https://t.me/backup_test_bot?start=example' }),
    verify: async () => {},
    send: async payload => { deliveries.push(payload); return { messageId: 9 }; }
  };
  const backup = {
    accountingPath,
    relay,
    verifyRecipient: async () => {},
    createArchive: async ({ bin: selectedBin }) => ({ bytes: Buffer.from('test'), fileName: `vb-backup-${selectedBin}.tar.gz.age` }),
    sendArchive: async payload => {
      deliveries.push(payload);
      return { messageId: 9 };
    },
    ...options
  };
  const service = () => createService({ stateDir, now: () => new Date(now), backup });
  return { service, stateDir, deliveries, setNow: value => { now = value; } };
}

test('pair and configure the shared bot, then send once per month across services', async t => {
  const { service, stateDir, deliveries, setNow } = await fixture(t);
  assert.equal((await service().call('vb_backup_settings')).bot, 'disabled');
  assert.match((await service().call('vb_backup_pair')).url, /https:\/\/t\.me\//);
  assert.equal((await service().call('vb_backup_settings', settings)).ready, true);
  assert.equal(deliveries.length, 0);
  const result = await service().call('vb_send_backup', scope);
  assert.equal(result.status, 'sent');
  assert.equal(result.messageId, 9);
  assert.equal(deliveries[0].token, undefined);
  assert.equal(deliveries[0].chatId, settings.chatId);
  assert.equal((await service().call('vb_send_backup', scope)).status, 'already-sent');
  assert.equal(deliveries.length, 1);
  const state = await readFile(join(stateDir, 'state.json'), 'utf8');
  assert.ok(!state.includes(token));
  setNow('2026-12-01T07:00:00.000Z');
  assert.equal((await service().call('vb_send_backup', scope)).status, 'sent');
  assert.equal(deliveries.length, 2);
});

test('an uncertain result blocks scheduled retries until the user checks their chat', async t => {
  let attempts = 0;
  const { service } = await fixture(t, {
    relay: {
      available: true, hasProof: async () => true, verify: async () => {},
      send: async () => {
        if (++attempts === 1) throw Object.assign(new Error('unconfirmed'), { code: 'telegram-unconfirmed' });
        return { messageId: 9 };
      }
    }
  });
  await service().call('vb_backup_settings', settings);
  await assert.rejects(service().call('vb_send_backup', scope), /не подтвердил/i);
  await assert.rejects(service().call('vb_send_backup', scope), /чат/i);
  assert.equal(attempts, 1);
  assert.equal((await service().call('vb_send_backup', { ...scope, retryUnconfirmed: true })).status, 'sent');
});

test('own bot requires a private token file and the default bot is optional', async t => {
  const { service, stateDir, deliveries } = await fixture(t, { relay: { available: false } });
  assert.equal((await service().call('vb_backup_settings')).defaultBotAvailable, false);
  await assert.rejects(service().call('vb_backup_settings', settings), /по умолчанию/i);
  const own = await service().call('vb_backup_settings', { ...settings, bot: 'own' });
  assert.equal(own.ready, false);
  await assert.rejects(service().call('vb_send_backup', scope), /токен/i);
  await writeFile(join(stateDir, 'telegram-bot-token'), `${token}\n`, { mode: 0o644 });
  assert.equal((await service().call('vb_backup_settings', scope)).ready, false);
  await rm(join(stateDir, 'telegram-bot-token'));
  await writeFile(join(stateDir, 'telegram-bot-token'), `${token}\n`, { mode: 0o600 });
  assert.equal((await service().call('vb_backup_settings', scope)).ready, true);
  await service().call('vb_send_backup', scope);
  assert.equal(deliveries[0].token, token);
});

test('default configuration requires verification of the selected chat', async t => {
  const { service } = await fixture(t, {
    relay: { available: true, verify: async chatId => {
      assert.equal(chatId, settings.chatId);
      throw new Error('Start required');
    } }
  });
  await assert.rejects(service().call('vb_backup_settings', settings), /Start required/);
  assert.equal((await service().call('vb_backup_settings', scope)).bot, 'disabled');
});

test('switching to another chat and back preserves the monthly delivery marker', async t => {
  const { service, deliveries } = await fixture(t);
  await service().call('vb_backup_settings', settings);
  assert.equal((await service().call('vb_send_backup', scope)).status, 'sent');
  await service().call('vb_backup_settings', { ...settings, chatId: '234567890' });
  assert.equal((await service().call('vb_send_backup', scope)).status, 'sent');
  await service().call('vb_backup_settings', settings);
  assert.equal((await service().call('vb_send_backup', scope)).status, 'already-sent');
  assert.deepEqual(deliveries.map(item => item.chatId), [settings.chatId, '234567890']);
});

test('requires explicit company selection and tracks two companies separately in the same chat', async t => {
  const { service, deliveries } = await fixture(t);
  await assert.rejects(service().call('vb_send_backup'), /БИН/);
  await assert.rejects(service().call('vb_backup_settings', { ...settings, bin: '000000000000' }), /карточки/);
  await service().call('vb_backup_settings', settings);
  await service().call('vb_backup_settings', { ...settings, bin: otherBin });
  assert.deepEqual((await service().call('vb_backup_settings')).configuredCompanies, [bin, otherBin]);
  assert.equal((await service().call('vb_send_backup', scope)).status, 'sent');
  assert.equal((await service().call('vb_send_backup', { bin: otherBin })).status, 'sent');
  assert.equal((await service().call('vb_send_backup', scope)).status, 'already-sent');
  await service().call('vb_backup_settings', { ...scope, bot: 'disabled' });
  assert.equal((await service().call('vb_send_backup', scope)).status, 'disabled');
  assert.equal((await service().call('vb_send_backup', { bin: otherBin })).status, 'already-sent');
  assert.deepEqual(deliveries.map(item => item.fileName), [`vb-backup-${bin}.tar.gz.age`, `vb-backup-${otherBin}.tar.gz.age`]);
});
