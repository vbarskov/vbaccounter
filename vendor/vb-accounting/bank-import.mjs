// Bank descriptions are hints, not proof of the legal nature of a payment.
// Only narrow, explicit matches are offered for automatic posting.
const bankAccounts = {
  'Дополнительный взнос в имущество ТОО': ['1030', '5420'],
  'Заём учредителя': ['1030', '3010'],
  'Зарплата': ['3350', '1030'],
  'ИПН': ['3120', '1030'],
  'ОПВ': ['3220', '1030'],
  'ОПВР': ['3250', '1030'],
  'ОСМС': ['3230', '1030'],
  'Социальные отчисления': ['3210', '1030'],
  'Социальный налог': ['3150', '1030'],
  'Субаренда': ['3310', '1030'],
};

export function classifyBankTransaction(item) {
  const text = String(item.description || '').toLowerCase().replace(/ё/g, 'е');
  const match = (pattern, category) => pattern.test(text) ? category : null;
  if (/возврат|сторно|пен[яи]|штраф/.test(text)) return 'Прочее';
  let category = null;
  if (item.kind === 'income') {
    const contribution = match(/дополнительн[а-я]*\s+взнос[а-я]*\s+в\s+имущество|взнос[а-я]*\s+в\s+имущество\s+тоо/, 'Дополнительный взнос в имущество ТОО');
    const loan = match(/заем[а-я]*\s+учредител|займ[а-я]*\s+учредител/, 'Заём учредителя');
    if (contribution && loan) return 'Прочее';
    category = contribution || loan;
  } else if (item.kind === 'expense') {
    const employerPension = /опвр|пенсионн[а-я]*\s+взнос[а-я]*\s+работодател/.test(text);
    if (employerPension && /(?:^|[^а-яa-z])опв(?:$|[^а-яa-z])/.test(text)) return 'Прочее';
    const taxes = [
      match(/социальн[а-я]*\s+налог/, 'Социальный налог'),
      match(/социальн[а-я]*\s+отчислен/, 'Социальные отчисления'),
      employerPension ? 'ОПВР' : match(/(?:^|[^а-яa-z])опв(?:$|[^а-яa-z])|обязательн[а-я]*\s+пенсионн[а-я]*\s+взнос/, 'ОПВ'),
      match(/осмс|медицинск[а-я]*\s+страхован/, 'ОСМС'),
      match(/(?:^|[^а-яa-z])ипн(?:$|[^а-яa-z])|индивидуальн[а-я]*\s+подоходн[а-я]*\s+налог/, 'ИПН'),
    ].filter(Boolean);
    if (taxes.length > 1) return 'Прочее';
    const rent = match(/субаренд/, 'Субаренда');
    const salary = match(/зарплат|заработн[а-я]*\s+плат|(?:^|[^а-яa-z])з\s*\/?\s*п(?:$|[^а-яa-z])/, 'Зарплата');
    if (rent && salary) return 'Прочее';
    category = taxes[0] || rent || salary;
  }
  return category || 'Прочее';
}

export function bankJournalInput(transaction) {
  const pair = bankAccounts[transaction.category];
  if (!pair || (transaction.kind === 'income' ? pair[0] !== '1030' : pair[1] !== '1030')) return null;
  return {
    date: transaction.date,
    description: transaction.description,
    documentRef: transaction.documentRef,
    sourceTransactionId: transaction.id,
    debitAccount: pair[0],
    creditAccount: pair[1],
    amountMinor: transaction.amountMinor,
    taxBaseMinor: 0,
    bankGenerated: true,
    ...(transaction.counterpartyId ? { counterpartyId: transaction.counterpartyId } : {}),
    ...(transaction.payrollId ? { payrollId: transaction.payrollId } : {}),
    ...(transaction.payrollMonth ? { periodMonth: transaction.payrollMonth } : {}),
  };
}

const normalizeBankText = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const legacyCoreFingerprint = item => [item.date, item.kind, item.amountMinor, normalizeBankText(item.description), normalizeBankText(item.counterparty), item.counterpartyId || ''].join('|');
export const bankFingerprint = item => item.bankIdentity ||
  [legacyCoreFingerprint(item), normalizeBankText(item.bankDocumentNumber || item.documentRef)].join('|');

