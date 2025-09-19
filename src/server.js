const express = require('express');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const archiver = require('archiver');
const mime = require('mime-types');

const app = express();
const PORT = process.env.PORT || 5000;
const ROOT = process.env.FILE_MANAGER_ROOT
  ? path.resolve(process.env.FILE_MANAGER_ROOT)
  : path.resolve(process.cwd(), 'storage');

if (!fsSync.existsSync(ROOT)) {
  fsSync.mkdirSync(ROOT, { recursive: true });
}

const MAX_EDITABLE_SIZE = 2 * 1024 * 1024; // 2 MB

app.use(morgan('dev'));
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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

app.get(
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

app.post(
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

app.post(
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

app.post(
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

app.get(
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

app.put(
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

app.post(
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

app.get(
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

app.use((req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
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

app.listen(PORT, () => {
  console.log(`🚀 Файловый менеджер запущен: http://localhost:${PORT}`);
  console.log(`📁 Рабочая директория: ${ROOT}`);
});
