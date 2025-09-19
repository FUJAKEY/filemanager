const http = require('http');
const express = require('express');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const archiver = require('archiver');
const mime = require('mime-types');
const pty = require('node-pty');
const { WebSocketServer, WebSocket } = require('ws');
const { randomUUID } = require('crypto');
const EventEmitter = require('events');

const FILE_PORT = Number(process.env.PORT) || 5000;
const TERMINAL_PORT = Number(process.env.TERMINAL_PORT) || 4000;

const ROOT = process.env.FILE_MANAGER_ROOT
  ? path.resolve(process.env.FILE_MANAGER_ROOT)
  : path.resolve(process.cwd(), 'storage');

if (!fsSync.existsSync(ROOT)) {
  fsSync.mkdirSync(ROOT, { recursive: true });
}

const MAX_EDITABLE_SIZE = 2 * 1024 * 1024;
const MAX_TERMINAL_HISTORY = 512 * 1024;
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 32;

const toPosix = (value) => value.split(path.sep).join('/');

const isInsideRoot = (targetPath) => {
  const relative = path.relative(ROOT, targetPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

const resolvePath = (target = '') => {
  const resolved = path.resolve(ROOT, target || '.');
  if (!isInsideRoot(resolved)) {
    const error = new Error('Недопустимый путь. Операция отклонена.');
    error.status = 400;
    throw error;
  }
  return resolved;
};

const buildBreadcrumbs = (relativePath) => {
  const normalized = toPosix(relativePath || '').replace(/^\/+|\/+$/g, '');
  const segments = normalized ? normalized.split('/') : [];
  const breadcrumbs = [{ name: 'Корень', path: '' }];

  if (!segments.length) {
    return breadcrumbs;
  }

  let current = '';
  segments.forEach((segment) => {
    current = current ? `${current}/${segment}` : segment;
    breadcrumbs.push({ name: segment, path: current });
  });

  return breadcrumbs;
};

const formatItem = async (dirent, fullPath) => {
  const stats = await fs.stat(fullPath);
  return {
    name: dirent.name,
    path: toPosix(path.relative(ROOT, fullPath)),
    isDirectory: stats.isDirectory(),
    size: stats.isDirectory() ? null : stats.size,
    modifiedAt: stats.mtime,
    extension: stats.isDirectory() ? null : path.extname(dirent.name).replace('.', ''),
  };
};

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const validateName = (name) => {
  if (!name || typeof name !== 'string') {
    const error = new Error('Название обязательно.');
    error.status = 400;
    throw error;
  }
  if (/[/\\]/.test(name)) {
    const error = new Error('Название не должно содержать слеши.');
    error.status = 400;
    throw error;
  }
};

const streamArchive = async (res, files, archiveName) => {
  const sanitizedName = (archiveName && archiveName.replace(/[^a-zA-Z0-9-_\.]/g, '_')) || 'archive.zip';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizedName}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });

  const streamFinished = new Promise((resolve, reject) => {
    archive.on('error', reject);
    res.on('close', resolve);
    res.on('finish', resolve);
    res.on('error', reject);
  });

  archive.pipe(res);

  try {
    for (const file of files) {
      const absolute = resolvePath(file);
      const stats = await fs.stat(absolute);
      const entryName = toPosix(path.relative(ROOT, absolute)) || path.basename(absolute);
      if (stats.isDirectory()) {
        archive.directory(absolute, entryName);
      } else {
        archive.file(absolute, { name: entryName });
      }
    }

    archive.finalize();
    await streamFinished;
  } catch (error) {
    archive.destroy();
    throw error;
  }
};

const fileApp = express();
fileApp.use(morgan('dev'));
fileApp.use(express.json({ limit: '25mb' }));
fileApp.use(express.static(path.join(__dirname, '..', 'public')));

fileApp.get(
  '/api/list',
  asyncHandler(async (req, res) => {
    const requestedPath = req.query.path || '';
    const absolutePath = resolvePath(requestedPath);
    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });

    const items = await Promise.all(
      dirents.map((dirent) => formatItem(dirent, path.join(absolutePath, dirent.name)))
    );

    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, 'ru');
    });

    const relativePath = toPosix(path.relative(ROOT, absolutePath));

    res.json({
      currentPath: relativePath,
      breadcrumbs: buildBreadcrumbs(relativePath),
      items,
    });
  })
);

fileApp.post(
  '/api/mkdir',
  asyncHandler(async (req, res) => {
    const { path: parentPath = '', name } = req.body || {};
    validateName(name);
    const destination = resolvePath(parentPath);
    const newDir = path.join(destination, name);
    await fs.mkdir(newDir, { recursive: false });
    res.status(201).json({ message: 'Папка создана успешно.' });
  })
);

