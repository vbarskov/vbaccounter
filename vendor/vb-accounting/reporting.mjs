import { reconcilePayrollPayments, payrollPeriod } from './bank-import.mjs';

export const REPORTING_RULES = '2026-10-11-v2';
export const REPORTING_SOURCE = 'https://old.adilet.zan.kz/rus/docs/V2500037390';
export const reportingDefaults = () => ({ settings: { activityStart: '', payrollStart: '', salaryGross: '', passportNumber: '', passportDate: '', residenceCountry: '', foreignTaxId: '', foreignTaxIdAbsent: false, activityCity: '', activityStreet: '', activityBuilding: '', activityOffice: '', directorName: '', activityCode: '', declarationType: '', citizenshipCountry: '', identityDocumentType: '', onlyStandardOperations: false }, documents: [], assignments: [], reports: [] });
const copy = value => structuredClone(value);
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0);
const isoDate = value => /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
export function reportPeriod(form, period) {
  const match = /^(20\d{2})-(H[12]|Q[1-4])$/.exec(period);
  if (!match || Number(match[1]) < 2026 || (form === '910.00' ? !match[2].startsWith('H') : !match[2].startsWith('Q'))) throw new Error('Выберите квартал или полугодие с 2026 года.');
  const year = Number(match[1]);
  const length = form === '910.00' ? 6 : 3;
  const start = (Number(match[2][1]) - 1) * length + 1;
  const months = Array.from({ length }, (_, i) => `${year}-${String(start + i).padStart(2, '0')}`);
  const last = months.at(-1);
  return { months, from: months[0] + '-01', to: last + '-' + new Date(Date.UTC(year, Number(last.slice(5)), 0)).getUTCDate(), label: `${match[2][1]} ${length === 6 ? 'полугодие' : 'квартал'} ${year}` };
}
export function reportObligation(form, period) {
  return ['200.00', '910.00'].includes(form) ? `${period.slice(0, 4)}-${form.slice(0, 3)}-${period.slice(5).toLowerCase()}-file` : '';
}
const paymentField = row => ({ 'Зарплата': 'netMinor', 'ИПН': 'ipnMinor', 'ОПВ': 'opvMinor', 'ОПВР': 'opvrMinor', 'Социальные отчисления': 'soMinor', 'Социальный налог': 'socialTaxMinor', 'ОСМС': /отчислен|оосмс/i.test(row.description) ? 'oosmsMinor' : /взнос|восмс/i.test(row.description) ? 'vosmsMinor' : '' })[row.category];
const employeeKey = row => row.employeeId || row.employeeIin || row.employeeName;
const salaryMatches = (transaction, payroll) => transaction.kind === 'expense' && transaction.category === 'Зарплата' && transaction.payrollMonth === payroll.month && transaction.amountMinor === payroll.netMinor && (transaction.payrollId ? transaction.payrollId === payroll.id : transaction.counterpartyId === payroll.employeeIin || transaction.payrollAutoLinked);
export function acceptedReport(data, form, period) {
  const reporting = data.reporting || {};
  const report = reporting.reports?.find(row => row.form === form && row.period === period && row.status === 'accepted');
  return report && report.receipt?.status === 'accepted' && reporting.documents?.some(doc => doc.id === report.receipt.documentId && doc.kind === 'receipt') ? report : null;
}
export function obligationAccepted(data, obligationId) {
  const match = /^(20\d{2})-(200|910)-(q[1-4]|h[12])-file$/.exec(obligationId);
  return !!(match && acceptedReport(data, `${match[2]}.00`, `${match[1]}-${match[3].toUpperCase()}`));
}
export function calculateReport(data, form, period, confirmations = {}, now = new Date()) {
  if (!['200.00', '910.00', '2-МП', '2-услуги'].includes(form)) throw new Error('Неизвестная форма.');
  const span = reportPeriod(form, period);
  const settings = data.reporting?.settings || reportingDefaults().settings;
  const company = data.company || {};
  const bank = reconcilePayrollPayments(data.transactions || [], data.payroll || [], company.employeeCount === 1);
  const inPeriod = date => date >= span.from && date <= span.to;
  const transactions = bank.filter(row => inPeriod(row.date));
  const journal = (data.journal || []).filter(row => inPeriod(row.date));
  const payroll = (data.payroll || []).filter(row => span.months.includes(row.month));
  const issues = [];
  const warnings = [];
  const fields = [];
  const issue = (code, text, screen = 'reports', month = '') => issues.push({ code, text, screen, month });
  const field = (code, label, value, unit = '₸') => fields.push({ code, label, value, unit });
  if (!/^\d{12}$/.test(company.bin || '') || !company.legalName || !company.taxOfficeCode) issue('company', 'Заполните название, БИН и код УГД в карточке компании.', 'tax');
  if (!isoDate(settings.activityStart)) issue('activity', 'Укажите дату начала учёта и подтвердите полноту данных за период.');
  else if (settings.activityStart > span.to) issue('before-start', 'Выбранный период закончился до даты начала учёта.');
  if (now.toISOString().slice(0, 10) <= span.to) issue('open-period', 'Период ещё не закончился. Расчёт предварительный; окончательный отчёт можно подготовить после его окончания.');
  if (!confirmations.scope) issue('scope', 'Подтвердите условия расчёта: одно место деятельности, штатные работники; без ГПХ, дивидендов, льгот, подразделений и единого платежа; расчёты в тенге.');
  if (!confirmations.complete) issue('complete', 'Подтвердите, что все выписки и первичные документы за период внесены.');
  if (!confirmations.reviewed) issue('review', 'Проверьте расчёт и основания исключения взносов из дохода.');
  const unposted = transactions.filter(row => !journal.some(entry => entry.sourceTransactionId === row.id));
  if (unposted.length) issue('unposted', `${unposted.length} операций без проводки. Уточните категории в «Операциях».`, 'transactions');
  const months = span.months.filter(month => !settings.activityStart || month >= settings.activityStart.slice(0, 7));
  let previousClosing = null;
  for (const month of months) {
    const reconciliation = (data.bankReconciliations || []).find(row => row.month === month);
    if (!reconciliation) { issue(`bank-${month}`, `${month}: укажите начальный и конечный остаток из полной выписки.`, 'accounting', month); continue; }
    if (previousClosing !== null && previousClosing !== reconciliation.openingMinor) issue(`continuity-${month}`, `${month}: начальный остаток не совпадает с конечным остатком предыдущего месяца.`, 'accounting', month);
    previousClosing = reconciliation.closingMinor;
    const movement = bank.filter(row => row.date.startsWith(month)).reduce((total, row) => total + (row.kind === 'income' ? row.amountMinor : -row.amountMinor), 0);
    if (reconciliation.openingMinor + movement !== reconciliation.closingMinor) issue(`balance-${month}`, `${month}: движения не совпадают с остатками банка.`, 'accounting', month);
  }
  const configuredYear = period.startsWith('2026-');
  if (!configuredYear) issue('unconfigured-year', `Правила автозаполнения ${period.slice(0, 4)} года ещё не настроены. Проверьте действующую форму в официальном кабинете; готовый отчёт и квитанцию можно сохранить здесь.`);
  if (form === '910.00' && configuredYear) {
    if (company.taxRegime !== 'simplified' || company.vatRegistered || !/^г\.?\s*Алматы(?:\s*,|\s*$)/i.test(company.region || '')) issue('regime', 'Авторасчёт 910 поддерживает ТОО на упрощённом режиме без НДС в г. Алматы.', 'tax');
    const income = sum(journal, 'taxBaseMinor');
    const annual = sum((data.journal || []).filter(row => row.date >= '2026-01-01' && row.date <= span.to), 'taxBaseMinor');
    if (annual > 10380000000) issue('threshold', 'Доход превысил 24 000 МРП: нужен отдельный расчёт уменьшения дохода на расходы по работникам.');
    if (income < 0) issue('negative', 'Отрицательная база: проверьте корректировки дохода.', 'accounting');
    if (journal.some(row => /^6/.test(row.creditAccount) && !row.taxBaseMinor)) issue('unrecognized', 'Есть проводки дохода без заполненной налоговой базы. Проверьте признание дохода.', 'accounting');
    // Official monetary cells contain whole tenge. Tax is computed from that
    // reported base so main and appendix follow the portal's arithmetic checks.
    const incomeTenge = Math.round(income / 100);
    const taxTenge = Math.round(incomeTenge * .03);
    field('910.00.001', 'Доход за полугодие', incomeTenge);
    field('910.00.002', 'Уменьшение по п. 1 ст. 724 (при доходе до порога — 0)', annual > 10380000000 ? null : 0);
    field('910.00.003', 'Доход для исчисления КПН', incomeTenge);
    field('910.00.004', 'КПН, ставка Алматы 3%', taxTenge);
    field('910.01.B', 'Код УГД единственного места деятельности', company.taxOfficeCode || '', '');
    if (!settings.activityCity || !settings.activityStreet || !settings.activityBuilding) issue('place', 'Заполните фактическое место деятельности для приложения 910.01 в сведениях компании.');
    field('910.01.A', 'Номер места деятельности', 1, '');
    field('910.01.C', 'Город места деятельности', settings.activityCity || '', '');
    field('910.01.D', 'Улица места деятельности', settings.activityStreet || '', '');
    field('910.01.E', 'Дом', settings.activityBuilding || '', '');
    field('910.01.F', 'Офис / помещение (если есть)', settings.activityOffice || '', '');
    field('910.01.G', 'Ставка КПН для единственного места в Алматы', 3, '%');
    field('910.01.001', 'Уменьшение дохода', annual > 10380000000 ? null : 0);
    field('910.01.I', 'Доля единственного места деятельности', income ? 100 : 0, '%');
    field('910.01.J', 'Распределённое уменьшение', annual > 10380000000 ? null : 0);
    field('910.01.K', 'Облагаемый доход места деятельности', incomeTenge);
    field('910.01.L', 'КПН по месту деятельности', taxTenge);
    field('910.01.H', 'Доход единственного места деятельности', incomeTenge);
    warnings.push('Взносы и займы исключены по категориям учёта. Основания должны быть сохранены с операциями. Раздел платежей ИП за себя к ТОО не применяется.');
  } else if (form === '200.00' && configuredYear) {
    if (company.taxRegime !== 'simplified') issue('employee-scope', 'Автозаполнение платежей работодателя настроено для ТОО на упрощённом режиме. Готовую форму из кабинета можно сохранить здесь.', 'tax');
    const employees = (company.employees || []).filter(employee => (!employee.startDate || employee.startDate <= span.to) && (!employee.endDate || employee.endDate >= span.from));
    if (!employees.length && !isoDate(settings.payrollStart)) issue('payroll-start', 'Укажите дату начала работы сотрудника в карточке компании либо директора в сведениях отчётности.', 'tax');
    const expected = span.months.filter(month => !settings.payrollStart || month >= settings.payrollStart.slice(0, 7));
    for (const month of employees.length ? span.months : expected) {
      const active = employees.filter(employee => (!employee.startDate || employee.startDate.slice(0, 7) <= month) && (!employee.endDate || employee.endDate.slice(0, 7) >= month));
      const items = payroll.filter(row => row.month === month && row.status === 'posted');
      for (const employee of active) if (!items.some(row => row.employeeId === employee.id || row.employeeIin === employee.iin)) issue(`payroll-${month}-${employee.id}`, `${month}: нет начисления для ${employee.fullName}. Откройте зарплату, выберите сотрудника и сохраните расчёт.`, 'payroll', month);
      if (!employees.length && !items.length) issue(`payroll-${month}`, `${month}: нет сохранённого начисления зарплаты.`, 'payroll', month);
      for (const item of items) {
        if (!item.employerMode || item.employerMode === 'none') issue(`employer-${month}-${item.id}`, `${month}, ${item.employeeName}: платежи ТОО ещё не определены. В зарплате откройте «Дополнить платежи ТОО»: рассчитайте их или внесите внешний расчёт; для неприменимых платежей укажите явный 0 с основанием.`, 'payroll', month);
        if (item.employerMode === 'manual' && !item.employerBasis?.trim()) issue(`employer-basis-${item.id}`, `${month}, ${item.employeeName}: укажите основание внешнего расчёта платежей ТОО в зарплате. Сохранённые суммы остаются прежними до исправления.`, 'payroll', month);
        if (item.workerProfile === 'unknown') issue(`worker-status-${item.id}`, `Уточните налоговый статус ${item.employeeName}.`, 'payroll', month);
      }
    }
    const relevant = (data.payroll || []).filter(row => row.status === 'posted' && (span.months.includes(row.month) || transactions.some(t => salaryMatches(t, row))));
    for (const key of new Set(relevant.map(employeeKey))) if (new Set(relevant.filter(row => employeeKey(row) === key).map(row => row.workerProfile)).size > 1) issue(`status-change-${key}`, 'В периоде менялся налоговый статус сотрудника: проверьте применимые приложения в кабинете.');
    if (relevant.some(row => row.workerProfile === 'eaeu-nonresident')) {
      const nonresidentEmployees = [...new Map(relevant.filter(row => row.workerProfile === 'eaeu-nonresident').map(row => [employeeKey(row), row])).values()];
      if (new Set(relevant.map(employeeKey)).size > 1) issue('individual-passports', `Для ${nonresidentEmployees.map(row => `${row.employeeName} (ИИН ${row.employeeIin})`).join(', ')} заполните индивидуальные страну налогового резидентства, номер и дату паспорта в приложении 200.02 КНП ИСНА. Общие сведения директора не подставляются другим сотрудникам. Прикрепите здесь готовую форму с проверенными приложениями.`);
      else if (!/^[A-Z]{2}$/.test(settings.residenceCountry) || !settings.passportNumber || !isoDate(settings.passportDate)) issue('passport', 'Для приложения 200.02 укажите страну налогового резидентства, номер и дату выдачи паспорта.');
      warnings.push('Нерезидент отражается в приложении 200.02. Гражданство РФ и налоговое резидентство — разные сведения.');
    }
    const mapping = [['200.00.001', 'ИПН с выплаченного дохода', 'ipnMinor', true], ['200.00.002', 'ОПВ с выплаченного дохода', 'opvMinor', true], ['200.00.005', 'Социальный налог', 'socialTaxMinor', false], ['200.00.008', 'Социальные отчисления', 'soMinor', false], ['200.00.010', 'Отчисления ОСМС', 'oosmsMinor', false], ['200.00.011', 'Взносы ОСМС', 'vosmsMinor', false], ['200.00.013', 'ОПВР', 'opvrMinor', false]];
    for (const [code, label, key, onPayment] of mapping) {
      const values = span.months.map(month => {
        const source = onPayment ? relevant.filter(p => bank.some(t => t.date.startsWith(month) && salaryMatches(t, p))) : relevant.filter(p => p.month === month);
        if ((!source.length && (!settings.payrollStart || (month >= settings.payrollStart.slice(0, 7) && !payroll.some(p => p.month === month && p.status === 'posted')))) || source.some(p => p[key] == null)) return null;
        return sum(source, key) / 100;
      });
      values.forEach((value, i) => field(`${code} ${['I', 'II', 'III'][i]}`, `${label} · ${span.months[i]}`, value));
      field(`${code} IV`, `${label} · квартал`, values.some(value => value === null) ? null : values.reduce((a, b) => a + b, 0));
    }
    for (const row of transactions.filter(row => row.kind === 'expense' && ['Зарплата', 'ИПН', 'ОПВ', 'ОПВР', 'ОСМС', 'Социальные отчисления'].includes(row.category))) {
      const month = row.payrollMonth || payrollPeriod(row).month;
      const key = paymentField(row);
      const candidates = (data.payroll || []).filter(item => item.month === month && item.status === 'posted');
      const paid = key ? bank.filter(item => item.kind === 'expense' && (item.payrollMonth || payrollPeriod(item).month) === month && paymentField(item) === key).reduce((total, item) => total + item.amountMinor, 0) : null;
      const matches = key && (row.category === 'Зарплата' ? candidates.some(item => salaryMatches(row, item)) : candidates.length > 0 && candidates.every(item => Number.isSafeInteger(item[key])) && paid === sum(candidates, key));
      if (!matches) issue(`match-${row.id}`, `${row.date}: ${row.category} — платёж ${(row.amountMinor / 100).toLocaleString('ru-RU')} ₸ не подтверждён расчётом за ${month || 'неуказанный месяц'}.`, 'payroll', month);
    }
    warnings.push('ИПН и ОПВ в основной форме относятся к месяцу выплаты дохода; начисления — к своему месяцу. Разделённые выплаты, авансы и специальные случаи требуют проверки.');
    // Application fields vary with residency and the current portal revision. Never label a partial register as a complete declaration.
    issue('official-appendix', 'Этот расчёт содержит основные показатели. Полную форму с приложениями скачайте через «Файл для ИСНА», затем проверьте её в кабинете и сохраните официальный отчёт здесь.');
  } else if (form.startsWith('2-')) {
    const assignment = data.reporting?.assignments?.find(row => row.form === form && row.period === period);
    if (!assignment || assignment.status !== 'required') issue('assignment', `${form}: обязательность за этот квартал не подтверждена результатом выборки БНС.`);
    issue('stat-fields', 'Выписки недостаточно для полной статистической формы. Заполните назначенную форму в Кабинете респондента и сохраните её копию здесь.');
  }
  // A payment preference does not change the figures or evidence behind a report.
  const relevantPayroll = (data.payroll || []).filter(row => span.months.includes(row.month) || (form === '200.00' && transactions.some(transaction => transaction.payrollMonth === row.month)))
    .map(({ paymentIntent, ...record }) => record);
  const companyBasis = Object.fromEntries(['legalName', 'bin', 'taxOfficeCode', 'taxRegime', 'vatRegistered', 'region', 'registrationDate'].map(key => [key, company[key]]));
  if (form === '200.00') companyBasis.employees = (company.employees || []).filter(employee => (!employee.startDate || employee.startDate <= span.to) && (!employee.endDate || employee.endDate >= span.from)).map(employee => ({ id: employee.id, fullName: employee.fullName, iin: employee.iin, startDate: employee.startDate, endDate: employee.endDate }));
  const relevantSettings = Object.fromEntries((form === '910.00' ? ['activityStart', 'activityCity', 'activityStreet', 'activityBuilding', 'activityOffice'] : form === '200.00' ? ['activityStart', 'payrollStart', 'passportNumber', 'passportDate', 'residenceCountry', 'foreignTaxId'] : ['activityStart']).map(key => [key, settings[key]]));
  const annualIncome = form === '910.00' ? (data.journal || []).filter(row => row.date >= `${period.slice(0, 4)}-01-01` && row.date < span.from && row.taxBaseMinor).map(row => ({ date: row.date, taxBaseMinor: row.taxBaseMinor })) : [];
  const basis = { rules: REPORTING_RULES, company: companyBasis, settings: relevantSettings, form, period, transactions, journal, annualIncome, payroll: relevantPayroll, bankReconciliations: (data.bankReconciliations || []).filter(row => span.months.includes(row.month)), assignments: (data.reporting?.assignments || []).filter(row => row.form === form && row.period === period), confirmations };
  return { rules: REPORTING_RULES, form, period, ...span, company: copy(company), settings: copy(settings), fields, issues, warnings, transactions, payroll, sourceKey: JSON.stringify(basis), ready: issues.length === 0 };
}

