import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configureMacRelay, launchAgentPlist, registerWebhook, readMacRelayConfig } from '../scripts/macos-backup-relay.mjs';

const token = '123456789:fixture-token';
const origin = 'https://relay.example';

test('configuration keeps secrets private and the LaunchAgent contains only local paths', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vb-mac-relay-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  assert.equal((await configureMacRelay({ configPath, token })).publicUrl, null);
  const options = { configPath, publicUrl: origin, token };
  const config = await configureMacRelay(options);
  assert.equal(config.publicUrl, origin);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  const newConfig = await configureMacRelay({ ...options, token: '123456789:fixture-replacement' });
  assert.equal(newConfig.webhookSecret, config.webhookSecret);
  const plist = launchAgentPlist({ nodePath: '/opt/homebrew/bin/node', scriptPath: '/Users/Test & Co/relay.mjs', relayDir: dir });
  assert.match(plist, /Test &amp; Co/);
  assert.ok(!plist.includes(token));
  assert.ok(!plist.includes(config.webhookSecret));
  assert.match(await readFile(configPath, 'utf8'), /fixture-replacement/);
  await chmod(configPath, 0o644);
  await assert.rejects(readMacRelayConfig(configPath), /0600/);
});

test('checks both endpoints and only replaces an existing Telegram webhook when requested', async () => {
  const calls = [];
  const config = { token, publicUrl: origin, webhookSecret: 'test-webhook-secret' };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/healthz')) return Response.json({ ok: true, service: 'vbaccounter-telegram-relay', instance: 'fixture' });
    if (url.endsWith('/getMe')) return Response.json({ ok: true, result: { username: 'backup_test_bot' } });
    if (url.endsWith('/getWebhookInfo')) return Response.json({ ok: true, result: { url: 'https://old.example/hook' } });
    if (url.endsWith('/setWebhook')) return Response.json({ ok: true, result: true });
    throw new Error('unexpected request');
  };
  await assert.rejects(registerWebhook(config, { fetchImpl }), /уже настроен/);
  assert.ok(!calls.some(call => call.url.endsWith('/setWebhook')));
  assert.ok(calls.some(call => call.url === 'http://127.0.0.1:8787/healthz'));
  assert.ok(calls.some(call => call.url === `${origin}/healthz`));
  const result = await registerWebhook(config, { fetchImpl, replace: true });
  assert.equal(result.botUsername, 'backup_test_bot');
  const request = calls.find(call => call.url.endsWith('/setWebhook'));
  assert.deepEqual(JSON.parse(request.options.body), {
    url: `${origin}/v1/telegram/webhook`, secret_token: config.webhookSecret, allowed_updates: ['message']
  });
});
