import { reportingReminders, obligationAccepted } from './reporting.mjs';
import { nbReminders } from './national-bank.mjs';
import { taxObligations } from './tax-calendar.mjs';
import { reconcilePayrollPayments } from './bank-import.mjs';

export const defaultNotificationSettings = () => ({ enabled: true, hour: 9, salaryDay: 5, paymentsDay: 20, statementDay: 3 });
export function validateNotificationSettings(input) {
  if (!input || typeof input.enabled !== 'boolean') throw new Error('Проверьте настройку уведомлений.');
  const next = { enabled: input.enabled };
  for (const [key, max] of [['hour', 23], ['salaryDay', 28], ['paymentsDay', 28], ['statementDay', 28]]) {
    if (!Number.isInteger(input[key]) || input[key] < (key === 'hour' ? 0 : 1) || input[key] > max) throw new Error('Проверьте время и дни напоминаний.');
    next[key] = input[key];
  }
  return next;
}

export function kazakhstanClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, month: `${parts.year}-${parts.month}`, day: Number(parts.day), hour: Number(parts.hour) };
}

export function validObligationId(id) {
  return typeof id === 'string' && /^20\d{2}-(?:910-h[12]-(?:file|pay)|200-q[1-4]-file)$/.test(id);
}

// Scheduled dates below are personal reminders, not statutory payment deadlines.
export function dueReminders(accounts, settings, now = new Date()) {
  const clock = kazakhstanClock(now);
  if (!settings.enabled || clock.hour < settings.hour) return [];
  const today = new Date(`${clock.date}T12:00:00Z`);
  const previous = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1, 12)).toISOString().slice(0, 7);
  const rows = [];
  for (const account of accounts) {
    const accountLabel = `${account.isDemo ? 'ДЕМО · ' : ''}${account.name}`;
    const data = account.data;
    const company = data.company;
    if (!company) continue;
    for (const item of taxObligations(company, today, data.payroll || [])) {
      const accepted = item.kind === 'filing' ? obligationAccepted(data, item.id) : data.completedObligations?.includes(item.id);
      if (accepted) continue;
      const days = Math.round((new Date(`${item.due}T12:00:00Z`) - today) / 86400000);
      if (days > (item.kind === 'filing' ? 14 : 30) || (item.kind === 'payment' && days < -30)) continue;
      const stage = days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 1 ? '1d' : days <= 7 ? '7d' : item.kind === 'filing' ? '14d' : '30d';
      const date = item.due.split('-').reverse().join('.');
      const instructions = item.kind === 'filing' ? `Подготовьте полные выписки за период, ${item.id.includes('-200-') ? 'расчёты зарплаты по каждому сотруднику и платежи ИПН/социальных взносов' : 'документы доходов и оснований взносов участника'}, документы подрядчика за месяцы до начала самостоятельного учёта. В «Отчётах» проверьте расчёт. Откройте knp.kgd.gov.kz с ЭЦП ТОО, выберите ${item.id.includes('-200-') ? '200.00' : '910.00'} и этот период, перенесите показатели, заполните приложения, проверьте, подпишите и отправьте. Сохраните готовую форму и квитанцию «Принята» в приложении.` : 'Проверьте сумму по декларации и оплату в банке.';
      rows.push({ key: `${account.id}:${item.id}:${item.verified ? stage : 'verify-rules'}`, accountId: account.id, title: `${accountLabel}: ${item.verified ? item.title : `Проверьте правила ${item.period.slice(-4)} года — ${item.title}`}`, body: `${item.period}. ${item.verified ? days < 0 ? 'Срок прошёл' : days === 0 ? 'Срок сегодня' : `Срок ${date}` : `Дата ${date} — ориентир. Правила этого года ещё не настроены: сверьте действующую форму и срок в КНП ИСНА.`} ${instructions} ${item.kind === 'filing' ? 'Напоминание остаётся до подтверждения приёма квитанцией.' : 'Выполнение пока не отмечено.'}`, screen: item.kind === 'filing' ? 'reports' : 'tax', month: item.id.includes('-h') ? `${item.id.slice(0, 4)}-${item.id.includes('-h1-') ? '01' : '07'}` : `${item.id.slice(0, 4)}-${String((Number(item.id.match(/-q([1-4])-/)?.[1] || 1) - 1) * 3 + 1).padStart(2, '0')}`, obligationId: item.id });
    }
    const previousStart = `${previous}-01`;
    const previousEndDate = new Date(`${previous}-01T12:00:00Z`); previousEndDate.setUTCMonth(previousEndDate.getUTCMonth() + 1); previousEndDate.setUTCDate(0);
    const previousEnd = previousEndDate.toISOString().slice(0, 10);
    const companyExisted = !company.registrationDate || company.registrationDate <= previousEnd;
    const staffWorked = Array.isArray(company.employees) && company.employees.length
      ? company.employees.some(employee => (!employee.startDate || employee.startDate <= previousEnd) && (!employee.endDate || employee.endDate >= previousStart))
      : company.hasEmployees;
    const monthly = (type, day, title, body, screen) => {
      if (clock.day < day) return;
      rows.push({ key: `${account.id}:${clock.month}:${type}`, accountId: account.id, title: `${accountLabel}: ${title}`, body, screen, month: previous, obligationId: '' });
    };
    if (companyExisted && staffWorked) {
      const payroll = (data.payroll || []).filter(item => item.month === previous && item.status === 'posted');
      const bank = reconcilePayrollPayments(data.transactions || [], data.payroll || [], company.employeeCount === 1);
      const expectedStaff = (company.employees || []).filter(employee => (!employee.startDate || employee.startDate <= previousEnd) && (!employee.endDate || employee.endDate >= previousStart));
      const allAccrued = payroll.length > 0 && (expectedStaff.length ? expectedStaff.every(employee => payroll.some(item => item.employeeId === employee.id || item.employeeIin === employee.iin)) : payroll.length >= (company.employeeCount || 1));
      const salaryPaid = allAccrued && payroll.every(pay => bank.some(item => item.kind === 'expense' && item.category === 'Зарплата' && item.payrollMonth === previous && item.amountMinor === pay.netMinor && (item.counterpartyId === pay.employeeIin || item.payrollId === pay.id || (company.employeeCount === 1 && item.payrollAutoLinked))));
      if (!salaryPaid) monthly('salary', settings.salaryDay, 'Проверьте зарплату', `За ${previous}: ${allAccrued ? 'начисления есть, подтверждены не все выплаты' : 'подготовьте расчёт для каждого работавшего сотрудника'}. День выплаты — по документам компании. Если уже платили, загрузите XLS-выписку.`, 'payroll');
      const paymentFields = ['ipnMinor', 'opvMinor', 'vosmsMinor', 'soMinor', 'oosmsMinor', 'opvrMinor'];
      const fieldFor = item => ({ 'ИПН': 'ipnMinor', 'ОПВ': 'opvMinor', 'ОПВР': 'opvrMinor', 'Социальные отчисления': 'soMinor', 'ОСМС': /отчислен|оосмс/i.test(item.description || '') ? 'oosmsMinor' : /взнос|восмс/i.test(item.description || '') ? 'vosmsMinor' : '' })[item.category];
      const allPayments = allAccrued && payroll.every(pay => pay.employerMode && pay.employerMode !== 'none') && paymentFields.every(field => payroll.every(pay => Number.isSafeInteger(pay[field])) && payroll.reduce((sum, pay) => sum + pay[field], 0) === bank.filter(item => item.kind === 'expense' && item.payrollMonth === previous && fieldFor(item) === field).reduce((sum, item) => sum + item.amountMinor, 0));
      if (!allPayments) monthly('payments', settings.paymentsDay, 'Проверьте платежи по зарплате', `За ${previous}: в зарплате проверьте применимые ИПН, пенсионные и социальные платежи каждого сотрудника. Внесите внешний расчёт или явный 0 с основанием для неприменимого платежа. После оплаты в банке загрузите XLS-выписку; подтверждённые платежи закроют проверку.`, 'payroll');
    }
    if (companyExisted && !data.bankStatements?.some(item => item.month === previous)) monthly('statement', settings.statementDay, 'Загрузите выписку за месяц', `За ${previous}: загрузите XLS-выписку БЦК. Проверьте взносы, зарплату, обязательные платежи и субаренду.`, 'transactions');
  }
  rows.push(...accounts.flatMap(account => [...nbReminders(account, today), ...reportingReminders(account, today)]));
  return rows;
}

