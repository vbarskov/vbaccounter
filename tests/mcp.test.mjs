import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../', import.meta.url));

async function client(t) {
  const state = await mkdtemp(join(tmpdir(), 'vbaccounter-mcp-test-'));
  const child = spawn(process.execPath, [join(root, 'scripts/mcp-server.mjs'), '--data-dir', state], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0;
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      const task = pending.get(message.id);
      if (task) { pending.delete(message.id); task.resolve(message); }
    } catch (error) { for (const task of pending.values()) task.reject(error); }
  });
  child.on('exit', code => {
    for (const task of pending.values()) task.reject(new Error(`MCP exited ${code}: ${stderr}`));
    pending.clear();
  });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); const timer = setTimeout(() => child.kill(), 1000); timer.unref(); });
    lines.close();
    await rm(state, { recursive: true, force: true });
  });
  function request(method, params = {}, raw) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No response to ${method}: ${stderr}`)); }, 5000);
      timer.unref();
      pending.set(id, { resolve: message => { clearTimeout(timer); resolve(message); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(`${raw ?? JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async function initialize(version = '2025-11-25') {
    const response = await request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return response;
  }
  return { request, initialize, child, state };
}

test('MCP negotiates lifecycle, lists tools, rejects invalid input and persists company across restart', async t => {
  const c = await client(t);
  assert.equal((await c.request('tools/list')).error.code, -32002);
  assert.equal((await c.initialize()).result.protocolVersion, '2025-11-25');
  const catalog = (await c.request('tools/list')).result.tools;
  assert.ok(catalog.some(tool => tool.name === 'vb_list_obligations'));
  assert.equal(catalog.find(tool => tool.name === 'vb_status').annotations.readOnlyHint, true);
  const call = (name, args = {}) => c.request('tools/call', { name, arguments: args });
  const invalid = await call('vb_create_company', { name: 'Example', unexpected: true });
  assert.equal(invalid.result.isError, true);
  assert.equal((await call('vb_create_company', { name: 'Example', bin: '123' })).result.isError, true);
  const created = await call('vb_create_company', { name: 'Test company', taxRegime: 'unknown' });
  assert.equal(created.result.isError, false, JSON.stringify(created));
  assert.equal(typeof created.result.structuredContent, 'object');
  const status = await call('vb_status');
  assert.match(JSON.stringify(status.result.structuredContent), /Test company/);
  assert.deepEqual(JSON.parse(status.result.content[0].text), status.result.structuredContent);
  const accountId = created.result.structuredContent.account.id;
  const added = await call('vb_add_obligation', { accountId, title: 'Check appointment', authority: 'Test recipient', period: '2026-Q4', kind: 'filing', applicability: 'unknown' });
  assert.equal(added.result.isError, false, JSON.stringify(added));
  const obligationId = added.result.structuredContent.obligation.id;
  const resolved = await call('vb_set_applicability', { accountId, id: obligationId, applicability: 'required', notes: 'User checked appointment', due: '2026-11-20' });
  assert.equal(resolved.result.isError, false, JSON.stringify(resolved));
  assert.equal(resolved.result.structuredContent.obligation.applicability, 'required');
  assert.equal((await call('vb_list_notifications', { unreadOnly: false })).result.isError, false);
  const unsupported = await c.request('not/a/method');
  assert.equal(unsupported.error.code, -32601);
  assert.equal((await c.request('ping')).result.constructor, Object);
  const { createService } = await import('../lib/service.mjs');
  const reopened = await createService({ stateDir: c.state }).call('vb_status', {});
  assert.match(JSON.stringify(reopened), /Test company/);
});

test('MCP recovers after malformed JSON and negotiates unsupported protocol version', async t => {
  const c = await client(t);
  // Invalid input has id:null and is intentionally not associated with a pending request.
  c.child.stdin.write('{bad json}\n');
  const initialized = await c.initialize('2099-01-01');
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.equal((await c.request('tools/call', { name: 'missing' })).error.code, -32602);
});

test('plugin manifests resolve installed assets and server without app checkout or dependencies', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  const overlay = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'vbaccounter');
  assert.equal(overlay.name, manifest.name);
  const ui = manifest.extensions['com.openai'].interface;
  const icon = await readFile(join(root, ui.logo));
  assert.equal(icon.subarray(1, 4).toString(), 'PNG');
  assert.equal(icon.readUInt32BE(16), icon.readUInt32BE(20));
  assert.ok(icon.readUInt32BE(16) >= 48);
  const config = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8'));
  const server = config.mcpServers.vbaccounter;
  assert.equal(server.type, 'stdio');
  assert.ok(server.args.some(arg => arg.includes('${PLUGIN_ROOT}/scripts/mcp-server.mjs')));
  assert.ok((await readFile(join(root, 'skills/setup/SKILL.md'), 'utf8')).includes('vb_status'));
});

test('Kimi Code manifest provides local and opt-in SSH servers', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'kimi.plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'vbaccounter');
  assert.equal(manifest.skills, './skills/');
  assert.deepEqual(manifest.mcpServers.vbaccounter, {
    command: './scripts/mcp-server.mjs',
    cwd: './',
  });
  assert.equal(manifest.mcpServers['vbaccounter-ssh'].environment_id, 'vbaccounter-ssh');
  assert.equal(manifest.mcpServers['vbaccounter-ssh'].enabled, false);
  assert.equal(manifest.mcpServers['vbaccounter-ssh'].command, './scripts/mcp-server.mjs');
  const { stat } = await import('node:fs/promises');
  assert.ok((await stat(join(root, 'scripts/mcp-server.mjs'))).mode & 0o111);
});
