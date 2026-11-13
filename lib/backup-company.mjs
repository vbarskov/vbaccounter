import { isAbsolute, join, resolve, sep } from 'node:path';
import { sha256 } from './storage.mjs';

const uuidPattern = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const accountingId = /^[0-9a-f-]{36}$/;
const externalDocumentFields = ['attachments', 'bankStatements', 'payrollDocuments'];
const attachmentExtensions = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.xls', '.xlsx', '.csv']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isCompanyBin(bin) {
  return typeof bin === 'string' && /^\d{12}$/.test(bin);
}

function availableAccounts(workspace) {
  if (workspace?.version !== 6 || !Array.isArray(workspace.accounts) || workspace.accounts.length === 0
      || workspace.accounts.length > 50) {
    throw new Error('Для резервной копии нужен файл VB Accounting версии 6 со списком ТОО.');
  }

  const accountsByBin = new Map();
  const ids = new Set();
  for (const account of workspace.accounts) {
    if (!isRecord(account) || typeof account.id !== 'string' || !account.id.trim()
        || ids.has(account.id.trim()) || typeof account.name !== 'string' || !account.name.trim()
        || !isRecord(account.data?.company)) {
      throw new Error('Повреждён список ТОО в файле VB Accounting.');
    }
    ids.add(account.id.trim());
    const { bin } = account.data.company;
    if (account.isDemo === true || !isCompanyBin(bin)) continue;
    accountsByBin.set(bin, accountsByBin.has(bin) ? null : account);
  }
  return [...accountsByBin.values()].filter(Boolean);
}

export function listBackupCompanies(workspace) {
  return availableAccounts(workspace).map(account => ({ bin: account.data.company.bin, name: account.name }));
}

function assertStateShape(state) {
  if (state?.version !== 1 || !Array.isArray(state.accounts) || !Array.isArray(state.obligations)
      || !Array.isArray(state.notifications) || !Array.isArray(state.audit) || !isRecord(state.overrides)
      || typeof state.settings?.enabled !== 'boolean' || !Array.isArray(state.settings.leadDays)) {
    throw new Error('Повреждено состояние VB Accounter.');
  }
}

function connectedWorkspace(state, workspacePath) {
  const current = state.workspace;
  if (typeof current?.path !== 'string' || !isAbsolute(current.path) || resolve(current.path) !== resolve(workspacePath)) {
    return null;
  }
  return {
    path: current.path,
    ...(typeof current.connectedAt === 'string' ? { connectedAt: current.connectedAt } : {})
  };
}

function scopeAudit(audit, selectedIds, notificationIds) {
  return audit.flatMap(event => {
    if (selectedIds.has(event?.accountId)) return [event];
    if (event?.accountId !== undefined) return [];
    if (event?.action === 'ack-notification' && notificationIds.has(event.notificationId)) return [event];
    if (event?.action !== 'produce-notifications' || !Array.isArray(event.notificationIds)) return [];
    const scoped = event.notificationIds.filter(id => notificationIds.has(id));
    if (!scoped.length) return [];
    return [{ id: event.id, at: event.at, action: event.action, notificationIds: scoped }];
  });
}

function pluginProjection(state, bin, workspacePath, account) {
  assertStateShape(state);
  const workspace = connectedWorkspace(state, workspacePath);
  const accounts = state.accounts.filter(row => row?.isDemo !== true && row?.data?.company?.bin === bin);
  const selectedIds = new Set(accounts.map(row => row.id));
  if (workspace) selectedIds.add(`workspace:${sha256(resolve(workspace.path)).slice(0, 12)}:${account.id.trim()}`);
  const sharesAccountId = state.accounts.some(row => !accounts.includes(row) && selectedIds.has(row?.id));
  if (accounts.length > 1 || sharesAccountId || selectedIds.size !== accounts.length + Number(Boolean(workspace))
      || [...selectedIds].some(id => typeof id !== 'string' || !id || id.includes('\n'))) {
    throw new Error('Неоднозначная карточка ТОО в VB Accounter. Проверьте БИН.');
  }

  const obligations = state.obligations.filter(row => selectedIds.has(row?.accountId));
  const overrides = Object.fromEntries(Object.entries(state.overrides)
    .filter(([key]) => selectedIds.has(key.split('\n', 1)[0])));
  const notifications = state.notifications.filter(row => selectedIds.has(row?.accountId));
  const audit = scopeAudit(state.audit, selectedIds, new Set(notifications.map(row => row.id)));
  return { selectedIds, projected: {
    version: 1, accounts, workspace, obligations, overrides, notifications, audit,
    settings: {
      enabled: state.settings.enabled,
      leadDays: state.settings.leadDays.filter(days => Number.isInteger(days) && days >= 0 && days <= 90)
    }
  } };
}

