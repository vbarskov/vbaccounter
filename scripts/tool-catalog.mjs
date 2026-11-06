const text = (description, maxLength = 500) => ({ type: 'string', minLength: 1, maxLength, description });
const identifier = text('Стабильный идентификатор из результата инструмента.', 250);
const path = text('Абсолютный путь к локальному файлу, выбранному пользователем.', 4096);
const day = { ...text('Календарная дата YYYY-MM-DD.', 10), pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const choice = values => ({ type: 'string', enum: values });
const flag = description => ({ type: 'boolean', description });
const notes = text('Пояснение пользователя или основание изменения.', 8000);
const account = { accountId: identifier };
const notificationScope = { ...account, includeDemo: flag('Включить учебные ТОО; по умолчанию false.') };

function tool(name, description, properties = {}, required = [], readOnly = false, idempotent = readOnly) {
  return {
    name, description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false },
  };
}

export const tools = [
  tool('vb_status', 'Показать подключённый источник, ТОО, каталог состояния и ограничения покрытия отчётности.', {}, [], true),
  tool('vb_connect_workspace', 'Подключить выбранный пользователем vb-accounting.json версии 6 для чтения. Исходный файл не изменяется. Не искать и не подключать личные файлы без запроса пользователя.', { path }, ['path']),
  tool('vb_create_company', 'Создать профиль ТОО в отдельном хранилище плагина. Не изменяет настольное приложение.', {
    name: text('Название ТОО.'), bin: { ...text('БИН из 12 цифр.', 12), pattern: '^\\d{12}$' },
    taxRegime: choice(['simplified', 'general', 'unknown']), registrationDate: day, hasEmployees: flag('Есть ли работники.'),
  }, ['name']),
  tool('vb_update_company', 'Дополнить или исправить локальный профиль ТОО в плагине. Подключённые профили приложения доступны только для чтения.', {
    ...account, name: text('Название ТОО.'), bin: { ...text('БИН из 12 цифр.', 12), pattern: '^\\d{12}$' },
    taxRegime: choice(['simplified', 'general', 'unknown']), registrationDate: day, hasEmployees: flag('Есть ли работники.'),
  }, ['accountId']),
  tool('vb_list_obligations', 'Что нужно сдать, оплатить или проверить: применимость, срок, статус и следующее действие. Просрочки и неизвестная применимость видны независимо от горизонта. Покрытие неполное; правила из снимка приложения требуют проверки.', {
    ...notificationScope, horizonDays: { type: 'integer', minimum: 0, maximum: 730, description: 'Горизонт в днях, по умолчанию 31.' }, includeClosed: flag('Показать также принятые, оплаченные и неприменимые обязательства.'),
  }, [], true),
  tool('vb_get_obligation', 'Получить подробности обязательства, основание, состояние и подтверждения.', { ...account, id: identifier }, ['accountId', 'id'], true),
  tool('vb_add_obligation', 'Добавить обязательство с указанными пользователем сроком и основанием. Не определяет юридическую обязанность автоматически.', {
    ...account, title: text('Что требуется сделать.'), authority: text('Куда сдавать или кому платить.'), period: text('Отчётный период.', 100),
    due: day, kind: choice(['filing', 'payment', 'check']), applicability: choice(['required', 'unknown', 'not-required']),
    sourceUrl: text('Ссылка на основание или официальный источник.', 2000), notes,
  }, ['accountId', 'title', 'authority', 'period', 'kind']),
  tool('vb_update_obligation', 'Сохранить состояние обязательства только в плагине. accepted требует файла квитанции, paid — подтверждения оплаты; файлы сохраняются с хешем. Это запись предоставленного пользователем подтверждения, а не проверка в государственном кабинете.', {
    ...account, id: identifier, status: choice(['needs-data', 'prepared', 'sent', 'accepted', 'rejected', 'pending', 'paid', 'done']), notes, evidencePath: path,
  }, ['accountId', 'id', 'status']),
  tool('vb_set_applicability', 'Сохранить результат проверки применимости и зарегистрированный срок. Для required/not-required нужно основание: пояснение, ссылка или документ. Не проверяет кабинет автоматически и не меняет файл приложения.', {
    ...account, id: identifier, applicability: choice(['required', 'unknown', 'not-required']), due: day,
    sourceUrl: text('Источник зарегистрированных сведений.', 2000), notes, evidencePath: path,
  }, ['accountId', 'id', 'applicability']),
  tool('vb_list_notifications', 'Прочитать сохранённые уведомления и их идентификаторы без формирования новых. По умолчанию показывает непрочитанные.', {
    ...notificationScope, unreadOnly: flag('Только непрочитанные; по умолчанию true.'),
  }, [], true),
  tool('vb_check_notifications', 'Проверить обязательства и сохранить новые уведомления с защитой от повторов. Возвращает структурированные события для чата или задания по расписанию; сам не отправляет push, письма и сообщения. Ошибка источника не означает отсутствие обязательств.', notificationScope),
  tool('vb_notification_settings', 'Показать или изменить настройки напоминаний. Дни означают время до срока; изменение не создаёт задание по расписанию.', {
    enabled: flag('Включить формирование уведомлений.'), leadDays: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 90 } },
  }),
  tool('vb_ack_notification', 'Отметить уведомление прочитанным или отложить повтор до даты. Не закрывает обязательство и не переносит его срок.', { id: identifier, snoozeUntil: day }, ['id'], false, true),
];

export function validateArguments(schema, value, location = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${location}: ожидается объект.`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${location}.${key}: обязательное поле.`);
    for (const [key, field] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`${location}.${key}: неизвестное поле.`);
      const property = schema.properties[key];
      validateArguments(property, field, `${location}.${key}`);
    }
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) throw new Error(`${location}: неверная строка.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${location}: неверный формат.`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${location}: недопустимое значение.`);
    return;
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${location}: ожидается true или false.`);
  if (schema.type === 'integer' && (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum)) throw new Error(`${location}: число вне допустимого диапазона.`);
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) throw new Error(`${location}: неверный список.`);
    if (schema.uniqueItems && new Set(value).size !== value.length) throw new Error(`${location}: повторяющиеся элементы.`);
    for (const item of value) validateArguments(schema.items, item, location);
  }
}