export function validateReporting(input) {
  if (!input) return reportingDefaults();
  if (!Array.isArray(input.documents) || !Array.isArray(input.reports) || !Array.isArray(input.assignments) || !input.settings) throw new Error('Повреждён архив отчётности.');
  if (input.documents.length > 300 || input.reports.length > 100) throw new Error('Превышен лимит архива отчётности.');
  const next = copy(input);
  next.settings = { ...reportingDefaults().settings, ...next.settings };
  const ids = new Set();
  for (const doc of next.documents) {
    if (!/^[0-9a-f-]{36}$/.test(doc.id) || ids.has(doc.id) || !['respondent', 'official', 'receipt', 'isna'].includes(doc.kind) || !(doc.kind === 'isna' ? doc.ext === '.json' : ['.pdf', '.xml', '.txt'].includes(doc.ext)) || typeof doc.name !== 'string' || doc.name.length > 500 || typeof doc.base64 !== 'string' || doc.base64.length > 5600000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(doc.base64) || typeof doc.text !== 'string' || doc.text.length > 200000) throw new Error('Повреждён документ архива отчётности.');
    ids.add(doc.id);
  }
  for (const report of next.reports) {
    reportPeriod(report.form, report.period);
    if (report.id !== `${report.form}:${report.period}` || !['prepared', 'sent', 'accepted', 'rejected'].includes(report.status) || !report.calculation || typeof report.calculation.sourceKey !== 'string') throw new Error('Повреждена версия отчёта.');
    if (report.status === 'accepted' && (!report.receipt || report.receipt.status !== 'accepted' || !ids.has(report.receipt.documentId))) throw new Error('Для принятого отчёта отсутствует квитанция.');
  }
  return next;
}
export function updateReporting(data, action, now = new Date()) {
  const next = validateReporting(data.reporting);
  if (action.type === 'settings') {
    const value = action.value || {};
    for (const key of ['activityStart', 'payrollStart', 'passportDate']) if (value[key] && !isoDate(value[key])) throw new Error('Проверьте даты в настройках отчётности.');
    for (const key of ['activityStart', 'payrollStart', 'salaryGross', 'passportNumber', 'passportDate', 'residenceCountry', 'foreignTaxId', 'activityCity', 'activityStreet', 'activityBuilding', 'activityOffice']) {
      if (typeof value[key] !== 'string' || value[key].length > 100) throw new Error('Проверьте сведения для отчётности.');
      next.settings[key] = value[key].trim();
    }
    for (const key of ['directorName', 'activityCode', 'declarationType', 'citizenshipCountry', 'identityDocumentType']) {
      const item = value[key] ?? next.settings[key];
      if (typeof item !== 'string' || item.length > 100) throw new Error('Проверьте реквизиты для ИСНА.');
      next.settings[key] = item.trim();
    }
    if (next.settings.declarationType && !['PRIORITY', 'NEXT_PRIORITY'].includes(next.settings.declarationType)) throw new Error('Выберите первоначальную или очередную декларацию.');
    if (value.salaryGross && !/^\d+(?:[.,]\d{1,2})?$/.test(value.salaryGross.trim())) throw new Error('Укажите оклад числом в тенге.');
    if (value.foreignTaxIdAbsent !== undefined && typeof value.foreignTaxIdAbsent !== 'boolean') throw new Error('Проверьте отметку об отсутствии иностранного налогового номера.');
    next.settings.foreignTaxIdAbsent = value.foreignTaxIdAbsent ?? next.settings.foreignTaxIdAbsent;
    next.settings.onlyStandardOperations = value.onlyStandardOperations === true;
    return next;
  }
  const { form, period } = action;
  reportPeriod(form, period);
  if (!['200.00', '910.00', '2-МП', '2-услуги'].includes(form)) throw new Error('Неизвестная форма.');
  if (action.type === 'assignment') {
    if (!['required', 'not-required', 'unknown'].includes(action.status)) throw new Error('Проверьте результат выборки.');
    if (action.status !== 'unknown' && (!action.reference?.trim() || !next.documents.some(doc => doc.id === action.documentId && doc.kind === 'respondent'))) throw new Error('Прикрепите результат выборки и укажите основание.');
    next.assignments = next.assignments.filter(row => row.form !== form || row.period !== period);
    if (action.dueDate && !isoDate(action.dueDate)) throw new Error('Укажите срок из Кабинета респондента.');
    next.assignments.push({ form, period, status: action.status, reference: String(action.reference || '').slice(0, 300), documentId: action.documentId || '', dueDate: action.dueDate || '', checkedAt: now.toISOString() });
    return next;
  }
  const id = `${form}:${period}`;
  let report = next.reports.find(row => row.id === id);
  if (report?.status === 'accepted') throw new Error('Принятый отчёт сохранён неизменным. Для корректировки создайте дополнительную декларацию в кабинете и сохраните её отдельно.');
  if (action.type === 'prepare') {
    const calculation = calculateReport(data, form, period, action.confirmations, now);
    if (!calculation.ready) throw new Error('Сначала устраните замечания расчёта.');
    const history = [...(report?.history || []), ...(report ? [{ ...report, history: undefined }] : [])];
    report = { id, form, period, history, status: 'prepared', preparedAt: now.toISOString(), calculation, confirmations: action.confirmations, officialDocumentId: '', receipt: null };
    next.reports = [...next.reports.filter(row => row.id !== id), report];
  } else if (action.type === 'official') {
    const doc = next.documents.find(row => row.id === action.documentId && row.kind === 'official');
    if (!doc || action.confirmed !== true) throw new Error('Прикрепите готовую форму из кабинета и подтвердите её БИН и период.');
    const detected = detectReceipt(doc.text || '');
    if ((detected.bin && detected.bin !== data.company.bin) || (detected.form && detected.form !== form) || (detected.period && detected.period !== period)) throw new Error('БИН, форма или период готового документа не совпадают с выбранным отчётом.');
    const calculation = calculateReport(data, form, period, action.confirmations, now);
    // An official, user-verified document can be archived even where the local
    // calculator does not cover the year, appendix or employer calculation.
    // Its local calculation remains labelled preliminary with its issues.
    const hard = calculation.issues.filter(issue => ['company', 'before-start', 'open-period'].includes(issue.code));
    if (hard.length) throw new Error(hard[0].text);
    const history = [...(report?.history || []), ...(report ? [{ ...report, history: undefined }] : [])];
    report = { id, form, period, history, status: 'prepared', preparedAt: now.toISOString(), calculation, confirmations: action.confirmations, officialDocumentId: doc.id, receipt: null };
    next.reports = [...next.reports.filter(row => row.id !== id), report];
  } else if (action.type === 'sent') {
    if (!report || report.status !== 'prepared') throw new Error('Сначала подготовьте отчёт.');
    if (calculateReport(data, form, period, report.confirmations, now).sourceKey !== report.calculation.sourceKey) throw new Error('Учёт изменился. Подготовьте отчёт заново.');
    if (!report.officialDocumentId || !next.documents.some(doc => doc.id === report.officialDocumentId && doc.kind === 'official')) throw new Error('Сохраните готовый официальный отчёт из кабинета перед отметкой отправки.');
    if (!action.reference?.trim()) throw new Error('Укажите регистрационный номер отправки из кабинета.');
    report.status = 'sent'; report.sentAt = now.toISOString(); report.submissionRef = action.reference.trim().slice(0, 200);
  } else if (action.type === 'receipt') {
    if (!report || !['sent', 'rejected'].includes(report.status)) throw new Error('Сначала отметьте отправку отчёта.');
    const doc = next.documents.find(row => row.id === action.documentId && row.kind === 'receipt');
    if (!doc || action.confirmed !== true || action.bin !== data.company.bin || !action.reference?.trim() || !isoDate(action.date) || !['accepted', 'rejected', 'processing'].includes(action.status)) throw new Error('Проверьте БИН, номер, дату и статус квитанции; подтвердите соответствие форме и периоду.');
    const detected = detectReceipt(doc.text || '');
    if (detected.bin && detected.bin !== action.bin) throw new Error('БИН в квитанции не совпадает с БИН компании.');
    if (detected.form && detected.form !== form) throw new Error('В квитанции указана другая форма.');
    if (detected.period && detected.period !== period) throw new Error('В квитанции указан другой период.');
    if (detected.status && detected.status !== action.status) throw new Error('Выбранный статус не совпадает с текстом квитанции.');
    report.receipt = { documentId: doc.id, bin: action.bin, reference: action.reference.trim().slice(0, 200), date: action.date, status: action.status, confirmedAt: now.toISOString() };
    report.status = action.status === 'processing' ? 'sent' : action.status;
  } else throw new Error('Неизвестное действие с отчётом.');
  return next;
}
export function detectReceipt(text) {
  const flat = text.replace(/\s+/g, ' ');
  const bin = flat.match(/(?:БИН|ИИН\s*\(БИН\))\s*[:№]?\s*(\d{12})/i)?.[1] || '';
  const form = flat.match(/(?:форм[аы]|ФНО)\s*[:№]?\s*(200\.00|910\.00|2-МП|2-услуги)/i)?.[1] || '';
  const q = flat.match(/([1-4])\s*(?:квартал|кв\.)\s*(20\d{2})/i);
  const h = flat.match(/([12])\s*полугоди[ея]\s*(20\d{2})/i);
  const status = /не\s+принят|отклон[её]н|отказ\s+в\s+при[её]ме/i.test(flat) ? 'rejected' : /(?:статус\s*[:—-]?\s*|отч[её]тность\s+|декларация\s+|отч[её]т\s+)(?:успешно\s+)?принят[ао]?(?=\s|[.,;]|$)/iu.test(flat) ? 'accepted' : /обрабатывается|в обработке|доставлен|получен/i.test(flat) ? 'processing' : '';
  return { bin, form, period: h ? `${h[2]}-H${h[1]}` : q ? `${q[2]}-Q${q[1]}` : '', status };
}
export function respondentSummary(text) {
  if (!/Перечень статистических форм/i.test(text)) throw new Error('Не распознан перечень респондента БНС. Файл сохранён; проверьте его вручную.');
  const bin = text.match(/\b\d{12}\b/)?.[0] || '';
  const forms = ['2-МП', '2-услуги', '1-ТС', '1-инвест', '2-КС', '7-ТПЗ'].filter(form => text.toLowerCase().includes(form.toLowerCase()));
  return { bin, forms, message: 'Перечень форм не подтверждает включение в выборку. Проверьте результат для квартала в Кабинете респондента. Условные формы применяются только при соответствующей деятельности.' };
}
export function reportingReminders(account, today) {
  const reports = account.data.reporting?.reports || [];
  const pending = reports.filter(row => ['sent', 'rejected'].includes(row.status)).map(row => ({ key: `${account.id}:report:${row.id}:${row.status}:${row.receipt?.reference || row.submissionRef}`, accountId: account.id, title: `${account.isDemo ? 'ДЕМО · ' : ''}${account.name}: ${row.status === 'rejected' ? 'Отчёт отклонён' : 'Проверьте приём отчёта'} ${row.form}`, body: `${row.period}. ${row.status === 'rejected' ? 'Откройте квитанцию, исправьте ошибки и повторите сдачу.' : 'Сохраните квитанцию со статусом «Принята». Отправка ещё не означает приём.'}`, screen: 'reports', month: reportPeriod(row.form, row.period).months[0], obligationId: '' }));
  for (const assignment of account.data.reporting?.assignments || []) {
    if (assignment.status !== 'required' || acceptedReport(account.data, assignment.form, assignment.period)) continue;
    const span = reportPeriod(assignment.form, assignment.period);
    if (account.data.company?.registrationDate > span.to) continue;
    const days = assignment.dueDate && isoDate(assignment.dueDate) ? Math.round((new Date(`${assignment.dueDate}T12:00:00Z`) - today) / 86400000) : null;
    if (days !== null && days > 14) continue;
    const stage = days === null ? 'check-deadline' : days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 7 ? '7d' : '14d';
    pending.push({ key: `${account.id}:bns:${assignment.form}:${assignment.period}:${stage}`, accountId: account.id, title: `${account.isDemo ? 'ДЕМО · ' : ''}${account.name}: ${days === null ? 'уточните срок' : 'подготовьте'} ${assignment.form}`, body: `${span.label}. ${days === null ? 'Срок из Кабинета респондента ещё не сохранён.' : `Срок из кабинета: ${assignment.dueDate.split('-').reverse().join('.')}.`} Откройте cabinet.stat.gov.kz с ЭЦП ТОО, проверьте назначение и срок. Подготовьте выписки, расчёты зарплаты, договоры и акты за период; заполните назначенную форму в кабинете, подпишите и отправьте. Сохраните официальный отчёт и квитанцию «Принята» в «Отчётах».`, screen: 'reports', month: span.months[0], obligationId: '' });
  }
  return pending;
}
