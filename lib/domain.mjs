import { createHash } from 'node:crypto';
import { taxObligations } from '../vendor/vb-accounting/tax-calendar.mjs';
import {
  obligationAccepted, acceptedReport, reportObligation, reportPeriod, reportingReminders,
} from '../vendor/vb-accounting/reporting.mjs';
import {
  nbAcceptanceConfirmed, nbDueDate, nbPeriod, nbForms, nbLinks,
} from '../vendor/vb-accounting/national-bank.mjs';
import {
  dueReminders, defaultNotificationSettings, kazakhstanClock,
} from '../vendor/vb-accounting/reminders.mjs';

export const RULE_NOTICE = 'Правила перенесены из снимка VB Accounting; действующие формы, применимость и сроки в официальном кабинете не проверялись.';
export const RULES = {
  kind: 'vendored-snapshot',
  sourceVerifiedYear: 2026,
  rulesNeedVerification: true,
  notice: RULE_NOTICE,
};

export function isoDate(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function text(value, label, max = 1000, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) {
    throw new Error(`Проверьте ${label}: текст до ${max} символов.`);
  }
  return value.trim();
}

export function date(value, label, optional = false) {
  if (optional && (value === undefined || value === '')) return null;
  if (!isoDate(value)) throw new Error(`Проверьте дату ${label}: YYYY-MM-DD.`);
  return value;
}

