use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// ── macOS: overlay window over fullscreen apps ──

#[cfg(target_os = "macos")]
mod macos_overlay {
    use std::ffi::c_void;

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_msgSend();
        fn sel_registerName(name: *const std::os::raw::c_char) -> *mut c_void;
    }

    /// Set NSWindowCollectionBehavior so the compact widget appears over fullscreen apps.
    /// Flags: canJoinAllSpaces (1<<0) | stationary (1<<4) | fullScreenAuxiliary (1<<8)
    pub unsafe fn set_overlay(ns_win: *mut c_void, enable: bool) {
        let sel =
            sel_registerName(b"setCollectionBehavior:\0".as_ptr() as *const std::os::raw::c_char);
        let behavior: u64 = if enable {
            (1 << 0) | (1 << 4) | (1 << 8)
        } else {
            0
        };
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void, u64) =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        send(ns_win, sel, behavior);
    }
}

// ── Data model ──

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct AppData {
    #[serde(default)]
    todos: Vec<Todo>,
    #[serde(default)]
    archived_todos: Vec<Todo>,
    current_task_id: Option<String>,
    todos_date: Option<String>,
    #[serde(default)]
    compact_mode: bool,
    window_position: Option<Position>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Todo {
    id: String,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    completed: bool,
    #[serde(default)]
    in_progress: bool,
    #[serde(default)]
    created_at: u64,
    #[serde(default)]
    order: usize,
    #[serde(default)]
    subitems: Vec<SubItem>,
    #[serde(default)]
    estimated_minutes: Option<u32>,
    #[serde(default)]
    elapsed_seconds: u64,
    #[serde(default)]
    timer_started_at: Option<u64>,
    #[serde(default)]
    time_logs: Vec<TimeLog>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct SubItem {
    id: String,
    title: String,
    #[serde(default)]
    completed: bool,
    #[serde(default)]
    order: usize,
    #[serde(default)]
    estimated_minutes: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct TimeLog {
    event: String,       // "start", "pause", "complete"
    timestamp: u64,      // milliseconds since epoch
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct TimelineBout {
    task_id: String,
    task_title: String,
    start_ms: u64,
    end_ms: Option<u64>, // None = active
    color_index: u8,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Position {
    x: f64,
    y: f64,
}

// ── Page metadata model ──

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
enum PageType {
    Task,
    Daily,
    Note,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct PageMeta {
    id: String,
    title: String,
    page_type: PageType,
    created_at: u64,
    updated_at: u64,
}

// ── Data store (JSON file on disk) ──

struct DataStore {
    path: PathBuf,
    data: Mutex<AppData>,
}

impl DataStore {
    fn new(path: PathBuf) -> Self {
        let data = if path.exists() {
            fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            AppData::default()
        };
        Self {
            path,
            data: Mutex::new(data),
        }
    }

    fn save(&self) {
        let data = self.data.lock().unwrap();
        if let Ok(json) = serde_json::to_string_pretty(&*data) {
            let _ = fs::create_dir_all(self.path.parent().unwrap());
            let _ = fs::write(&self.path, json);
        }
    }
}

// ── Page metadata store ──

struct PageMetaStore {
    path: PathBuf,
    pages_dir: PathBuf,
    data: Mutex<Vec<PageMeta>>,
}

impl PageMetaStore {
    fn new(data_dir: &std::path::Path) -> Self {
        let path = data_dir.join("pages_meta.json");
        let pages_dir = data_dir.join("pages");
        let data = if path.exists() {
            fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        Self {
            path,
            pages_dir,
            data: Mutex::new(data),
        }
    }

    fn save(&self) {
        let data = self.data.lock().unwrap();
        if let Ok(json) = serde_json::to_string_pretty(&*data) {
            let _ = fs::create_dir_all(self.path.parent().unwrap());
            let _ = fs::write(&self.path, json);
        }
    }

    fn upsert(&self, meta: PageMeta) {
        let mut data = self.data.lock().unwrap();
        if let Some(existing) = data.iter_mut().find(|m| m.id == meta.id) {
            existing.title = meta.title;
            existing.updated_at = meta.updated_at;
        } else {
            data.push(meta);
        }
        drop(data);
        self.save();
    }

    fn remove(&self, page_id: &str) {
        let mut data = self.data.lock().unwrap();
        data.retain(|m| m.id != page_id);
        drop(data);
        self.save();
    }
}

fn infer_page_type(id: &str) -> PageType {
    if id.starts_with("todo_") || id.starts_with("sub_") {
        PageType::Task
    } else if id.starts_with("daily_") {
        PageType::Daily
    } else {
        PageType::Note
    }
}

fn format_daily_title(id: &str) -> String {
    // id is like "daily_2026-03-10"
    let date_str = id.strip_prefix("daily_").unwrap_or(id);
    // Parse and format nicely
    if let Ok(date) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
        date.format("%a, %b %-d, %Y").to_string()
    } else {
        date_str.to_string()
    }
}

fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

// ── Tauri commands ──

#[tauri::command]
fn load_data(store: tauri::State<DataStore>) -> AppData {
    store.data.lock().unwrap().clone()
}

#[tauri::command]
fn save_todos(
    store: tauri::State<DataStore>,
    todos: Vec<Todo>,
    current_task_id: Option<String>,
) {
    {
        let mut data = store.data.lock().unwrap();
        data.todos = todos;
        if current_task_id.is_some() {
            data.current_task_id = current_task_id;
        }
        data.todos_date = Some(today_str());
    }
    store.save();
}

#[tauri::command]
fn set_in_progress(store: tauri::State<DataStore>, todo_id: Option<String>) {
    let now = now_ms();
    {
        let mut data = store.data.lock().unwrap();

        // Pause timer on previously in-progress task
        for todo in &mut data.todos {
            if todo.in_progress {
                if let Some(started) = todo.timer_started_at {
                    todo.elapsed_seconds += (now - started) / 1000;
                }
                todo.timer_started_at = None;
                todo.in_progress = false;
                todo.time_logs.push(TimeLog { event: "pause".into(), timestamp: now });
            }
        }

        // Start timer on new in-progress task
        if let Some(ref id) = todo_id {
            if let Some(todo) = data.todos.iter_mut().find(|t| t.id == *id) {
                todo.in_progress = true;
                todo.timer_started_at = Some(now);
                todo.time_logs.push(TimeLog { event: "start".into(), timestamp: now });
            }
        }

        data.current_task_id = todo_id;
    }
    store.save();
}

#[tauri::command]
fn complete_task(store: tauri::State<DataStore>, task_id: String) {
    let now = now_ms();
    {
        let mut data = store.data.lock().unwrap();
        if let Some(todo) = data.todos.iter_mut().find(|t| t.id == task_id) {
            todo.completed = true;
            todo.in_progress = false;
            // Pause timer (accumulate, don't reset)
            if let Some(started) = todo.timer_started_at {
                todo.elapsed_seconds += (now - started) / 1000;
            }
            todo.timer_started_at = None;
            todo.time_logs.push(TimeLog { event: "complete".into(), timestamp: now });
        }
        data.current_task_id = None;
    }
    store.save();
}

#[tauri::command]
fn toggle_subitem(store: tauri::State<DataStore>, task_id: String, subitem_id: String) {
    {
        let mut data = store.data.lock().unwrap();
        if let Some(todo) = data.todos.iter_mut().find(|t| t.id == task_id) {
            if let Some(sub) = todo.subitems.iter_mut().find(|s| s.id == subitem_id) {
                sub.completed = !sub.completed;
            }
        }
    }
    store.save();
}

#[tauri::command]
fn clear_todos(store: tauri::State<DataStore>) {
    {
        let mut data = store.data.lock().unwrap();
        data.todos.clear();
        data.current_task_id = None;
        data.todos_date = Some(today_str());
    }
    store.save();
}

#[tauri::command]
fn archive_todos(store: tauri::State<DataStore>, mode: String) {
    let now = now_ms();
    {
        let mut data = store.data.lock().unwrap();

        let to_archive: Vec<Todo> = if mode == "clear" {
            // Archive ALL tasks
            data.todos.drain(..).collect()
        } else {
            // mode == "keep" — Archive only completed tasks, keep pending
            let (completed, pending): (Vec<Todo>, Vec<Todo>) =
                data.todos.drain(..).partition(|t| t.completed);
            data.todos = pending;
            completed
        };

        // Finalize timers and move to archived_todos
        for mut todo in to_archive {
            if let Some(started) = todo.timer_started_at {
                todo.elapsed_seconds += (now - started) / 1000;
                todo.timer_started_at = None;
                todo.time_logs.push(TimeLog { event: "pause".into(), timestamp: now });
            }
            todo.in_progress = false;

            // Deduplicate: don't add if already archived
            if !data.archived_todos.iter().any(|t| t.id == todo.id) {
                data.archived_todos.push(todo);
            }
        }

        data.current_task_id = None;
        data.todos_date = Some(today_str());
    }
    store.save();
}

#[tauri::command]
fn toggle_compact_mode(store: tauri::State<DataStore>, app: AppHandle, compact: bool) {
    {
        let mut data = store.data.lock().unwrap();
        data.compact_mode = compact;
    }
    store.save();

    if let Some(win) = app.get_webview_window("main") {
        if compact {
            let data = store.data.lock().unwrap();
            let current_todo = data
                .current_task_id
                .as_ref()
                .and_then(|id| data.todos.iter().find(|t| t.id == *id));
            let sub_count = current_todo.map(|t| t.subitems.len()).unwrap_or(0);
            // progress bar adds ~15px when subtasks exist
            let progress_extra = if sub_count > 0 { 15.0 } else { 0.0 };
            let height = (110.0 + progress_extra + sub_count as f64 * 30.0).max(90.0).min(400.0);
            drop(data);

            let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(340.0, height)));
            let _ = win.set_always_on_top(true);
            let _ = win.set_resizable(false);
            let _ = win.set_decorations(false);
            #[cfg(target_os = "macos")]
            if let Ok(ns_win) = win.ns_window() {
                unsafe { macos_overlay::set_overlay(ns_win, true); }
            }
        } else {
            #[cfg(target_os = "macos")]
            if let Ok(ns_win) = win.ns_window() {
                unsafe { macos_overlay::set_overlay(ns_win, false); }
            }
            let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(400.0, 560.0)));
            let _ = win.set_always_on_top(false);
            let _ = win.set_resizable(true);
            let _ = win.set_decorations(true);
        }
    }
}

#[tauri::command]
fn set_estimate(store: tauri::State<DataStore>, task_id: String, minutes: Option<u32>) {
    {
        let mut data = store.data.lock().unwrap();
        if let Some(todo) = data.todos.iter_mut().find(|t| t.id == task_id) {
            todo.estimated_minutes = minutes;
        }
    }
    store.save();
}

#[tauri::command]
fn reorder_todos(store: tauri::State<DataStore>, todo_ids: Vec<String>) {
    {
        let mut data = store.data.lock().unwrap();
        for (index, id) in todo_ids.iter().enumerate() {
            if let Some(todo) = data.todos.iter_mut().find(|t| t.id == *id) {
                todo.order = index;
            }
        }
        data.todos.sort_by_key(|t| t.order);
    }
    store.save();
}

#[tauri::command]
fn reorder_subitems(store: tauri::State<DataStore>, task_id: String, subitem_ids: Vec<String>) {
    {
        let mut data = store.data.lock().unwrap();
        if let Some(todo) = data.todos.iter_mut().find(|t| t.id == task_id) {
            for (index, id) in subitem_ids.iter().enumerate() {
                if let Some(sub) = todo.subitems.iter_mut().find(|s| s.id == *id) {
                    sub.order = index;
                }
            }
            todo.subitems.sort_by_key(|s| s.order);
        }
    }
    store.save();
}

#[tauri::command]
fn resize_compact(store: tauri::State<DataStore>, app: AppHandle) {
    let data = store.data.lock().unwrap();
    if !data.compact_mode {
        return;
    }
    let current_todo = data
        .current_task_id
        .as_ref()
        .and_then(|id| data.todos.iter().find(|t| t.id == *id));
    let sub_count = current_todo.map(|t| t.subitems.len()).unwrap_or(0);
    // progress bar adds ~15px when subtasks exist
    let progress_extra = if sub_count > 0 { 15.0 } else { 0.0 };
    let height = (110.0 + progress_extra + sub_count as f64 * 30.0).max(90.0).min(400.0);
    drop(data);

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(340.0, height)));
    }
}

