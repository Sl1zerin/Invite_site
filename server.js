'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const ROOT = __dirname;
const MAX_BODY_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 8;
const requestBuckets = new Map();

// Read .env for local development. On Render, configure these in the service's Environment tab.
function loadLocalEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) process.env[key] = value;
  }
}
loadLocalEnv();

const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const configuredRecipientIds = [...new Set([
  process.env.TELEGRAM_CHAT_ID,
  process.env.TELEGRAM_CHAT_ID_2
].map((value) => String(value || '').trim()).filter(Boolean))];
const adminChatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '').trim();
const adminUserIds = new Set(String(process.env.TELEGRAM_ADMIN_USER_IDS || '')
  .split(',').map((value) => value.trim()).filter(Boolean));
const webhookSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const dbPool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000 }) : null;
let databaseReady = false;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4'
};

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let settled = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (settled) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.resume();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      try {
        settled = true;
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

async function initDatabase() {
  if (!dbPool) return;
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS guest_responses (
      id BIGSERIAL PRIMARY KEY,
      guest_name VARCHAR(80) NOT NULL,
      attendance BOOLEAN NOT NULL,
      guest_count INTEGER,
      note VARCHAR(500) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notification_messages JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  await dbPool.query('CREATE INDEX IF NOT EXISTS guest_responses_created_at_idx ON guest_responses (created_at DESC)');
  databaseReady = true;
  console.log('Guest list database is ready.');
}

function checkRateLimit(req) {
  // On Render, the last address appended by its proxy is the visitor IP.
  const forwardedFor = process.env.RENDER ? req.headers['x-forwarded-for'] : null;
  const ip = (forwardedFor ? String(forwardedFor).split(',').at(-1).trim() : req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const timestamps = (requestBuckets.get(ip) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT) {
    requestBuckets.set(ip, timestamps);
    return false;
  }
  timestamps.push(now);
  requestBuckets.set(ip, timestamps);
  if (requestBuckets.size > 1000) {
    for (const [key, values] of requestBuckets) {
      if (!values.some((time) => now - time < RATE_WINDOW_MS)) requestBuckets.delete(key);
    }
  }
  return true;
}

function cleanSingleLine(value, maxLength) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength);
}

async function telegramApi(method, payload) {
  if (!botToken) throw new Error('Telegram token is not configured');
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    // Never log the bot token, guest details, or full request URL.
    console.error(`Telegram API call failed: ${method}; HTTP ${response.status}`);
    throw new Error(`Telegram API ${method} failed`);
  }
  return data.result;
}

async function sendTelegramMessage(chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramApi('sendMessage', payload);
}