fileApp.post(
  '/api/file',
  asyncHandler(async (req, res) => {
    const { path: parentPath = '', name, content = '' } = req.body || {};
    validateName(name);
    const destination = resolvePath(parentPath);
    const filePath = path.join(destination, name);
    if (fsSync.existsSync(filePath)) {
      const error = new Error('Файл с таким именем уже существует.');
      error.status = 409;
      throw error;
    }

    await fs.writeFile(filePath, content ?? '', { encoding: 'utf8', flag: 'wx' });
    res.status(201).json({
      message: 'Файл создан.',
      path: toPosix(path.relative(ROOT, filePath)),
    });
  })
);

fileApp.post(
  '/api/rename',
  asyncHandler(async (req, res) => {
    const { path: targetPath, newName } = req.body || {};
    if (!targetPath) {
      const error = new Error('Не указан путь.');
      error.status = 400;
      throw error;
    }
    validateName(newName);
    const source = resolvePath(targetPath);
    const destinationDirectory = path.dirname(source);
    const destination = path.join(destinationDirectory, newName);
    await fs.rename(source, destination);
    res.json({ message: 'Имя обновлено.' });
  })
);

fileApp.post(
  '/api/delete',
  asyncHandler(async (req, res) => {
    const { paths } = req.body || {};
    if (!Array.isArray(paths) || !paths.length) {
      const error = new Error('Необходимо передать массив путей.');
      error.status = 400;
      throw error;
    }

    for (const relative of paths) {
      const absolute = resolvePath(relative);
      await fs.rm(absolute, { recursive: true, force: true });
    }

    res.json({ message: 'Объекты удалены.' });
  })
);

fileApp.get(
  '/api/file',
  asyncHandler(async (req, res) => {
    const requestedPath = req.query.path;
    if (!requestedPath) {
      const error = new Error('Не указан путь.');
      error.status = 400;
      throw error;
    }

    const absolutePath = resolvePath(requestedPath);
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      const error = new Error('Нельзя открыть папку как файл.');
      error.status = 400;
      throw error;
    }

    if (stats.size > MAX_EDITABLE_SIZE) {
      const error = new Error('Файл слишком большой для редактирования через браузер.');
      error.status = 413;
      throw error;
    }

    const content = await fs.readFile(absolutePath, 'utf8');
    res.json({
      path: toPosix(path.relative(ROOT, absolutePath)),
      name: path.basename(absolutePath),
      content,
    });
  })
);

fileApp.put(
  '/api/file',
  asyncHandler(async (req, res) => {
    const { path: targetPath, content } = req.body || {};
    if (!targetPath) {
      const error = new Error('Не указан путь файла.');
      error.status = 400;
      throw error;
    }
    const absolutePath = resolvePath(targetPath);
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      const error = new Error('Нельзя сохранить содержимое папки.');
      error.status = 400;
      throw error;
    }

    await fs.writeFile(absolutePath, content ?? '', 'utf8');
    res.json({ message: 'Файл сохранён.' });
  })
);

fileApp.post(
  '/api/archive',
  asyncHandler(async (req, res) => {
    const { paths, archiveName = 'archive.zip' } = req.body || {};
    if (!Array.isArray(paths) || !paths.length) {
      const error = new Error('Нужно выбрать хотя бы один объект.');
      error.status = 400;
      throw error;
    }

    await streamArchive(res, paths, archiveName.endsWith('.zip') ? archiveName : `${archiveName}.zip`);
  })
);

fileApp.get(
  '/api/download',
  asyncHandler(async (req, res) => {
    const requestedPath = req.query.path;
    if (!requestedPath) {
      const error = new Error('Не указан путь.');
      error.status = 400;
      throw error;
    }
    const absolutePath = resolvePath(requestedPath);
    const stats = await fs.stat(absolutePath);

    if (stats.isDirectory()) {
      const baseName = path.basename(absolutePath) || 'root';
      await streamArchive(res, [requestedPath], `${baseName}.zip`);
    } else {
      const filename = path.basename(absolutePath);
      const contentType = mime.lookup(filename) || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      fsSync.createReadStream(absolutePath).pipe(res);
    }
  })
);

fileApp.use((req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }
  return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

fileApp.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Внутренняя ошибка сервера.';

  if (err.code === 'ENOENT') {
    status = 404;
    message = 'Файл или папка не найдены.';
  }

  console.error(err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(status).json({ message });
});

class TerminalSession {
  constructor({ id, name, ptyProcess }) {
    this.id = id;
    this.name = name;
    this.pty = ptyProcess;
    this.history = '';
    this.status = 'active';
    this.createdAt = new Date();
    this.lastActivity = this.createdAt;
    this.exitCode = null;
    this.exitSignal = null;
    this.cols = DEFAULT_TERMINAL_COLS;
    this.rows = DEFAULT_TERMINAL_ROWS;
  }