// ── Page (notes) commands ──

#[tauri::command]
fn open_page_window(
    app: AppHandle,
    task_id: String,
) -> Result<(), String> {
    let label = "pages_browser";

    // If pages browser already exists, focus it and navigate to the page
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit_to(label, "navigate-to-page", &task_id);
        return Ok(());
    }

    // Create the pages browser window with page param so it opens directly
    let url = tauri::WebviewUrl::App(format!("pages_browser.html?page={}", task_id).into());

    let mut builder = tauri::WebviewWindowBuilder::new(&app, label, url)
        .title("All Pages")
        .inner_size(400.0, 560.0)
        .min_inner_size(320.0, 400.0);

    // Position relative to main window
    if let Some(main_win) = app.get_webview_window("main") {
        if let (Ok(pos), Ok(size), Ok(Some(monitor))) =
            (main_win.outer_position(), main_win.outer_size(), main_win.current_monitor())
        {
            let scale = monitor.scale_factor();
            let main_x = pos.x as f64 / scale;
            let main_y = pos.y as f64 / scale;
            let main_w = size.width as f64 / scale;
            let mon_pos = monitor.position();
            let mon_size = monitor.size();
            let mon_right = mon_pos.x as f64 / scale + mon_size.width as f64 / scale;

            let gap = 36.0;
            let page_w = 400.0;
            let page_y = main_y;

            let page_x = if main_x + main_w + gap + page_w <= mon_right {
                main_x + main_w + gap
            } else {
                main_x - page_w - gap
            };

            builder = builder.position(page_x, page_y);
        }
    } else {
        builder = builder.center();
    }

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_page_window(app: AppHandle, _task_id: String) {
    if let Some(win) = app.get_webview_window("pages_browser") {
        let _ = win.close();
    }
}