async function sendRsvpNotifications(message) {
  const results = await Promise.all(configuredRecipientIds.map(async (chatId) => {
    try {
      const telegramMessage = await sendTelegramMessage(chatId, message);
      return { chatId, messageId: telegramMessage.message_id };
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean);
}

async function handleRsvp(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Используйте POST-запрос.' });
  }
  if (!checkRateLimit(req)) {
    return sendJson(res, 429, { error: 'Слишком много попыток. Подожди несколько минут и попробуй снова.' });
  }
  if (!databaseReady || !dbPool) {
    return sendJson(res, 503, { error: 'Список гостей ещё не подключён. Попробуйте позже.' });
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      return sendJson(res, error.statusCode || 400, { error: error.statusCode === 413 ? 'Слишком большой запрос.' : 'Не удалось прочитать ответ.' });
    }
    return;
  }

  const guestName = cleanSingleLine(payload.guestName, 80);
  const attendance = payload.attendance;
  const note = String(payload.note ?? '').trim().slice(0, 500);
  const guestCount = Number(payload.guestCount);
  if (!guestName) return sendJson(res, 400, { error: 'Укажи имя.' });
  if (attendance !== 'yes' && attendance !== 'no') {
    return sendJson(res, 400, { error: 'Укажи, сможешь ли прийти.' });
  }
  if (attendance === 'yes' && (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 6)) {
    return sendJson(res, 400, { error: 'Количество гостей должно быть от 1 до 6.' });
  }

  let guestRecord;
  try {
    const insert = await dbPool.query(
      `INSERT INTO guest_responses (guest_name, attendance, guest_count, note)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [guestName, attendance === 'yes', attendance === 'yes' ? guestCount : null, note]
    );
    guestRecord = insert.rows[0];
  } catch (error) {
    console.error('Could not save guest response:', error.code || error.name || 'DatabaseError');
    return sendJson(res, 503, { error: 'Не удалось сохранить ответ. Попробуйте ещё раз немного позже.' });
  }

  const lines = [
    '💌 Новый ответ на приглашение',
    `🆔 Запись: #${guestRecord.id}`,
    '',
    `👤 Имя: ${guestName}`,
    attendance === 'yes' ? '✅ Присутствие: подтвердил(а)' : '❌ Присутствие: не сможет прийти'
  ];
  if (attendance === 'yes') lines.push(`👥 Количество человек: ${guestCount}`);
  if (note) lines.push('', '💬 Сообщение:', note);
  const message = lines.join('\n');
  const deliveredMessages = await sendRsvpNotifications(message);

  try {
    await dbPool.query('UPDATE guest_responses SET notification_messages = $1::jsonb WHERE id = $2', [JSON.stringify(deliveredMessages), guestRecord.id]);
  } catch (error) {
    console.error('Could not save Telegram message references:', error.code || error.name || 'DatabaseError');
  }

  if (deliveredMessages.length === 0) {
    // The RSVP is saved so the guest will not create duplicates by retrying the form.
    return sendJson(res, 200, { ok: true, stored: true, notificationSent: false, guestId: guestRecord.id });
  }
  if (deliveredMessages.length < configuredRecipientIds.length) {
    return sendJson(res, 200, {
      ok: true,
      stored: true,
      notificationSent: true,
      partial: true,
      deliveredTo: deliveredMessages.length,
      totalRecipients: configuredRecipientIds.length,
      guestId: guestRecord.id
    });
  }
  return sendJson(res, 200, { ok: true, stored: true, notificationSent: true, deliveredTo: deliveredMessages.length, totalRecipients: configuredRecipientIds.length, guestId: guestRecord.id });
}

function requireDatabaseMessage() {
  return databaseReady && dbPool ? null : 'База списка гостей не подключена. Проверьте DATABASE_URL в настройках Render.';
}

function adminAuthorized(userId) {
  return Boolean(userId && adminUserIds.size > 0 && adminUserIds.has(String(userId)));
}

function safeDate(value) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow'
    }).format(new Date(value));
  } catch {
    return String(value || '');
  }
}

function truncate(value, maxLength = 90) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

async function renderGuestList(chatId, page = 0, editMessageId = null) {
  const pageSize = 10;
  const countResult = await dbPool.query('SELECT COUNT(*)::int AS count FROM guest_responses');
  const total = countResult.rows[0].count;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.max(0, Math.min(Number.isInteger(page) ? page : 0, pageCount - 1));
  const result = await dbPool.query(
    `SELECT id, guest_name, attendance, guest_count, note, created_at
       FROM guest_responses ORDER BY id DESC LIMIT $1 OFFSET $2`,
    [pageSize, currentPage * pageSize]
  );
  const lines = [`📋 Список гостей и ответов`, `Всего записей: ${total} · Страница ${currentPage + 1}/${pageCount}`, ''];
  const keyboard = [];
  if (result.rows.length === 0) {
    lines.push('Пока нет сохранённых ответов от гостей.');
  } else {
    for (const guest of result.rows) {
      const attendance = guest.attendance ? `✅ Придёт · ${guest.guest_count} чел.` : '❌ Не сможет прийти';
      lines.push(`#${guest.id} · ${truncate(guest.guest_name, 80)}`);
      lines.push(`${attendance} · ${safeDate(guest.created_at)}`);
      if (guest.note) lines.push(`💬 ${truncate(guest.note, 90)}`);
      lines.push('');
      keyboard.push([{ text: `🗑 Удалить #${guest.id}`, callback_data: `gaskdel:${guest.id}:${currentPage}` }]);
    }
  }
  const navRow = [];
  if (currentPage > 0) navRow.push({ text: '⬅️ Назад', callback_data: `gpage:${currentPage - 1}` });
  if (currentPage + 1 < pageCount) navRow.push({ text: 'Вперёд ➡️', callback_data: `gpage:${currentPage + 1}` });
  if (navRow.length) keyboard.push(navRow);
  if (total > 0) keyboard.push([{ text: '🗑 Удалить всех…', callback_data: 'gaskall' }]);
  const replyMarkup = keyboard.length ? { inline_keyboard: keyboard } : undefined;
  const text = lines.join('\n').slice(0, 3900);
  if (editMessageId) {
    try {
      await telegramApi('editMessageText', {
        chat_id: chatId, message_id: editMessageId, text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      });
    } catch (error) {
      if (!String(error.message).includes('failed')) throw error;
      await sendTelegramMessage(chatId, text, replyMarkup);
    }
  } else {
    await sendTelegramMessage(chatId, text, replyMarkup);
  }
}