// A statement is a multiset: identical amounts and descriptions can be real
// separate transfers. Bank identities are unique; rows without an identity are
// reconciled by occurrence count, so repeating an overlapping file is safe.
export function filterBankImport(inputs, transactions) {
  const known = new Map();
  const legacy = new Map();
  for (const item of transactions) {
    const key = bankFingerprint(item);
    known.set(key, (known.get(key) || 0) + 1);
    if (!item.bankIdentity) {
      const core = legacyCoreFingerprint(item);
      legacy.set(core, (legacy.get(core) || 0) + 1);
    }
  }
  const occurrences = new Map();
  const identified = new Set();
  const entries = [];
  const indices = [];
  for (const [index, item] of inputs.entries()) {
    const key = bankFingerprint(item);
    const occurrence = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, occurrence);
    if (item.bankIdentity) {
      if (identified.has(key)) continue;
      identified.add(key);
      if (known.has(key)) continue;
      const core = legacyCoreFingerprint(item);
      const legacyCount = legacy.get(core) || 0;
      if (legacyCount > 0) { legacy.set(core, legacyCount - 1); continue; }
    } else if (occurrence <= (known.get(key) || 0)) continue;
    entries.push(item);
    indices.push(index);
  }
  return { entries, indices, skipped: inputs.length - entries.length };
}

export function paymentBelongsToPayroll(transaction, month, payrollId) {
  return transaction.payrollMonth === month && (!payrollId || transaction.payrollId === payrollId);
}

// Read-time reconciliation also covers statements imported before the payroll existed.
// It never creates accruals or bank movements, and recalculates automatic links after edits.
export function payrollPeriod(transaction) {
  const text = `${transaction.description || ''} ${transaction.note || ''}`.toLowerCase().replace(/ё/g, 'е');
  const months = new Set();
  for (const match of text.matchAll(/(?:^|[^\d])(20\d{2})-(0[1-9]|1[0-2])(?![-\d])/g)) months.add(`${match[1]}-${match[2]}`);
  for (const match of text.matchAll(/за\s+(0?[1-9]|1[0-2])[./-](20\d{2})(?!\d)/g)) months.add(`${match[2]}-${match[1].padStart(2, '0')}`);
  const names = ['январ', 'феврал', 'март', 'апрел', 'ма[йя]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
  names.forEach((name, index) => {
    const expression = new RegExp(`(?:^|[^а-я])${name}[а-я]*(?:\\s+(20\\d{2}))?`, 'g');
    for (const match of text.matchAll(expression)) {
      const paymentYear = Number(transaction.date?.slice(0, 4));
      const paymentMonth = Number(transaction.date?.slice(5, 7));
      const year = match[1] || String(paymentYear - (index + 1 > paymentMonth ? 1 : 0));
      if (!match[1] && (paymentYear - Number(year)) * 12 + paymentMonth - (index + 1) > 2) continue;
      if (/^20\d{2}$/.test(year)) months.add(`${year}-${String(index + 1).padStart(2, '0')}`);
    }
  });
  return { month: months.size === 1 ? [...months][0] : '', ambiguous: months.size > 1 };
}

const normalizedEmployeeName = value => String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z]/g, '');
const payrollBankIntermediary = row => row.category === 'Зарплата' && /(?:банк|bank|bcc|бцк)/iu.test(String(row.counterparty || ''));

// A tax recipient's BIN belongs to the budget/fund, not to the employee.
// Explicit employee IINs take precedence over a name or one-employee fallback.
export function payrollEmployeeIdentity(row, record) {
  const paymentIins = new Set();
  const text = `${row.description || ''} ${row.note || ''}`.toLowerCase().replace(/ё/g, 'е');
  for (const match of text.matchAll(/(?:^|[^а-яa-z])(?:иин|iin)(?![а-яa-z])(?:\s+(?:сотрудника|работника|получателя))?[\s:=№-]*(\d{12})(?!\d)/g)) paymentIins.add(match[1]);
  const recipientIin = String(row.counterpartyId || '');
  if (row.category === 'Зарплата' && !payrollBankIntermediary(row) && /^\d{12}$/.test(recipientIin)) paymentIins.add(recipientIin);
  const iins = [...paymentIins];
  const employeeIin = String(record.employeeIin || '');
  const conflict = iins.length > 0 && (iins.length !== 1 || iins[0] !== employeeIin);
  const matches = !conflict && (iins.length === 1 || (row.category === 'Зарплата'
    ? !!normalizedEmployeeName(row.counterparty) && normalizedEmployeeName(row.counterparty) === normalizedEmployeeName(record.employeeName)
    : !!employeeIin && recipientIin === employeeIin));
  return { matches, conflict, paymentIins: iins };
}