export function urgency(due, now, leadDays = [30, 14, 7, 1, 0]) {
  if (!due) return { stage: 'unknown', daysUntilDue: null };
  const today = kazakhstanClock(now).date;
  const days = Math.round((Date.parse(`${due}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
  const lead = [...leadDays].sort((a, b) => a - b).find(day => days <= day);
  let stage = 'upcoming';
  if (days < 0) stage = 'overdue';
  else if (days === 0) stage = 'today';
  else if (lead !== undefined) stage = `${lead}d`;
  return { stage, daysUntilDue: days };
}

function nextAction(row) {
  if (row.applicability === 'not-required') return 'Сохраните основание неприменимости и перепроверьте при изменении обстоятельств.';
  if (row.applicability === 'unknown') {
    return row.origin === 'profile-check'
      ? `${row.notes} Дополните карточку компании либо сохраните основание проверки.`
      : 'Проверьте назначение и действующие сроки в официальном кабинете; сохраните основание.';
  }
  if (row.lifecycle === 'accepted') return 'Квитанция о приёме сохранена. Храните её вместе с отчётом.';
  if (row.lifecycle === 'paid') return 'Подтверждение оплаты сохранено. Сверьте платёж в официальном кабинете.';
  if (row.lifecycle === 'done') return 'Проверка отмечена выполненной.';
  if (row.lifecycle === 'rejected') return 'Проверьте причину в квитанции, исправьте отчёт и повторите отправку.';
  if (row.lifecycle === 'sent') return 'Получите квитанцию «Принята»; отправка не подтверждает приём.';
  if (row.kind === 'payment') return 'Проверьте сумму и реквизиты, выполните платёж и сохраните банковское подтверждение.';
  if (row.kind === 'filing') {
    return row.lifecycle === 'prepared'
      ? 'Проверьте полную форму в официальном кабинете, подпишите, отправьте и сохраните квитанцию.'
      : 'Соберите документы за период, уточните действующие правила и подготовьте отчёт.';
  }
  return row.notes || 'Проверьте данные и сохраните результат проверки.';
}

function receiptMeta(document, receipt) {
  if (!document) return null;
  return {
    verification: 'user-supplied',
    source: 'connected-workspace',
    documentId: document.id || '',
    name: document.name || '',
    receiptReference: receipt?.reference || '',
    notice: 'Сведения и квитанция из выбранного файла. Онлайн-проверка государственного статуса не выполнялась.',
  };
}

function revision(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function reportingRevision(report) {
  if (!report) return revision(null);
  const shallow = value => ({
    status: value.status || null,
    submissionRef: value.submissionRef || null,
    sentAt: value.sentAt || null,
    preparedAt: value.preparedAt || null,
    receipt: value.receipt || null,
  });
  return revision({ ...shallow(report), history: (report.history || []).map(shallow) });
}

function reportLifecycle(data, form, period) {
  const report = data.reporting?.reports?.find(row => row.form === form && row.period === period);
  const accepted = acceptedReport(data, form, period);
  const document = accepted && data.reporting.documents.find(doc =>
    doc.id === accepted.receipt.documentId && doc.kind === 'receipt');
  let lifecycle = 'needs-data';
  if (accepted) lifecycle = 'accepted';
  else if (report?.status === 'accepted') lifecycle = 'sent';
  else if (['prepared', 'sent', 'rejected'].includes(report?.status)) lifecycle = report.status;
  return {
    sourceRevision: reportingRevision(report),
    sourceLifecycle: accepted ? 'accepted' : report?.status || 'needs-data',
    lifecycle,
    evidence: receiptMeta(document, accepted?.receipt),
  };
}

function taxRows(account, now) {
  const data = account.data;
  return taxObligations(data.company, now, data.payroll || []).map(item => {
    const completionClaim = data.completedObligations?.includes(item.id) === true;
    const form = item.id.includes('-200-') ? '200.00' : '910.00';
    const period = `${item.id.slice(0, 4)}-${item.id.match(/-(h[12]|q[1-4])-/)[1].toUpperCase()}`;
    const lifecycle = item.kind === 'filing'
      ? reportLifecycle(data, form, period)
      : {
        lifecycle: 'pending', sourceLifecycle: 'pending',
        sourceRevision: revision({ completionClaim }), sourceCompletionClaim: completionClaim,
      };
    return {
      id: item.id,
      title: item.title,
      authority: 'КГД Казахстана',
      period: item.period,
      periodStart: item.periodStart,
      periodEnd: item.periodEnd,
      due: item.verified ? item.due : null,
      estimatedDue: item.verified ? null : item.due,
      kind: item.kind,
      applicability: 'required',
      sourceUrl: item.source,
      origin: 'tax-snapshot',
      sourceVerifiedYear: item.verified ? 2026 : null,
      rulesNeedVerification: true,
      ...lifecycle,
      ...(item.kind === 'filing' && completionClaim && !obligationAccepted(data, item.id)
        ? { sourceCompletionClaim: true } : {}),
    };
  });
}

function bnsRows(account) {
  const data = account.data;
  return (data.reporting?.assignments || []).map(assignment => {
    const span = reportPeriod(assignment.form, assignment.period);
    const document = data.reporting.documents?.find(doc =>
      doc.id === assignment.documentId && doc.kind === 'respondent');
    const missingBasis = assignment.status !== 'unknown' && (!assignment.reference || !document);
    return {
      id: `bns:${assignment.form}:${assignment.period}`,
      title: `Сдать ${assignment.form}`,
      authority: 'БНС Казахстана',
      period: assignment.period,
      periodStart: span.from,
      periodEnd: span.to,
      kind: 'filing',
      due: assignment.dueDate || null,
      applicability: missingBasis ? 'unknown' : assignment.status,
      ...reportLifecycle(data, assignment.form, assignment.period),
      origin: 'bns-assignment',
      sourceUrl: 'https://cabinet.stat.gov.kz/',
      provenance: {
        reference: assignment.reference || '',
        documentId: assignment.documentId || '',
        checkedAt: assignment.checkedAt || '',
        recordedStatus: assignment.status,
      },
      rulesNeedVerification: true,
    };
  }).filter(row => !data.company.registrationDate || row.periodEnd >= data.company.registrationDate);
}

function completedQuarters(data, now) {
  const current = nbPeriod(now);
  if (current.year < 2026) return [];
  const start = knownAccountingStart(data);
  const firstYear = start ? Math.max(2026, Number(start.slice(0, 4))) : current.year;
  const firstQuarter = start && firstYear === Number(start.slice(0, 4))
    ? Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1
    : start ? 1 : current.quarter;
  const quarters = [];
  const last = current.year * 4 + current.quarter - 1;
  for (let index = firstYear * 4 + firstQuarter - 1; index <= last; index++) {
    quarters.push({ year: Math.floor(index / 4), quarter: index % 4 + 1 });
  }
  return quarters;
}

function nbCandidates(account, now) {
  const candidates = [...(account.data.nationalBankReports || [])];
  for (const period of completedQuarters(account.data, now)) {
    for (const form of nbForms) {
      const saved = candidates.some(report =>
        report.form === form && report.year === period.year && report.quarter === period.quarter);
      if (!saved) {
        candidates.push({
          id: `${period.year}-Q${period.quarter}:${form}`,
          year: period.year, quarter: period.quarter, form,
          assignment: 'unknown', status: 'draft',
        });
      }
    }
  }
  return candidates;
}

function nbRows(account, now) {
  return nbCandidates(account, now).map(report => {
    const period = `${report.year}-Q${report.quarter}`;
    const span = reportPeriod('200.00', period);
    const accepted = nbAcceptanceConfirmed(report);
    const proven = report.checkedOn && report.assignmentRef;
    const applicability = report.assignment === 'unknown' || !proven ? 'unknown' : report.assignment;
    let lifecycle = 'needs-data';
    if (accepted) lifecycle = 'accepted';
    else if (report.status === 'accepted') lifecycle = 'sent';
    else if (['sent', 'rejected'].includes(report.status)) lifecycle = report.status;
    return {
      id: `nb:${report.id}`,
      title: `Сдать ${report.form}`,
      authority: 'Национальный Банк Казахстана',
      period,
      periodStart: span.from,
      periodEnd: span.to,
      kind: 'filing',
      applicability,
      due: applicability === 'required' && report.year === 2026
        ? nbDueDate(report.year, report.quarter, report.form) : null,
      estimatedDue: report.year !== 2026 ? nbDueDate(report.year, report.quarter, report.form) : null,
      lifecycle,
      evidence: accepted ? {
        verification: 'user-supplied', source: 'connected-workspace',
        name: report.documents.find(doc => doc.kind === 'receipt')?.name || '',
        receiptReference: report.receiptRef,
      } : null,
      sourceUrl: nbLinks.portal,
      origin: 'nb-assignment',
      sourceLifecycle: report.status,
      sourceRevision: revision({
        status: report.status,
        receiptRef: report.receiptRef || '',
        receiptDate: report.receiptDate || '',
        receiptVerified: report.receiptVerified === true,
        assignment: report.assignment,
      }),
      sourceVerifiedYear: report.year === 2026 ? 2026 : null,
      rulesNeedVerification: true,
      provenance: {
        reference: report.assignmentRef || '',
        checkedAt: report.checkedOn || '',
        recordedStatus: report.assignment,
      },
    };
  }).filter(row => !account.data.company.registrationDate || row.periodEnd >= account.data.company.registrationDate);
}

function knownAccountingStart(data) {
  const dates = [data.company.registrationDate, data.reporting?.settings?.activityStart,
    ...(data.transactions || []).map(row => row.date),
    ...(data.bankStatements || []).map(row => row.month ? `${row.month}-01` : ''),
    ...(data.payroll || []).map(row => row.month ? `${row.month}-01` : '')];
  return dates.filter(isoDate).sort()[0] || null;
}
function monthlyReviewTimes(data, now) {
  const clock = kazakhstanClock(now);
  const previous = new Date(`${clock.month}-01T12:00:00Z`);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const lastMonth = previous.toISOString().slice(0, 7);
  const firstMonth = knownAccountingStart(data)?.slice(0, 7) || lastMonth;
  const times = [];
  for (let month = firstMonth; month <= lastMonth;) {
    if (month === lastMonth) {
      times.push(now);
    } else {
      const nextMonthEnd = new Date(`${month}-01T12:00:00Z`);
      nextMonthEnd.setUTCMonth(nextMonthEnd.getUTCMonth() + 2);
      nextMonthEnd.setUTCDate(0);
      times.push(nextMonthEnd);
    }
    const nextMonth = new Date(`${month}-01T12:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    month = nextMonth.toISOString().slice(0, 7);
  }
  return times;
}
function supportingRows(account, now) {
  // Recompute every known historical period so unresolved monthly work survives rollover.
  // These review dates are personal reminders, never statutory deadlines.
  const monthlyAccount = {
    ...account,
    data: {
      ...account.data,
      company: { ...account.data.company, taxRegime: 'unknown' },
      reporting: { settings: {}, documents: [], assignments: [], reports: [] },
      nationalBankReports: [],
    },
  };
  const monthly = monthlyReviewTimes(account.data, now).flatMap(reviewAt =>
    dueReminders([monthlyAccount], { ...defaultNotificationSettings(), hour: 0 }, reviewAt)
      .filter(reminder => /:(salary|payments|statement)$/.test(reminder.key)));
  const rows = monthly.map(reminder => ({
    id: `check:${reminder.key.slice(account.id.length + 1)}`,
    title: reminder.title.slice(reminder.title.indexOf(':') + 1).trim(),
    authority: reminder.screen === 'transactions' ? 'Внутренний учёт' : 'Работодатель / внутренний учёт',
    period: reminder.month,
    due: null,
    kind: 'check',
    applicability: 'required',
    lifecycle: 'needs-data',
    notes: reminder.body,
    nextAction: reminder.body,
    origin: 'personal-reminder',
    deadlineKind: 'personal-review',
    rulesNeedVerification: false,
  }));
  for (const quarter of completedQuarters(account.data, now)) {
    const period = `${quarter.year}-Q${quarter.quarter}`;
    // A result for a single form never proves the whole period's selection was checked.
    rows.push({
      id: `check:bns:${period}`,
      title: 'Проверить полный перечень назначенных форм БНС',
      authority: 'БНС Казахстана',
      period,
      due: null,
      kind: 'check',
      applicability: 'unknown',
      lifecycle: 'needs-data',
      sourceUrl: 'https://cabinet.stat.gov.kz/',
      origin: 'assignment-check',
      rulesNeedVerification: true,
    });
  }
  const profileCheck = (id, title, notes) => rows.push({
    id, title, notes, authority: 'Карточка компании / внутренний учёт',
    period: 'Сведения о компании', due: null, kind: 'check', applicability: 'unknown',
    lifecycle: 'needs-data', origin: 'profile-check', rulesNeedVerification: false,
  });
  if (!account.data.company.registrationDate) {
    profileCheck('check:registration-date', 'Уточнить дату регистрации компании',
      'Дата регистрации неизвестна: полнота исторических обязательств не подтверждена.');
  }
  if (typeof account.data.company.hasEmployees !== 'boolean' && !(account.data.company.employees || []).length && !(account.data.payroll || []).length) {
    profileCheck('check:staff-scope', 'Уточнить наличие работников и зарплатной отчётности',
      'Наличие работников неизвестно. Отсутствие сохранённых начислений не подтверждает отсутствие зарплатной отчётности.');
  }
  if (account.data.company.taxRegime !== 'simplified') {
    rows.push({
      id: 'check:tax-scope', title: 'Уточнить состав налоговой отчётности',
      authority: 'КГД Казахстана', period: 'Текущие обязательства', due: null,
      kind: 'check', applicability: 'unknown', lifecycle: 'needs-data',
      sourceUrl: 'https://knp.kgd.gov.kz/', origin: 'scope-check', rulesNeedVerification: true,
    });
  }
  reportingReminders(account, now);
  return rows;
}

function addUncoveredReports(generated, account) {
  for (const report of account.data.reporting?.reports || []) {
    const id = reportObligation(report.form, report.period) || `bns:${report.form}:${report.period}`;
    if (generated.some(obligation => obligation.id === id)) continue;
    const span = reportPeriod(report.form, report.period);
    generated.push({
      id,
      title: `Сдать ${report.form}`,
      authority: report.form.startsWith('2-') ? 'БНС Казахстана' : 'КГД Казахстана',
      period: report.period,
      periodStart: span.from,
      periodEnd: span.to,
      kind: 'filing',
      applicability: 'unknown',
      due: null,
      ...reportLifecycle(account.data, report.form, report.period),
      origin: 'source-report',
      rulesNeedVerification: true,
    });
  }
}

function applyOverride(item, override, account) {
  const closedOverride = ['accepted', 'paid'].includes(override.lifecycle);
  const changedSource = closedOverride && override.sourceBasis
    && override.sourceBasis.revision !== (item.sourceRevision || null);
  // Accepted source evidence takes precedence over an older local open status.
  const { lifecycle, evidence, sourceBasis, ...basisPatch } = override;
  const patch = item.lifecycle === 'accepted' && !changedSource ? basisPatch : override;
  const row = {
    ...item,
    ...patch,
    accountId: account.id,
    accountName: account.name,
    isDemo: account.isDemo === true,
  };
  if (changedSource) {
    row.conflict = {
      kind: 'source-changed',
      previousLocalStatus: override.lifecycle,
      sourceLifecycle: item.lifecycle,
      notice: 'Исходный статус или квитанция изменились после локального подтверждения. Проверьте новую запись и сохраните актуальное доказательство.',
    };
    row.previousLocalEvidence = override.evidence || null;
    row.evidence = item.evidence || null;
    row.lifecycle = item.kind === 'payment' ? 'pending' : item.lifecycle === 'accepted' ? 'sent' : item.lifecycle;
  }
  // Keep current source revision separate from the basis of the saved local action.
  row.sourceRevision = item.sourceRevision || null;
  row.sourceLifecycle = item.sourceLifecycle || item.lifecycle;
  return row;
}

function projectedNextAction(row) {
  if (row.conflict) return row.conflict.notice;
  if (row.closed || row.applicability === 'unknown' || ['sent', 'rejected', 'prepared'].includes(row.lifecycle)) {
    return nextAction(row);
  }
  return row.nextAction || nextAction(row);
}

export function project(account, state, now) {
  const generated = [
    ...taxRows(account, now),
    ...bnsRows(account),
    ...nbRows(account, now),
    ...supportingRows(account, now),
  ];
  addUncoveredReports(generated, account);
  const manual = state.obligations.filter(obligation => obligation.accountId === account.id);
  return [...generated, ...manual].map(item => {
    const override = state.overrides[`${account.id}\n${item.id}`] || {};
    const row = applyOverride(item, override, account);
    row.closed = row.applicability !== 'unknown'
      && (row.applicability === 'not-required' || ['accepted', 'paid', 'done'].includes(row.lifecycle));
    row.paymentStatus = row.kind === 'payment' ? row.lifecycle : null;
    row.urgency = {
      ...urgency(row.due || row.estimatedDue, now, state.settings.leadDays),
      estimated: !row.due && !!row.estimatedDue,
    };
    row.history = state.audit.filter(event => event.accountId === account.id && event.obligationId === row.id);
    row.nextAction = projectedNextAction(row);
    row.ruleNotice = row.rulesNeedVerification ? RULE_NOTICE : null;
    return row;
  }).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.id.localeCompare(b.id));
}