async function deleteGuestRecord(guestId) {
  const result = await dbPool.query('DELETE FROM guest_responses WHERE id = $1 RETURNING notification_messages', [guestId]);
  if (!result.rowCount) return { deleted: false, messagesRemoved: 0, messageDeleteFailures: 0 };
  const references = Array.isArray(result.rows[0].notification_messages) ? result.rows[0].notification_messages : [];
  let messagesRemoved = 0;
  let messageDeleteFailures = 0;
  for (const ref of references) {
    if (!ref || !ref.chatId || !ref.messageId) continue;
    try {
      await telegramApi('deleteMessage', { chat_id: ref.chatId, message_id: ref.messageId });
      messagesRemoved += 1;
    } catch {
      messageDeleteFailures += 1;
    }
  }
  return { deleted: true, messagesRemoved, messageDeleteFailures };
}

async function deleteAllGuestRecords() {
  const client = await dbPool.connect();
  let references = [];
  let deletedCount = 0;
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT notification_messages FROM guest_responses');
    references = existing.rows.flatMap((row) => Array.isArray(row.notification_messages) ? row.notification_messages : []);
    const deleted = await client.query('DELETE FROM guest_responses');
    deletedCount = deleted.rowCount;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  let messagesRemoved = 0;
  let messageDeleteFailures = 0;
  // Delete a small number of Telegram messages concurrently to avoid API bursts.
  for (let i = 0; i < references.length; i += 5) {
    const chunk = references.slice(i, i + 5);
    const results = await Promise.all(chunk.map(async (ref) => {
      if (!ref || !ref.chatId || !ref.messageId) return false;
      try {
        await telegramApi('deleteMessage', { chat_id: ref.chatId, message_id: ref.messageId });
        return true;
      } catch {
        return false;
      }
    }));
    messagesRemoved += results.filter(Boolean).length;
    messageDeleteFailures += results.length - results.filter(Boolean).length;
  }
  return { deletedCount, messagesRemoved, messageDeleteFailures };
}