#[tauri::command]
fn load_page(store: tauri::State<DataStore>, task_id: String) -> String {
    let pages_dir = store.path.parent().unwrap().join("pages");
    let page_path = pages_dir.join(format!("{}.txt", task_id));
    fs::read_to_string(page_path).unwrap_or_default()
}

#[tauri::command]
fn save_page(
    store: tauri::State<DataStore>,
    page_meta_store: tauri::State<PageMetaStore>,
    task_id: String,
    content: String,
) {
    let pages_dir = store.path.parent().unwrap().join("pages");
    let _ = fs::create_dir_all(&pages_dir);
    let page_path = pages_dir.join(format!("{}.txt", task_id));
    let _ = fs::write(page_path, content);

    // Upsert page metadata
    let now = now_ms();
    let page_type = infer_page_type(&task_id);
    let title = match page_type {
        PageType::Task => {
            let data = store.data.lock().unwrap();
            data.todos
                .iter()
                .chain(data.archived_todos.iter())
                .find(|t| t.id == task_id)
                .map(|t| t.title.clone())
                .unwrap_or_else(|| {
                    // Check if metadata already has a title
                    let meta = page_meta_store.data.lock().unwrap();
                    meta.iter()
                        .find(|m| m.id == task_id)
                        .map(|m| m.title.clone())
                        .unwrap_or_else(|| task_id.clone())
                })
        }
        PageType::Daily => format_daily_title(&task_id),
        PageType::Note => {
            // For notes, preserve existing title
            let meta = page_meta_store.data.lock().unwrap();
            meta.iter()
                .find(|m| m.id == task_id)
                .map(|m| m.title.clone())
                .unwrap_or_else(|| "Untitled".to_string())
        }
    };

    page_meta_store.upsert(PageMeta {
        id: task_id,
        title,
        page_type,
        created_at: now, // Will be ignored if entry already exists (upsert only updates title + updated_at)
        updated_at: now,
    });
}

