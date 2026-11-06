/**
 * DSH-слой VB Accounter.
 *
 * Регистрирует три навыка плагина (`vb-setup`, `vb-obligations`,
 * `vb-reporting`) как bundled-провайдеры `ctx.skills`, чтобы они были доступны
 * в DeepSeek Harness в любом рабочем каталоге. Инструкции читаются из тех же
 * `skills/<имя>/SKILL.md`, что используют Kimi Code и Codex, поэтому текст
 * один.
 *
 * Контракт реестра DSH: у провайдера есть `name`, и каждый кандидат из
 * `list()` обязан вернуть это же значение в поле `provider`. Иначе реестр
 * отклоняет каталог навыков на каждом ходу — и падает каждое сообщение.
 * Поэтому каждый навык обслуживается одноимённым провайдером.
 *
 * Префикс `vb-` в именах нужен потому, что DSH хранит навыки разных плагинов
 * в одном пространстве имён: имя `setup` уже занимает плагин MCU iOS Git Flow,
 * и один из двух навыков был бы вытеснен.
 *
 * Вторая половина того же пакета (`./client`) рисует чип, панель статусов и
 * карточку в ленте чата. Данные для неё отдаёт read-only маршрут
 * `GET /vbaccounter/status`, который регистрируется здесь же, если в
 * композиции есть веб-сервер: браузер не может читать файлы состояния.
 *
 * Пакет импортирует только встроенные модули Node.js и собственные файлы
 * репозитория: так `link:`-установка работает без зависимостей в профиле DSH.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createService } from '../../lib/service.mjs';
import { defaultDataDirectory } from '../../scripts/mcp-server.mjs';

/** Путь маршрута статуса; браузерная половина использует ту же константу. */
export const STATUS_PATH = '/vbaccounter/status';

/** Навыки плагина в порядке каталога: сначала настройка. */
export const SKILL_NAMES = ['vb-setup', 'vb-obligations', 'vb-reporting'];

/** Ранг bundled-провайдера из `@deepseek-ai/dsh-skill`. */
const BUNDLED_SKILL_RANK = 600;

/** Доступ из модели и из пользовательского `/`. */
const INVOCATION = { modelInvocable: true, userInvocable: true };

/** YAML-описание навыка в начале `SKILL.md`. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Публичная грамматика имён навыков. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** URL файла навыка. */
function skillFile(name) {
  return new URL(`../../skills/${name}/SKILL.md`, import.meta.url);
}

/** Абсолютный путь каталога навыка: относительно него работают `references/…`. */
function skillDirectory(name) {
  return fileURLToPath(new URL(`../../skills/${name}/`, import.meta.url));
}

/** Убрать YAML-описание, оставив тело инструкций. */
function stripFrontmatter(text) {
  return text.replace(FRONTMATTER, '');
}

/** Разобрать обязательные поля YAML-описания. */
function parseFrontmatter(text, name) {
  const block = text.match(FRONTMATTER)?.[1];
  if (!block) throw new Error(`vbaccounter: у навыка ${name} нет YAML-описания`);
  const frontName = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (frontName !== name) throw new Error(`vbaccounter: имя навыка ${frontName ?? '(нет)'} не совпадает с каталогом ${name}`);
  if (!description) throw new Error(`vbaccounter: у навыка ${name} нет описания`);
  return { description };
}

/** Прочитать файл навыка синхронно: так ошибка установки видна при монтировании. */
function readSkillFile(name) {
  try {
    return readFileSync(skillFile(name), 'utf8');
  } catch (error) {
    throw new Error(`vbaccounter: не удалось прочитать навык ${name}: ${error.message}`, { cause: error });
  }
}

/** Проверить все навыки до регистрации провайдеров. */
function validateSkills() {
  for (const name of SKILL_NAMES) {
    if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`vbaccounter: недопустимое имя навыка ${name}`);
    const text = readSkillFile(name);
    parseFrontmatter(text, name);
    if (!stripFrontmatter(text).trim()) throw new Error(`vbaccounter: навык ${name} не содержит инструкций`);
  }
}

/** Загрузить навык целиком: описание, путь и тело инструкций. */
async function loadSkill(name) {
  const file = skillFile(name);
  const text = await readFile(file, 'utf8');
  const { description } = parseFrontmatter(text, name);
  const body = stripFrontmatter(text);
  if (!body.trim()) throw new Error(`vbaccounter: навык ${name} не содержит инструкций`);
  return {
    name,
    description,
    invocation: INVOCATION,
    // Реестр DSH требует, чтобы кандидат указывал имя своего провайдера.
    provider: name,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: skillDirectory(name) },
    path: fileURLToPath(file),
    content: body,
  };
}

