'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const MAX_BODY_BYTES = 8 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 8;
const requestBuckets = new Map();

// Read .env for local development. In production, set environment variables in the hosting dashboard.
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

async function handleRsvp(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Используйте POST-запрос.' });
  }
  if (!checkRateLimit(req)) {
    return sendJson(res, 429, { error: 'Слишком много попыток. Подожди несколько минут и попробуй снова.' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return sendJson(res, 503, { error: 'Отправка пока не настроена. Попробуйте позже или скопируйте текст ответа.' });
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

  const lines = [
    '💌 Новый ответ на приглашение',
    '',
    `👤 Имя: ${guestName}`,
    attendance === 'yes' ? '✅ Присутствие: подтвердил(а)' : '❌ Присутствие: не сможет прийти'
  ];
  if (attendance === 'yes') lines.push(`👥 Количество человек: ${guestCount}`);
  if (note) lines.push('', '💬 Сообщение:', note);
  const message = lines.join('\n');

  try {
    const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000)
    });
    const telegramData = await telegramResponse.json().catch(() => ({}));
    if (!telegramResponse.ok || telegramData.ok !== true) {
      // Avoid logging tokens or guest message contents.
      console.error('Telegram sendMessage failed with HTTP status:', telegramResponse.status);
      return sendJson(res, 502, { error: 'Telegram не принял сообщение. Проверь настройки бота и chat ID.' });
    }
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error('Telegram request failed:', error.name || 'UnknownError');
    return sendJson(res, 502, { error: 'Не удалось связаться с Telegram. Попробуй ещё раз.' });
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
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) });
  return serveStatic(req, res, url.pathname);
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => {
  console.log(`Wedding invitation server listening on port ${port}`);
});