#[tauri::command]
fn delete_page(
    store: tauri::State<DataStore>,
    page_meta_store: tauri::State<PageMetaStore>,
    app: AppHandle,
    task_id: String,
) {
    // Close page window if open
    let label = format!("page_{}", task_id);
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
    // Delete page file
    let pages_dir = store.path.parent().unwrap().join("pages");
    let page_path = pages_dir.join(format!("{}.txt", task_id));
    let _ = fs::remove_file(page_path);
    // Remove metadata
    page_meta_store.remove(&task_id);
}

// ── Pages browser commands ──

#[tauri::command]
fn list_all_pages(
    store: tauri::State<DataStore>,
    page_meta_store: tauri::State<PageMetaStore>,
) -> Vec<PageMeta> {
    let pages_dir = &page_meta_store.pages_dir;
    let _ = fs::create_dir_all(pages_dir);

    // Collect all .txt files in pages dir
    let mut file_ids: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(pages_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("txt") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    file_ids.push(stem.to_string());
                }
            }
        }
    }

    let now = now_ms();
    let app_data = store.data.lock().unwrap();
    let mut meta_data = page_meta_store.data.lock().unwrap();
    let mut changed = false;

    // Backfill metadata for any files that don't have entries
    for file_id in &file_ids {
        if !meta_data.iter().any(|m| m.id == *file_id) {
            let page_type = infer_page_type(file_id);
            let title = match page_type {
                PageType::Task => app_data
                    .todos
                    .iter()
                    .chain(app_data.archived_todos.iter())
                    .find(|t| t.id == *file_id)
                    .map(|t| t.title.clone())
                    .unwrap_or_else(|| file_id.clone()),
                PageType::Daily => format_daily_title(file_id),
                PageType::Note => "Untitled".to_string(),
            };

            // Get file modification time as a rough created_at
            let file_path = pages_dir.join(format!("{}.txt", file_id));
            let modified = fs::metadata(&file_path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(now);

            meta_data.push(PageMeta {
                id: file_id.clone(),
                title,
                page_type,
                created_at: modified,
                updated_at: modified,
            });
            changed = true;
        }
    }

    // Remove metadata entries for files that no longer exist
    let before_len = meta_data.len();
    meta_data.retain(|m| file_ids.contains(&m.id));
    if meta_data.len() != before_len {
        changed = true;
    }

    // Update task page titles from current todo data
    for meta in meta_data.iter_mut() {
        if meta.page_type == PageType::Task {
            if let Some(todo) = app_data.todos.iter().chain(app_data.archived_todos.iter()).find(|t| t.id == meta.id) {
                if meta.title != todo.title {
                    meta.title = todo.title.clone();
                    changed = true;
                }
            }
        }
    }

    let mut result = meta_data.clone();
    drop(meta_data);
    drop(app_data);

    if changed {
        page_meta_store.save();
    }

    // Sort by updated_at descending
    result.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    result
}

