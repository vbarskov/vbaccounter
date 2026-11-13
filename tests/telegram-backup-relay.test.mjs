import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createTelegramBackupRelay } from '../scripts/telegram-backup-relay.mjs';
import { createBackupRelayClient } from '../lib/backup-relay-client.mjs';

const token = '123456:Example_token-for-tests';
const webhookSecret = 'test-webhook-secret';
const bearer = Buffer.alloc(32, 1).toString('base64url');
const digest = createHash('sha256').update(bearer).digest('base64url');
const chatId = '1234567';
const time = new Date('2026-11-13T12:00:00Z');
const archive = Buffer.from('age-encryption.org/v1\nfixture');

async function fixture(t, overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'vbaccounter-relay-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const uploads = [];
  const server = await createTelegramBackupRelay({
    token, webhookSecret, stateDir, now: () => time,
    sendBackup: async args => {
      uploads.push(args);
      return { messageId: 99, sentAt: time.toISOString() };
    },
    ...overrides
  });
  const post = async (path, options) => {
    const input = new Request(`https://test.invalid${path}`, { method: 'POST', ...options });
    const request = Readable.fromWeb(input.body);
    request.method = input.method;
    request.url = path;
    request.headers = Object.fromEntries(input.headers);
    return new Promise(resolve => {
      let responseStatus;
      let responseHeaders;
      const response = {
        writeHead(status, headers) {
          responseStatus = status;
          responseHeaders = headers;
        },
        end(body) {
          resolve(new Response(body, { status: responseStatus, headers: responseHeaders }));
        }
      };
      server.emit('request', request, response);
    });
  };
  const update = (secret, values = {}) => post('/v1/telegram/webhook', {
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify({ update_id: 10, message: {
      message_id: 10, date: time.getTime() / 1000, text: `/start ${digest}`,
      chat: { id: Number(chatId), type: 'private' }, from: { id: Number(chatId), is_bot: false }, ...values
    } })
  });
  const pair = (id = chatId, key = bearer) => post('/v1/pair', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ chat_id: id })
  });
  const send = (id = chatId, bytes = archive, key = bearer) => {
    const body = new FormData();
    body.set('chat_id', id);
    body.set('document', new Blob([bytes]), 'vb-backup-2026-11-13.tar.gz.age');
    return post('/v1/backups', { headers: { authorization: `Bearer ${key}` }, body });
  };
  return { update, pair, send, uploads, stateDir, post };
}

test('the plugin deep link pairs with the shared relay and uploads to the selected chat', async t => {
  const { update, uploads, stateDir, post } = await fixture(t);
  const client = createBackupRelayClient({ stateDir, env: {
    VBACCOUNTER_TELEGRAM_RELAY_URL: 'https://test.invalid',
    VBACCOUNTER_TELEGRAM_DEFAULT_BOT_USERNAME: 'backup_test_bot'
  }, fetchImpl: (url, options) => post(new URL(url).pathname, options) });
  assert.equal(client.available, true);
  assert.equal(await client.hasProof(), false);
  const link = await client.pair();
  const challenge = new URL(link.url).searchParams.get('start');
  const proof = await readFile(join(stateDir, 'telegram-default-pairing-key'), 'utf8');
  assert.notEqual(challenge, proof);
  assert.equal(await client.hasProof(), true);
  await assert.rejects(client.verify(chatId), /Start/);
  await update(webhookSecret, { text: `/start ${challenge}` });
  await client.verify(chatId);
  await assert.rejects(client.verify('999999'), /chat_id/);
  assert.equal(uploads.length, 0);
  const receipt = await client.send({ chatId, bytes: archive, fileName: 'vb-backup-2026-11-13.tar.gz.age' });
  assert.equal(receipt.messageId, 99);
  assert.deepEqual(uploads[0].bytes, archive);
});

test('accepts only a verified private start, binds the proof to the chat, and throttles backup uploads', async t => {
  const { update, pair, send, uploads, stateDir } = await fixture(t);
  assert.equal((await pair()).status, 401);
  assert.equal((await update('wrong-secret')).status, 401);
  assert.equal((await update(webhookSecret, { chat: { id: -1, type: 'group' } })).status, 200);
  assert.equal((await pair()).status, 401);
  assert.equal((await update(webhookSecret)).status, 200);
  assert.deepEqual(await (await pair()).json(), { ok: true });
  assert.equal((await pair('999999')).status, 401);
  assert.equal((await send('999999')).status, 401);
  assert.equal((await send(chatId, Buffer.from('not age-encrypted'))).status, 400);
  assert.equal(uploads.length, 0);

  const result = await send();
  assert.deepEqual(await result.json(), { ok: true, messageId: 99, sentAt: time.toISOString() });
  assert.deepEqual(uploads[0], { token, chatId, bytes: archive, fileName: 'vb-backup-2026-11-13.tar.gz.age' });
  assert.equal((await send()).status, 429);
  assert.equal(uploads.length, 1);
  const state = await readFile(join(stateDir, 'telegram-relay.json'), 'utf8');
  for (const secret of [bearer, token, webhookSecret]) assert.ok(!state.includes(secret));
});

test('ignores stale starts and replayed updates after a new proof replaces the old proof', async t => {
  const { update, pair } = await fixture(t);
  await update(webhookSecret, { date: time.getTime() / 1000 - 3600 });
  assert.equal((await pair()).status, 401);
  await update(webhookSecret);
  assert.equal((await pair()).status, 200);
  const newKey = Buffer.alloc(32, 2).toString('base64url');
  const newDigest = createHash('sha256').update(newKey).digest('base64url');
  await update(webhookSecret, { message_id: 11, text: `/start ${newDigest}` });
  await update(webhookSecret);
  assert.equal((await pair()).status, 401);
  assert.equal((await pair(chatId, newKey)).status, 200);
});

test('reports ambiguous Telegram delivery without leaking thrown details', async t => {
  const { update, send } = await fixture(t, { sendBackup: async () => {
    throw Object.assign(new Error(token), { code: 'telegram-unconfirmed' });
  } });
  await update(webhookSecret);
  const result = await send();
  assert.equal(result.status, 502);
  assert.deepEqual(await result.json(), { ok: false, code: 'telegram-unconfirmed' });
});
