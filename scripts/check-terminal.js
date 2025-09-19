#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { setTimeout: delay } = require('timers/promises');
const WebSocket = require('ws');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const FILE_PORT = 5050;
const TERMINAL_PORT = 4050;
const TERMINAL_BASE_URL = `http://127.0.0.1:${TERMINAL_PORT}`;
const CHECK_TOKEN = '__NEOCONSOLE_CHECK__';

if (typeof fetch !== 'function') {
  throw new Error('Для запуска проверки требуется Node.js с поддержкой глобального fetch (>= 18.0).');
}

async function waitForServer(url, { timeout = 15_000, interval = 250, onEarlyExit } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (onEarlyExit && onEarlyExit()) {
      throw new Error('Сервер завершил работу до готовности принять подключения.');
    }
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch (error) {
      // игнорируем до истечения таймаута
    }
    await delay(interval);
  }
  throw new Error(`Сервер по адресу ${url} не ответил за ${timeout} мс.`);
}

async function readJson(response, context) {
  const body = await response.text();
  if (!response.ok) {
    const message = body ? `${response.status} ${response.statusText}: ${body}` : `${response.status} ${response.statusText}`;
    throw new Error(`${context}: ${message}`);
  }
  if (!body) {
    return {};
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`${context}: не удалось разобрать JSON (${error.message}). Ответ сервера: ${body}`);
  }
}

async function ensureTerminalUiAccessible() {
  const response = await fetch(`${TERMINAL_BASE_URL}/`);
  if (!response.ok) {
    throw new Error(`Главная страница терминала недоступна: ${response.status} ${response.statusText}`);
  }
}

async function fetchSessions() {
  const response = await fetch(`${TERMINAL_BASE_URL}/api/terminals`);
  const data = await readJson(response, 'Не удалось получить список терминальных сессий');
  if (!Array.isArray(data.sessions)) {
    throw new Error('Ответ API /api/terminals не содержит массива sessions.');
  }
  return data.sessions;
}

async function createSession() {
  const response = await fetch(`${TERMINAL_BASE_URL}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Проверка терминала' }),
  });
  const data = await readJson(response, 'Не удалось создать терминальную сессию');
  if (!data.session || !data.session.id) {
    throw new Error('API создания терминала вернуло неожиданный ответ без session.id.');
  }
  return data.session;
}

async function closeSession(sessionId) {
  const response = await fetch(`${TERMINAL_BASE_URL}/api/terminals/${encodeURIComponent(sessionId)}/close`, {
    method: 'POST',
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Не удалось завершить терминальную сессию ${sessionId}: ${response.status} ${response.statusText} ${body}`);
  }
}

async function fetchHistory(sessionId) {
  const response = await fetch(
    `${TERMINAL_BASE_URL}/api/terminals/${encodeURIComponent(sessionId)}/history`
  );
  const data = await readJson(response, `Не удалось загрузить историю для сессии ${sessionId}`);
  if (typeof data.output !== 'string') {
    throw new Error('Ответ истории не содержит текстового поля output.');
  }
  return data;
}

async function checkWebSocketEcho(sessionId) {
  const wsUrl = `ws://127.0.0.1:${TERMINAL_PORT}/ws`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let buffer = '';
    let commandSent = false;
    let closed = false;
    const timeout = setTimeout(() => {
      cleanup(new Error('Таймаут проверки WebSocket для терминала.'));
    }, 15_000);

    const cleanup = (error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
      } catch (error) {
        cleanup(error);
      }
    });

    ws.on('message', (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch (error) {
        cleanup(new Error(`Невозможно разобрать сообщение WebSocket: ${error.message}`));
        return;
      }

      if (!payload || typeof payload !== 'object') {
        return;
      }

      if (payload.type === 'error' && payload.sessionId === sessionId) {
        cleanup(new Error(`Сервер вернул ошибку для сессии ${sessionId}: ${payload.message || 'неизвестная ошибка'}`));
        return;
      }

      if (payload.type === 'session-history' && payload.sessionId === sessionId && !commandSent) {
        try {
          ws.send(
            JSON.stringify({
              type: 'input',
              sessionId,
              data: `echo ${CHECK_TOKEN}\n`,
            })
          );
          commandSent = true;
        } catch (error) {
          cleanup(error);
        }
        return;
      }

      if (payload.type === 'session-output' && payload.sessionId === sessionId) {
        buffer += String(payload.data || '');
        if (buffer.includes(CHECK_TOKEN)) {
          cleanup();
        }
      }

      if (payload.type === 'session-exit' && payload.sessionId === sessionId) {
        cleanup(new Error('Сессия терминала завершилась раньше времени.'));
      }
    });

    ws.on('close', () => {
      if (!closed) {
        cleanup(new Error('WebSocket-соединение закрыто до завершения проверки.'));
      }
    });

    ws.on('error', (error) => cleanup(error));
  });
}

async function run() {
  const storageRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'neostorage-terminal-'));

  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(FILE_PORT),
      TERMINAL_PORT: String(TERMINAL_PORT),
      FILE_MANAGER_ROOT: storageRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
  });
  server.stderr.on('data', (chunk) => {
    process.stderr.write(`[server:err] ${chunk}`);
  });

  let exited = false;
  let exitError = null;

  const exitPromise = new Promise((resolve, reject) => {
    server.on('exit', (code, signal) => {
      exited = true;
      if (code === 0 || signal === 'SIGTERM') {
        resolve();
      } else {
        exitError = new Error(`Сервер завершился с кодом ${code} (сигнал ${signal || 'none'})`);
        reject(exitError);
      }
    });
  });

  try {
    await waitForServer(`${TERMINAL_BASE_URL}/`, {
      onEarlyExit: () => exited,
    });

    await ensureTerminalUiAccessible();

    const sessionsBefore = await fetchSessions();
    if (!Array.isArray(sessionsBefore)) {
      throw new Error('Ответ списка сессий не является массивом.');
    }

    const session = await createSession();
    const sessionId = session.id;

    await checkWebSocketEcho(sessionId);

    const history = await fetchHistory(sessionId);
    if (!history.output.includes(CHECK_TOKEN)) {
      throw new Error('История терминала не содержит ожидаемый вывод после выполнения команды.');
    }

    await closeSession(sessionId);
  } finally {
    if (!exited) {
      server.kill('SIGTERM');
    }
    try {
      await Promise.race([exitPromise, delay(5_000)]);
    } catch (error) {
      if (exitError) {
        console.error(exitError.message);
      }
    } finally {
      if (!exited) {
        server.kill('SIGKILL');
      }
    }
    await fsp.rm(storageRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