#[tauri::command]
fn create_note_page(page_meta_store: tauri::State<PageMetaStore>) -> PageMeta {
    let now = now_ms();
    let rand: String = (0..6)
        .map(|_| {
            let idx = (now as usize + rand_simple()) % 36;
            "abcdefghijklmnopqrstuvwxyz0123456789"
                .chars()
                .nth(idx)
                .unwrap()
        })
        .collect();
    let id = format!("note_{}_{}", now, rand);

    // Create empty file
    let _ = fs::create_dir_all(&page_meta_store.pages_dir);
    let page_path = page_meta_store.pages_dir.join(format!("{}.txt", id));
    let _ = fs::write(&page_path, "");

    let meta = PageMeta {
        id: id.clone(),
        title: "Untitled".to_string(),
        page_type: PageType::Note,
        created_at: now,
        updated_at: now,
    };

    page_meta_store.upsert(meta.clone());
    meta
}

fn rand_simple() -> usize {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut hasher);
    std::thread::current().id().hash(&mut hasher);
    hasher.finish() as usize
}

#[tauri::command]
fn rename_page(page_meta_store: tauri::State<PageMetaStore>, page_id: String, title: String) {
    let mut data = page_meta_store.data.lock().unwrap();
    if let Some(meta) = data.iter_mut().find(|m| m.id == page_id && m.page_type == PageType::Note) {
        meta.title = title;
        meta.updated_at = now_ms();
    }
    drop(data);
    page_meta_store.save();
}

