use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

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
struct Position {
    x: f64,
    y: f64,
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
            }
        }

        // Start timer on new in-progress task
        if let Some(ref id) = todo_id {
            if let Some(todo) = data.todos.iter_mut().find(|t| t.id == *id) {
                todo.in_progress = true;
                todo.timer_started_at = Some(now);
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
    store: tauri::State<DataStore>,
    task_id: String,
) -> Result<(), String> {
    let label = format!("page_{}", task_id);

    // If window already exists, just focus it
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    // Get task title for window header
    let data = store.data.lock().unwrap();
    let _title = data
        .todos
        .iter()
        .find(|t| t.id == task_id)
        .map(|t| t.title.clone())
        .unwrap_or_else(|| "Notes".to_string());
    drop(data);

    let url = tauri::WebviewUrl::App("page.html".into());

    let mut builder = tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title(&_title)
        .inner_size(480.0, 560.0)
        .min_inner_size(320.0, 300.0);

    // Position page window beside the main window instead of centered
    if let Some(main_win) = app.get_webview_window("main") {
        if let (Ok(pos), Ok(size)) = (main_win.outer_position(), main_win.outer_size()) {
            let main_x = pos.x as f64;
            let main_y = pos.y as f64;
            let main_w = size.width as f64;
            let gap = 16.0;
            // Try right side first; the window will auto-clamp if off-screen
            let page_x = main_x + main_w + gap;
            builder = builder.position(page_x, main_y);
        }
    } else {
        builder = builder.center();
    }

    builder
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn close_page_window(app: AppHandle, task_id: String) {
    let label = format!("page_{}", task_id);
    if let Some(win) = app.get_webview_window(&label) {
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
fn save_page(store: tauri::State<DataStore>, task_id: String, content: String) {
    let pages_dir = store.path.parent().unwrap().join("pages");
    let _ = fs::create_dir_all(&pages_dir);
    let page_path = pages_dir.join(format!("{}.txt", task_id));
    let _ = fs::write(page_path, content);
}

#[tauri::command]
fn delete_page(store: tauri::State<DataStore>, app: AppHandle, task_id: String) {
    // Close page window if open
    let label = format!("page_{}", task_id);
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
    // Delete page file
    let pages_dir = store.path.parent().unwrap().join("pages");
    let page_path = pages_dir.join(format!("{}.txt", task_id));
    let _ = fs::remove_file(page_path);
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

            app.manage(store);

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