async function handleBotCommand(message) {
  if (!message || !message.chat || !message.from || !message.text) return;
  const chatId = String(message.chat.id);
  // Commands are only accepted in the configured organizers' group.
  if (!adminChatId || chatId !== adminChatId) return;
  const match = message.text.trim().match(/^\/([a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i);
  if (!match) return;
  const command = match[1].toLowerCase();
  const argument = String(match[2] || '').trim();
  if (!['guests', 'guestlist', 'list', 'delete', 'delete_all', 'deleteall', 'help', 'start', 'cancel'].includes(command)) return;

  if (!adminAuthorized(message.from.id)) {
    if (adminUserIds.size === 0) {
      await sendTelegramMessage(chatId, '⚠️ Управление списком пока не настроено. Добавьте TELEGRAM_ADMIN_USER_IDS в Environment на Render.');
    }
    return;
  }
  const dbMessage = requireDatabaseMessage();
  if (dbMessage && ['guests', 'guestlist', 'list', 'delete', 'delete_all', 'deleteall'].includes(command)) {
    await sendTelegramMessage(chatId, `⚠️ ${dbMessage}`);
    return;
  }

  if (command === 'help' || command === 'start') {
    await sendTelegramMessage(chatId,
      'Управление списком гостей:\n/guests — показать гостей и кнопки управления\n/delete ID — удалить одну запись после подтверждения\n/delete_all — удалить весь список после подтверждения\n\nID записи указан рядом с каждым гостем. Удаление из списка постоянное; бот также попробует удалить соответствующее уведомление из группы.');
    return;
  }
  if (command === 'cancel') {
    await sendTelegramMessage(chatId, 'Операция отменена.');
    return;
  }
  if (command === 'guests' || command === 'guestlist' || command === 'list') {
    await renderGuestList(chatId, 0);
    return;
  }
  if (command === 'delete') {
    const guestId = Number(argument);
    if (!Number.isSafeInteger(guestId) || guestId < 1) {
      await sendTelegramMessage(chatId, 'Укажите ID записи из списка, например: /delete 12');
      return;
    }
    const result = await dbPool.query('SELECT id, guest_name FROM guest_responses WHERE id = $1', [guestId]);
    if (!result.rowCount) {
      await sendTelegramMessage(chatId, `Запись #${guestId} не найдена. Используйте /guests, чтобы посмотреть текущий список.`);
      return;
    }
    await sendTelegramMessage(chatId,
      `Удалить запись #${guestId} (${truncate(result.rows[0].guest_name, 80)})?`,
      { inline_keyboard: [[
        { text: 'Да, удалить', callback_data: `gdel:${guestId}` },
        { text: 'Отмена', callback_data: 'gcancel' }
      ]] });
    return;
  }
  if (command === 'delete_all' || command === 'deleteall') {
    const result = await dbPool.query('SELECT COUNT(*)::int AS count FROM guest_responses');
    const count = result.rows[0].count;
    if (!count) {
      await sendTelegramMessage(chatId, 'Список уже пуст.');
      return;
    }
    await sendTelegramMessage(chatId,
      `⚠️ Удалить все ${count} записей из списка гостей? Это действие нельзя отменить.`,
      { inline_keyboard: [[
        { text: 'Да, удалить всех', callback_data: 'gdelall' },
        { text: 'Отмена', callback_data: 'gcancel' }
      ]] });
  }
}

async function handleBotCallback(callbackQuery) {
  if (!callbackQuery || !callbackQuery.data || !callbackQuery.message || !callbackQuery.from) return;
  const chatId = String(callbackQuery.message.chat && callbackQuery.message.chat.id);
  if (!adminChatId || chatId !== adminChatId) return;
  if (!adminAuthorized(callbackQuery.from.id)) {
    await telegramApi('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Нет доступа к управлению.' }).catch(() => {});
    return;
  }
  const data = String(callbackQuery.data);
  const messageId = callbackQuery.message.message_id;
  await telegramApi('answerCallbackQuery', { callback_query_id: callbackQuery.id }).catch(() => {});
  const dbMessage = requireDatabaseMessage();
  if (dbMessage && data.startsWith('g')) {
    await sendTelegramMessage(chatId, `⚠️ ${dbMessage}`);
    return;
  }

  if (data.startsWith('gpage:')) {
    const page = Number(data.split(':')[1]);
    if (Number.isInteger(page) && page >= 0) await renderGuestList(chatId, page, messageId);
    return;
  }
  if (data.startsWith('gaskdel:')) {
    const [, rawId, rawPage] = data.split(':');
    const guestId = Number(rawId);
    const page = Number(rawPage || 0);
    if (!Number.isSafeInteger(guestId) || guestId < 1) return;
    const result = await dbPool.query('SELECT id, guest_name FROM guest_responses WHERE id = $1', [guestId]);
    if (!result.rowCount) {
      await renderGuestList(chatId, page, messageId);
      return;
    }
    await telegramApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `Удалить запись #${guestId} (${truncate(result.rows[0].guest_name, 80)})?`,
      reply_markup: { inline_keyboard: [[
        { text: 'Да, удалить', callback_data: `gdel:${guestId}:${page}` },
        { text: 'Отмена', callback_data: `gback:${page}` }
      ]] }
    });
    return;
  }
  if (data.startsWith('gdel:')) {
    const [, rawId, rawPage] = data.split(':');
    const guestId = Number(rawId);
    const page = Number(rawPage || 0);
    if (!Number.isSafeInteger(guestId) || guestId < 1) return;
    const result = await deleteGuestRecord(guestId);
    if (!result.deleted) {
      await sendTelegramMessage(chatId, `Запись #${guestId} уже удалена или не найдена.`);
    } else {
      const suffix = result.messageDeleteFailures > 0
        ? `\nУведомлений удалено из истории группы: ${result.messagesRemoved}. Некоторые старые сообщения Telegram не разрешил удалить.`
        : `\nУведомлений удалено из истории группы: ${result.messagesRemoved}.`;
      await sendTelegramMessage(chatId, `✅ Запись #${guestId} удалена из списка.${suffix}`);
    }
    await renderGuestList(chatId, page, messageId);
    return;
  }
  if (data === 'gaskall') {
    const result = await dbPool.query('SELECT COUNT(*)::int AS count FROM guest_responses');
    const count = result.rows[0].count;
    await telegramApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: count ? `⚠️ Удалить все ${count} записей? Список будет очищен без возможности восстановления.` : 'Список уже пуст.',
      ...(count ? { reply_markup: { inline_keyboard: [[
        { text: 'Да, удалить всех', callback_data: 'gdelall' },
        { text: 'Отмена', callback_data: 'gback:0' }
      ]] } } : {})
    });
    return;
  }
  if (data === 'gdelall') {
    const result = await deleteAllGuestRecords();
    const suffix = result.messageDeleteFailures > 0
      ? ` Уведомлений удалено из истории: ${result.messagesRemoved}; некоторые старые сообщения остались в группе.`
      : ` Уведомлений удалено из истории: ${result.messagesRemoved}.`;
    await telegramApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `✅ Список очищен. Удалено записей: ${result.deletedCount}.${suffix}`
    }).catch(async () => sendTelegramMessage(chatId, `✅ Список очищен. Удалено записей: ${result.deletedCount}.${suffix}`));
    return;
  }
  if (data === 'gcancel' || data.startsWith('gback:')) {
    const page = data.startsWith('gback:') ? Number(data.split(':')[1] || 0) : 0;
    await renderGuestList(chatId, Number.isInteger(page) && page >= 0 ? page : 0, messageId);
  }
}