  appendOutput(chunk) {
    if (!chunk) {
      return '';
    }
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (!text) {
      return '';
    }
    this.history = (this.history + text).slice(-MAX_TERMINAL_HISTORY);
    this.lastActivity = new Date();
    return text;
  }

  write(data) {
    if (this.status !== 'active') {
      const error = new Error('Сессия завершена.');
      error.status = 409;
      throw error;
    }
    if (typeof data !== 'string' || data.length === 0) {
      return;
    }
    this.lastActivity = new Date();
    this.pty.write(data);
  }

  resize(cols, rows) {
    if (this.status !== 'active') {
      return;
    }
    const safeCols = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : this.cols;
    const safeRows = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : this.rows;
    this.cols = safeCols;
    this.rows = safeRows;
    this.pty.resize(this.cols, this.rows);
  }

  close() {
    try {
      this.pty.kill();
    } catch (error) {
      // ignore
    }
  }

  markClosed({ exitCode, signal }) {
    this.status = 'closed';
    this.exitCode = exitCode;
    this.exitSignal = signal;
    this.lastActivity = new Date();
  }

  serialize() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      cols: this.cols,
      rows: this.rows,
    };
  }

  getHistory() {
    return this.history;
  }
}

class TerminalManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.sequence = 1;
  }

  list() {
    return Array.from(this.sessions.values()).map((session) => session.serialize());
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  ensureSession(id) {
    const session = this.sessions.get(id);
    if (!session) {
      const error = new Error('Сессия не найдена.');
      error.status = 404;
      throw error;
    }
    return session;
  }

  buildShellArgs(shell) {
    const lower = shell.toLowerCase();
    if (lower.includes('powershell')) {
      return ['-NoLogo'];
    }
    const args = [];
    if (lower.includes('bash')) {
      args.push('--noprofile', '--norc');
    }
    args.push('-i');
    return args;
  }

  createSession(name) {
    const id = randomUUID();
    const sessionName = typeof name === 'string' && name.trim() ? name.trim() : `Терминал ${this.sequence++}`;
    const shell = process.env.SHELL || '/bin/bash';
    const args = this.buildShellArgs(shell);
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
      cwd: ROOT,
      env,
    });

    const session = new TerminalSession({ id, name: sessionName, ptyProcess });
    this.sessions.set(id, session);
    this.emit('created', session.serialize());

    ptyProcess.onData((data) => {
      const chunk = session.appendOutput(data);
      if (chunk) {
        this.emit('data', { sessionId: id, data: chunk, session: session.serialize() });
      } else {
        this.emit('state', { sessionId: id, session: session.serialize() });
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.markClosed({ exitCode, signal });
      this.emit('exit', { sessionId: id, session: session.serialize() });
    });

    return session;
  }

  write(id, data) {
    const session = this.ensureSession(id);
    session.write(data);
    this.emit('state', { sessionId: id, session: session.serialize() });
  }

  resize(id, cols, rows) {
    const session = this.ensureSession(id);
    session.resize(cols, rows);
  }

  close(id) {
    const session = this.ensureSession(id);
    session.close();
  }
}

const terminalManager = new TerminalManager();

const terminalApp = express();
terminalApp.use(morgan('dev'));
terminalApp.use(express.json({ limit: '5mb' }));

terminalApp.get(
  '/api/terminals',
  asyncHandler(async (req, res) => {
    res.json({ sessions: terminalManager.list() });
  })
);

terminalApp.post(
  '/api/terminals',
  asyncHandler(async (req, res) => {
    const { name } = req.body || {};
    const session = terminalManager.createSession(name);
    res.status(201).json({ session: session.serialize() });
  })
);

terminalApp.get(
  '/api/terminals/:id/history',
  asyncHandler(async (req, res) => {
    const session = terminalManager.ensureSession(req.params.id);
    res.json({ session: session.serialize(), output: session.getHistory() });
  })
);

terminalApp.post(
  '/api/terminals/:id/close',
  asyncHandler(async (req, res) => {
    terminalManager.close(req.params.id);
    res.json({ message: 'Завершение запрошено.' });
  })
);

terminalApp.use('/api', (req, res) => {
  res.status(404).json({ message: 'Маршрут не найден.' });
});

const terminalStaticPath = path.join(__dirname, '..', 'terminal');
terminalApp.use(express.static(terminalStaticPath));

terminalApp.get('*', (req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    return next();
  }
  return res.sendFile(path.join(terminalStaticPath, 'index.html'));
});

terminalApp.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Ошибка терминального сервера.';
  console.error(err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(status).json({ message });
});

const portsEqual = FILE_PORT === TERMINAL_PORT;
let fileServer;
let terminalServer;
let terminalMountPath = '/';