const employeeIdentityIssue = (row, records) => {
  if (!records.length) return '';
  const identity = payrollEmployeeIdentity(row, records[0] || {});
  if (!identity.paymentIins.length || records.some(record => !payrollEmployeeIdentity(row, record).conflict)) return '';
  const payrollIins = [...new Set(records.map(record => record.employeeIin).filter(Boolean))];
  return `ИИН в выписке (${identity.paymentIins.join(', ')}) не совпадает с ИИН сотрудника в расчёте (${payrollIins.join(', ')}). Проверьте данные сотрудника или выберите расчёт вручную.`;
};

export function reconcilePayrollPayments(transactions, payroll, singleEmployee = false) {
  const rows = transactions.map(item => {
    const { payrollMatchIssue, payrollDetectedMonth, payrollAutoLinked, ...clean } = item;
    if (payrollAutoLinked) { delete clean.payrollMonth; delete clean.payrollId; }
    return clean;
  });
  const candidates = new Map();
  const fieldFor = item => ({ 'Зарплата': 'netMinor', 'ИПН': 'ipnMinor', 'ОПВ': 'opvMinor', 'ОПВР': 'opvrMinor', 'Социальные отчисления': 'soMinor', 'Социальный налог': 'socialTaxMinor', 'ОСМС': /отчислен|оосмс/i.test(item.description) ? 'oosmsMinor' : 'vosmsMinor' })[item.category];
  const reserved = new Set();
  for (const row of rows.filter(item => item.payrollMonth && item.kind === 'expense')) {
    const field = fieldFor(row);
    const monthRecords = payroll.filter(record => record.month === row.payrollMonth);
    const matches = monthRecords.filter(record => {
      // A payrollId is an explicit choice made by the user, not a heuristic.
      if (row.payrollId) return record.id === row.payrollId;
      const identity = payrollEmployeeIdentity(row, record);
      return !identity.conflict && (identity.matches || singleEmployee && !identity.paymentIins.length);
    });
    if (field && matches.length === 1) { row.payrollId = matches[0].id; reserved.add(`${row.payrollId}:${field}`); }
    else if (field) row.payrollMatchIssue = employeeIdentityIssue(row, monthRecords) || 'Уточните сотрудника для ранее связанного платежа.';
  }
  for (const row of rows) {
    const field = fieldFor(row);
    if (row.kind !== 'expense' || !field || row.payrollMonth) continue;
    const period = payrollPeriod(row);
    row.payrollDetectedMonth = period.month;
    const issue = message => { row.payrollMatchIssue = message; };
    if (!period.month) { issue(period.ambiguous ? 'В назначении несколько месяцев — уточните период.' : 'В назначении нет месяца зарплаты — укажите его один раз.'); continue; }
    const monthRecords = payroll.filter(item => item.month === period.month);
    if (!monthRecords.length) { issue(`Нет расчёта зарплаты за ${period.month}. Выплата уже сохранена; нужен оклад до удержаний.`); continue; }
    if (row.category === 'ОСМС' && (!/восмс|(?:^|[^а-я])взнос|отчислен|оосмс/i.test(row.description))) {
      issue('Уточните вид ОСМС: взносы работника или отчисления работодателя.'); continue;
    }
    const singleEmployeeFallback = singleEmployee && monthRecords.length === 1 && (payrollBankIntermediary(row) || row.category !== 'Зарплата');
    const personRecords = monthRecords.filter(record => {
      const identity = payrollEmployeeIdentity(row, record);
      return !identity.conflict && (identity.matches || singleEmployeeFallback && !identity.paymentIins.length);
    });
    if (!personRecords.length) { issue(employeeIdentityIssue(row, monthRecords) || (row.category === 'Зарплата' ? 'Получатель зарплаты не совпадает с сотрудником в расчёте.' : 'Уточните, за какого сотрудника перечислен платёж. Общий платёж не распределяется автоматически.')); continue; }
    const matching = personRecords.filter(record => record.status === 'posted' && record[field] === row.amountMinor);
    if (!matching.length) { issue(personRecords.every(record => record.status !== 'posted') ? `Расчёт за ${period.month} пока в черновике. Подтвердите начисление.` : `Сумма платежа не совпадает с расчётом за ${period.month}. Проверьте доплату, аванс или расчёт.`); continue; }
    if (matching.length !== 1) { issue('Платёж подходит нескольким сотрудникам — выберите конкретный расчёт.'); continue; }
    const record = matching[0];
    const key = `${record.id}:${field}`;
    const group = candidates.get(key) || [];
    group.push(row); candidates.set(key, group);
  }
  for (const [key, group] of candidates) {
    if (group.length !== 1 || reserved.has(key)) {
      for (const row of group) row.payrollMatchIssue = 'Найдено несколько платежей на одно начисление — проверьте дубли или разделённую выплату.';
    } else {
      group[0].payrollMonth = group[0].payrollDetectedMonth;
      group[0].payrollId = key.slice(0, key.lastIndexOf(':'));
      group[0].payrollAutoLinked = true;
    }
  }
  return rows;
}

