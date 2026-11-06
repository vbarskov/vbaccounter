import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('пакет объявляет навыки, клиентскую половину и маршрут статуса', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'vbaccounter');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, './dsh/lib/index.js');
  assert.deepEqual(manifest.exports['./client'], { default: './dsh/client.js' });
  assert.equal(manifest.dsh.bundle.patch, './dsh/cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  const patch = await readFile(path.join(root, 'dsh/cordis.patch.yml'), 'utf8');
  assert.match(patch, /- insert:/);
  assert.match(patch, /^ {4}- id: vbaccounter$/m);
  assert.match(patch, /^ {6}name: vbaccounter$/m);
});

test('host сводит статус и вешает маршрут только при наличии веб-сервера', async () => {
  const host = await import('../dsh/lib/index.js');
  assert.equal(host.name, 'vbaccounter');
  assert.deepEqual(host.inject, ['skills']);
  assert.equal(host.STATUS_PATH, '/vbaccounter/status');

  const summary = host.summarize(
    { accounts: [{ name: 'ТОО «Тест»', taxRegime: 'simplified' }], unreadNotifications: 2, notificationSettings: { enabled: true, leadDays: [30, 14, 7, 1, 0] } },
    {
      asOf: '2026-11-06',
      obligations: [
        { id: 'a', title: 'ФНО 200.00', closed: false, applicability: 'required', lifecycle: 'needs-data', kind: 'filing', due: '2026-11-16', accountName: 'ТОО «Тест»', authority: 'КГД', period: '2026-Q3', nextAction: 'Собрать документы', urgency: { stage: '14d', daysUntilDue: 10 } },
        { id: 'b', title: 'Проверить назначение', closed: false, applicability: 'unknown', lifecycle: 'needs-data', kind: 'check', due: null, accountName: 'ТОО «Тест»', urgency: { stage: 'unknown', daysUntilDue: null } },
        { id: 'c', title: 'Оплачено', closed: true, applicability: 'required', lifecycle: 'paid', kind: 'payment', due: '2026-10-01', urgency: { stage: 'overdue', daysUntilDue: -30 } },
      ],
    },
  );
  assert.equal(summary.asOf, '2026-11-06');
  assert.deepEqual(summary.accounts, [{ name: 'ТОО «Тест»', taxRegime: 'simplified' }]);
  assert.equal(summary.total, 2);
  assert.equal(summary.unread, 2);
  assert.deepEqual(summary.settings, { enabled: true, leadDays: [30, 14, 7, 1, 0] });
  assert.deepEqual(summary.counts, { overdue: 0, week: 0, fortnight: 1, unknown: 1, needsData: 2 });
  assert.equal(summary.items.length, 2);
  assert.equal(summary.items[0].title, 'ФНО 200.00');
  assert.equal(summary.items[0].days, 10);
  assert.equal(summary.items[0].authority, 'КГД');
  assert.equal(summary.items[0].nextAction, 'Собрать документы');
  assert.equal(summary.items[1].title, 'Проверить назначение');
  assert.equal(summary.items[1].days, null);

  const providers = [];
  const routes = [];
  host.apply({
    skills: { registerProvider(factory) { providers.push(factory()); } },
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer']);
      callback({
        effect(run) { run(); },
        webServer: { register(route) { routes.push(route); return () => {}; } },
      });
    },
  });
  assert.deepEqual(providers.map(provider => provider.name), host.SKILL_NAMES);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'exact');
  assert.equal(routes[0].path, '/vbaccounter/status');
  assert.equal(typeof routes[0].handler, 'function');
});

function fakeResponse() {
  const state = { status: 0, headers: {}, body: '' };
  return {
    state,
    writeHead(status, headers = {}) { state.status = status; state.headers = headers; },
    end(chunk = '') { state.body += chunk; },
  };
}

test('маршрут статуса отдаёт JSON и отвергает не-GET', async () => {
  const host = await import('../dsh/lib/index.js');
  const service = {
    async call(name) {
      if (name === 'vb_status') return { accounts: [{ name: 'ТОО' }], unreadNotifications: 0 };
      return { asOf: '2026-11-06', obligations: [] };
    },
  };
  const handler = host.createStatusHandler(service);

  const ok = fakeResponse();
  await handler({ method: 'GET' }, ok);
  assert.equal(ok.state.status, 200);
  assert.match(ok.state.headers['content-type'], /application\/json/);
  const body = JSON.parse(ok.state.body);
  assert.deepEqual(body.accounts, [{ name: 'ТОО', taxRegime: 'unknown' }]);
  assert.deepEqual(body.counts, { overdue: 0, week: 0, fortnight: 0, unknown: 0, needsData: 0 });

  const rejected = fakeResponse();
  await handler({ method: 'POST' }, rejected);
  assert.equal(rejected.state.status, 405);

  const failing = fakeResponse();
  await host.createStatusHandler({ async call() { throw new Error('источник недоступен'); } })({ method: 'GET' }, failing);
  assert.equal(failing.state.status, 500);
  assert.match(failing.state.body, /источник недоступен/);
});

