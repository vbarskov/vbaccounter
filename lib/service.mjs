import { randomUUID } from 'node:crypto';
import { resolve, isAbsolute } from 'node:path';
import { createStorage, readRegular, sha256 } from './storage.mjs';
import { RULES, project, date, text, isoDate } from './domain.mjs';
import { kazakhstanClock } from '../vendor/vb-accounting/reminders.mjs';

const APPLICABILITY = ['required', 'unknown', 'not-required'];
const arrayFields = [
  'transactions',
  'payroll',
  'bankStatements',
  'completedObligations',
  'nationalBankReports'
];

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Проверьте ${label}: нужен объект.`);
  }
  return value;
}

function boolean(args, key) {
  if (args[key] !== undefined && typeof args[key] !== 'boolean') {
    throw new Error(`Проверьте ${key}: true или false.`);
  }
}

function sourceData(data) {
  object(data, 'данные ТОО');
  object(data.company, 'карточку компании');
  for (const key of arrayFields) {
    if (data[key] !== undefined && !Array.isArray(data[key])) {
      throw new Error(`Повреждён источник: ${key} должен быть массивом.`);
    }
  }
  if (data.company.taxRegime !== undefined
    && !['simplified', 'general', 'unknown'].includes(data.company.taxRegime)) {
    throw new Error('Повреждён источник: налоговый режим.');
  }
  if (data.company.registrationDate) {
    date(data.company.registrationDate, 'регистрации');
  }
  if (data.company.employees !== undefined && !Array.isArray(data.company.employees)) {
    throw new Error('Повреждён список сотрудников.');
  }
  for (const employee of data.company.employees || []) {
    object(employee, 'сотрудника');
    for (const key of ['startDate', 'endDate']) {
      if (employee[key]) date(employee[key], key);
    }
  }
  for (const key of ['transactions', 'payroll', 'bankStatements', 'nationalBankReports']) {
    for (const item of data[key] || []) object(item, `запись ${key}`);
  }
  if (data.reporting !== undefined) {
    object(data.reporting, 'архив отчётности');
    for (const key of ['documents', 'assignments', 'reports']) {
      if (data.reporting[key] !== undefined && !Array.isArray(data.reporting[key])) {
        throw new Error(`Повреждён архив: ${key}.`);
      }
      for (const item of data.reporting[key] || []) object(item, `запись ${key}`);
    }
    for (const assignment of data.reporting.assignments || []) {
      if (!APPLICABILITY.includes(assignment.status)) {
        throw new Error('Повреждён статус назначения БНС.');
      }
      if (assignment.dueDate) date(assignment.dueDate, 'срока БНС');
    }
    for (const report of data.reporting.reports || []) {
      if (!['prepared', 'sent', 'accepted', 'rejected'].includes(report.status)) {
        throw new Error('Повреждён статус отчёта.');
      }
    }
  }
  for (const report of data.nationalBankReports || []) {
    if (!Number.isInteger(report.year)
      || report.year < 2026
      || report.year > 2099
      || ![1, 2, 3, 4].includes(report.quarter)
      || !['1-ПБ', '10-ПБ'].includes(report.form)
      || !APPLICABILITY.includes(report.assignment)
      || !['draft', 'sent', 'accepted', 'rejected'].includes(report.status)
      || !Array.isArray(report.rows)
      || !Array.isArray(report.documents)) {
      throw new Error('Повреждён отчёт Нацбанка.');
    }
  }
  return data;
}

async function loadWorkspace(path, now) {
  let bytes;
  try {
    bytes = await readRegular(path);
  } catch (error) {
    throw new Error(
      `Не удалось прочитать выбранный source источник ${path}: ${error.message}`,
      { cause: error }
    );
  }
  let source;
  try {
    source = JSON.parse(bytes);
  } catch {
    throw new Error('Повреждён JSON выбранного источника.');
  }
  if (source?.version !== 6
    || !Array.isArray(source.accounts)
    || source.accounts.length === 0
    || source.accounts.length > 50) {
    throw new Error('Нужен файл VB Accounting версии 6 со списком ТОО.');
  }
  const seen = new Set();
  const prefix = `workspace:${sha256(path).slice(0, 12)}:`;
  const accounts = source.accounts.map(item => {
    object(item, 'аккаунт источника');
    const id = text(item.id, 'ID аккаунта', 200);
    const name = text(item.name, 'название ТОО', 200);
    if (seen.has(id)) throw new Error('Повторный ID ТОО в источнике.');
    seen.add(id);
    return {
      id: prefix + id,
      sourceAccountId: id,
      name,
      isDemo: item.isDemo === true,
      data: sourceData(item.data),
      origin: 'connected-workspace'
    };
  });
  return {
    accounts,
    metadata: {
      path,
      readAt: now.toISOString(),
      sha256: sha256(bytes),
      version: 6,
      readOnly: true
    }
  };
}

function summary(account) {
  return {
    id: account.id,
    name: account.name,
    isDemo: account.isDemo === true,
    origin: account.origin || 'local',
    sourceAccountId: account.sourceAccountId || null,
    taxRegime: account.data.company.taxRegime || 'unknown'
  };
}

function getAccount(accounts, id) {
  text(id, 'accountId', 500);
  const account = accounts.find(account => account.id === id);
  if (!account) throw new Error('ТОО не найдено. Сначала вызовите vb_status.');
  return account;
}

function getObligation(accounts, state, now, args) {
  const account = getAccount(accounts, args.accountId);
  text(args.id, 'id обязательства', 500);
  const obligation = project(account, state, now).find(item => item.id === args.id);
  if (!obligation) throw new Error('Обязательство не найдено.');
  return { account, obligation };
}

const record = (state, now, action, detail = {}) => state.audit.push({
  id: randomUUID(),
  at: now.toISOString(),
  action,
  ...detail
});

function companyFields(args) {
  const fields = {};
  if (args.name !== undefined) fields.name = text(args.name, 'название ТОО', 200);
  if (args.bin !== undefined) {
    fields.bin = text(args.bin, 'БИН', 12, true);
    if (fields.bin && !/^\d{12}$/.test(fields.bin)) {
      throw new Error('БИН должен содержать 12 цифр.');
    }
  }
  if (args.taxRegime !== undefined) {
    if (!['simplified', 'general', 'unknown'].includes(args.taxRegime)) {
      throw new Error('Проверьте taxRegime.');
    }
    fields.taxRegime = args.taxRegime;
  }
  if (args.registrationDate !== undefined) {
    fields.registrationDate = date(args.registrationDate, 'регистрации', true) || '';
  }
  boolean(args, 'hasEmployees');
  if (args.hasEmployees !== undefined) fields.hasEmployees = args.hasEmployees;
  return fields;
}

function checkDuplicateBin(accounts, bin, excludedId) {
  if (bin && accounts.some(account => account.id !== excludedId && account.data.company.bin === bin)) {
    throw new Error('ТОО с таким БИН уже существует в плагине.');
  }
}

function addCompany(state, args, now) {
  const name = text(args.name, 'название ТОО', 200);
  const bin = text(args.bin, 'БИН', 12, true);
  if (bin && !/^\d{12}$/.test(bin)) throw new Error('БИН должен содержать 12 цифр.');
  const regime = args.taxRegime ?? 'unknown';
  if (!['simplified', 'general', 'unknown'].includes(regime)) {
    throw new Error('Проверьте taxRegime.');
  }
  boolean(args, 'hasEmployees');
  const registrationDate = date(args.registrationDate, 'регистрации', true);
  checkDuplicateBin(state.accounts, bin);
  const account = {
    id: `local:${randomUUID()}`,
    name,
    isDemo: false,
    origin: 'local',
    data: {
      company: {
        legalName: name,
        bin,
        taxRegime: regime,
        registrationDate: registrationDate || '',
        ...(args.hasEmployees !== undefined ? { hasEmployees: args.hasEmployees } : {})
      },
      transactions: [],
      payroll: [],
      bankStatements: [],
      reporting: { settings: {}, documents: [], reports: [], assignments: [] },
      nationalBankReports: [],
      completedObligations: []
    }
  };
  state.accounts.push(account);
  record(state, now, 'create-company', { accountId: account.id });
  return { account: summary(account), rules: RULES };
}

function updateCompany(accounts, state, args, now) {
  const account = getAccount(accounts, args.accountId);
  if (account.origin === 'connected-workspace' || !state.accounts.some(item => item.id === account.id)) {
    throw new Error('Карточка подключённого ТОО доступна только для чтения; измените её в источнике.');
  }
  const fields = companyFields(args);
  checkDuplicateBin(accounts, fields.bin, account.id);
  const changedFields = {};
  for (const [key, value] of Object.entries(fields)) {
    const previous = key === 'name' ? account.name : account.data.company[key];
    if (previous !== value) changedFields[key] = value;
    if (key === 'name') {
      account.name = value;
      account.data.company.legalName = value;
    } else {
      account.data.company[key] = value;
    }
  }
  record(state, now, 'update-company', { accountId: account.id, changedFields });
  return { account: summary(account), rules: RULES };
}

function sourceUrl(value) {
  if (value === undefined) return '';
  const raw = text(value, 'sourceUrl', 2000, true);
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Проверьте sourceUrl.');
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('sourceUrl должен быть HTTP(S).');
  }
  return raw;
}

function addObligation(accounts, state, now, args) {
  getAccount(accounts, args.accountId);
  const kind = args.kind;
  if (!['filing', 'payment', 'check'].includes(kind)) {
    throw new Error('kind: filing, payment или check.');
  }
  const applicability = args.applicability ?? 'required';
  if (!APPLICABILITY.includes(applicability)) throw new Error('Проверьте applicability.');
  const notes = text(args.notes, 'notes', 10000, true);
  if (applicability === 'not-required' && !notes) {
    throw new Error('Укажите в notes основание неприменимости.');
  }
  const row = {
    id: `manual:${randomUUID()}`,
    accountId: args.accountId,
    title: text(args.title, 'название обязательства', 500),
    authority: text(args.authority, 'орган/получателя', 300),
    period: text(args.period, 'период', 200),
    due: date(args.due, 'срока', true),
    kind,
    applicability,
    sourceUrl: sourceUrl(args.sourceUrl),
    notes,
    lifecycle: kind === 'payment' ? 'pending' : 'needs-data',
    origin: 'user-provided',
    rulesNeedVerification: false,
    deadlineKind: 'user-provided',
    deadlineVerified: false,
    provenance: { source: 'user-provided', notes, recordedAt: now.toISOString() }
  };
  state.obligations.push(row);
  record(state, now, 'add-obligation', {
    accountId: args.accountId,
    obligationId: row.id,
    applicability
  });
  return {
    obligation: project(getAccount(accounts, args.accountId), state, now).find(item => item.id === row.id)
  };
}

function filterList(accounts, state, now, args) {
  boolean(args, 'includeClosed');
  boolean(args, 'includeDemo');
  const horizon = args.horizonDays ?? 31;
  if (!Number.isInteger(horizon) || horizon < 0 || horizon > 3660) {
    throw new Error('horizonDays: целое число от 0 до 3660.');
  }
  const selected = args.accountId ? [getAccount(accounts, args.accountId)] : accounts;
  return selected
    .filter(account => args.includeDemo || !account.isDemo)
    .flatMap(account => project(account, state, now))
    .filter(obligation => (args.includeClosed || !obligation.closed)
      && (obligation.applicability === 'unknown'
        || obligation.urgency.daysUntilDue === null
        || obligation.urgency.daysUntilDue <= horizon));
}

async function updateObligation(accounts, state, now, args, storage) {
  const { account, obligation } = getObligation(accounts, state, now, args);
  const allowed = {
    filing: ['needs-data', 'prepared', 'sent', 'accepted', 'rejected'],
    payment: ['pending', 'paid'],
    check: ['needs-data', 'pending', 'done']
  };
  if (!allowed[obligation.kind].includes(args.status)) {
    throw new Error('Недопустимый status для этого вида обязательства.');
  }
  if (obligation.applicability === 'not-required') {
    throw new Error('Для неприменимого обязательства нельзя отмечать сдачу или оплату.');
  }
  if (obligation.applicability === 'unknown' && ['accepted', 'paid', 'done'].includes(args.status)) {
    throw new Error('Сначала явно уточните applicability: применимость неизвестна.');
  }
  if (['accepted', 'paid'].includes(obligation.lifecycle)) {
    throw new Error('Подтверждённое обязательство и его доказательство сохранены неизменными.');
  }
  const notes = text(args.notes, 'notes', 10000, true);
  const closed = ['accepted', 'paid'].includes(args.status);
  if (closed && !args.evidencePath) {
    throw new Error('Для подтверждения требуется evidencePath к файлу квитанции или оплаты.');
  }
  const evidence = args.evidencePath
    ? await storage.saveEvidence(text(args.evidencePath, 'evidencePath', 4000), now)
    : undefined;
  const override = {
    lifecycle: args.status,
    sourceBasis: {
      revision: obligation.sourceRevision || null,
      lifecycle: obligation.sourceLifecycle || obligation.lifecycle
    },
    updatedAt: now.toISOString(),
    ...(args.notes !== undefined ? { notes } : {}),
    ...(evidence ? { evidence } : {}),
    ...(closed ? { applicability: 'required' } : {})
  };
  const key = `${account.id}\n${obligation.id}`;
  state.overrides[key] = { ...(state.overrides[key] || {}), ...override };
  record(state, now, 'update-obligation', {
    accountId: account.id,
    obligationId: obligation.id,
    previousStatus: obligation.lifecycle,
    status: args.status,
    notes,
    ...(evidence ? {
      evidence: {
        sha256: evidence.sha256,
        path: evidence.path,
        verification: evidence.verification
      }
    } : {})
  });
  return { obligation: project(account, state, now).find(item => item.id === obligation.id) };
}

async function setApplicability(accounts, state, now, args, storage) {
  const { account, obligation } = getObligation(accounts, state, now, args);
  if (!APPLICABILITY.includes(args.applicability)) throw new Error('Проверьте applicability.');
  if (obligation.lifecycle === 'paid'
    || obligation.lifecycle === 'accepted' && obligation.applicability !== 'unknown') {
    throw new Error('Подтверждённое обязательство и его основание сохранены неизменными.');
  }
  const notes = text(args.notes, 'notes', 10000, true);
  const url = sourceUrl(args.sourceUrl);
  if (args.applicability !== 'unknown' && !notes && !url && !args.evidencePath) {
    throw new Error('Укажите основание: notes, sourceUrl или evidencePath.');
  }
  const due = args.due === undefined ? undefined : date(args.due, 'подтверждённого срока', true);
  const evidence = args.evidencePath
    ? await storage.saveEvidence(text(args.evidencePath, 'evidencePath', 4000), now)
    : undefined;
  const provenance = {
    source: 'user-provided',
    notes,
    sourceUrl: url,
    recordedAt: now.toISOString(),
    ...(evidence ? { evidence } : {}),
    notice: 'Основание предоставлено пользователем; официальное назначение и срок онлайн не проверялись.'
  };
  const patch = {
    applicability: args.applicability,
    provenance,
    updatedAt: now.toISOString(),
    ...(due !== undefined ? { due, deadlineKind: 'user-confirmed', deadlineVerified: false } : {}),
    ...(args.sourceUrl !== undefined ? { sourceUrl: url } : {}),
    ...(args.notes !== undefined ? { notes } : {})
  };
  const key = `${account.id}\n${obligation.id}`;
  state.overrides[key] = { ...(state.overrides[key] || {}), ...patch };
  record(state, now, 'set-applicability', {
    accountId: account.id,
    obligationId: obligation.id,
    previousApplicability: obligation.applicability,
    applicability: args.applicability,
    previousDue: obligation.due,
    ...patch
  });
  return { obligation: project(account, state, now).find(item => item.id === obligation.id) };
}

function settings(state, args, now) {
  boolean(args, 'enabled');
  let leadDays = state.settings.leadDays;
  if (args.leadDays !== undefined) {
    if (!Array.isArray(args.leadDays)
      || args.leadDays.length > 91
      || args.leadDays.some(days => !Number.isInteger(days) || days < 0 || days > 90)) {
      throw new Error('leadDays: массив целых дней от 0 до 90.');
    }
    leadDays = [...new Set(args.leadDays)].sort((a, b) => b - a);
  }
  if (args.enabled !== undefined || args.leadDays !== undefined) {
    state.settings = { enabled: args.enabled ?? state.settings.enabled, leadDays };
    record(state, now, 'notification-settings', { settings: structuredClone(state.settings) });
  }
  return { settings: state.settings };
}

function checkNotifications(accounts, state, now, args) {
  boolean(args, 'includeDemo');
  const selected = args.accountId ? [getAccount(accounts, args.accountId)] : accounts;
  if (!state.settings.enabled) {
    return { enabled: false, notifications: [], checkedAt: now.toISOString() };
  }
  const rows = selected
    .filter(account => args.includeDemo || !account.isDemo)
    .flatMap(account => project(account, state, now));
  const produced = [];
  for (const row of rows) {
    if (row.closed
      || row.urgency.stage === 'upcoming'
        && row.applicability !== 'unknown'
        && !['sent', 'rejected'].includes(row.lifecycle)) continue;
    const prior = state.notifications.filter(notice =>
      notice.accountId === row.accountId && notice.obligationId === row.id);
    if (prior.some(notice => notice.snoozeUntil && notice.snoozeUntil > kazakhstanClock(now).date)) {
      continue;
    }
    const key = JSON.stringify([
      row.accountId,
      row.id,
      row.lifecycle,
      row.applicability,
      row.due,
      row.estimatedDue || null,
      row.urgency.stage
    ]);
    let notice = state.notifications.find(item => item.key === key);
    if (notice) {
      if (!notice.snoozeUntil || notice.snoozeUntil > kazakhstanClock(now).date) continue;
      notice.snoozeUntil = null;
      notice.read = false;
      notice.returnedAt = now.toISOString();
      produced.push(structuredClone(notice));
      continue;
    }
    notice = {
      id: randomUUID(),
      key,
      accountId: row.accountId,
      obligationId: row.id,
      title: `${row.accountName}: ${row.title}`,
      body: row.nextAction,
      authority: row.authority,
      period: row.period,
      due: row.due,
      lifecycle: row.lifecycle,
      applicability: row.applicability,
      urgency: row.urgency,
      rulesNeedVerification: row.rulesNeedVerification,
      ruleNotice: row.ruleNotice,
      createdAt: now.toISOString(),
      returnedAt: now.toISOString(),
      read: false,
      readAt: null,
      delivery: 'returned-to-caller',
      snoozeUntil: null
    };
    state.notifications.push(notice);
    produced.push(structuredClone(notice));
  }
  if (produced.length) {
    record(state, now, 'produce-notifications', { notificationIds: produced.map(notice => notice.id) });
  }
  return {
    enabled: true,
    notifications: produced,
    checkedAt: now.toISOString(),
    delivery: 'Structured data only. Caller/scheduler is responsible for showing or delivering it.'
  };
}

function listNotifications(accounts, state, now, args) {
  boolean(args, 'unreadOnly');
  boolean(args, 'includeDemo');
  const selected = args.accountId ? [getAccount(accounts, args.accountId)] : accounts;
  const visibleAccounts = selected.filter(account => args.includeDemo || !account.isDemo);
  const current = new Map(visibleAccounts
    .flatMap(account => project(account, state, now))
    .map(obligation => [`${obligation.accountId}\n${obligation.id}`, obligation]));
  const accountIds = new Set(visibleAccounts.map(account => account.id));
  const notifications = state.notifications
    .filter(notice => accountIds.has(notice.accountId) && (args.unreadOnly === false || !notice.read))
    .map(notice => {
      const obligation = current.get(`${notice.accountId}\n${notice.obligationId}`);
      return {
        ...structuredClone(notice),
        currentlyActionable: !!obligation && !obligation.closed,
        currentLifecycle: obligation?.lifecycle || null,
        currentDue: obligation?.due || null
      };
    });
  return { notifications, unreadOnly: args.unreadOnly !== false, asOf: now.toISOString() };
}

function ack(state, args, now) {
  const id = text(args.id, 'id уведомления', 100);
  const notice = state.notifications.find(item => item.id === id);
  if (!notice) throw new Error('Уведомление не найдено.');
  let snoozeUntil = null;
  if (args.snoozeUntil !== undefined) {
    snoozeUntil = date(args.snoozeUntil, 'отложения');
    if (snoozeUntil <= kazakhstanClock(now).date) {
      throw new Error('Дата отложения должна быть в будущем.');
    }
  }
  notice.read = true;
  notice.readAt = now.toISOString();
  notice.snoozeUntil = snoozeUntil;
  record(state, now, 'ack-notification', { notificationId: id, snoozeUntil });
  return { notification: structuredClone(notice), obligationChanged: false };
}

export function createService({ stateDir, now = () => new Date() } = {}) {
  const storage = createStorage(stateDir);
  return {
    async call(name, args = {}) {
      object(args, 'аргументы');
      const current = now();
      if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
        throw new Error('Некорректные часы.');
      }
      return storage.transaction(async state => {
        if (name === 'vb_connect_workspace') {
          const path = text(args.path, 'path', 4000);
          if (!isAbsolute(path)) throw new Error('Нужен абсолютный path.');
          const canonical = resolve(path);
          const loaded = await loadWorkspace(canonical, current);
          // Project before persisting the connection, so malformed source data never poisons it.
          for (const account of loaded.accounts) project(account, state, current);
          state.workspace = { path: canonical, connectedAt: current.toISOString() };
          record(state, current, 'connect-workspace', {
            path: canonical,
            sha256: loaded.metadata.sha256
          });
          return {
            workspace: loaded.metadata,
            accounts: loaded.accounts.map(summary),
            rules: RULES
          };
        }
        const loaded = state.workspace
          ? await loadWorkspace(state.workspace.path, current)
          : { accounts: [], metadata: null };
        const accounts = [...state.accounts, ...loaded.accounts];
        const context = { workspace: loaded.metadata, rules: RULES };
        if (name === 'vb_status') {
          return {
            ...context,
            stateDir: storage.stateDir,
            accounts: accounts.map(summary),
            notificationSettings: state.settings,
            unreadNotifications: state.notifications.filter(notice => !notice.read).length
          };
        }
        if (name === 'vb_create_company') return addCompany(state, args, current);
        if (name === 'vb_update_company') return updateCompany(accounts, state, args, current);
        if (name === 'vb_list_obligations') {
          return {
            ...context,
            obligations: filterList(accounts, state, current, args),
            asOf: kazakhstanClock(current).date
          };
        }
        if (name === 'vb_get_obligation') {
          return { ...context, obligation: getObligation(accounts, state, current, args).obligation };
        }
        if (name === 'vb_add_obligation') return addObligation(accounts, state, current, args);
        if (name === 'vb_update_obligation') {
          return updateObligation(accounts, state, current, args, storage);
        }
        if (name === 'vb_set_applicability') {
          return setApplicability(accounts, state, current, args, storage);
        }
        if (name === 'vb_check_notifications') {
          return { ...context, ...checkNotifications(accounts, state, current, args) };
        }
        if (name === 'vb_list_notifications') {
          return { ...context, ...listNotifications(accounts, state, current, args) };
        }
        if (name === 'vb_notification_settings') return settings(state, args, current);
        if (name === 'vb_ack_notification') return ack(state, args, current);
        throw new Error(`Неизвестный инструмент: ${String(name)}.`);
      });
    }
  };
}