#[tauri::command]
fn search_pages(
    page_meta_store: tauri::State<PageMetaStore>,
    query: String,
) -> Vec<PageMeta> {
    let query_lower = query.to_lowercase();
    let pages_dir_path = &page_meta_store.pages_dir;
    let meta_data = page_meta_store.data.lock().unwrap();
    let mut results: Vec<PageMeta> = Vec::new();

    for meta in meta_data.iter() {
        let title_match = meta.title.to_lowercase().contains(&query_lower);
        let content_match = if !title_match {
            let page_path = pages_dir_path.join(format!("{}.txt", meta.id));
            fs::read_to_string(page_path)
                .map(|c| c.to_lowercase().contains(&query_lower))
                .unwrap_or(false)
        } else {
            false
        };

        if title_match || content_match {
            results.push(meta.clone());
        }
    }

    drop(meta_data);
    results.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    results
}


#[tauri::command]
fn open_pages_browser(app: AppHandle) -> Result<(), String> {
    let label = "pages_browser";

    // If window already exists, just focus it
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    let url = tauri::WebviewUrl::App("pages_browser.html".into());

    let mut builder = tauri::WebviewWindowBuilder::new(&app, label, url)
        .title("All Pages")
        .inner_size(400.0, 560.0)
        .min_inner_size(320.0, 400.0);

    // Position relative to main window
    if let Some(main_win) = app.get_webview_window("main") {
        if let (Ok(pos), Ok(size), Ok(Some(monitor))) =
            (main_win.outer_position(), main_win.outer_size(), main_win.current_monitor())
        {
            let scale = monitor.scale_factor();
            let main_x = pos.x as f64 / scale;
            let main_y = pos.y as f64 / scale;
            let main_w = size.width as f64 / scale;
            let mon_pos = monitor.position();
            let mon_size = monitor.size();
            let mon_right = mon_pos.x as f64 / scale + mon_size.width as f64 / scale;

            let gap = 36.0;
            let page_w = 400.0;
            let page_y = main_y;

            let page_x = if main_x + main_w + gap + page_w <= mon_right {
                main_x + main_w + gap
            } else {
                main_x - page_w - gap
            };

            builder = builder.position(page_x, page_y);
        }
    } else {
        builder = builder.center();
    }

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

// ── Timeline ──

/// Compute bouts from time_logs: pair "start" with next "pause"/"complete".
fn compute_bouts_from_logs(
    todo: &Todo,
    task_title: &str,
    color_index: u8,
) -> Vec<TimelineBout> {
    let mut bouts = Vec::new();
    let mut open_start: Option<u64> = None;

    for log in todo.time_logs.iter() {
        match log.event.as_str() {
            "start" => {
                // Close orphaned previous start at this start's timestamp
                if let Some(s) = open_start {
                    bouts.push(TimelineBout {
                        task_id: todo.id.clone(),
                        task_title: task_title.to_string(),
                        start_ms: s,
                        end_ms: Some(log.timestamp),
                        color_index,
                    });
                }
                open_start = Some(log.timestamp);
            }
            "pause" | "complete" => {
                if let Some(s) = open_start {
                    bouts.push(TimelineBout {
                        task_id: todo.id.clone(),
                        task_title: task_title.to_string(),
                        start_ms: s,
                        end_ms: Some(log.timestamp),
                        color_index,
                    });
                    open_start = None;
                }
            }
            _ => {}
        }
    }

    // If there's an unclosed start and the timer is running, it's active
    if let Some(s) = open_start {
        bouts.push(TimelineBout {
            task_id: todo.id.clone(),
            task_title: task_title.to_string(),
            start_ms: s,
            end_ms: None, // active
            color_index,
        });
    }

    bouts
}

/// Split bouts at midnight boundaries so each bout fits within a single day.
fn split_bouts_at_midnight(bouts: Vec<TimelineBout>) -> Vec<TimelineBout> {
    use chrono::{TimeZone, Local, Datelike, Duration};
    let mut result = Vec::new();

    for bout in bouts {
        let end_ms = bout.end_ms.unwrap_or_else(|| now_ms());
        let start_dt = Local.timestamp_millis_opt(bout.start_ms as i64).unwrap();
        let end_dt = Local.timestamp_millis_opt(end_ms as i64).unwrap();

        if start_dt.date_naive() == end_dt.date_naive() {
            // Same day, no split needed
            result.push(bout);
        } else {
            // Split at each midnight
            let mut seg_start = bout.start_ms;
            let mut current_date = start_dt.date_naive();
            let end_date = end_dt.date_naive();

            while current_date < end_date {
                let next_day = current_date + Duration::days(1);
                let midnight = Local
                    .with_ymd_and_hms(next_day.year(), next_day.month(), next_day.day(), 0, 0, 0)
                    .unwrap()
                    .timestamp_millis() as u64;

                result.push(TimelineBout {
                    task_id: bout.task_id.clone(),
                    task_title: bout.task_title.clone(),
                    start_ms: seg_start,
                    end_ms: Some(midnight),
                    color_index: bout.color_index,
                });

                seg_start = midnight;
                current_date = next_day;
            }

            // Final segment (same day as end)
            result.push(TimelineBout {
                task_id: bout.task_id.clone(),
                task_title: bout.task_title.clone(),
                start_ms: seg_start,
                end_ms: bout.end_ms, // preserve None for active
                color_index: bout.color_index,
            });
        }
    }

    result
}

#[tauri::command]
fn load_timeline(store: tauri::State<DataStore>, task_id: String) -> Vec<TimelineBout> {
    let data = store.data.lock().unwrap();
    let all_todos: Vec<&Todo> = data.todos.iter().chain(data.archived_todos.iter()).collect();

    if task_id.starts_with("daily_") {
        // Daily page: aggregate bouts from all tasks on that date
        let date_str = &task_id[6..]; // "YYYY-MM-DD"
        let mut bouts = Vec::new();
        let mut color_idx: u8 = 0;

        for todo in &all_todos {
            if todo.time_logs.is_empty() {
                continue;
            }
            let raw = compute_bouts_from_logs(todo, &todo.title, color_idx);
            let split = split_bouts_at_midnight(raw);

            // Filter to bouts on this date
            let day_bouts: Vec<TimelineBout> = split
                .into_iter()
                .filter(|b| {
                    use chrono::{TimeZone, Local};
                    let dt = Local.timestamp_millis_opt(b.start_ms as i64).unwrap();
                    dt.format("%Y-%m-%d").to_string() == *date_str
                })
                .collect();

            if !day_bouts.is_empty() {
                bouts.extend(day_bouts);
                color_idx = (color_idx + 1).min(4);
            }
        }

        bouts.sort_by_key(|b| b.start_ms);
        bouts
    } else {
        // Task page: find the specific todo
        if let Some(todo) = all_todos.iter().find(|t| t.id == task_id) {
            let raw = compute_bouts_from_logs(todo, &todo.title, 0);
            let mut bouts = split_bouts_at_midnight(raw);
            bouts.sort_by_key(|b| b.start_ms);
            bouts
        } else {
            Vec::new()
        }
    }
}

// ── App entry point ──

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            let data_path = data_dir.join("data.json");
            let store = DataStore::new(data_path);
            let page_meta_store = PageMetaStore::new(&data_dir);

            app.manage(store);
            app.manage(page_meta_store);

            // System tray
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;

            let show_item =
                MenuItem::with_id(app, "show", "Open Daily Focus", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_todos,
            set_in_progress,
            complete_task,
            toggle_subitem,
            clear_todos,
            archive_todos,
            toggle_compact_mode,
            set_estimate,
            reorder_todos,
            reorder_subitems,
            resize_compact,
            open_page_window,
            close_page_window,
            load_page,
            save_page,
            delete_page,
            list_all_pages,
            create_note_page,
            rename_page,
            search_pages,
            open_pages_browser,
            load_timeline,
        ])
        .on_window_event(|window, event| {
            match event {
                // Save window position in compact mode
                tauri::WindowEvent::Moved(pos) if window.label() == "main" => {
                    let app = window.app_handle();
                    if let Some(store) = app.try_state::<DataStore>() {
                        let data = store.data.lock().unwrap();
                        if data.compact_mode {
                            drop(data);
                            let mut data = store.data.lock().unwrap();
                            data.window_position = Some(Position {
                                x: pos.x as f64,
                                y: pos.y as f64,
                            });
                            drop(data);
                            store.save();
                        }
                    }
                }
                // Hide main window on close instead of quitting
                tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error running Daily Focus");
}