export function planBankImport(inputs, transactions, journal, makeId) {
  const nextTransactions = [...transactions];
  const nextJournal = [...journal];
  let added = 0;
  let posted = 0;
  let needsReview = 0;
  for (const input of filterBankImport(inputs, transactions).entries) {
    const transaction = { ...input, id: makeId() };
    nextTransactions.push(transaction);
    const entry = bankJournalInput(transaction);
    if (entry) { nextJournal.push({ ...entry, id: makeId() }); posted++; }
    else needsReview++;
    added++;
  }
  return { transactions: nextTransactions, journal: nextJournal, added, posted, needsReview, skipped: inputs.length - added };
}

export function saveBankTransaction(transaction, transactions, journal, makeId) {
  const previous = transactions.find(item => item.id === transaction.id);
  const linked = journal.find(item => item.sourceTransactionId === transaction.id);
  if (linked && !linked.bankGenerated && previous && ['date', 'kind', 'amountMinor', 'category'].some(key => previous[key] !== transaction[key])) {
    throw new Error('У операции есть вручную настроенная проводка. Сначала исправьте её в разделе «Проводки и 910.00».');
  }
  const nextTransactions = previous ? transactions.map(item => item.id === transaction.id ? transaction : item) : [...transactions, transaction];
  if (linked && !linked.bankGenerated) return { transactions: nextTransactions, journal: [...journal] };
  const planned = bankJournalInput(transaction);
  const nextJournal = journal.filter(item => item.id !== linked?.id);
  if (planned) nextJournal.push({ ...planned, id: linked?.id || makeId() });
  return { transactions: nextTransactions, journal: nextJournal };
}

// Recording an invoice creates the liability; the existing bank-generated entry
// only settles it. Never point this accrual at sourceTransactionId: that link is
// reserved for the bank movement itself.
export function rentAccrualInput(transaction, input, journal = []) {
  if (transaction?.kind !== 'expense' || transaction.category !== 'Субаренда') throw new Error('Выберите банковский платёж по субаренде.');
  const periodMonth = String(input?.periodMonth || '').trim();
  const date = String(input?.date || '').trim();
  const amountMinor = input?.amountMinor;
  const documentRef = String(input?.documentRef || '').trim();
  const counterpartyId = String(input?.counterpartyId ?? transaction.counterpartyId ?? '').trim();
  const sourceDocumentId = String(input?.sourceDocumentId || '').trim();
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(periodMonth)) throw new Error('Выберите месяц субаренды по счёту или акту.');
  const parsedDate = new Date(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(periodMonth) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) throw new Error('Дата начисления должна относиться к месяцу субаренды.');
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Укажите сумму счёта в тиынах.');
  if (!documentRef || documentRef.length > 200) throw new Error('Укажите номер и дату счёта или акта.');
  if (counterpartyId && !/^\d{12}$/.test(counterpartyId)) throw new Error('Проверьте БИН/ИИН арендодателя.');
  const existing = journal.find(entry => entry.creditAccount === '3310' && /^7/.test(entry.debitAccount) && ((sourceDocumentId && entry.sourceDocumentId === sourceDocumentId) || ((entry.periodMonth || payrollPeriod(entry).month || String(entry.date).slice(0, 7)) === periodMonth && (!entry.counterpartyId || entry.counterpartyId === counterpartyId) && normalizeBankText(entry.documentRef) === normalizeBankText(documentRef))));
  if (existing) throw new Error('Этот счёт по субаренде уже учтён. Повторное начисление не создано.');
  return { date, description: `Начислена субаренда за ${periodMonth}${transaction.counterparty ? ` · ${transaction.counterparty}` : ''}`.slice(0, 300), documentRef, sourceTransactionId: '', debitAccount: '7210', creditAccount: '3310', amountMinor, taxBaseMinor: 0, counterpartyId, periodMonth, ...(sourceDocumentId ? { sourceDocumentId } : {}) };
}
