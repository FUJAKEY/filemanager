(() => {
  const state = {
    sessions: new Map(),
    activeId: null,
    socket: null,
    socketReady: false,
    reconnectAttempts: 0,
    subscriptionTargets: new Set(),
    activeSubscriptions: new Set(),
  };

  const BASE_PATH = (() => {
    const rawPath = window.location.pathname.replace(/\/+$/, '') || '/';
    if (rawPath === '/terminal' || rawPath.startsWith('/terminal/')) {
      return '/terminal';
    }
    return '';
  })();

  const withBase = (url) => {
    if (!url) {
      return BASE_PATH || '';
    }
    const normalized = url.startsWith('/') ? url : `/${url}`;
    return `${BASE_PATH}${normalized}` || normalized;
  };

  const elements = {
    newTerminalBtn: document.getElementById('newTerminalBtn'),
    refreshSessionsBtn: document.getElementById('refreshSessionsBtn'),
    terminalList: document.getElementById('terminalList'),
    outputContainer: document.getElementById('terminalOutputContainer'),
    output: document.getElementById('terminalOutput'),
    placeholder: document.getElementById('terminalPlaceholder'),
    inputForm: document.getElementById('inputForm'),
    terminalInput: document.getElementById('terminalInput'),
    sendButton: document.querySelector('#inputForm button[type="submit"]'),
    sendRawBtn: document.getElementById('sendRawBtn'),
    connectionStatus: document.getElementById('connectionStatus'),
    terminalTitle: document.getElementById('terminalTitle'),
    terminalMeta: document.getElementById('terminalMeta'),
    closeTerminalBtn: document.getElementById('closeTerminalBtn'),
    toast: document.getElementById('toast'),
  };

  const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'medium',
  });

  let toastTimer = null;

  const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
  const OSC_PATTERN = /\u001B]([^\u0007]*)(\u0007|\u001B\\)/g;

  function sanitizeChunk(chunk) {
    if (!chunk) return '';
    let text = String(chunk)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(OSC_PATTERN, '')
      .replace(ANSI_PATTERN, '')
      .replace(/\u0007/g, '');

    if (text.includes('\b')) {
      let result = '';
      for (const char of text) {
        if (char === '\b') {
          result = result.slice(0, -1);
        } else {
          result += char;
        }
      }
      text = result;
    }

    return text;
  }

  function showToast(message, type = 'info') {
    if (!message) {
      elements.toast.classList.add('hidden');
      return;
    }
    elements.toast.textContent = message;
    elements.toast.className = `toast ${type}`;
    elements.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      elements.toast.classList.add('hidden');
    }, 4000);
  }

  function setConnectionStatus(text, statusClass = 'status-idle') {
    elements.connectionStatus.textContent = text;
    elements.connectionStatus.className = `connection ${statusClass}`;
  }

  function toDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value) {
    const date = toDate(value);
    if (!date) return '';
    return dateFormatter.format(date);
  }

  function formatSessionMeta(session) {
    if (!session) return '';
    if (session.status === 'closed') {
      const exitDetails =
        typeof session.exitCode === 'number'
          ? `код ${session.exitCode}`
          : session.exitSignal
          ? `сигнал ${session.exitSignal}`
          : 'завершено';
      const when = session.lastActivity ? ` · ${formatDate(session.lastActivity)}` : '';
      return `Завершён (${exitDetails})${when}`;
    }
    const activity = session.lastActivity ? formatDate(session.lastActivity) : null;
    return activity ? `Активен · ${activity}` : 'Активен';
  }

  function updateSessionMeta(target, source) {
    if (!target || !source) return target;
    if (source.name) target.name = source.name;
    if (source.status) target.status = source.status;
    if (Object.prototype.hasOwnProperty.call(source, 'exitCode')) {
      target.exitCode = source.exitCode;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'exitSignal')) {
      target.exitSignal = source.exitSignal;
    }
    const createdAt = toDate(source.createdAt);
    if (createdAt) {
      target.createdAt = createdAt;
    }
    const lastActivity = toDate(source.lastActivity);
    if (lastActivity) {
      target.lastActivity = lastActivity;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'cols')) {
      target.cols = source.cols;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'rows')) {
      target.rows = source.rows;
    }
    return target;
  }

  function upsertSession(raw) {
    if (!raw || !raw.id) return null;
    const existing = state.sessions.get(raw.id);
    const session = existing || {
      id: raw.id,
      output: '',
      historyLoaded: false,
    };

    session.name = raw.name || session.name || raw.id;
    session.status = raw.status || session.status || 'active';
    session.exitCode = Object.prototype.hasOwnProperty.call(raw, 'exitCode')
      ? raw.exitCode
      : session.exitCode ?? null;
    session.exitSignal = Object.prototype.hasOwnProperty.call(raw, 'exitSignal')
      ? raw.exitSignal
      : session.exitSignal ?? null;
    const createdAt = toDate(raw.createdAt);
    if (createdAt) {
      session.createdAt = createdAt;
    } else if (!session.createdAt) {
      session.createdAt = new Date();
    }
    const lastActivity = toDate(raw.lastActivity);
    if (lastActivity) {
      session.lastActivity = lastActivity;
    }
    session.cols = raw.cols ?? session.cols ?? null;
    session.rows = raw.rows ?? session.rows ?? null;

    state.sessions.set(session.id, session);
    return session;
  }

  function renderSessionList() {
    const sessions = Array.from(state.sessions.values()).sort((a, b) => {
      const aTime = toDate(a.createdAt)?.getTime() || 0;
      const bTime = toDate(b.createdAt)?.getTime() || 0;
      return aTime - bTime;
    });

    elements.terminalList.innerHTML = '';

    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'terminal-list-empty';
      empty.textContent = 'Нет активных терминалов. Создайте новый, чтобы начать.';
      elements.terminalList.appendChild(empty);
      return;
    }

    sessions.forEach((session) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'session-item';
      item.dataset.id = session.id;
      if (session.id === state.activeId) {
        item.classList.add('active');
      }
      if (session.status === 'closed') {
        item.classList.add('closed');
      }

      const statusDot = document.createElement('span');
      statusDot.className = `status-dot ${session.status === 'closed' ? 'status-dot--closed' : 'status-dot--active'}`;

      const nameEl = document.createElement('span');
      nameEl.className = 'session-name';
      nameEl.textContent = session.name;

      const metaEl = document.createElement('span');
      metaEl.className = 'session-meta';
      metaEl.textContent = formatSessionMeta(session);

      item.append(statusDot, nameEl, metaEl);
      item.addEventListener('click', () => setActiveSession(session.id));
      elements.terminalList.appendChild(item);
    });
  }

  function renderOutput(session, { forceScroll = false } = {}) {
    const container = elements.outputContainer;
    const shouldStick = forceScroll || isNearBottom();

    if (!session) {
      elements.output.textContent = '';
      elements.placeholder.textContent = 'Создайте новый терминал или выберите его в списке слева.';
      elements.placeholder.classList.remove('hidden');
      if (shouldStick) {
        container.scrollTop = 0;
      }
      return;
    }

    const content = session.output || '';
    elements.output.textContent = content;

    if (!session.historyLoaded) {
      elements.placeholder.textContent = 'История загружается…';
      elements.placeholder.classList.remove('hidden');
    } else if (!content) {
      elements.placeholder.textContent = 'Ожидаем вывод. Введите команду ниже.';
      elements.placeholder.classList.remove('hidden');
    } else {
      elements.placeholder.classList.add('hidden');
    }

    if (shouldStick) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  }

  function isNearBottom() {
    const container = elements.outputContainer;
    const threshold = 48;
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }

  function setActiveSession(sessionId) {
    if (!sessionId || !state.sessions.has(sessionId)) {
      state.activeId = null;
      renderSessionList();
      updatePanel(null);
      renderOutput(null);
      updateInputAvailability();
      return;
    }

    state.activeId = sessionId;
    const session = state.sessions.get(sessionId);
    ensureSubscribed(sessionId);
    renderSessionList();
    updatePanel(session);
    renderOutput(session, { forceScroll: true });
    updateInputAvailability();
  }

  function updatePanel(session) {
    if (!session) {
      elements.terminalTitle.textContent = 'Нет выбранной сессии';
      elements.terminalMeta.textContent = 'Создайте терминал или выберите его в списке слева.';
      return;
    }
    elements.terminalTitle.textContent = session.name;
    if (session.status === 'closed') {
      const exitDetails =
        typeof session.exitCode === 'number'
          ? `код ${session.exitCode}`
          : session.exitSignal
          ? `сигнал ${session.exitSignal}`
          : 'завершено';
      elements.terminalMeta.textContent = `Сессия завершена (${exitDetails}). История доступна для просмотра.`;
    } else {
      const activity = formatDate(session.lastActivity) || 'нет данных';
      elements.terminalMeta.textContent = `Последняя активность: ${activity}`;
    }
  }

  function ensureSubscribed(sessionId) {
    if (!sessionId) return;
    state.subscriptionTargets.add(sessionId);
    if (!state.socketReady || !state.socket || state.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (state.activeSubscriptions.has(sessionId)) {
      return;
    }
    try {
      state.socket.send(JSON.stringify({ type: 'subscribe', sessionId }));
      state.activeSubscriptions.add(sessionId);
    } catch (error) {
      console.error(error);
    }
  }

  function subscribeExistingSessions(force = false) {
    state.subscriptionTargets.forEach((sessionId) => {
      if (force) {
        state.activeSubscriptions.delete(sessionId);
      }
      ensureSubscribed(sessionId);
    });
  }

  function handleSocketMessage(event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      console.error('Ошибка разбора сообщения сокета', error);
      return;
    }

    if (!payload || typeof payload !== 'object') {
      return;
    }

    switch (payload.type) {
      case 'session-list': {
        const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        sessions.forEach((session) => {
          const normalized = upsertSession(session);
          ensureSubscribed(normalized?.id);
        });
        if (!state.activeId && sessions.length) {
          state.activeId = sessions[0].id;
        }
        renderSessionList();
        updatePanel(state.sessions.get(state.activeId) || null);
        renderOutput(state.sessions.get(state.activeId) || null, { forceScroll: true });
        updateInputAvailability();
        break;
      }
      case 'session-created': {
        const session = upsertSession(payload.session);
        if (session) {
          ensureSubscribed(session.id);
          setActiveSession(session.id);
          showToast(`Создан терминал «${session.name}».`, 'success');
        }
        break;
      }
      case 'session-state': {
        const session = upsertSession(payload.session);
        if (session) {
          renderSessionList();
          if (session.id === state.activeId) {
            updatePanel(session);
          }
        }
        break;
      }
      case 'session-output': {
        const session = upsertSession(payload.session || { id: payload.sessionId });
        if (session) {
          updateSessionMeta(session, payload.session);
          const chunk = sanitizeChunk(payload.data);
          session.output = (session.output || '') + chunk;
          session.historyLoaded = true;
          if (session.id === state.activeId) {
            renderOutput(session);
          }
          renderSessionList();
        }
        break;
      }
      case 'session-history': {
        const session = upsertSession(payload.session || { id: payload.sessionId });
        if (session) {
          updateSessionMeta(session, payload.session);
          session.output = sanitizeChunk(payload.data);
          session.historyLoaded = true;
          if (session.id === state.activeId) {
            renderOutput(session, { forceScroll: true });
            updatePanel(session);
          }
          renderSessionList();
        }
        break;
      }
      case 'session-exit': {
        const session = upsertSession(payload.session || { id: payload.sessionId });
        if (session) {
          updateSessionMeta(session, payload.session);
          session.status = 'closed';
          session.historyLoaded = true;
          renderSessionList();
          if (session.id === state.activeId) {
            updatePanel(session);
            renderOutput(session);
            updateInputAvailability();
          }
          showToast(`Терминал «${session.name}» завершил работу.`, 'info');
        }
        break;
      }
      case 'error': {
        if (payload.message) {
          showToast(payload.message, 'error');
        }
        break;
      }
      default:
        break;
    }
  }

  function connectSocket() {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.close();
    }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const endpoint = `${protocol}://${window.location.host}${withBase('/ws')}`;
    setConnectionStatus('Подключаемся к терминальному серверу…', 'status-pending');

    const ws = new WebSocket(endpoint);
    state.socket = ws;

    ws.addEventListener('open', () => {
      state.socketReady = true;
      state.reconnectAttempts = 0;
      state.activeSubscriptions.clear();
      setConnectionStatus('Соединение установлено.', 'status-success');
      subscribeExistingSessions(true);
      updateInputAvailability();
    });

    ws.addEventListener('message', handleSocketMessage);

    ws.addEventListener('close', () => {
      if (state.socket === ws) {
        state.socketReady = false;
      }
      updateInputAvailability();
      setConnectionStatus('Соединение потеряно. Повторяем попытку…', 'status-warning');
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  function scheduleReconnect() {
    state.reconnectAttempts = Math.min(state.reconnectAttempts + 1, 6);
    const delay = Math.min(15000, 1000 * 2 ** (state.reconnectAttempts - 1));
    setTimeout(() => {
      if (!state.socketReady) {
        connectSocket();
      }
    }, delay);
  }

  async function loadSessions() {
    try {
      const response = await fetch(withBase('/api/terminals'));
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Не удалось загрузить список терминалов.');
      }
      const data = await response.json();
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      sessions.forEach((session) => {
        const normalized = upsertSession(session);
        ensureSubscribed(normalized?.id);
      });
      if (!state.activeId && sessions.length) {
        state.activeId = sessions[0].id;
      }
      renderSessionList();
      updatePanel(state.sessions.get(state.activeId) || null);
      renderOutput(state.sessions.get(state.activeId) || null, { forceScroll: true });
      updateInputAvailability();
    } catch (error) {
      console.error(error);
      showToast(error.message, 'error');
    }
  }

  async function handleCreateTerminal() {
    const name = window.prompt('Название терминала (опционально):', '') || undefined;
    try {
      const response = await fetch(withBase('/api/terminals'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Не удалось создать терминал.');
      }
      const data = await response.json();
      const session = upsertSession(data.session);
      if (session) {
        ensureSubscribed(session.id);
        setActiveSession(session.id);
      }
    } catch (error) {
      console.error(error);
      showToast(error.message, 'error');
    }
  }

  async function handleCloseTerminal() {
    const session = state.sessions.get(state.activeId);
    if (!session) {
      return;
    }
    try {
      const response = await fetch(
        withBase(`/api/terminals/${encodeURIComponent(session.id)}/close`),
        {
          method: 'POST',
        }
      );
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Не удалось завершить терминал.');
      }
      showToast('Команда на завершение отправлена.', 'info');
    } catch (error) {
      console.error(error);
      showToast(error.message, 'error');
    }
  }

  function sendInput(value, { appendNewLine = false, allowEmpty = false } = {}) {
    const session = state.sessions.get(state.activeId);
    if (!session) {
      showToast('Сначала выберите терминал.', 'warning');
      return;
    }
    if (!state.socketReady || !state.socket || state.socket.readyState !== WebSocket.OPEN) {
      showToast('Нет соединения с сервером терминала.', 'error');
      return;
    }
    if (!value && !allowEmpty && !appendNewLine) {
      return;
    }
    const payload = value ?? '';
    const data = appendNewLine ? `${payload}\n` : payload;
    try {
      state.socket.send(
        JSON.stringify({
          type: 'input',
          sessionId: session.id,
          data,
        })
      );
      if (appendNewLine && !value) {
        session.historyLoaded = true;
      }
    } catch (error) {
      console.error(error);
      showToast('Не удалось отправить данные в терминал.', 'error');
    }
  }

  function handleInputSubmit(event) {
    event.preventDefault();
    const value = elements.terminalInput.value;
    sendInput(value, { appendNewLine: true, allowEmpty: true });
    elements.terminalInput.value = '';
    autoResizeInput();
  }

  function handleRawSend() {
    const value = elements.terminalInput.value;
    if (!value) {
      return;
    }
    sendInput(value, { appendNewLine: false });
    elements.terminalInput.value = '';
    autoResizeInput();
  }

  function autoResizeInput() {
    const textarea = elements.terminalInput;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(240, textarea.scrollHeight)}px`;
  }

  function handleInputKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      handleInputSubmit(event);
    } else if ((event.key === 'Enter' && event.shiftKey) || event.key === 'Tab') {
      requestAnimationFrame(autoResizeInput);
    }
  }

  function updateInputAvailability() {
    const session = state.sessions.get(state.activeId);
    const disabled = !session || session.status === 'closed' || !state.socketReady;
    elements.terminalInput.disabled = disabled;
    elements.sendButton.disabled = disabled;
    elements.sendRawBtn.disabled = disabled;
    elements.closeTerminalBtn.disabled = !session || session.status === 'closed';
  }

  function bindEvents() {
    elements.newTerminalBtn.addEventListener('click', handleCreateTerminal);
    elements.refreshSessionsBtn.addEventListener('click', loadSessions);
    elements.closeTerminalBtn.addEventListener('click', handleCloseTerminal);
    elements.inputForm.addEventListener('submit', handleInputSubmit);
    elements.sendRawBtn.addEventListener('click', handleRawSend);
    elements.terminalInput.addEventListener('input', autoResizeInput);
    elements.terminalInput.addEventListener('keydown', handleInputKeydown);
  }

  function init() {
    bindEvents();
    autoResizeInput();
    setConnectionStatus('Ожидание подключения…', 'status-idle');
    connectSocket();
    loadSessions();
  }

  init();
})();