test('клиентский бандл регистрирует карточку в ленте и чип в шапке', async () => {
  let entry;
  globalThis.window = { __ModuleLoader__: { load(candidate) { entry = candidate; } } };
  globalThis.document = { body: {}, addEventListener() {}, removeEventListener() {} };
  await import('../dsh/client.js');
  assert.equal(entry.id, 'vbaccounter');
  assert.equal(typeof entry.factory, 'function');

  const modules = {
    react: { useState(initial) { return [initial, () => {}]; }, useEffect() {} },
    'react/jsx-runtime': { jsx(type, props) { return { type, props }; } },
    'react-dom': { createPortal(node) { return node; } },
  };
  const bundle = entry.factory(name => modules[name]);
  assert.deepEqual(bundle.inject, ['slots']);
  assert.equal(typeof bundle.apply, 'function');

  const registrations = [];
  bundle.apply({
    slots: {
      inject(key, callback) { callback(); },
      register(spec, component) { registrations.push({ spec, component }); },
    },
  });
  assert.equal(registrations.length, 2);
  const card = registrations.find(entry => entry.spec.name === 'tool.call.toolview');
  const chip = registrations.find(entry => entry.spec.name === 'conversation.session.header.actions');
  assert.equal(card.spec.key, 'mcp__vbaccounter__vb_list_obligations');
  assert.equal(typeof card.component, 'function');
  assert.equal(chip.spec.id, 'vbaccounter-status');
  assert.equal(typeof chip.component, 'function');

  const settled = {
    kind: 'tool-result',
    isError: false,
    content: [{
      type: 'text',
      text: JSON.stringify({
        asOf: '2026-11-06',
        obligations: [
          { title: 'ФНО 200.00', due: '2026-11-16', closed: false, applicability: 'required', lifecycle: 'needs-data', kind: 'filing', authority: 'КГД', period: '2026-Q3', urgency: { daysUntilDue: 10 } },
          { title: 'Уточнить назначение', due: null, closed: false, applicability: 'unknown', lifecycle: 'needs-data', kind: 'check', urgency: { daysUntilDue: null } },
        ],
      }),
    }],
  };
  const cardText = JSON.stringify(card.component({ block: settled }));
  assert.match(cardText, /VB Accounter/);
  assert.match(cardText, /≤14 дней: 1/);
  assert.match(cardText, /применимость \?: 1/);
  assert.match(cardText, /ФНО 200\.00/);
  assert.match(cardText, /КГД · 2026-Q3 · отчёт · требуется · нужны данные/);
  assert.match(JSON.stringify(card.component({ block: { callId: 'x', argsRaw: '{}' } })), /читаю обязательства/);
  assert.match(JSON.stringify(card.component({ block: { kind: 'tool-result', isError: true, content: [{ type: 'text', text: 'нет доступа' }] } })), /нет доступа/);

  const element = chip.component();
  assert.equal(element.type, 'span');
  const chipButton = element.props.children[0];
  assert.equal(chipButton.type, 'button');
  assert.match(chipButton.props.children, /^VB • .*▾$/);
  assert.equal(typeof chipButton.props.title, 'string');

  const stateful = { slots: [], cursor: 0 };
  const richModules = {
    react: {
      useState(initial) {
        const index = stateful.cursor++;
        if (!stateful.slots[index]) stateful.slots[index] = [initial, value => { stateful.slots[index][0] = value; }];
        return stateful.slots[index];
      },
      useEffect() {},
    },
    'react/jsx-runtime': modules['react/jsx-runtime'],
    'react-dom': modules['react-dom'],
  };
  const richRegistrations = [];
  const rich = entry.factory(name => richModules[name]);
  rich.apply({
    slots: {
      inject(key, callback) { callback(); },
      register(spec, component) { richRegistrations.push({ spec, component }); },
    },
  });
  const richChip = richRegistrations.find(candidate => candidate.spec.name === 'conversation.session.header.actions').component;
  stateful.cursor = 0;
  richChip();
  stateful.slots[0][1]({
    status: 'ready',
    value: {
      asOf: '2026-11-06',
      accounts: [{ name: 'ТОО «Тест»', taxRegime: 'simplified' }],
      counts: { overdue: 1, week: 0, fortnight: 1, unknown: 2, needsData: 3 },
      settings: { enabled: true, leadDays: [30, 14, 7, 1, 0] },
      items: [{ title: 'ФНО 200.00', due: '2026-11-16', days: 10, applicability: 'required', lifecycle: 'needs-data', kind: 'filing', authority: 'КГД', period: '2026-Q3' }],
      unread: 1,
    },
  });
  stateful.slots[1][1](true);
  stateful.cursor = 0;
  const panelText = JSON.stringify(richChip());
  assert.match(panelText, /просрочено: 1/);
  assert.match(panelText, /≤14 дней: 1/);
  assert.match(panelText, /применимость \?: 2/);
  assert.match(panelText, /ФНО 200\.00/);
  assert.match(panelText, /Ближайшие 14 дней/);
  assert.match(panelText, /локальный реестр/);

  assert.equal(bundle.formatChip(null), 'VB • …');
  assert.equal(bundle.formatChip({ total: 0, counts: { overdue: 0, week: 0, fortnight: 0, unknown: 0, needsData: 0 } }), 'VB • чисто');
  assert.equal(bundle.formatChip({ total: 3, counts: { overdue: 1, week: 2, fortnight: 0, unknown: 0, needsData: 1 } }), 'VB • 1 просроч. • 2 ≤7д');
  assert.equal(bundle.formatChip({ total: 5, counts: { overdue: 0, week: 0, fortnight: 2, unknown: 3, needsData: 0 } }), 'VB • 2 ≤14д • 3 ?');
});
