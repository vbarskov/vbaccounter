import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skillNames = ['vb-setup', 'vb-obligations', 'vb-reporting'];

function frontmatter(text) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  return {
    name: block.match(/^name:\s*(.+)$/m)?.[1]?.trim(),
    description: block.match(/^description:\s*(.+)$/m)?.[1]?.trim(),
  };
}

test('корневой пакет объявляет DSH-слой, точку входа и патч', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'vbaccounter');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dsh.bundle.patch, './dsh/cordis.patch.yml');
  assert.equal(pkg.main, './dsh/lib/index.js');
  assert.deepEqual(pkg.exports, { '.': './dsh/lib/index.js', './client': { default: './dsh/client.js' }, './package.json': './package.json' });
  assert.equal(pkg.dsh.client.platform, 'web');
  const patch = await readFile(path.join(root, 'dsh/cordis.patch.yml'), 'utf8');
  assert.match(patch, /- insert:/);
  assert.match(patch, /^ {4}- id: vbaccounter$/m);
  assert.match(patch, /^ {6}name: vbaccounter$/m);
});

test('все манифесты плагина называют одну версию', async () => {
  const read = async relative => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
  const pkg = await read('package.json');
  for (const manifest of ['plugin.json', 'kimi.plugin.json', '.codex-plugin/plugin.json']) {
    assert.equal((await read(manifest)).version, pkg.version, `${manifest}: версия не совпадает с package.json`);
    assert.equal((await read(manifest)).name, pkg.name, `${manifest}: имя не совпадает с package.json`);
  }
});

test('пакет импортируется по имени так же, как его загружает DSH', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-import-'));
  try {
    await mkdir(path.join(home, 'node_modules'), { recursive: true });
    await symlink(root, path.join(home, 'node_modules', 'vbaccounter'), 'dir');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "const m = await import('vbaccounter'); console.log(typeof m.apply, m.name, m.inject.join(','))"], { cwd: home, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'function vbaccounter skills');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('плагин регистрирует три навыка с метаданными из SKILL.md', async () => {
  const plugin = await import('../dsh/lib/index.js');
  assert.equal(plugin.name, 'vbaccounter');
  assert.deepEqual(plugin.inject, ['skills']);
  assert.deepEqual(plugin.SKILL_NAMES, skillNames);

  const providers = [];
  plugin.apply({
    skills: { registerProvider(factory) { providers.push(factory()); } },
    inject(deps, callback) {
      callback({ effect(run) { run(); }, webServer: { register() { return () => {}; } } });
    },
  });
  assert.deepEqual(providers.map(provider => provider.name), skillNames);

  for (const [index, provider] of providers.entries()) {
    const [candidate] = await provider.list();
    assert.equal(candidate.name, skillNames[index]);
    assert.equal(candidate.provider, provider.name);
    assert.equal(candidate.provider, skillNames[index]);
    assert.equal(candidate.source, 'bundled');
    assert.equal(candidate.rank, 600);
    assert.equal(candidate.invocation.modelInvocable, true);
    assert.equal(candidate.invocation.userInvocable, true);

    const text = await readFile(candidate.path, 'utf8');
    assert.deepEqual(frontmatter(text), { name: candidate.name, description: candidate.description });
    assert.equal(candidate.resourceBase.path, path.join(root, 'skills', candidate.name, '/'));
    assert.ok(candidate.description.length > 0);

    const loaded = await provider.get();
    assert.equal(loaded.name, candidate.name);
    assert.equal(loaded.description, candidate.description);
    assert.ok(loaded.content.trim().length > 0);
    assert.equal(loaded.content.trimStart().startsWith('---'), false);
  }
});

test('install-mcp.mjs идемпотентно добавляет MCP-строку и не трогает чужие строки', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-home-'));
  try {
    const profile = path.join(home, 'profiles', 'desktop');
    await mkdir(profile, { recursive: true });
    const target = path.join(profile, 'cordis.patch.yml');
    await writeFile(target, '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n');

    const run = (...extra) => spawnSync(process.execPath, [path.join(root, 'dsh/install-mcp.mjs'), ...extra], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' });
    assert.equal(run().status, 0);
    assert.equal(run().status, 0);

    const text = await readFile(target, 'utf8');
    assert.equal(text.split('# vbaccounter: начало').length - 1, 1);
    assert.match(text, /serverName: vbaccounter/);
    assert.match(text, /- id: mcp-vbaccounter/);
    assert.match(text, /\n {10}- ".*scripts\/mcp-server\.mjs"\n/);
    assert.match(text, /- id: ui-chat/);

    const printed = run('--print');
    assert.equal(printed.status, 0);
    assert.match(printed.stdout, /serverName: vbaccounter/);
    assert.equal(await readFile(target, 'utf8'), text);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('install-mcp.mjs заменяет пустой список профиля', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-home-'));
  try {
    const profile = path.join(home, 'profiles', 'desktop');
    await mkdir(profile, { recursive: true });
    const target = path.join(profile, 'cordis.patch.yml');
    await writeFile(target, '[]\n');
    const result = spawnSync(process.execPath, [path.join(root, 'dsh/install-mcp.mjs')], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(target, 'utf8'), /^- insert:$/m);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