export function demoNotificationExamples(account, now = new Date()) {
  if (!account.isDemo) return [];
  const clock = kazakhstanClock(now);
  const date = new Date(`${clock.date}T12:00:00Z`);
  const month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1, 12)).toISOString().slice(0, 7);
  const examples = [
    ['salary', 'Проверить зарплату', `Пример: за ${month} нужно рассчитать зарплату директора и сверить выплату с банком.`, 'payroll'],
    ['payments', 'Проверить обязательные платежи', 'Пример: сверить ИПН, пенсионные и социальные платежи с расчётом зарплаты и выпиской.', 'payroll'],
    ['statement', 'Загрузить выписку', `Пример: загрузить полную XLS-выписку БЦК за ${month}. Файл будет сохранён вместе с операциями.`, 'transactions'],
    ['rent', 'Проверить оплату субаренды', 'Пример: сопоставить платёж с договором, счётом и документами по субаренде.', 'transactions'],
    ['200', 'Сдать 200.00 за квартал', 'Пример уведомления для ТОО с зарплатой директору: подготовить квартальный отчёт, отправить его в КНП ИСНА и проверить статус «Принята».', 'tax'],
    ['national-bank', 'Проверить отчётность Нацбанка', 'Пример: получите справку за квартал, проверьте назначение 1-ПБ и 10-ПБ. Черновики, документы и инструкция по подаче доступны в разделе «Нацбанк».', 'national-bank'],
    ['910', 'Сдать 910.00 за полугодие', 'Пример: проверить доходы за полугодие, подготовить 910.00 и отправить её в КНП ИСНА. Сроки доступны в календаре.', 'tax'],
  ];
  return examples.map(([type, title, body, screen]) => ({ key: `${account.id}:demo-example-v1:${type}`, accountId: account.id, title: `ДЕМО · ${title}`, body, screen, month: screen === 'tax' ? '' : month, obligationId: '', createdAt: now.toISOString(), attemptDate: clock.date, read: false, delivery: 'in-app' }));
}