/** Провайдер одного навыка: реестр DSH вызывает `list` и `get`. */
function skillProvider(name) {
  return {
    name,
    async list() {
      const { content: _content, ...summary } = await loadSkill(name);
      return [{ ...summary, rank: BUNDLED_SKILL_RANK, locator: skillFile(name) }];
    },
    async get() {
      return loadSkill(name);
    },
  };
}

/**
 * Свести ответы `vb_status` и `vb_list_obligations` в компактную сводку для
 * браузерной половины.
 * @param {{accounts?: unknown[], unreadNotifications?: number, notificationSettings?: object,
 *   stateDir?: string, rules?: {kind?: string}}} status - ответ `vb_status`.
 * @param {{obligations?: unknown[], asOf?: string}} list - ответ `vb_list_obligations`.
 * @returns {{asOf: string|null, accounts: {name: string, taxRegime: string}[], total: number,
 *   unread: number, settings: object|null, stateDir: string|null, rules: string|null,
 *   counts: {overdue: number, week: number, fortnight: number, unknown: number, needsData: number},
 *   items: {id: string, title: string, due: string|null, days: number|null, stage: string,
 *     kind: string, applicability: string, lifecycle: string, account: string,
 *     authority: string, period: string, nextAction: string}[]}}
 */
export function summarize(status, list) {
  const obligations = (Array.isArray(list?.obligations) ? list.obligations : []).filter(item => !item.closed);
  const counts = { overdue: 0, week: 0, fortnight: 0, unknown: 0, needsData: 0 };
  for (const item of obligations) {
    const days = item.urgency?.daysUntilDue;
    if (typeof days === 'number') {
      if (days < 0) counts.overdue += 1;
      else if (days <= 7) counts.week += 1;
      else if (days <= 14) counts.fortnight += 1;
    }
    if (item.applicability === 'unknown') counts.unknown += 1;
    if (item.lifecycle === 'needs-data') counts.needsData += 1;
  }
  const rank = item => (typeof item.urgency?.daysUntilDue === 'number' ? item.urgency.daysUntilDue : Number.POSITIVE_INFINITY);
  const items = obligations
    .map(item => ({
      id: item.id,
      title: item.title,
      due: item.due ?? null,
      days: typeof item.urgency?.daysUntilDue === 'number' ? item.urgency.daysUntilDue : null,
      stage: item.urgency?.stage ?? 'unknown',
      kind: item.kind ?? '',
      applicability: item.applicability ?? '',
      lifecycle: item.lifecycle ?? '',
      account: item.accountName ?? '',
      authority: item.authority ?? '',
      period: item.period ?? '',
      nextAction: item.nextAction ?? '',
    }))
    .sort((left, right) => rank(left) - rank(right));
  return {
    asOf: list?.asOf ?? null,
    accounts: (Array.isArray(status?.accounts) ? status.accounts : []).map(account => ({
      name: account.name,
      taxRegime: account.taxRegime ?? 'unknown',
    })),
    total: obligations.length,
    unread: status?.unreadNotifications ?? 0,
    settings: status?.notificationSettings ?? null,
    stateDir: status?.stateDir ?? null,
    rules: status?.rules?.kind ?? null,
    counts,
    items,
  };
}

/**
 * Создать HTTP-обработчик маршрута статуса.
 * @param {{call: (name: string, args?: object) => Promise<unknown>}} service - сервис плагина.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createStatusHandler(service) {
  return async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'content-type': 'text/plain; charset=utf-8' });
      response.end('method not allowed');
      return;
    }
    try {
      const status = await service.call('vb_status', {});
      const list = await service.call('vb_list_obligations', { horizonDays: 366 });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(summarize(status, list)));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  };
}

/** Имя Cordis-плагина в списке плагинов профиля. */
export const name = 'vbaccounter';

/** Реестр навыков, который заполняет этот плагин. */
export const inject = ['skills'];

/**
 * Проверить инструкции, зарегистрировать провайдеров навыков и, если в
 * композиции есть веб-сервер, отдать маршрут статуса браузерной половине.
 * @param {import('@deepseek-ai/cordis').Context} ctx - контекст с `ctx.skills`.
 */
export function apply(ctx) {
  validateSkills();
  for (const skillName of SKILL_NAMES) ctx.skills.registerProvider(() => skillProvider(skillName));
  // Веб-сервера может не быть (например, headless-запуск): тогда навыки
  // остаются доступны, а маршрут просто не регистрируется.
  ctx.inject(['webServer'], webCtx => {
    const service = createService({ stateDir: defaultDataDirectory() });
    const handler = createStatusHandler(service);
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: STATUS_PATH, handler }), 'vbaccounter: status route');
  });
}
