import fields from './national-bank-fields.json' with { type: 'json' };

export const nationalBankFields = fields;
export const nbLinks = {
  portal: 'https://digital.nationalbank.kz/pub/landing',
  certificate: 'https://digital.nationalbank.kz/pub/landing/exchange/bop-cert',
  rules: 'https://old.adilet.zan.kz/rus/docs/V2500036409',
  help: 'https://nationalbank.kz/ru/gb/vopros-otvet?theme_id=1156',
  templates: 'https://nationalbank.kz/ru/news/formy-statisticheskoy-i-administrativnoy-otchetnosti/7463',
};
export const nbForms = ['1-ПБ', '10-ПБ'];
export function nbPeriod(now = new Date()) {
  const date = new Date(now);
  const quarter = Math.floor(date.getUTCMonth() / 3);
  return quarter ? { year: date.getUTCFullYear(), quarter } : { year: date.getUTCFullYear() - 1, quarter: 4 };
}
export function nbDueDate(year, quarter, form) {
  return new Date(Date.UTC(year, quarter * 3 + (form === '1-ПБ' ? 1 : 0), form === '1-ПБ' ? 10 : 30)).toISOString().slice(0, 10);
}
export function newNbReport(year, quarter, form) {
  return { id: `${year}-Q${quarter}:${form}`, year, quarter, form, assignment: 'unknown', checkedOn: '', assignmentRef: '', status: 'draft', receiptRef: '', receiptDate: '', receiptVerified: false, reviewed: false, residencyConfirmed: false, nilConfirmed: false, rows: [], documents: [], notes: '' };
}
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const validDate = value => /^20\d{2}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
export function validateNbReport(input) {
  if (!input || !Number.isInteger(input.year) || input.year < 2026 || input.year > 2099 || ![1, 2, 3, 4].includes(input.quarter) || !nbForms.includes(input.form)) throw new Error('Проверьте форму и квартал Нацбанка (с 2026 года).');
  const next = newNbReport(input.year, input.quarter, input.form);
  if (!['unknown', 'required', 'not-required'].includes(input.assignment) || !['draft', 'sent', 'accepted', 'rejected'].includes(input.status)) throw new Error('Проверьте статус отчёта.');
  for (const key of ['checkedOn', 'assignmentRef', 'receiptRef', 'receiptDate', 'notes']) next[key] = text(input[key]);
  Object.assign(next, { assignment: input.assignment, status: input.status, receiptVerified: input.receiptVerified === true, reviewed: input.reviewed === true, residencyConfirmed: input.residencyConfirmed === true, nilConfirmed: input.nilConfirmed === true });
  for (const key of ['checkedOn', 'receiptDate']) if (next[key] && !validDate(next[key])) throw new Error('Проверьте дату справки или квитанции.');
  if (next.assignment !== 'unknown' && (!next.checkedOn || !next.assignmentRef)) throw new Error('Укажите дату проверки и номер / описание электронной справки Нацбанка за этот квартал.');
  if (!Array.isArray(input.rows) || input.rows.length > 3000) throw new Error('Слишком много строк отчёта.');
  const seen = new Set();
  next.rows = input.rows.map(row => {
    const field = fields.find(field => field.form === next.form && field.code === row.code);
    const country = text(row.country, 80).toUpperCase();
    const partner = text(row.partner, 200);
    if (!field) throw new Error('Код показателя отсутствует в форме.');
    if (country && !/^[A-Z]{2}$/.test(country) && !['ДРУГИЕ СТРАНЫ', 'МЕЖДУНАРОДНЫЕ ОРГАНИЗАЦИИ'].includes(country)) throw new Error('Страна: двухбуквенный код, например RU; либо «Другие страны», «Международные организации».');
    const key = `${country}:${partner}:${field.code}`;
    if (seen.has(key)) throw new Error('Показатель для этой страны и партнёра уже добавлен.');
    seen.add(key);
    const value = row.value === null ? null : row.value;
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12)) throw new Error('Некорректное значение показателя.');
    if (value !== null && field.unit === '%' && (value < 0 || value > 100)) throw new Error('Доля участия должна быть от 0 до 100%.');
    if (value !== null && field.unit !== '%' && next.form === '1-ПБ' && !Number.isInteger(value)) throw new Error('1-ПБ: суммы в целых тысячах USD.');
    return { code: field.code, country, partner, value, basis: text(row.basis) };
  });
  if (!Array.isArray(input.documents) || input.documents.length > 3) throw new Error('Можно сохранить до трёх файлов: справка, расчёт, квитанция.');
  next.documents = input.documents.map(doc => {
    if (!['certificate', 'calculation', 'receipt'].includes(doc.kind) || !/\.(pdf|xlsx|xlsm|xls|png|jpg|jpeg)$/i.test(doc.name || '') || typeof doc.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(doc.base64) || doc.base64.length > 2800000) throw new Error('Прикрепите PDF, Excel или изображение до 2 МБ.');
    return { kind: doc.kind, name: text(doc.name, 255), base64: doc.base64 };
  });
  if (next.status !== 'draft' && next.assignment !== 'required') throw new Error('Отметка подачи доступна для назначенной формы.');
  if (['sent', 'accepted', 'rejected'].includes(next.status) && (!next.receiptRef || !next.receiptDate)) throw new Error('Укажите дату и номер / описание подтверждения с портала.');
  if (next.status === 'accepted' && (!next.documents.some(doc => doc.kind === 'receipt') || !next.receiptVerified)) throw new Error('Прикрепите квитанцию о приёме и подтвердите её БИН, форму, квартал, год и статус «Принят».');
  if (next.status === 'accepted') {
    const issues = nbChecks(next, null, { checkCompany: false });
    if (issues.length) throw new Error(`Перед подтверждением приёма: ${issues[0]}`);
  }
  return next;
}
export function nbAcceptanceConfirmed(report) {
  return report?.status === 'accepted' && report.receiptVerified === true && !!report.receiptRef && validDate(report.receiptDate) && report.documents?.some(doc => doc.kind === 'receipt') && nbChecks(report, null, { checkCompany: false }).length === 0;
}
export function saveNbReport(reports, input, company) {
  const clean = validateNbReport(input);
  if (clean.status === 'accepted') {
    const issues = nbChecks(clean, company);
    if (issues.length) throw new Error(`Перед подтверждением приёма: ${issues[0]}`);
  }
  const previous = reports.find(row => row.id === clean.id);
  const data = report => JSON.stringify([report.rows, report.nilConfirmed, report.residencyConfirmed, report.reviewed]);
  if (previous?.status === 'accepted' && clean.status === 'accepted' && data(previous) !== data(clean)) throw new Error('Для изменения принятого расчёта сначала верните его в черновик.');
  return [...reports.filter(row => row.id !== clean.id), clean];
}
export function nbChecks(report, company, { checkCompany = true } = {}) {
  const issues = [];
  if (report.assignment === 'unknown') issues.push('Проверьте назначение формы в электронной справке за выбранный квартал.');
  if (report.assignment === 'not-required') return ['По сохранённой справке эта форма за данный квартал не назначена.'];
  if (checkCompany && !/^\d{12}$/.test(company?.bin || '')) issues.push('Заполните БИН ТОО в разделе «Компания и налоги».');
  if (checkCompany && !company?.legalName) issues.push('Заполните наименование ТОО.');
  if (!report.residencyConfirmed) issues.push('Подтвердите резидентство контрагентов по инструкции Нацбанка.');
  if (!report.reviewed) issues.push('Проверьте все разделы официальной формы, включая операции вне банковской выписки.');
  if (!report.rows.length && !report.nilConfirmed) issues.push('Добавьте показатели либо подтвердите отсутствие данных для отчёта.');
  if (report.nilConfirmed && report.rows.some(row => row.value !== null && row.value !== 0)) issues.push('Есть ненулевые показатели: снимите отметку об отсутствии данных.');
  if (report.rows.some(row => !row.country || row.value === null || !row.basis)) issues.push('У каждой строки укажите страну, значение (в том числе явный 0) и источник расчёта.');
  if (report.form === '1-ПБ') {
    const groups = new Set(report.rows.filter(row => row.code.startsWith('22110')).map(row => JSON.stringify([row.country, row.partner])));
    for (const group of groups) {
      const [country, partner] = JSON.parse(group);
      const values = Object.fromEntries(report.rows.filter(row => row.country === country && row.partner === partner).map(row => [row.code, row.value]));
      for (const [end, terms] of [['2211006', [['2211001', 1], ['2211002', 1], ['2211003', -1], ['2211004', 1], ['2211005', 1]]], ['2211016', [['2211011', 1], ['2211012', 1], ['2211013', -1], ['2211014', 1], ['2211015', 1]]], ['2211026', [['2211021', 1], ['2211025', 1]]]]) {
        const codes = [end, ...terms.map(([code]) => code)];
        if (!codes.some(code => Object.hasOwn(values, code))) continue;
        if (codes.some(code => values[code] == null)) issues.push(`${country || 'Страна не указана'}: для проверки ${end} заполните ${codes.join(', ')}.`);
        else if (values[end] !== terms.reduce((sum, [code, sign]) => sum + values[code] * sign, 0)) issues.push(`${country}: не сходится контрольное равенство ${end}. Проверьте остатки и изменения.`);
      }
    }
  }
  return issues;
}
export function nbReminders(account, now = new Date()) {
  const period = nbPeriod(now);
  if (period.year < 2026) return [];
  const reports = account.data.nationalBankReports || [];
  const label = `${account.isDemo ? 'ДЕМО · ' : ''}${account.name}`;
  const result = [];
  const quarterEnd = (year, quarter) => new Date(Date.UTC(year, quarter * 3, 0)).toISOString().slice(0, 10);
  const registrationDate = account.data.company?.registrationDate || '';
  if (registrationDate && registrationDate > quarterEnd(period.year, period.quarter)) return [];
  const pending = nbForms.filter(form => !reports.some(row => row.year === period.year && row.quarter === period.quarter && row.form === form && row.assignment !== 'unknown'));
  if (pending.length) result.push({ key: `${account.id}:nb-check:${period.year}-Q${period.quarter}`, accountId: account.id, title: `${label}: проверьте формы Нацбанка`, body: `За ${period.quarter} квартал ${period.year}: получите электронную справку на digital.nationalbank.kz и отметьте назначение ${pending.join(', ')}.`, screen: 'national-bank', month: `${period.year}-${String(period.quarter * 3).padStart(2, '0')}`, obligationId: '' });
  for (const report of reports) {
    if (report.assignment !== 'required' || nbAcceptanceConfirmed(report) || (registrationDate && registrationDate > quarterEnd(report.year, report.quarter))) continue;
    const due = nbDueDate(report.year, report.quarter, report.form);
    const days = Math.floor((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) / 86400000);
    if (days > 14) continue;
    const stage = days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 7 ? '7d' : '14d';
    result.push({ key: `${account.id}:nb:${report.id}:${stage}`, accountId: account.id, title: `${label}: ${report.form} — ${report.status === 'sent' || report.status === 'accepted' ? 'проверьте приём' : 'подготовьте отчёт'}`, body: `${report.quarter} квартал ${report.year}. Дата по форме: ${due.split('-').reverse().join('.')}. ${days < 0 ? 'Дата прошла. ' : ''}Получите справку о назначении на digital.nationalbank.kz с ЭЦП ТОО. Для ${report.form === '1-ПБ' ? '1-ПБ подготовьте остатки капитала и долгов, изменения за квартал и резидентство участников' : '10-ПБ подготовьте начисления зарплаты, акты/договоры услуг и резидентство контрагентов'}, выписки и применимые курсы валют. Возьмите официальный шаблон на сайте Нацбанка, заполните и загрузите его на цифровом портале; подпишите, проверьте приём и сохраните квитанцию. Рабочий Excel приложения используется для сверки.`, screen: 'national-bank', month: `${report.year}-${String(report.quarter * 3).padStart(2, '0')}`, obligationId: '' });
  }
  return result;
}