function referencedPluginDocuments(state, stateDir) {
  const pathPrefix = join(stateDir, 'documents') + sep;
  const escapedPrefix = pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filenamePattern = new RegExp(`${escapedPrefix}(${uuidPattern}\\.bin)(?=$|[\\s"'<>),;#?])`, 'g');
  const documents = new Set();
  function visit(value) {
    if (typeof value === 'string') {
      for (const [, filename] of value.matchAll(filenamePattern)) documents.add(filename);
    } else if (Array.isArray(value) || isRecord(value)) {
      for (const child of Object.values(value)) visit(child);
    }
  }
  visit(state);
  return documents;
}

function scopedPluginDocuments(state, projected, selectedIds, stateDir) {
  const documents = referencedPluginDocuments(projected, stateDir);
  const excluded = {
    accounts: state.accounts.filter(row => !projected.accounts.includes(row)),
    obligations: state.obligations.filter(row => !selectedIds.has(row?.accountId)),
    overrides: Object.entries(state.overrides).filter(([key]) => !Object.hasOwn(projected.overrides, key)).map(([, row]) => row),
    notifications: state.notifications.filter(row => !selectedIds.has(row?.accountId)),
    audit: state.audit.filter(event => event?.accountId !== undefined && !selectedIds.has(event.accountId))
  };
  const foreignDocuments = referencedPluginDocuments(excluded, stateDir);
  if ([...documents].some(filename => foreignDocuments.has(filename))) {
    throw new Error('Документ связан с несколькими ТОО. Уточните принадлежность документа перед копированием.');
  }
  return [...documents].sort();
}

function scopedAccountingDocuments(account) {
  const directory = sha256(account.id);
  const documents = new Set();
  for (const field of externalDocumentFields) {
    const items = account.data[field];
    if (items === undefined) continue;
    if (!Array.isArray(items)) throw new Error('Повреждён список вложений VB Accounting.');
    for (const item of items) {
      if (typeof item?.id !== 'string' || !accountingId.test(item.id) || !attachmentExtensions.has(item.ext)) {
        throw new Error('Повреждены данные вложения VB Accounting.');
      }
      documents.add(join(directory, item.id + item.ext));
    }
  }
  return [...documents].sort();
}

export function projectCompanyBackup({ state, workspace, bin, stateDir, workspacePath }) {
  if (!isCompanyBin(bin)) throw new Error('Укажите БИН из 12 цифр.');
  if (![stateDir, workspacePath].every(path => typeof path === 'string' && isAbsolute(path))) {
    throw new Error('Для резервной копии требуются абсолютные пути к данным VB Accounter и VB Accounting.');
  }
  const account = availableAccounts(workspace).find(row => row.data.company.bin === bin);
  if (!account) throw new Error('По указанному БИН не найдено единственное ТОО в VB Accounting.');
  const { selectedIds, projected } = pluginProjection(state, bin, workspacePath, account);
  return {
    state: projected,
    workspace: { version: 6, activeAccountId: account.id, accounts: [account] },
    pluginDocuments: scopedPluginDocuments(state, projected, selectedIds, stateDir),
    accountingDocuments: scopedAccountingDocuments(account)
  };
}
