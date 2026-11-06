const simplifiedSource = 'https://www.gov.kz/memleket/entities/kgd-vko/press/news/details/1288957?lang=ru';
const augustSource = 'https://www.gov.kz/memleket/entities/kgd-almaty/press/news/details/1265649?lang=ru';
const payrollReportSource = 'https://www.gov.kz/memleket/entities/kgd/press/article/details/221941';

function nextWeekday(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function taxObligations(company, now = new Date(), payroll = []) {
  if (company.taxRegime !== 'simplified') return [];
  const rows = [];
  const registrationDate = /^\d{4}-\d{2}-\d{2}$/.test(company.registrationDate || '') ? company.registrationDate : '';
  const include = row => {
    if (!registrationDate) return true;
    const periodEnd = row.periodEnd || '';
    return !periodEnd || periodEnd >= registrationDate;
  };
  for (let year = Math.max(2026, registrationDate ? Number(registrationDate.slice(0, 4)) : 2026); year <= now.getFullYear() + 1; year++) {
    for (const half of [1, 2]) {
      const dueYear = half === 1 ? year : year + 1;
      const dueMonth = half === 1 ? 8 : 2;
      const verified = year === 2026;
      const period = `${half === 1 ? 'I' : 'II'} полугодие ${year}`;
      const fileDue = year === 2026 && half === 1 ? '2026-08-17' : year === 2026 && half === 2 ? '2027-02-15' : nextWeekday(dueYear, dueMonth, 15);
      const payDue = year === 2026 && half === 1 ? '2026-08-25' : year === 2026 && half === 2 ? '2027-02-25' : nextWeekday(dueYear, dueMonth, 25);
      const periodStart = `${year}-${half === 1 ? '01-01' : '07-01'}`;
      const periodEnd = `${year}-${half === 1 ? '06-30' : '12-31'}`;
      rows.push({ id: `${year}-910-h${half}-file`, title: 'Сдать ФНО 910.00', period, periodStart, periodEnd, due: fileDue, kind: 'filing', source: year === 2026 && half === 1 ? augustSource : simplifiedSource, verified });
      rows.push({ id: `${year}-910-h${half}-pay`, title: 'Уплатить налог по ФНО 910.00', period, periodStart, periodEnd, due: payDue, kind: 'payment', source: simplifiedSource, verified });
    }
    if (company.hasEmployees || company.employees?.length || payroll.length) {
      for (const quarter of [1, 2, 3, 4]) {
        const dueYear = quarter === 4 ? year + 1 : year;
        const dueMonth = quarter === 4 ? 2 : quarter === 1 ? 5 : quarter === 2 ? 8 : 11;
        const due = nextWeekday(dueYear, dueMonth, 15);
        const periodStart = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`;
        const periodEnd = `${quarter === 4 ? year + 1 : year}-${String(quarter === 4 ? 1 : quarter * 3 + 1).padStart(2, '0')}-01`;
        const end = new Date(`${periodEnd}T12:00:00Z`); end.setUTCDate(0);
        const endIso = end.toISOString().slice(0, 10);
        const historicalPayroll = payroll.some(item => item.status === 'posted' && item.month >= periodStart.slice(0, 7) && item.month <= endIso.slice(0, 7));
        const staffInPeriod = historicalPayroll || (company.employees?.length ? company.employees.some(employee => (!employee.startDate || employee.startDate <= endIso) && (!employee.endDate || employee.endDate >= periodStart)) : company.hasEmployees);
        if (staffInPeriod) rows.push({ id: `${year}-200-q${quarter}-file`, title: 'Сдать ФНО 200.00 по зарплате', period: `${quarter} квартал ${year}`, periodStart, periodEnd: endIso, due, kind: 'filing', source: payrollReportSource, verified: year === 2026 });
      }
    }
  }
  return rows.filter(include).sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
}

export function obligationStatus(due, done, now = new Date()) {
  if (done) return 'done';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const deadline = new Date(`${due}T12:00:00`);
  if (deadline < today) return 'overdue';
  if ((deadline.getTime() - today.getTime()) / 86400000 <= 30) return 'soon';
  return 'upcoming';
}
