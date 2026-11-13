import test from 'node:test';
import assert from 'node:assert/strict';
import { sendTelegramBackup } from '../lib/backup-telegram.mjs';

const token = '123456:Example_token-for-tests';
const chatId = '1234567890123';
const bytes = Buffer.from('age-encryption.org/v1\nfixture');
const fileName = 'vb-backup-2026-11-13.tar.gz.age';
const archive = { token, chatId, bytes, fileName };

function privateChat(id = Number(chatId), type = 'private') {
  return Response.json({ ok: true, result: { id, type } });
}

function receipt(id = Number(chatId), type = 'private') {
  return Response.json({
    ok: true,
    result: {
      message_id: 123,
      date: 1794560400,
      chat: { id, type },
      document: { file_id: 'sample-document', file_name: fileName, file_size: bytes.length }
    }
  });
}

function withPreflight(sendDocument, getChat = () => privateChat()) {
  return async (url, options) => {
    if (url.endsWith('/getChat')) return getChat(url, options);
    return sendDocument(url, options);
  };
}

test('uploads the encrypted archive as a document to the selected private chat', async () => {
  const requests = [];
  const result = await sendTelegramBackup({
    ...archive,
    fetchImpl: withPreflight(async (url, options) => {
      requests.push('upload');
      assert.equal(url, `https://api.telegram.org/bot${token}/sendDocument`);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.body.get('chat_id'), chatId);
      const document = options.body.get('document');
      assert.equal(document.name, fileName);
      assert.deepEqual(Buffer.from(await document.arrayBuffer()), bytes);
      return receipt();
    }, (url, options) => {
      requests.push('verify');
      assert.equal(url, `https://api.telegram.org/bot${token}/getChat`);
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), { chat_id: chatId });
      return privateChat();
    })
  });

  assert.deepEqual(result, { messageId: 123, sentAt: new Date(1794560400 * 1000).toISOString() });
  assert.deepEqual(requests, ['verify', 'upload']);
});

test('rejects invalid recipients, tokens, and over-limit archives before any network request', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return receipt(); };
  const overLimit = Buffer.alloc(50_000_001);
  bytes.copy(overLimit);
  for (const invalid of [
    { chatId: '-1001234' },
    { chatId: '@channel' },
    { chatId: '12345678901234567890' },
    { token: '123:abcd?redirect=evil' },
    { fileName: '../backup.tar.gz.age' },
    { caption: 'a'.repeat(1025) },
    { bytes: Buffer.from('unprotected archive') }
  ]) {
    await assert.rejects(sendTelegramBackup({ ...archive, ...invalid, fetchImpl }));
  }
  await assert.rejects(sendTelegramBackup({ ...archive, bytes: overLimit, fetchImpl }), /50 МБ/);
  assert.equal(requests, 0);
});

test('sends the company name and BIN as a Unicode filename and plain caption', async () => {
  const name = 'ТОО-VB-Tech-260740046461-2026-11-13.tar.gz.age';
  const caption = 'ТОО «VB Tech» · БИН 260740046461';
  const fetchImpl = withPreflight(async (_url, options) => {
    assert.equal(options.body.get('document').name, name);
    assert.equal(options.body.get('caption'), caption);
    assert.equal(options.body.has('parse_mode'), false);
    const { result } = await receipt().json();
    return Response.json({ ok: true, result: { ...result, caption, document: { ...result.document, file_name: name } } });
  });
  assert.equal((await sendTelegramBackup({ ...archive, fileName: name, caption, fetchImpl })).messageId, 123);
});

test('does not upload when Telegram cannot verify the intended private chat', async () => {
  let uploads = 0;
  for (const result of [
    () => privateChat(Number(chatId) + 1),
    () => privateChat(Number(chatId), 'supergroup'),
    () => Response.json({ ok: false, description: token }, { status: 403 })
  ]) {
    const fetchImpl = withPreflight(async () => { uploads++; }, result);
    await assert.rejects(sendTelegramBackup({ ...archive, fetchImpl }), error => {
      assert.equal(error.code, 'telegram-preflight');
      assert.ok(!String(error.stack).includes(token));
      return true;
    });
  }
  assert.equal(uploads, 0);
});

test('treats an unexpected chat or absent document as unconfirmed delivery', async () => {
  for (const result of [
    () => receipt(Number(chatId) + 1),
    () => receipt(Number(chatId), 'group'),
    () => Response.json({ ok: true, result: { message_id: 123, chat: { id: Number(chatId), type: 'private' } } }),
    () => new Response('Client closed request', { status: 499 })
  ]) {
    await assert.rejects(sendTelegramBackup({ ...archive, fetchImpl: withPreflight(() => result()) }), {
      code: 'telegram-unconfirmed'
    });
  }
});

test('redacts Telegram response bodies and network errors and makes one attempt', async () => {
  let requests = 0;
  const fetchImpl = withPreflight(async () => {
    requests++;
    throw new Error(`Failed request https://api.telegram.org/bot${token}/sendDocument`);
  });

  await assert.rejects(sendTelegramBackup({ ...archive, fetchImpl }), error => {
    assert.equal(error.code, 'telegram-unconfirmed');
    assert.ok(!String(error.stack).includes(token));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(requests, 1);

  await assert.rejects(sendTelegramBackup({
    ...archive,
    fetchImpl: withPreflight(() => Response.json({ ok: false, error_code: 403, description: token }, { status: 403 }))
  }), error => {
    assert.equal(error.code, 'telegram-rejected');
    assert.ok(!String(error.stack).includes(token));
    return true;
  });
});