async function handleTelegramWebhook(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Используйте POST-запрос.' });
  }
  if (!webhookSecret || req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  let update;
  try {
    update = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: 'Некорректный запрос.' });
  }
  // Acknowledge promptly so Telegram does not retry while database/Telegram APIs are running.
  sendJson(res, 200, { ok: true });
  Promise.resolve().then(async () => {
    if (update.message) await handleBotCommand(update.message);
    else if (update.callback_query) await handleBotCallback(update.callback_query);
  }).catch((error) => {
    console.error('Telegram update processing failed:', error.name || 'UnknownError');
  });
}

async function configureTelegramWebhook() {
  const publicUrl = String(process.env.TELEGRAM_WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  if (!botToken || !webhookSecret || !publicUrl) {
    console.log('Telegram management webhook not configured yet. Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, and use Render public URL.');
    return;
  }
  try {
    await telegramApi('setWebhook', {
      url: `${publicUrl}/api/telegram-webhook`,
      secret_token: webhookSecret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    });
    await telegramApi('setMyCommands', { commands: [
      { command: 'guests', description: 'Показать список гостей' },
      { command: 'delete', description: 'Удалить одну запись по ID' },
      { command: 'delete_all', description: 'Очистить весь список' },
      { command: 'help', description: 'Помощь по командам' }
    ] });
    console.log('Telegram management webhook configured.');
  } catch (error) {
    console.error('Could not configure Telegram webhook:', error.name || 'UnknownError');
  }
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Метод не поддерживается.' });
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'Некорректный URL.' });
  }
  if (decodedPath === '/') decodedPath = '/index.html';
  const segments = decodedPath.split('/').filter(Boolean);
  const protectedNames = new Set(['server.js', 'package.json', 'render.yaml', 'readme.md', 'readme', '.env', '.env.example', '.gitignore']);
  if (segments.some((segment) => segment.startsWith('.') || protectedNames.has(segment.toLowerCase()) || segment.toLowerCase() === 'node_modules')) {
    return sendJson(res, 403, { error: 'Доступ запрещён.' });
  }
  const filePath = path.resolve(ROOT, `.${decodedPath}`);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return sendJson(res, 403, { error: 'Доступ запрещён.' });
  }
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      return res.end('Not found');
    }
    const headers = {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
    if (path.extname(filePath).toLowerCase() === '.html') headers['Cache-Control'] = 'no-cache';
    else headers['Cache-Control'] = 'public, max-age=3600';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: 'Некорректный запрос.' });
  }
  if (url.pathname === '/api/rsvp') return handleRsvp(req, res);
  if (url.pathname === '/api/telegram-webhook') return handleTelegramWebhook(req, res);
  if (url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      telegramConfigured: Boolean(botToken && configuredRecipientIds.length > 0),
      telegramRecipientsConfigured: configuredRecipientIds.length,
      databaseConfigured: Boolean(dbPool),
      databaseReady,
      managementWebhookConfigured: Boolean(botToken && webhookSecret && (process.env.TELEGRAM_WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL)),
      adminUsersConfigured: adminUserIds.size
    });
  }
  return serveStatic(req, res, url.pathname);
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', async () => {
  console.log(`Wedding invitation server listening on port ${port}`);
  if (dbPool) {
    try {
      await initDatabase();
    } catch (error) {
      databaseReady = false;
      console.error('Guest list database initialization failed:', error.code || error.name || 'DatabaseError');
    }
  } else {
    console.warn('DATABASE_URL is not configured; RSVP storage and guest-management commands are unavailable.');
  }
  await configureTelegramWebhook();
});

process.on('SIGTERM', async () => {
  server.close();
  if (dbPool) await dbPool.end().catch(() => {});
});
