(function () {
  'use strict';

  const { invoke } = window.__TAURI__.core;
  const { getCurrentWindow } = window.__TAURI__.window;
  const appWindow = getCurrentWindow();

  // ── Helpers ──

  function generateId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function formatDate() {
    return new Date().toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });
  }

  function getElapsedSeconds(todo) {
    let total = todo.elapsedSeconds || 0;
    if (todo.timerStartedAt) {
      total += Math.floor((Date.now() - todo.timerStartedAt) / 1000);
    }
    return total;
  }

  function getTodayElapsedSeconds(todo) {
    const logs = todo.timeLogs || [];
    if (logs.length === 0) return 0;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    let total = 0;
    let openStart = null;

    for (const log of logs) {
      if (log.event === 'start') {
        openStart = log.timestamp;
      } else if ((log.event === 'pause' || log.event === 'complete') && openStart != null) {
        const boutStart = Math.max(openStart, todayMs);
        const boutEnd = log.timestamp;
        if (boutEnd > todayMs) {
          total += Math.max(0, boutEnd - boutStart);
        }
        openStart = null;
      }
    }

    // If timer is still running (last event was a start with no close)
    if (openStart != null) {
      const boutStart = Math.max(openStart, todayMs);
      total += Math.max(0, Date.now() - boutStart);
    }

    return Math.floor(total / 1000);
  }

  function getTotalTodaySeconds() {
    return todos.reduce((sum, t) => sum + getTodayElapsedSeconds(t), 0);
  }

  function formatTimer(elapsedSec, estimateMin) {
    const hh = Math.floor(elapsedSec / 3600);
    const mm = Math.floor((elapsedSec % 3600) / 60);
    const elapsed = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

    if (estimateMin != null && estimateMin > 0) {
      const estHh = Math.floor(estimateMin / 60);
      const estMm = estimateMin % 60;
      const estimate = `${String(estHh).padStart(2, '0')}:${String(estMm).padStart(2, '0')}`;
      const overTime = elapsedSec > estimateMin * 60;
      return { text: `${elapsed} / ${estimate}`, overTime };
    }

    return { text: elapsed, overTime: false };
  }

  function parseTimeInput(str) {
    if (!str) return null;
    const trimmed = str.trim();
    if (!trimmed) return null;
    const parts = trimmed.split(':');
    if (parts.length === 2) {
      const hh = parseInt(parts[0], 10) || 0;
      const mm = parseInt(parts[1], 10) || 0;
      const total = hh * 60 + mm;
      return total > 0 ? total : null;
    }
    const val = parseInt(trimmed, 10);
    return val > 0 ? val : null;
  }

  function formatEstimate(minutes) {
    if (minutes == null || minutes <= 0) return '';
    const hh = Math.floor(minutes / 60);
    const mm = minutes % 60;
    return `${hh}:${String(mm).padStart(2, '0')}`;
  }

  function sortSubitemsCompletedLast(todo) {
    if (!todo || !todo.subitems) return;
    const incomplete = todo.subitems.filter(s => !s.completed);
    const completed = todo.subitems.filter(s => s.completed);
    todo.subitems = [...incomplete, ...completed];
    todo.subitems.forEach((s, i) => { s.order = i; });
  }

  // ── State ──

  let todos = [];
  let currentTaskId = null;
  let expandedIds = new Set();
  let isCompactMode = false;
  let timerInterval = null;
  let dragState = null; // pointer-based drag state

  // ── DOM refs (full mode) ──

  const todoInput = document.getElementById('todo-input');
  const estimateInput = document.getElementById('estimate-input');
  const addBtn = document.getElementById('add-btn');
  const todoList = document.getElementById('todo-list');
  const emptyState = document.getElementById('empty-state');
  const footer = document.getElementById('footer');
  const headerDate = document.getElementById('header-date');
  const dayResetBanner = document.getElementById('day-reset-banner');
  const resetClearBtn = document.getElementById('reset-clear');
  const resetKeepBtn = document.getElementById('reset-keep');
  const headerTotalTime = document.getElementById('header-total-time');
  const headerDragHandle = document.getElementById('header-drag-handle');

  // ── DOM refs (compact mode) ──

  const compactDragHandle = document.getElementById('compact-drag-handle');
  const compactTaskCheck = document.getElementById('compact-task-check');
  const compactProgress = document.getElementById('compact-progress');
  const compactProgressFill = document.getElementById('compact-progress-fill');
  const compactTaskTitle = document.getElementById('compact-task-title');
  const compactSubtaskList = document.getElementById('compact-subtask-list');
  const compactTimerEl = document.getElementById('compact-timer');
  const compactPauseBtn = document.getElementById('compact-pause-btn');
  const compactPageBtn = document.getElementById('compact-page-btn');
  const expandToggleBtn = document.getElementById('expand-toggle-btn');

  headerDate.textContent = formatDate();

  // ── Init ──

  async function init() {
    const data = await invoke('load_data');
    todos = data.todos || [];
    currentTaskId = data.currentTaskId || null;
    isCompactMode = data.compactMode || false;

    if (data.todosDate && data.todosDate !== todayStr() && todos.length > 0) {
      dayResetBanner.classList.remove('hidden');
    }

    applyMode(isCompactMode);
    render();
    startTimerDisplay();
  }

  // ══════════════════════════════════════════
  //  MODE SWITCHING
  // ══════════════════════════════════════════

  async function toggleMode(compact) {
    isCompactMode = compact;
    applyMode(compact);
    await invoke('toggle_compact_mode', { compact });
    render();
  }

  function applyMode(compact) {
    document.body.className = compact ? 'mode-compact' : 'mode-full';
  }

  const dailyNotesBtn = document.getElementById('daily-notes-btn');
  dailyNotesBtn.addEventListener('click', () => {
    invoke('open_page_window', { taskId: `daily_${todayStr()}` });
  });

  const allPagesBtn = document.getElementById('all-pages-btn');
  allPagesBtn.addEventListener('click', () => {
    invoke('open_pages_browser');
  });

  expandToggleBtn.addEventListener('click', () => toggleMode(false));

  compactPauseBtn.addEventListener('click', async () => {
    if (currentTaskId) {
      await invoke('close_page_window', { taskId: currentTaskId });
      await invoke('set_in_progress', { todoId: null });
      const data = await invoke('load_data');
      todos = data.todos;
      currentTaskId = data.currentTaskId;
    }
    await toggleMode(false);
  });

  compactPageBtn.addEventListener('click', () => {
    if (currentTaskId) {
      invoke('open_page_window', { taskId: currentTaskId });
    }
  });

  // ── Header drag (full mode) ──

  headerDragHandle.addEventListener('mousedown', (e) => {
    if (e.target.closest('.mode-toggle-btn')) return;
    appWindow.startDragging();
  });

  // ── Compact drag ──

  compactDragHandle.addEventListener('mousedown', (e) => {
    if (e.target.closest('.compact-btn')) return;
    appWindow.startDragging();
  });

  // ══════════════════════════════════════════
  //  TIMER DISPLAY
  // ══════════════════════════════════════════

  function startTimerDisplay() {
    clearInterval(timerInterval);
    timerInterval = setInterval(updateTimerDisplay, 1000);
  }

  function updateTimerDisplay() {
    const task = todos.find(t => t.id === currentTaskId);
    if (!task || !task.timerStartedAt) return;

    const elapsed = getElapsedSeconds(task);
    const { text, overTime } = formatTimer(elapsed, task.estimatedMinutes);

    // Update compact timer
    if (compactTimerEl) {
      compactTimerEl.textContent = text;
      compactTimerEl.classList.toggle('over-time', overTime);
    }

    // Update full mode timer
    const fullTimer = document.querySelector('.todo-item.in-progress .timer-display');
    if (fullTimer) {
      fullTimer.textContent = text;
      fullTimer.classList.toggle('over-time', overTime);
    }

    // Update header total time
    updateHeaderTotalTime();
  }

  function updateHeaderTotalTime() {
    const totalSec = getTotalTodaySeconds();
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    headerTotalTime.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  // ══════════════════════════════════════════
  //  DAY RESET
  // ══════════════════════════════════════════

  resetClearBtn.addEventListener('click', async () => {
    // Close page windows for all tasks before archiving
    for (const todo of todos) {
      await invoke('close_page_window', { taskId: todo.id });
    }
    await invoke('archive_todos', { mode: 'clear' });
    todos = [];
    currentTaskId = null;
    dayResetBanner.classList.add('hidden');
    render();
  });

  resetKeepBtn.addEventListener('click', async () => {
    // Close page windows for completed tasks before archiving
    for (const todo of todos) {
      if (todo.completed) {
        await invoke('close_page_window', { taskId: todo.id });
      }
    }
    await invoke('archive_todos', { mode: 'keep' });
    const data = await invoke('load_data');
    todos = data.todos;
    currentTaskId = data.currentTaskId;
    dayResetBanner.classList.add('hidden');
    render();
  });

  // ══════════════════════════════════════════
  //  ADD TODO
  // ══════════════════════════════════════════

  addBtn.addEventListener('click', addTodo);
  todoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTodo();
  });
  estimateInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTodo();
  });

  async function addTodo() {
    const title = todoInput.value.trim();
    if (!title) return;

    const estimatedMinutes = parseTimeInput(estimateInput.value);

    todos.push({
      id: generateId('todo'),
      title,
      completed: false,
      inProgress: false,
      createdAt: Date.now(),
      order: todos.length,
      subitems: [],
      estimatedMinutes: (estimatedMinutes && estimatedMinutes > 0) ? estimatedMinutes : null,
      elapsedSeconds: 0,
      timerStartedAt: null,
    });

    todoInput.value = '';
    estimateInput.value = '';
    await invoke('save_todos', { todos, currentTaskId });
    render();
    todoInput.focus();
  }

  // ══════════════════════════════════════════
  //  TASK OPERATIONS
  // ══════════════════════════════════════════

  async function toggleComplete(todoId) {
    const todo = todos.find(t => t.id === todoId);
    if (!todo) return;

    if (!todo.completed && todo.id === currentTaskId) {
      // Completing the in-progress task — close page, use backend for timer handling
      await invoke('close_page_window', { taskId: todoId });
      await invoke('complete_task', { taskId: todoId });
      const data = await invoke('load_data');
      todos = data.todos;
      currentTaskId = data.currentTaskId;
      render();
      return;
    }

    todo.completed = !todo.completed;
    if (todo.completed && todo.inProgress) {
      todo.inProgress = false;
      currentTaskId = null;
    }

    await invoke('save_todos', { todos, currentTaskId });
    render();
  }

  async function markInProgress(todoId) {
    if (currentTaskId === todoId) {
      // Toggle off (pause) — close page
      await invoke('close_page_window', { taskId: todoId });
      const todo = todos.find(t => t.id === todoId);
      if (todo) todo.inProgress = false;
      currentTaskId = null;
      await invoke('set_in_progress', { todoId: null });
      const data = await invoke('load_data');
      todos = data.todos;
      currentTaskId = data.currentTaskId;
      render();
    } else {
      // Switch to new task — close old page, open new page
      if (currentTaskId) {
        await invoke('close_page_window', { taskId: currentTaskId });
      }
      todos.forEach(t => { t.inProgress = false; });
      const todo = todos.find(t => t.id === todoId);
      if (!todo) return;
      todo.inProgress = true;
      currentTaskId = todoId;
      await invoke('set_in_progress', { todoId });
      const data = await invoke('load_data');
      todos = data.todos;
      currentTaskId = data.currentTaskId;
      // Auto-open page for the new task
      await invoke('open_page_window', { taskId: todoId });
      // Auto-switch to compact view
      await toggleMode(true);
    }
  }

  async function deleteTodo(todoId) {
    const idx = todos.findIndex(t => t.id === todoId);
    if (idx === -1) return;

    // Close and delete page
    await invoke('delete_page', { taskId: todoId });

    if (todos[idx].inProgress) {
      currentTaskId = null;
    }

    todos.splice(idx, 1);
    expandedIds.delete(todoId);
    await invoke('save_todos', { todos, currentTaskId });
    render();
  }

  function toggleExpand(todoId) {
    if (expandedIds.has(todoId)) {
      expandedIds.delete(todoId);
    } else {
      expandedIds.add(todoId);
    }
    render();
  }

  // ── Subitem operations ──

  async function addSubitem(todoId, title, estimateStr) {
    const todo = todos.find(t => t.id === todoId);
    if (!todo || !title.trim()) return;

    const estimatedMinutes = parseTimeInput(estimateStr);
    todo.subitems.push({
      id: generateId('sub'),
      title: title.trim(),
      completed: false,
      order: todo.subitems.length,
      estimatedMinutes: estimatedMinutes,
    });

    await invoke('save_todos', { todos, currentTaskId });
    if (isCompactMode) {
      await invoke('resize_compact');
    }
    render();

    const input = document.querySelector(`[data-subinput="${todoId}"]`);
    if (input) input.focus();
  }

  async function deleteSubitem(todoId, subitemId) {
    const todo = todos.find(t => t.id === todoId);
    if (!todo) return;

    todo.subitems = todo.subitems.filter(s => s.id !== subitemId);
    await invoke('save_todos', { todos, currentTaskId });
    if (isCompactMode) {
      await invoke('resize_compact');
    }
    render();
  }

  async function toggleSubitem(todoId, subitemId) {
    const todo = todos.find(t => t.id === todoId);
    if (!todo) return;
    const sub = todo.subitems.find(s => s.id === subitemId);
    if (!sub) return;
    sub.completed = !sub.completed;
    sortSubitemsCompletedLast(todo);
    await invoke('save_todos', { todos, currentTaskId });
    render();
  }

  async function setEstimate(todoId, minutes) {
    const todo = todos.find(t => t.id === todoId);
    if (!todo) return;
    todo.estimatedMinutes = minutes;
    await invoke('set_estimate', { taskId: todoId, minutes });
  }

  // ══════════════════════════════════════════
  //  DRAG AND DROP — POINTER-BASED
  // ══════════════════════════════════════════

  function setupTaskDragAndDrop() {
    // Task drag is initiated from the grip handle via pointerdown in render()
    // This function just needs to exist for the init call
  }

  function removeDropIndicators() {
    document.querySelectorAll('.drop-indicator, .sub-drop-indicator').forEach(el => el.remove());
  }

  function getInsertIndex(container, y, selector) {
    const elements = [...container.querySelectorAll(selector)];
    for (let i = 0; i < elements.length; i++) {
      const box = elements[i].getBoundingClientRect();
      if (y < box.top + box.height / 2) {
        return { index: i, beforeEl: elements[i] };
      }
    }
    return { index: elements.length, beforeEl: null };
  }

  function initPointerDrag(e, sourceEl, type, id, parentId) {
    e.preventDefault();
    e.stopPropagation();

    const rect = sourceEl.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    let hasMoved = false;
    const startX = e.clientX;
    const startY = e.clientY;

    // Create floating clone
    const ghost = sourceEl.cloneNode(true);
    ghost.style.position = 'fixed';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.style.width = rect.width + 'px';
    ghost.style.zIndex = '9999';
    ghost.style.opacity = '0.85';
    ghost.style.pointerEvents = 'none';
    ghost.style.boxShadow = '0 4px 16px rgba(0,0,0,0.15)';
    ghost.style.borderRadius = '8px';
    ghost.style.background = type.includes('compact') ? 'rgba(255,255,255,0.96)' : '#fff';
    ghost.style.transition = 'none';
    ghost.classList.add('drag-ghost');

    const placeholder = document.createElement('div');
    placeholder.className = 'drop-indicator';

    function onPointerMove(ev) {
      if (!hasMoved) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        hasMoved = true;
        document.body.appendChild(ghost);
        sourceEl.classList.add('dragging');
      }

      ghost.style.left = (ev.clientX - offsetX) + 'px';
      ghost.style.top = (ev.clientY - offsetY) + 'px';

      // Show drop indicator
      removeDropIndicators();
      if (type === 'todo') {
        const items = [...todoList.querySelectorAll('.todo-item:not(.dragging)')];
        let inserted = false;
        for (const item of items) {
          const box = item.getBoundingClientRect();
          if (ev.clientY < box.top + box.height / 2) {
            todoList.insertBefore(placeholder, item);
            inserted = true;
            break;
          }
        }
        if (!inserted) {
          todoList.appendChild(placeholder);
        }
      } else if (type === 'subitem') {
        const subSection = sourceEl.closest('.subitems-section');
        if (!subSection) return;
        const subs = [...subSection.querySelectorAll('.subitem:not(.dragging)')];
        let inserted = false;
        for (const sub of subs) {
          const box = sub.getBoundingClientRect();
          if (ev.clientY < box.top + box.height / 2) {
            subSection.insertBefore(placeholder, sub);
            inserted = true;
            break;
          }
        }
        if (!inserted) {
          const addDiv = subSection.querySelector('.add-subitem');
          if (addDiv) {
            subSection.insertBefore(placeholder, addDiv);
          } else {
            subSection.appendChild(placeholder);
          }
        }
        placeholder.className = 'sub-drop-indicator';
      } else if (type === 'compact-subitem') {
        const container = compactSubtaskList;
        const subs = [...container.querySelectorAll('.compact-sub:not(.dragging)')];
        let inserted = false;
        for (const sub of subs) {
          const box = sub.getBoundingClientRect();
          if (ev.clientY < box.top + box.height / 2) {
            container.insertBefore(placeholder, sub);
            inserted = true;
            break;
          }
        }
        if (!inserted) {
          container.appendChild(placeholder);
        }
        placeholder.className = 'sub-drop-indicator';
      }
    }

    async function onPointerUp(ev) {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);

      if (!hasMoved) return;

      ghost.remove();
      sourceEl.classList.remove('dragging');
      removeDropIndicators();

      if (type === 'todo') {
        // Figure out new position among non-completed tasks
        const items = [...todoList.querySelectorAll('.todo-item:not(.dragging)')];
        const { index } = getInsertIndex(todoList, ev.clientY, '.todo-item:not(.dragging)');

        // Get the visible order (excluding the dragged item)
        const sortedTodos = [...todos].sort((a, b) => {
          if (a.completed === b.completed) return 0;
          return a.completed ? 1 : -1;
        });
        const visibleIds = sortedTodos.filter(t => t.id !== id).map(t => t.id);
        const clampedIdx = Math.min(index, visibleIds.length);
        visibleIds.splice(clampedIdx, 0, id);

        // Now rebuild the todos array in this new visual order
        const reordered = [];
        visibleIds.forEach((tid, idx) => {
          const todo = todos.find(t => t.id === tid);
          if (todo) {
            todo.order = idx;
            reordered.push(todo);
          }
        });
        todos = reordered;

        await invoke('reorder_todos', { todoIds: todos.map(t => t.id) });
        render();
      } else if (type === 'subitem' && parentId) {
        const todo = todos.find(t => t.id === parentId);
        if (!todo) return;

        const subSection = sourceEl.closest('.subitems-section');
        if (!subSection) return;
        const { index } = getInsertIndex(subSection, ev.clientY, '.subitem:not(.dragging)');

        const subIds = todo.subitems.filter(s => s.id !== id).map(s => s.id);
        const clampedIdx = Math.min(index, subIds.length);
        subIds.splice(clampedIdx, 0, id);

        const reordered = [];
        subIds.forEach((sid, idx) => {
          const sub = todo.subitems.find(s => s.id === sid);
          if (sub) {
            sub.order = idx;
            reordered.push(sub);
          }
        });
        todo.subitems = reordered;

        await invoke('reorder_subitems', { taskId: parentId, subitemIds: subIds });
        render();
      } else if (type === 'compact-subitem' && parentId) {
        const todo = todos.find(t => t.id === parentId);
        if (!todo) return;

        const container = compactSubtaskList;
        const { index } = getInsertIndex(container, ev.clientY, '.compact-sub:not(.dragging)');

        const subIds = todo.subitems.filter(s => s.id !== id).map(s => s.id);
        const clampedIdx = Math.min(index, subIds.length);
        subIds.splice(clampedIdx, 0, id);

        const reordered = [];
        subIds.forEach((sid, idx) => {
          const sub = todo.subitems.find(s => s.id === sid);
          if (sub) {
            sub.order = idx;
            reordered.push(sub);
          }
        });
        todo.subitems = reordered;

        await invoke('reorder_subitems', { taskId: parentId, subitemIds: subIds });
        await invoke('resize_compact');
        renderCompact();
      }
    }

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }

  // ══════════════════════════════════════════
  //  SVG ICONS
  // ══════════════════════════════════════════

  const clockSvg = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M6 3v3.5l2 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const chevronSvg = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
  const playSvg = '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M4 2.5l7 4.5-7 4.5V2.5z" fill="currentColor"/></svg>';
  const pauseSvg = '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="3" y="2" width="3" height="10" rx="0.5" fill="currentColor"/><rect x="8" y="2" width="3" height="10" rx="0.5" fill="currentColor"/></svg>';
  const deleteSvg = '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M4 4l6 6M10 4l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const pageSvg = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4 1h4l4 4v7a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><path d="M8 1v4h4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.5 8h3M5.5 10h2" stroke="currentColor" stroke-width="0.9" stroke-linecap="round"/></svg>';
  const gripDots = '<span></span><span></span><span></span><span></span><span></span><span></span>';
  const subGripDots = '<span></span><span></span><span></span><span></span>';

  // ══════════════════════════════════════════
  //  RENDER (FULL MODE)
  // ══════════════════════════════════════════

  function render() {
    if (isCompactMode) {
      renderCompact();
      return;
    }

    todoList.innerHTML = '';

    if (todos.length === 0) {
      emptyState.classList.remove('hidden');
      footer.classList.add('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    // Sort: incomplete tasks first, completed tasks at bottom (preserve order within each group)
    const sortedTodos = [...todos].sort((a, b) => {
      if (a.completed === b.completed) return 0;
      return a.completed ? 1 : -1;
    });

    sortedTodos.forEach(todo => {
      const isExpanded = expandedIds.has(todo.id);
      const isInProgress = todo.id === currentTaskId;

      const item = document.createElement('div');
      item.className = 'todo-item' + (todo.completed ? ' completed' : '') + (isInProgress ? ' in-progress' : '');
      item.setAttribute('data-todo-id', todo.id);

      const main = document.createElement('div');
      main.className = 'todo-main';

      // Drag grip — initiates pointer-based drag
      const grip = document.createElement('div');
      grip.className = 'drag-grip';
      grip.innerHTML = gripDots;
      grip.addEventListener('pointerdown', (e) => {
        initPointerDrag(e, item, 'todo', todo.id, null);
      });

      // Expand button
      const expandBtn = document.createElement('button');
      expandBtn.className = 'expand-btn' + (isExpanded ? ' expanded' : '');
      expandBtn.innerHTML = chevronSvg;
      expandBtn.title = isExpanded ? 'Collapse' : 'Expand';
      expandBtn.addEventListener('click', () => toggleExpand(todo.id));

      // Checkbox
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'todo-checkbox';
      checkbox.checked = todo.completed;
      checkbox.addEventListener('change', () => toggleComplete(todo.id));

      // Title (double-click to edit)
      const title = document.createElement('span');
      title.className = 'todo-title';
      title.textContent = todo.title;

      title.addEventListener('dblclick', () => {
        if (todo.completed) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'todo-title-edit';
        input.value = todo.title;
        title.replaceWith(input);
        input.focus();
        input.select();

        let saved = false;
        const save = async () => {
          if (saved) return;
          saved = true;
          const newTitle = input.value.trim();
          if (newTitle && newTitle !== todo.title) {
            todo.title = newTitle;
            await invoke('save_todos', { todos, currentTaskId });
          }
          render();
        };

        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
          }
          if (e.key === 'Escape') {
            input.value = todo.title;
            input.blur();
          }
        });
      });

      // Actions container
      const actions = document.createElement('div');
      actions.className = 'todo-actions';

      // Timer display for in-progress task
      if (isInProgress && !todo.completed) {
        const timerEl = document.createElement('span');
        timerEl.className = 'timer-display';
        const elapsed = getElapsedSeconds(todo);
        const { text, overTime } = formatTimer(elapsed, todo.estimatedMinutes);
        timerEl.textContent = text;
        if (overTime) timerEl.classList.add('over-time');
        actions.appendChild(timerEl);
      }

      // Estimate badge (when not in progress but has estimate)
      if (!isInProgress && todo.estimatedMinutes && !todo.completed) {
        const badge = document.createElement('span');
        badge.className = 'estimate-badge';
        badge.textContent = formatEstimate(todo.estimatedMinutes);
        actions.appendChild(badge);
      }

      // Page button
      const pageBtn = document.createElement('button');
      pageBtn.className = 'action-btn page-btn';
      pageBtn.innerHTML = pageSvg;
      pageBtn.title = 'Open page';
      pageBtn.addEventListener('click', () => {
        invoke('open_page_window', { taskId: todo.id });
      });
      actions.appendChild(pageBtn);

      // Play/pause button
      if (!todo.completed) {
        const playBtn = document.createElement('button');
        playBtn.className = 'action-btn play-btn' + (isInProgress ? ' active' : '');
        playBtn.innerHTML = isInProgress ? pauseSvg : playSvg;
        playBtn.title = isInProgress ? 'Stop focusing' : 'Focus on this';
        playBtn.addEventListener('click', () => markInProgress(todo.id));
        actions.appendChild(playBtn);
      }

      // Delete button moved to detail section

      main.appendChild(grip);
      main.appendChild(expandBtn);
      main.appendChild(checkbox);
      main.appendChild(title);
      main.appendChild(actions);
      item.appendChild(main);

      // ── Card progress bar (subtask completion) ──
      if (todo.subitems && todo.subitems.length > 0) {
        const cardProgress = document.createElement('div');
        cardProgress.className = 'card-progress';
        const cardFill = document.createElement('div');
        cardFill.className = 'card-progress-fill';
        const done = todo.subitems.filter(s => s.completed).length;
        const pct = Math.round((done / todo.subitems.length) * 100);
        cardFill.style.width = pct + '%';
        cardProgress.appendChild(cardFill);
        item.appendChild(cardProgress);
      }

      // ── Detail section ──
      const detail = document.createElement('div');
      detail.className = 'todo-detail' + (isExpanded ? ' visible' : '');

      // Estimate editor
      if (!todo.completed) {
        const estRow = document.createElement('div');
        estRow.className = 'estimate-row';

        const estLabel = document.createElement('span');
        estLabel.className = 'estimate-label';
        estLabel.textContent = 'Estimate';

        const estField = document.createElement('div');
        estField.className = 'estimate-field sm';
        estField.innerHTML = clockSvg;
        const estInput = document.createElement('input');
        estInput.type = 'text';
        estInput.placeholder = '0:00';
        estInput.value = todo.estimatedMinutes ? formatEstimate(todo.estimatedMinutes) : '';
        estInput.addEventListener('change', () => {
          const mins = parseTimeInput(estInput.value);
          setEstimate(todo.id, mins);
        });
        estField.appendChild(estInput);

        estRow.appendChild(estLabel);
        estRow.appendChild(estField);
        detail.appendChild(estRow);
      }

      // Subitems
      const subSection = document.createElement('div');
      subSection.className = 'subitems-section';

      todo.subitems.forEach(sub => {
        const subEl = document.createElement('div');
        subEl.className = 'subitem' + (sub.completed ? ' completed' : '');
        subEl.setAttribute('data-sub-id', sub.id);

        // Sub drag grip — initiates pointer-based drag
        const subGrip = document.createElement('div');
        subGrip.className = 'sub-drag-grip';
        subGrip.innerHTML = subGripDots;
        subGrip.addEventListener('pointerdown', (e) => {
          initPointerDrag(e, subEl, 'subitem', sub.id, todo.id);
        });

        const subCheck = document.createElement('input');
        subCheck.type = 'checkbox';
        subCheck.className = 'subitem-checkbox';
        subCheck.checked = sub.completed;
        subCheck.addEventListener('change', () => toggleSubitem(todo.id, sub.id));

        // Subtask title (double-click to edit)
        const subTitle = document.createElement('span');
        subTitle.className = 'subitem-title';
        subTitle.textContent = sub.title;

        subTitle.addEventListener('dblclick', () => {
          if (sub.completed) return;
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'subitem-title-edit';
          input.value = sub.title;
          subTitle.replaceWith(input);
          input.focus();
          input.select();

          let saved = false;
          const save = async () => {
            if (saved) return;
            saved = true;
            const newTitle = input.value.trim();
            if (newTitle && newTitle !== sub.title) {
              sub.title = newTitle;
              await invoke('save_todos', { todos, currentTaskId });
            }
            render();
          };

          input.addEventListener('blur', save);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              input.blur();
            }
            if (e.key === 'Escape') {
              input.value = sub.title;
              input.blur();
            }
          });
        });

        subEl.appendChild(subGrip);
        subEl.appendChild(subCheck);
        subEl.appendChild(subTitle);

        // Subtask estimate badge
        if (sub.estimatedMinutes && !sub.completed) {
          const subBadge = document.createElement('span');
          subBadge.className = 'estimate-badge';
          subBadge.textContent = formatEstimate(sub.estimatedMinutes);
          subEl.appendChild(subBadge);
        }

        const subDel = document.createElement('button');
        subDel.className = 'subitem-delete';
        subDel.innerHTML = '&times;';
        subDel.title = 'Remove';
        subDel.addEventListener('click', () => deleteSubitem(todo.id, sub.id));
        subEl.appendChild(subDel);
        subSection.appendChild(subEl);
      });

      // Add subitem input
      const addSubDiv = document.createElement('div');
      addSubDiv.className = 'add-subitem';

      const subInput = document.createElement('input');
      subInput.type = 'text';
      subInput.placeholder = 'Add a subtask...';
      subInput.setAttribute('data-subinput', todo.id);

      const subEstField = document.createElement('div');
      subEstField.className = 'estimate-field sm';
      subEstField.innerHTML = clockSvg;
      const subEstInput = document.createElement('input');
      subEstInput.type = 'text';
      subEstInput.placeholder = '0:00';
      subEstField.appendChild(subEstInput);

      const doAddSub = () => {
        addSubitem(todo.id, subInput.value, subEstInput.value);
        subInput.value = '';
        subEstInput.value = '';
      };

      subInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doAddSub();
      });
      subEstInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doAddSub();
      });

      const subAddBtn = document.createElement('button');
      subAddBtn.textContent = 'Add';
      subAddBtn.addEventListener('click', doAddSub);

      addSubDiv.appendChild(subInput);
      addSubDiv.appendChild(subEstField);
      addSubDiv.appendChild(subAddBtn);
      subSection.appendChild(addSubDiv);
      detail.appendChild(subSection);

      const deleteRow = document.createElement('div');
      deleteRow.className = 'detail-delete-row';
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'detail-delete-btn';
      deleteBtn.innerHTML = deleteSvg + ' Delete task';
      deleteBtn.addEventListener('click', () => deleteTodo(todo.id));
      deleteRow.appendChild(deleteBtn);
      detail.appendChild(deleteRow);

      item.appendChild(detail);
      todoList.appendChild(item);
    });

    // Footer
    const completed = todos.filter(t => t.completed).length;
    if (todos.length > 0) {
      footer.textContent = `${completed} of ${todos.length} task${todos.length !== 1 ? 's' : ''} complete`;
      footer.classList.remove('hidden');
    } else {
      footer.classList.add('hidden');
    }

    // Header total time
    updateHeaderTotalTime();
  }

  // ══════════════════════════════════════════
  //  RENDER (COMPACT MODE)
  // ══════════════════════════════════════════

  function renderCompact() {
    const task = todos.find(t => t.id === currentTaskId && !t.completed);

    if (!task) {
      compactTaskTitle.textContent = 'No active task';
      compactTaskTitle.classList.add('no-task');
      compactTaskCheck.style.display = 'none';
      compactSubtaskList.innerHTML = '';
      compactTimerEl.textContent = '';
      compactProgress.style.display = 'none';
      return;
    }

    compactTaskTitle.textContent = task.title;
    compactTaskTitle.classList.remove('no-task');
    compactTaskCheck.style.display = '';
    compactTaskCheck.checked = false;

    // Timer
    const elapsed = getElapsedSeconds(task);
    const { text, overTime } = formatTimer(elapsed, task.estimatedMinutes);
    compactTimerEl.textContent = text;
    compactTimerEl.classList.toggle('over-time', overTime);

    // Progress bar (based on subtask completion)
    if (task.subitems && task.subitems.length > 0) {
      const done = task.subitems.filter(s => s.completed).length;
      const pct = Math.round((done / task.subitems.length) * 100);
      compactProgress.style.display = '';
      compactProgressFill.style.width = pct + '%';
    } else {
      compactProgress.style.display = 'none';
    }

    // Subtasks
    compactSubtaskList.innerHTML = '';
    if (task.subitems && task.subitems.length > 0) {
      task.subitems.forEach(sub => {
        const row = document.createElement('div');
        row.className = 'compact-sub' + (sub.completed ? ' done' : '');
        row.setAttribute('data-sub-id', sub.id);

        // Drag grip for compact subtasks
        const grip = document.createElement('div');
        grip.className = 'compact-sub-grip';
        grip.innerHTML = subGripDots;
        grip.addEventListener('pointerdown', (e) => {
          initPointerDrag(e, row, 'compact-subitem', sub.id, task.id);
        });

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = sub.completed;
        cb.addEventListener('change', async () => {
          sub.completed = !sub.completed;
          sortSubitemsCompletedLast(task);
          await invoke('save_todos', { todos, currentTaskId });
          await invoke('resize_compact');
          renderCompact();
        });

        const titleSpan = document.createElement('span');
        titleSpan.className = 'compact-sub-text';
        titleSpan.textContent = sub.title;

        row.appendChild(grip);
        row.appendChild(cb);
        row.appendChild(titleSpan);

        // Show time estimate for subtask
        if (sub.estimatedMinutes && !sub.completed) {
          const badge = document.createElement('span');
          badge.className = 'estimate-badge';
          badge.textContent = formatEstimate(sub.estimatedMinutes);
          row.appendChild(badge);
        }

        compactSubtaskList.appendChild(row);
      });
      compactSubtaskList.style.display = 'flex';
    } else {
      compactSubtaskList.style.display = 'none';
    }
  }

  // ── Compact complete — auto-expand to full view ──

  compactTaskCheck.addEventListener('change', async () => {
    if (currentTaskId) {
      await invoke('close_page_window', { taskId: currentTaskId });
      await invoke('complete_task', { taskId: currentTaskId });
      const data = await invoke('load_data');
      todos = data.todos;
      currentTaskId = data.currentTaskId;
      // Switch back to full mode after completing a task in compact view
      await toggleMode(false);
    }
  });

  // ── Setup and go ──

  setupTaskDragAndDrop();
  init();
})();
