(function () {
  'use strict';

  const { invoke } = window.__TAURI__.core;
  const { getCurrentWindow, LogicalSize } = window.__TAURI__.window;
  const appWindow = getCurrentWindow();

  async function resizeCompactToContent() {
    if (!isCompactMode) return;
    const el = document.querySelector('.compact-mode-container');
    if (!el) return;
    const height = el.scrollHeight;
    await appWindow.setSize(new LogicalSize(340, height));
  }

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
      weekday: 'short', month: 'short', day: 'numeric'
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
  let activeView = 'today'; // 'today' or 'all'
  let collapsedProjects = new Set();
  let knownProjects = [];
  let currentProjectOrder = []; // tracks project display order for drag

  function syncProjects() {
    knownProjects = [...new Set(todos.map(t => t.project).filter(Boolean))];
  }

  // ── DOM refs (full mode) ──

  const addBtn = document.getElementById('add-btn');
  const todoList = document.getElementById('todo-list');
  const emptyState = document.getElementById('empty-state');
  const footer = document.getElementById('footer');
  const headerDate = document.getElementById('header-date');
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

  // ── View Switcher ──

  const viewSwitcher = document.getElementById('view-switcher');
  viewSwitcher.addEventListener('click', (e) => {
    const tab = e.target.closest('.view-tab');
    if (!tab || tab.dataset.view === activeView) return;
    activeView = tab.dataset.view;
    viewSwitcher.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t === tab));
    render();
  });

  // ── Init ──

  async function init() {
    const data = await invoke('load_data');
    todos = data.todos || [];
    currentTaskId = data.currentTaskId || null;
    isCompactMode = data.compactMode || false;
    knownProjects = data.projects || [];

    if (data.todosDate && data.todosDate !== todayStr() && todos.length > 0) {
      // Auto-archive completed tasks and keep pending ones
      for (const todo of todos) {
        if (todo.completed) {
          await invoke('close_page_window', { taskId: todo.id });
        }
      }
      await invoke('archive_todos', { mode: 'keep' });
      const refreshed = await invoke('load_data');
      todos = refreshed.todos;
      currentTaskId = refreshed.currentTaskId;
      knownProjects = refreshed.projects || [];
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
    if (compact) await resizeCompactToContent();
  }

  function applyMode(compact) {
    document.body.className = compact ? 'mode-compact' : 'mode-full';
  }

  const dailyNotesBtn = document.getElementById('daily-notes-btn');
  dailyNotesBtn.addEventListener('click', () => {
    invoke('open_page_window', { taskId: `daily_${todayStr()}` });
  });

  headerTotalTime.style.cursor = 'pointer';
  headerTotalTime.addEventListener('click', () => {
    invoke('open_page_window', { taskId: `daily_${todayStr()}`, view: 'timeline' });
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
  //  ADD TODO (Modal)
  // ══════════════════════════════════════════

  const modal = document.getElementById('add-task-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalEstimate = document.getElementById('modal-estimate');
  const modalProject = document.getElementById('modal-project');
  const modalToday = document.getElementById('modal-today');
  const modalSubtasks = document.getElementById('modal-subtasks');
  const modalSubInput = document.getElementById('modal-subtask-input');
  const modalSubAdd = document.getElementById('modal-subtask-add');
  const modalSave = document.getElementById('modal-save');
  const modalCancel = document.getElementById('modal-cancel');
  const modalClose = document.getElementById('modal-close');

  let pendingSubtasks = []; // { title, estimatedMinutes }
  let modalTodayState = true;

  function updateModalTodayBtn() {
    if (modalTodayState) {
      modalToday.className = 'today-toggle-btn is-today';
      modalToday.innerHTML = '<span class="today-dot"></span> Planned for today';
    } else {
      modalToday.className = 'today-toggle-btn';
      modalToday.innerHTML = '+ Plan for today';
    }
  }

  modalToday.addEventListener('click', () => {
    modalTodayState = !modalTodayState;
    updateModalTodayBtn();
  });
  const modalSubEstimate = document.getElementById('modal-subtask-estimate');

  function openModal(presetProject) {
    modalTitle.value = '';
    modalEstimate.value = '';
    modalProject.value = presetProject || '';
    modalTodayState = activeView === 'today';
    updateModalTodayBtn();
    pendingSubtasks = [];
    renderModalSubtasks();
    modal.classList.remove('hidden');
    modalTitle.focus();
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  function renderModalSubtasks() {
    modalSubtasks.innerHTML = '';
    pendingSubtasks.forEach((sub, i) => {
      const row = document.createElement('div');
      row.className = 'modal-subtask-item';

      const title = document.createElement('span');
      title.className = 'modal-subtask-title';
      title.textContent = sub.title;
      row.appendChild(title);

      if (sub.estimatedMinutes) {
        const est = document.createElement('span');
        est.className = 'modal-subtask-est';
        est.textContent = formatEstimate(sub.estimatedMinutes);
        row.appendChild(est);
      }

      const del = document.createElement('button');
      del.className = 'modal-subtask-remove';
      del.innerHTML = '&times;';
      del.addEventListener('click', () => {
        pendingSubtasks.splice(i, 1);
        renderModalSubtasks();
      });
      row.appendChild(del);
      modalSubtasks.appendChild(row);
    });
  }

  function addModalSubtask() {
    const val = modalSubInput.value.trim();
    if (!val) return;
    const estMin = parseTimeInput(modalSubEstimate.value);
    pendingSubtasks.push({ title: val, estimatedMinutes: estMin });
    modalSubInput.value = '';
    modalSubEstimate.value = '';
    renderModalSubtasks();
    modalSubInput.focus();
  }

  async function saveModal() {
    const title = modalTitle.value.trim();
    if (!title) { modalTitle.focus(); return; }

    const estimatedMinutes = parseTimeInput(modalEstimate.value);
    const project = modalProject.value.trim() || null;

    const subitems = pendingSubtasks.map((s, i) => ({
      id: generateId('sub'),
      title: s.title,
      completed: false,
      order: i,
      estimatedMinutes: s.estimatedMinutes || null,
    }));

    todos.unshift({
      id: generateId('todo'),
      title,
      completed: false,
      inProgress: false,
      createdAt: Date.now(),
      order: 0,
      subitems,
      estimatedMinutes: (estimatedMinutes && estimatedMinutes > 0) ? estimatedMinutes : null,
      elapsedSeconds: 0,
      timerStartedAt: null,
      project,
      isToday: modalTodayState,
    });
    todos.forEach((t, i) => { t.order = i; });

    if (project && !knownProjects.includes(project)) knownProjects.push(project);

    await invoke('save_todos', { todos, currentTaskId });
    if (project) await invoke('set_project', { taskId: todos[0].id, project });
    closeModal();
    render();
  }

  addBtn.addEventListener('click', () => openModal());
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modalSave.addEventListener('click', saveModal);
  modalSubAdd.addEventListener('click', addModalSubtask);
  modalSubInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addModalSubtask(); }
  });
  modalTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveModal(); }
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // Project autocomplete in modal
  let modalAcDropdown = null;
  function showModalProjectAc() {
    const val = modalProject.value.trim().toLowerCase();
    const matches = knownProjects.filter(p => p.toLowerCase().includes(val));
    if (modalAcDropdown) modalAcDropdown.remove();
    if (matches.length === 0) return;
    modalAcDropdown = document.createElement('div');
    modalAcDropdown.className = 'project-autocomplete';
    matches.forEach(m => {
      const item = document.createElement('div');
      item.className = 'project-autocomplete-item';
      item.textContent = m;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        modalProject.value = m;
        if (modalAcDropdown) { modalAcDropdown.remove(); modalAcDropdown = null; }
      });
      modalAcDropdown.appendChild(item);
    });
    modalProject.parentElement.appendChild(modalAcDropdown);
  }
  modalProject.addEventListener('focus', showModalProjectAc);
  modalProject.addEventListener('input', showModalProjectAc);
  modalProject.addEventListener('blur', () => {
    setTimeout(() => { if (modalAcDropdown) { modalAcDropdown.remove(); modalAcDropdown = null; } }, 150);
  });

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
    syncProjects();
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
      await resizeCompactToContent();
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
      await resizeCompactToContent();
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
        await resizeCompactToContent();
        renderCompact();
      }
    }

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }

  // ── Project group drag ──

  function initProjectDrag(e, headerEl, projectName) {
    e.preventDefault();
    e.stopPropagation();

    const rect = headerEl.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    let hasMoved = false;
    const startX = e.clientX;
    const startY = e.clientY;

    const ghost = headerEl.cloneNode(true);
    ghost.style.position = 'fixed';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.style.width = rect.width + 'px';
    ghost.style.zIndex = '9999';
    ghost.style.opacity = '0.85';
    ghost.style.pointerEvents = 'none';
    ghost.style.boxShadow = '0 4px 16px rgba(0,0,0,0.15)';
    ghost.style.borderRadius = '8px';
    ghost.style.background = '#f8fafc';
    ghost.style.transition = 'none';

    const placeholder = document.createElement('div');
    placeholder.className = 'drop-indicator';

    function onMove(ev) {
      if (!hasMoved) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        hasMoved = true;
        document.body.appendChild(ghost);
        headerEl.classList.add('dragging');
        // Hide all tasks in this project group too
        let sib = headerEl.nextElementSibling;
        while (sib && !sib.classList.contains('project-group-header')) {
          sib.classList.add('dragging');
          sib = sib.nextElementSibling;
        }
      }

      ghost.style.left = (ev.clientX - offsetX) + 'px';
      ghost.style.top = (ev.clientY - offsetY) + 'px';

      removeDropIndicators();
      const headers = [...todoList.querySelectorAll('.project-group-header:not(.dragging)')];
      let inserted = false;
      for (const h of headers) {
        const box = h.getBoundingClientRect();
        if (ev.clientY < box.top + box.height / 2) {
          todoList.insertBefore(placeholder, h);
          inserted = true;
          break;
        }
      }
      if (!inserted && headers.length > 0) {
        // After the last project group — find the end
        const lastHeader = headers[headers.length - 1];
        let afterEl = lastHeader;
        while (afterEl.nextElementSibling && !afterEl.nextElementSibling.classList.contains('project-group-header')) {
          afterEl = afterEl.nextElementSibling;
        }
        if (afterEl.nextElementSibling) {
          todoList.insertBefore(placeholder, afterEl.nextElementSibling);
        } else {
          todoList.appendChild(placeholder);
        }
      }
    }

    async function onUp(ev) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (!hasMoved) return;

      ghost.remove();
      removeDropIndicators();
      todoList.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));

      // Find the drop position relative to other project headers
      const { index } = getInsertIndex(todoList, ev.clientY, '.project-group-header');

      // Get current project order (excluding dragged)
      const otherProjects = currentProjectOrder.filter(p => p !== projectName);
      const clampedIdx = Math.min(index, otherProjects.length);
      otherProjects.splice(clampedIdx, 0, projectName);

      // Reorder todos: project groups in new order, then ungrouped
      const reordered = [];
      for (const proj of otherProjects) {
        const projTodos = todos.filter(t => t.project === proj);
        reordered.push(...projTodos);
      }
      const ungroupedTodos = todos.filter(t => !t.project);
      reordered.push(...ungroupedTodos);
      reordered.forEach((t, i) => { t.order = i; });
      todos = reordered;

      await invoke('reorder_todos', { todoIds: todos.map(t => t.id) });
      render();
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
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

  // ── Project color helper ──

  const projectColors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f43f5e', '#84cc16'];

  function getProjectColor(name) {
    if (!name) return '#94a3b8';
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    return projectColors[Math.abs(hash) % projectColors.length];
  }

  // ══════════════════════════════════════════
  //  RENDER (FULL MODE)
  // ══════════════════════════════════════════

  function render() {
    if (isCompactMode) {
      renderCompact();
      return;
    }

    todoList.innerHTML = '';

    // Filter by active view
    const viewTodos = activeView === 'today'
      ? todos.filter(t => t.isToday !== false)
      : todos;

    if (viewTodos.length === 0) {
      emptyState.classList.remove('hidden');
      emptyState.querySelector('p').textContent = activeView === 'today'
        ? 'What needs to get done today?'
        : 'No tasks yet.';
      footer.classList.add('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    // Sort: incomplete tasks first, completed tasks at bottom
    const sortedTodos = [...viewTodos].sort((a, b) => {
      if (a.completed === b.completed) return 0;
      return a.completed ? 1 : -1;
    });

    // Group by project
    const ungrouped = sortedTodos.filter(t => !t.project);
    const projectMap = new Map();
    for (const t of sortedTodos) {
      if (t.project) {
        if (!projectMap.has(t.project)) projectMap.set(t.project, []);
        projectMap.get(t.project).push(t);
      }
    }
    currentProjectOrder = [...projectMap.keys()];

    // Render project groups first, then ungrouped tasks
    for (const [projectName, projectTodos] of projectMap) {
      const isCollapsed = collapsedProjects.has(projectName);
      const color = getProjectColor(projectName);
      const incompleteCount = projectTodos.filter(t => !t.completed).length;

      const header = document.createElement('div');
      header.className = 'project-group-header' + (isCollapsed ? ' collapsed' : '');
      header.setAttribute('data-project', projectName);

      const headerGrip = document.createElement('div');
      headerGrip.className = 'project-group-grip';
      headerGrip.innerHTML = subGripDots;
      headerGrip.addEventListener('pointerdown', (e) => {
        initProjectDrag(e, header, projectName);
      });

      header.innerHTML = '';
      header.appendChild(headerGrip);

      const chevronBtn = document.createElement('button');
      chevronBtn.className = 'project-group-chevron-btn';
      chevronBtn.innerHTML = '<svg class="project-group-chevron" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

      const dot = document.createElement('span');
      dot.className = 'project-group-dot';
      dot.style.background = color;

      const name = document.createElement('span');
      name.className = 'project-group-name';
      name.textContent = projectName;

      const count = document.createElement('span');
      count.className = 'project-group-count';
      count.textContent = incompleteCount;

      const projAddBtn = document.createElement('button');
      projAddBtn.className = 'project-group-action-btn';
      projAddBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      projAddBtn.title = 'Add task to project';
      projAddBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(projectName);
      });

      const projPageBtn = document.createElement('button');
      projPageBtn.className = 'project-group-action-btn';
      projPageBtn.innerHTML = pageSvg;
      projPageBtn.title = 'Project notes';
      projPageBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        invoke('open_page_window', { taskId: 'project_' + projectName });
      });

      header.appendChild(chevronBtn);
      header.appendChild(dot);
      header.appendChild(name);
      header.appendChild(count);
      header.appendChild(projAddBtn);
      header.appendChild(projPageBtn);

      chevronBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (collapsedProjects.has(projectName)) collapsedProjects.delete(projectName);
        else collapsedProjects.add(projectName);
        render();
      });
      todoList.appendChild(header);

      if (!isCollapsed) {
        projectTodos.forEach(todo => renderTodoItem(todo, todoList));
      }
    }

    // Visual separator before ungrouped tasks
    if (ungrouped.length > 0 && projectMap.size > 0) {
      const sep = document.createElement('div');
      sep.className = 'ungrouped-separator';
      todoList.appendChild(sep);
    }

    // Render ungrouped tasks after project groups
    ungrouped.forEach(todo => renderTodoItem(todo, todoList));

    // Footer
    const completed = viewTodos.filter(t => t.completed).length;
    if (viewTodos.length > 0) {
      footer.textContent = `${completed} of ${viewTodos.length} task${viewTodos.length !== 1 ? 's' : ''} complete`;
      footer.classList.remove('hidden');
    } else {
      footer.classList.add('hidden');
    }

    // Header total time
    updateHeaderTotalTime();
  }

  function renderTodoItem(todo, container) {
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

      // Today dot indicator (in All Tasks view)
      if (activeView === 'all' && todo.isToday !== false) {
        const dot = document.createElement('span');
        dot.className = 'today-dot';
        dot.title = 'Planned for today';
        actions.appendChild(dot);
      }

      // Estimate badge (when not in progress but has estimate)
      if (!isInProgress && todo.estimatedMinutes && !todo.completed) {
        const badge = document.createElement('span');
        badge.className = 'estimate-badge';
        badge.textContent = formatEstimate(todo.estimatedMinutes);
        actions.appendChild(badge);
      }

      // Play/pause button
      if (!todo.completed) {
        const playBtn = document.createElement('button');
        playBtn.className = 'action-btn play-btn' + (isInProgress ? ' active' : '');
        playBtn.innerHTML = isInProgress ? pauseSvg : playSvg;
        playBtn.title = isInProgress ? 'Stop focusing' : 'Focus on this';
        playBtn.addEventListener('click', () => markInProgress(todo.id));
        actions.appendChild(playBtn);
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

      // Back to focus view button (only on in-progress task in full mode)
      if (isInProgress && !isCompactMode) {
        const focusBtn = document.createElement('button');
        focusBtn.className = 'action-btn focus-btn';
        focusBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 2L5 4L3 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 12L9 10L11 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        focusBtn.title = 'Back to focus view';
        focusBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleMode(true);
        });
        actions.appendChild(focusBtn);
      }

      main.appendChild(grip);
      main.appendChild(expandBtn);
      main.appendChild(checkbox);
      main.appendChild(title);
      main.appendChild(actions);
      item.appendChild(main);

      // Timer on a separate row below (only for in-progress task)
      if (isInProgress && !todo.completed) {
        const progressRow = document.createElement('div');
        progressRow.className = 'todo-progress-row';
        const timerEl = document.createElement('span');
        timerEl.className = 'timer-display';
        const elapsed = getElapsedSeconds(todo);
        const { text, overTime } = formatTimer(elapsed, todo.estimatedMinutes);
        timerEl.textContent = text;
        if (overTime) timerEl.classList.add('over-time');
        progressRow.appendChild(timerEl);
        item.appendChild(progressRow);
      }

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

      // Project field
      if (!todo.completed) {
        const projRow = document.createElement('div');
        projRow.className = 'project-row';

        const projLabel = document.createElement('span');
        projLabel.className = 'project-label';
        projLabel.textContent = 'Project';

        const projWrapper = document.createElement('div');
        projWrapper.className = 'project-input-wrapper';

        const projInput = document.createElement('input');
        projInput.type = 'text';
        projInput.className = 'project-input';
        projInput.placeholder = 'No project';
        projInput.value = todo.project || '';

        let acDropdown = null;

        const showAutocomplete = () => {
          const val = projInput.value.trim().toLowerCase();
          const matches = knownProjects.filter(p => p.toLowerCase().includes(val) && p !== todo.project);
          if (acDropdown) acDropdown.remove();
          if (matches.length === 0) return;
          acDropdown = document.createElement('div');
          acDropdown.className = 'project-autocomplete';
          matches.forEach(m => {
            const item = document.createElement('div');
            item.className = 'project-autocomplete-item';
            item.textContent = m;
            item.addEventListener('mousedown', async (e) => {
              e.preventDefault();
              projInput.value = m;
              todo.project = m;
              await invoke('set_project', { taskId: todo.id, project: m });
              syncProjects();
              if (acDropdown) acDropdown.remove();
              acDropdown = null;
              render();
            });
            acDropdown.appendChild(item);
          });
          projWrapper.appendChild(acDropdown);
        };

        projInput.addEventListener('focus', showAutocomplete);
        projInput.addEventListener('input', showAutocomplete);
        projInput.addEventListener('blur', async () => {
          setTimeout(() => { if (acDropdown) { acDropdown.remove(); acDropdown = null; } }, 150);
          const val = projInput.value.trim() || null;
          if (val !== (todo.project || null)) {
            todo.project = val;
            await invoke('set_project', { taskId: todo.id, project: val });
            syncProjects();
            render();
          }
        });

        projWrapper.appendChild(projInput);
        projRow.appendChild(projLabel);
        projRow.appendChild(projWrapper);
        detail.appendChild(projRow);
      }

      // Today toggle
      {
        const todayRow = document.createElement('div');
        todayRow.className = 'today-toggle-row';
        const todayBtn = document.createElement('button');
        const isTodayTask = todo.isToday !== false;
        todayBtn.className = 'today-toggle-btn' + (isTodayTask ? ' is-today' : '');
        todayBtn.innerHTML = isTodayTask
          ? '<span class="today-dot"></span> Planned for today'
          : '+ Plan for today';
        todayBtn.addEventListener('click', async () => {
          const newVal = !isTodayTask;
          todo.isToday = newVal;
          expandedIds.delete(todo.id);
          await invoke('set_today', { taskId: todo.id, isToday: newVal });
          render();
        });
        todayRow.appendChild(todayBtn);
        detail.appendChild(todayRow);
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
      container.appendChild(item);
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
          await resizeCompactToContent();
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
    }

    // Add subtask — subtle trigger that expands into input row
    const addWrapper = document.createElement('div');
    addWrapper.className = 'compact-add-sub-wrapper';

    const trigger = document.createElement('button');
    trigger.className = 'compact-add-sub-trigger';
    trigger.textContent = '+ Add a subtask';

    const addRow = document.createElement('div');
    addRow.className = 'compact-add-sub';
    addRow.style.display = 'none';

    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.placeholder = 'Add a subtask...';
    addInput.setAttribute('data-subinput', task.id);

    const subEstField = document.createElement('div');
    subEstField.className = 'estimate-field sm';
    subEstField.innerHTML = clockSvg;
    const subEstInput = document.createElement('input');
    subEstInput.type = 'text';
    subEstInput.placeholder = '0:00';
    subEstField.appendChild(subEstInput);

    const collapse = () => {
      addRow.style.display = 'none';
      trigger.style.display = '';
    };

    const doAdd = () => {
      if (addInput.value.trim()) {
        addSubitem(task.id, addInput.value.trim(), subEstInput.value);
        addInput.value = '';
        subEstInput.value = '';
      }
    };
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doAdd();
      if (e.key === 'Escape') collapse();
    });
    subEstInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doAdd();
      if (e.key === 'Escape') collapse();
    });

    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', doAdd);

    trigger.addEventListener('click', () => {
      trigger.style.display = 'none';
      addRow.style.display = '';
      addInput.focus();
    });

    addRow.appendChild(addInput);
    addRow.appendChild(subEstField);
    addRow.appendChild(addBtn);
    addWrapper.appendChild(trigger);
    addWrapper.appendChild(addRow);
    compactSubtaskList.appendChild(addWrapper);
    compactSubtaskList.style.display = 'flex';
    resizeCompactToContent();
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
