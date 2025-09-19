(() => {
  const state = {
    currentPath: '',
    items: [],
    breadcrumbs: [],
    selected: new Set(),
  };

  const elements = {
    breadcrumbs: document.getElementById('breadcrumbs'),
    tableBody: document.getElementById('tableBody'),
    emptyState: document.getElementById('emptyState'),
    status: document.getElementById('statusMessage'),
    currentPath: document.getElementById('currentPath'),
    loader: document.getElementById('loader'),
    selectAll: document.getElementById('selectAll'),
    refreshBtn: document.getElementById('refreshBtn'),
    upBtn: document.getElementById('upBtn'),
    createFolderBtn: document.getElementById('createFolderBtn'),
    renameBtn: document.getElementById('renameBtn'),
    deleteBtn: document.getElementById('deleteBtn'),
    editBtn: document.getElementById('editBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    archiveBtn: document.getElementById('archiveBtn'),
  };

  const inputModal = createInputModal();
  const confirmModal = createConfirmModal();
  const editorModal = createEditorModal();

  const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  function formatSize(size) {
    if (size === null || size === undefined) return '—';
    const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let value = size;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const formatted = unitIndex === 0 ? value : value.toFixed(value < 10 ? 1 : 0);
    return `${formatted} ${units[unitIndex]}`;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    return dateFormatter.format(date);
  }

  function jsonFetch(url, options = {}) {
    const opts = { ...options };
    opts.headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(url, opts).then(async (response) => {
      const contentType = response.headers.get('Content-Type') || '';
      let payload = null;
      if (contentType.includes('application/json')) {
        payload = await response.json();
      } else {
        payload = await response.text();
      }
      if (!response.ok) {
        const message = payload && payload.message ? payload.message : payload;
        throw new Error(message || 'Ошибка запроса.');
      }
      return payload;
    });
  }

  function setLoading(isLoading) {
    elements.loader.classList.toggle('hidden', !isLoading);
  }

  function showStatus(message, type = 'info') {
    elements.status.textContent = message || '';
    elements.status.classList.remove('success', 'error', 'info');
    if (message) {
      elements.status.classList.add(type);
    }
  }

  function updateCurrentPathDisplay() {
    elements.currentPath.textContent = state.currentPath ? `/${state.currentPath}` : '/';
  }

  function updateSelectAllIndicator() {
    const total = state.items.length;
    const selected = state.selected.size;
    elements.selectAll.checked = total > 0 && selected === total;
    elements.selectAll.indeterminate = selected > 0 && selected < total;
  }

  function renderBreadcrumbs() {
    const crumbs = state.breadcrumbs || [];
    elements.breadcrumbs.innerHTML = '';
    crumbs.forEach((crumb, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = crumb.name || 'Корень';
      button.disabled = index === crumbs.length - 1;
      button.addEventListener('click', () => {
        openDirectory(crumb.path);
      });
      elements.breadcrumbs.appendChild(button);
      if (index < crumbs.length - 1) {
        const separator = document.createElement('span');
        separator.textContent = '/';
        elements.breadcrumbs.appendChild(separator);
      }
    });
  }

  function renderItems() {
    elements.tableBody.innerHTML = '';
    if (!state.items.length) {
      elements.emptyState.classList.remove('hidden');
      elements.tableBody.classList.add('hidden');
      elements.selectAll.checked = false;
      elements.selectAll.indeterminate = false;
      updateActionButtons();
      return;
    }

    elements.emptyState.classList.add('hidden');
    elements.tableBody.classList.remove('hidden');

    state.items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'table-row';
      row.dataset.path = item.path;
      row.classList.add(item.isDirectory ? 'directory' : 'file');
      if (state.selected.has(item.path)) {
        row.classList.add('selected');
      }

      const selectCell = document.createElement('div');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selected.has(item.path);
      checkbox.addEventListener('click', (event) => event.stopPropagation());
      checkbox.addEventListener('change', (event) => {
        if (event.target.checked) {
          state.selected.add(item.path);
        } else {
          state.selected.delete(item.path);
        }
        renderItems();
        updateActionButtons();
      });
      selectCell.appendChild(checkbox);

      const nameCell = document.createElement('div');
      nameCell.className = 'col name';
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = item.isDirectory ? '📂' : '📄';
      const nameButton = document.createElement('button');
      nameButton.type = 'button';
      nameButton.className = 'item-name';
      nameButton.textContent = item.name;
      nameButton.addEventListener('click', (event) => {
        event.stopPropagation();
        if (item.isDirectory) {
          openDirectory(item.path);
        } else {
          openFileEditor(item.path);
        }
      });
      nameCell.append(icon, nameButton);

      const sizeCell = document.createElement('div');
      sizeCell.className = 'col size';
      sizeCell.textContent = item.isDirectory ? '—' : formatSize(item.size);

      const modifiedCell = document.createElement('div');
      modifiedCell.className = 'col modified';
      modifiedCell.textContent = formatDate(item.modifiedAt);

      row.append(selectCell, nameCell, sizeCell, modifiedCell);

      row.addEventListener('click', (event) => {
        if (event.target.tagName === 'BUTTON' || event.target.tagName === 'INPUT') {
          return;
        }
        if (state.selected.has(item.path)) {
          state.selected.delete(item.path);
        } else {
          state.selected.add(item.path);
        }
        renderItems();
        updateActionButtons();
      });

      row.addEventListener('dblclick', () => {
        if (item.isDirectory) {
          openDirectory(item.path);
        } else {
          openFileEditor(item.path);
        }
      });

      elements.tableBody.appendChild(row);
    });

    updateSelectAllIndicator();
    updateActionButtons();
  }

  function getItemByPath(pathValue) {
    return state.items.find((item) => item.path === pathValue);
  }

  function getParentPath(pathValue) {
    if (!pathValue) return null;
    const parts = pathValue.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
  }

  function updateActionButtons() {
    const selection = Array.from(state.selected);
    const selectedItems = selection.map((pathValue) => getItemByPath(pathValue)).filter(Boolean);
    const hasSelection = selection.length > 0;
    const singleSelection = selection.length === 1;
    const singleItem = singleSelection ? selectedItems[0] : null;

    elements.renameBtn.disabled = !singleSelection;
    elements.deleteBtn.disabled = !hasSelection;
    elements.downloadBtn.disabled = !hasSelection;
    elements.archiveBtn.disabled = !hasSelection;
    elements.editBtn.disabled = !singleSelection || !singleItem || singleItem.isDirectory;

    const parentPath = getParentPath(state.currentPath);
    elements.upBtn.disabled = parentPath === null;
  }

  async function loadDirectory(targetPath = '', { silent = false } = {}) {
    if (!silent) {
      setLoading(true);
    }
    try {
      const data = await jsonFetch(`/api/list?path=${encodeURIComponent(targetPath)}`);
      state.currentPath = data.currentPath || '';
      state.items = Array.isArray(data.items) ? data.items : [];
      state.breadcrumbs = Array.isArray(data.breadcrumbs) ? data.breadcrumbs : [];
      state.selected.clear();
      renderBreadcrumbs();
      renderItems();
      updateCurrentPathDisplay();
      if (!silent) {
        showStatus('Каталог обновлён.', 'info');
      }
    } catch (error) {
      if (silent) {
        throw error;
      }
      showStatus(error.message, 'error');
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }

  async function openDirectory(pathValue) {
    await loadDirectory(pathValue || '');
  }

  async function handleCreateFolder() {
    try {
      const name = await inputModal.open({
        title: 'Новая папка',
        label: 'Название папки',
        placeholder: 'Например, проекты',
      });
      setLoading(true);
      await jsonFetch('/api/mkdir', {
        method: 'POST',
        body: { path: state.currentPath, name },
      });
      await loadDirectory(state.currentPath, { silent: true });
      showStatus('Папка создана.', 'success');
    } catch (error) {
      if (error && error.message === 'cancelled') {
        return;
      }
      showStatus(error.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleRename() {
    const [targetPath] = Array.from(state.selected);
    const targetItem = getItemByPath(targetPath);
    if (!targetItem) return;

    try {
      const newName = await inputModal.open({
        title: 'Переименование',
        label: 'Введите новое имя',
        placeholder: targetItem.name,
        defaultValue: targetItem.name,
        submitText: 'Переименовать',
      });
      setLoading(true);
      await jsonFetch('/api/rename', {
        method: 'POST',
        body: { path: targetPath, newName },
      });
      await loadDirectory(state.currentPath, { silent: true });
      showStatus('Имя изменено.', 'success');
    } catch (error) {
      if (error && error.message === 'cancelled') {
        return;
      }
      showStatus(error.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    const paths = Array.from(state.selected);
    const items = paths.map((value) => getItemByPath(value)).filter(Boolean);
    if (!items.length) return;

    const previewNames = items
      .slice(0, 3)
      .map((item) => item.name)
      .join(', ');
    const moreCount = items.length > 3 ? ` и ещё ${items.length - 3}` : '';

    try {
      await confirmModal.open({
        title: 'Удалить объекты',
        message: `Вы действительно хотите удалить: ${previewNames}${moreCount}?`,
        confirmLabel: 'Удалить',
      });
      setLoading(true);
      await jsonFetch('/api/delete', {
        method: 'POST',
        body: { paths },
      });
      await loadDirectory(state.currentPath, { silent: true });
      showStatus('Объекты удалены.', 'success');
    } catch (error) {
      if (error && error.message === 'cancelled') {
        return;
      }
      showStatus(error.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  function triggerDownload(url, filename) {
    const link = document.createElement('a');
    link.href = url;
    if (filename) {
      link.download = filename;
    }
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function downloadSelection(forceArchive = false) {
    const paths = Array.from(state.selected);
    if (!paths.length) return;

    if (paths.length === 1 && !forceArchive) {
      const url = `/api/download?path=${encodeURIComponent(paths[0])}`;
      triggerDownload(url);
      showStatus('Загрузка запущена.', 'info');
      return;
    }

    try {
      setLoading(true);
      const archiveName = paths.length === 1
        ? `${getItemByPath(paths[0])?.name || 'archive'}.zip`
        : `archive-${Date.now()}.zip`;
      const response = await fetch('/api/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, archiveName }),
      });
      if (!response.ok) {
        let errorMessage = 'Не удалось сформировать архив.';
        try {
          const data = await response.json();
          errorMessage = data.message || errorMessage;
        } catch (readError) {
          // пропускаем разбор ошибки
        }
        throw new Error(errorMessage);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      triggerDownload(url, archiveName);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showStatus('Архив готов.', 'success');
    } catch (error) {
      showStatus(error.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function openFileEditor(pathValue) {
    try {
      setLoading(true);
      const file = await jsonFetch(`/api/file?path=${encodeURIComponent(pathValue)}`);
      setLoading(false);
      const content = await editorModal.open({
        title: `Редактирование: ${file.name}`,
        value: file.content,
      });
      setLoading(true);
      await jsonFetch('/api/file', {
        method: 'PUT',
        body: { path: pathValue, content },
      });
      await loadDirectory(state.currentPath, { silent: true });
      showStatus('Файл сохранён.', 'success');
    } catch (error) {
      if (error && error.message === 'cancelled') {
        return;
      }
      showStatus(error.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  function handleSelectAll(event) {
    if (event.target.checked) {
      state.items.forEach((item) => state.selected.add(item.path));
    } else {
      state.selected.clear();
    }
    renderItems();
    updateActionButtons();
  }

  function bindEvents() {
    elements.selectAll.addEventListener('change', handleSelectAll);
    elements.refreshBtn.addEventListener('click', () => loadDirectory(state.currentPath));
    elements.upBtn.addEventListener('click', () => {
      const parent = getParentPath(state.currentPath);
      if (parent !== null) {
        openDirectory(parent);
      }
    });
    elements.createFolderBtn.addEventListener('click', handleCreateFolder);
    elements.renameBtn.addEventListener('click', handleRename);
    elements.deleteBtn.addEventListener('click', handleDelete);
    elements.downloadBtn.addEventListener('click', () => downloadSelection(false));
    elements.archiveBtn.addEventListener('click', () => downloadSelection(true));
    elements.editBtn.addEventListener('click', () => {
      const [pathValue] = Array.from(state.selected);
      if (pathValue) {
        openFileEditor(pathValue);
      }
    });
  }

  async function init() {
    bindEvents();
    await loadDirectory('');
    showStatus('Готово.', 'info');
  }

  init();

  function createInputModal() {
    const modal = document.getElementById('inputModal');
    const form = document.getElementById('inputModalForm');
    const titleEl = document.getElementById('inputModalTitle');
    const labelEl = document.getElementById('inputModalLabel');
    const fieldEl = document.getElementById('inputModalField');
    const submitBtn = form.querySelector('button[type="submit"]');
    const cancelBtn = form.querySelector('button[data-action="cancel"]');

    return {
      open: ({ title, label, placeholder = '', defaultValue = '', submitText = 'Сохранить' }) =>
        new Promise((resolve, reject) => {
          titleEl.textContent = title;
          labelEl.textContent = label;
          fieldEl.value = defaultValue || '';
          fieldEl.placeholder = placeholder || '';
          submitBtn.textContent = submitText || 'Сохранить';
          modal.classList.remove('hidden');
          setTimeout(() => fieldEl.focus(), 10);

          function cleanup() {
            modal.classList.add('hidden');
            form.removeEventListener('submit', handleSubmit);
            cancelBtn.removeEventListener('click', handleCancel);
            document.removeEventListener('keydown', handleKeydown);
          }

          function handleSubmit(event) {
            event.preventDefault();
            const value = fieldEl.value.trim();
            if (!value) {
              fieldEl.focus();
              return;
            }
            cleanup();
            resolve(value);
          }

          function handleCancel() {
            cleanup();
            reject(new Error('cancelled'));
          }

          function handleKeydown(event) {
            if (event.key === 'Escape') {
              handleCancel();
            }
          }

          form.addEventListener('submit', handleSubmit);
          cancelBtn.addEventListener('click', handleCancel);
          document.addEventListener('keydown', handleKeydown);
        }),
    };
  }

  function createConfirmModal() {
    const modal = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmModalTitle');
    const messageEl = document.getElementById('confirmModalMessage');
    const cancelBtn = modal.querySelector('button[data-action="cancel"]');
    const confirmBtn = modal.querySelector('button[data-action="confirm"]');

    return {
      open: ({ title, message, confirmLabel = 'Подтвердить' }) =>
        new Promise((resolve, reject) => {
          titleEl.textContent = title;
          messageEl.textContent = message;
          confirmBtn.textContent = confirmLabel;
          modal.classList.remove('hidden');

          function cleanup() {
            modal.classList.add('hidden');
            confirmBtn.removeEventListener('click', handleConfirm);
            cancelBtn.removeEventListener('click', handleCancel);
            document.removeEventListener('keydown', handleKeydown);
          }

          function handleConfirm() {
            cleanup();
            resolve();
          }

          function handleCancel() {
            cleanup();
            reject(new Error('cancelled'));
          }

          function handleKeydown(event) {
            if (event.key === 'Escape') {
              handleCancel();
            }
          }

          confirmBtn.addEventListener('click', handleConfirm);
          cancelBtn.addEventListener('click', handleCancel);
          document.addEventListener('keydown', handleKeydown);
        }),
    };
  }

  function createEditorModal() {
    const modal = document.getElementById('editorModal');
    const titleEl = document.getElementById('editorModalTitle');
    const textarea = document.getElementById('editorModalField');
    const closeButtons = modal.querySelectorAll('[data-action="close"]');
    const saveButton = modal.querySelector('[data-action="save"]');

    return {
      open: ({ title, value = '' }) =>
        new Promise((resolve, reject) => {
          titleEl.textContent = title;
          textarea.value = value || '';
          modal.classList.remove('hidden');
          setTimeout(() => textarea.focus(), 10);

          function cleanup() {
            modal.classList.add('hidden');
            textarea.value = '';
            saveButton.removeEventListener('click', handleSave);
            closeButtons.forEach((btn) => btn.removeEventListener('click', handleCancel));
            document.removeEventListener('keydown', handleKeydown);
          }

          function handleSave() {
            const result = textarea.value;
            cleanup();
            resolve(result);
          }

          function handleCancel() {
            cleanup();
            reject(new Error('cancelled'));
          }

          function handleKeydown(event) {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              handleSave();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              handleCancel();
            }
          }

          saveButton.addEventListener('click', handleSave);
          closeButtons.forEach((btn) => btn.addEventListener('click', handleCancel));
          document.addEventListener('keydown', handleKeydown);
        }),
    };
  }
})();