if (portsEqual) {
  const combinedApp = express();
  terminalMountPath = '/terminal';
  combinedApp.use(terminalMountPath, terminalApp);
  combinedApp.use(fileApp);
  fileServer = http.createServer(combinedApp);
  terminalServer = fileServer;
} else {
  fileServer = http.createServer(fileApp);
  terminalServer = http.createServer(terminalApp);
}

const wsPath = portsEqual ? `${terminalMountPath}/ws` : '/ws';
const wss = new WebSocketServer({ server: terminalServer, path: wsPath });

const clients = new Set();
const sessionSubscriptions = new Map();

const removeClient = (ws) => {
  if (!clients.has(ws)) {
    return;
  }
  clients.delete(ws);
  for (const [sessionId, subscribers] of sessionSubscriptions.entries()) {
    if (subscribers.delete(ws) && subscribers.size === 0) {
      sessionSubscriptions.delete(sessionId);
    }
  }
};

const broadcastAll = (payload) => {
  const message = JSON.stringify(payload);
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
};

const broadcastToSession = (sessionId, payload) => {
  const subscribers = sessionSubscriptions.get(sessionId);
  if (!subscribers || !subscribers.size) {
    return;
  }
  const message = JSON.stringify(payload);
  subscribers.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
};

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.subscriptions = new Set();

  ws.send(
    JSON.stringify({
      type: 'session-list',
      sessions: terminalManager.list(),
    })
  );

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      return;
    }

    if (!message || typeof message !== 'object') {
      return;
    }

    switch (message.type) {
      case 'subscribe': {
        const { sessionId } = message;
        if (!sessionId) {
          break;
        }
        try {
          const session = terminalManager.ensureSession(sessionId);
          if (!ws.subscriptions.has(sessionId)) {
            ws.subscriptions.add(sessionId);
            let set = sessionSubscriptions.get(sessionId);
            if (!set) {
              set = new Set();
              sessionSubscriptions.set(sessionId, set);
            }
            set.add(ws);
          }
          ws.send(
            JSON.stringify({
              type: 'session-history',
              sessionId,
              data: session.getHistory(),
              session: session.serialize(),
            })
          );
        } catch (error) {
          ws.send(
            JSON.stringify({
              type: 'error',
              sessionId,
              message: error.message,
            })
          );
        }
        break;
      }
      case 'unsubscribe': {
        const { sessionId } = message;
        if (!sessionId) {
          break;
        }
        ws.subscriptions.delete(sessionId);
        const set = sessionSubscriptions.get(sessionId);
        if (set) {
          set.delete(ws);
          if (!set.size) {
            sessionSubscriptions.delete(sessionId);
          }
        }
        break;
      }
      case 'input': {
        const { sessionId, data } = message;
        if (!sessionId || typeof data !== 'string') {
          break;
        }
        try {
          terminalManager.write(sessionId, data);
        } catch (error) {
          ws.send(
            JSON.stringify({
              type: 'error',
              sessionId,
              message: error.message,
            })
          );
        }
        break;
      }
      case 'resize': {
        const { sessionId, cols, rows } = message;
        if (!sessionId) {
          break;
        }
        try {
          terminalManager.resize(sessionId, cols, rows);
        } catch (error) {
          ws.send(
            JSON.stringify({
              type: 'error',
              sessionId,
              message: error.message,
            })
          );
        }
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    removeClient(ws);
  });

  ws.on('error', () => {
    removeClient(ws);
  });
});

terminalManager.on('created', (session) => {
  broadcastAll({ type: 'session-created', session });
});

terminalManager.on('data', ({ sessionId, data, session }) => {
  broadcastToSession(sessionId, { type: 'session-output', sessionId, data, session });
  broadcastAll({ type: 'session-state', session });
});

terminalManager.on('state', ({ session }) => {
  broadcastAll({ type: 'session-state', session });
});

terminalManager.on('exit', ({ sessionId, session }) => {
  broadcastToSession(sessionId, { type: 'session-exit', sessionId, session });
  broadcastAll({ type: 'session-state', session });
});

fileServer.listen(FILE_PORT, () => {
  console.log(`🚀 Файловый менеджер запущен: http://localhost:${FILE_PORT}`);
  console.log(`📁 Рабочая директория: ${ROOT}`);
  if (portsEqual) {
    console.log(
      `🖥️ Терминальный интерфейс доступен по общему порту: http://localhost:${TERMINAL_PORT}${terminalMountPath}`
    );
  }
});

if (!portsEqual) {
  terminalServer.listen(TERMINAL_PORT, () => {
    console.log(`🖥️ Терминальный интерфейс доступен: http://localhost:${TERMINAL_PORT}`);
  });
}
