#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{ipc::Response, State};

const WIN_TAIL: &str = "Saved Games/Frontier Developments/Elite Dangerous";
const PROTON_TAIL: &str = "steamapps/compatdata/359320/pfx/drive_c/users/steamuser/Saved Games/Frontier Developments/Elite Dangerous";

#[derive(Default)]
struct AppState {
    journal: Mutex<Option<Option<PathBuf>>>, // outer None = not yet detected
    pinned: Mutex<Option<Option<String>>>,   // set_journal_dir this session; Some(None) = cleared
}

fn home() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

fn config_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        return d.into();
    }
    if cfg!(windows) {
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(home()).join("AppData/Roaming"));
    }
    if cfg!(target_os = "macos") {
        return PathBuf::from(home()).join("Library/Application Support");
    }
    PathBuf::from(home()).join(".config")
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

fn journal_patterns() -> Vec<String> {
    let h = home();
    let mut v = vec![
        format!("{h}/{WIN_TAIL}"),
        format!("{h}/OneDrive/{WIN_TAIL}"),
    ];
    if let Ok(u) = std::env::var("USERPROFILE") {
        v.push(format!("{u}/{WIN_TAIL}"));
    }
    v.push(format!("{h}/.local/share/Steam/{PROTON_TAIL}"));
    v.push(format!("{h}/.steam/steam/{PROTON_TAIL}"));
    v.push(format!("/media/*/SteamLibrary/{PROTON_TAIL}"));
    v.push(format!("/mnt/*/SteamLibrary/{PROTON_TAIL}"));
    v.push(format!("?:/SteamLibrary/{PROTON_TAIL}"));
    v.push(format!("?:/Program Files (x86)/Steam/{PROTON_TAIL}"));
    v.dedup();
    v
}

/// Newest Journal.*.log mtime wins; `override_dir` wins if it exists.
fn find_journal_dir(override_dir: Option<&str>, patterns: &[String]) -> Option<PathBuf> {
    if let Some(o) = override_dir.map(PathBuf::from).filter(|p| p.is_dir()) {
        return Some(o);
    }
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    for pat in patterns {
        let Ok(paths) = glob::glob(pat) else { continue };
        for d in paths.flatten() {
            let Ok(logs) = glob::glob(&format!("{}/Journal.*.log", d.display())) else { continue };
            let m = logs
                .flatten()
                .filter_map(|f| f.metadata().ok()?.modified().ok())
                .max();
            if let Some(m) = m {
                if best.as_ref().map_or(true, |(_, b)| m > *b) {
                    best = Some((d, m));
                }
            }
        }
    }
    best.map(|(d, _)| d)
}

/// The folder the user chose: this session's pick, else the page's saved one
/// ("" = chose auto-detect), else the old Python app's `journal_dir`.
fn override_dir(pinned: Option<Option<String>>, store: Option<&Value>, legacy: Option<&Value>) -> Option<String> {
    let nonempty = |s: &str| (!s.is_empty()).then(|| s.to_string());
    pinned.unwrap_or_else(|| match store.and_then(|v| v["cgbuy.journalDir"].as_str()) {
        Some(s) => nonempty(s),
        None => legacy.and_then(|v| v["journal_dir"].as_str()).and_then(nonempty),
    })
}

fn journal_path(state: &AppState) -> Option<PathBuf> {
    let mut g = state.journal.lock().unwrap();
    g.get_or_insert_with(|| {
        let d = config_dir();
        let o = override_dir(
            state.pinned.lock().unwrap().clone(),
            read_json(&d.join("cgbuy-desktop.json")).as_ref(),
            read_json(&d.join("cgbuy.json")).as_ref(),
        );
        find_journal_dir(o.as_deref(), &journal_patterns())
    })
    .clone()
}

/// Point the journal reader at `path` (None = back to auto-detect) and return
/// the folder now in use. The page saves the choice in its own store.
#[tauri::command]
fn set_journal_dir(state: State<AppState>, path: Option<String>) -> Result<Option<String>, String> {
    let path = path.filter(|p| !p.trim().is_empty());
    if let Some(p) = &path {
        if !Path::new(p).is_dir() {
            return Err(format!("{p} is not a folder"));
        }
    }
    *state.pinned.lock().unwrap() = Some(path);
    *state.journal.lock().unwrap() = None;
    Ok(journal_path(&state).map(|p| p.to_string_lossy().into_owned()))
}

fn safe_name(name: &str) -> bool {
    !name.is_empty() && name != "." && !name.contains("..") && !name.contains(['/', '\\', '\0'])
}

#[tauri::command]
fn journal_dir(state: State<AppState>) -> Option<String> {
    journal_path(&state).map(|p| p.to_string_lossy().into_owned())
}

#[derive(Serialize)]
struct Entry {
    name: String,
    size: u64,
    mtime_ms: u64,
}

#[tauri::command]
fn journal_list(state: State<AppState>) -> Result<Vec<Entry>, String> {
    let dir = journal_path(&state).ok_or("no journal folder")?;
    let mut out = vec![];
    for e in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let Ok(m) = e.metadata() else { continue };
        if !m.is_file() {
            continue;
        }
        let mtime_ms = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        out.push(Entry { name: e.file_name().to_string_lossy().into_owned(), size: m.len(), mtime_ms });
    }
    Ok(out)
}

#[tauri::command]
fn journal_read(state: State<AppState>, name: String, offset: u64) -> Result<Response, String> {
    use std::io::{Read, Seek, SeekFrom};
    if !safe_name(&name) {
        return Err("bad file name".into());
    }
    let dir = journal_path(&state).ok_or("no journal folder")?;
    let mut f = std::fs::File::open(dir.join(name)).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let mut buf = vec![];
    if offset <= len {
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    }
    Ok(Response::new(buf))
}

#[tauri::command]
fn config_load() -> Value {
    let d = config_dir();
    serde_json::json!({
        "store": read_json(&d.join("cgbuy-desktop.json")),
        "legacy": read_json(&d.join("cgbuy.json")),
    })
}

#[tauri::command]
fn config_save(store: Value) -> Result<(), String> {
    let d = config_dir();
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let tmp = d.join("cgbuy-desktop.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&store).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, d.join("cgbuy-desktop.json")).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            journal_dir, set_journal_dir, journal_list, journal_read, config_load, config_save
        ])
        .run(tauri::generate_context!())
        .expect("error while running cgbuy");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    #[test]
    fn override_order() {
        let store = serde_json::json!({ "cgbuy.journalDir": "/s" });
        let legacy = serde_json::json!({ "journal_dir": "/l" });
        let o = |p, s, l| override_dir(p, s, l);
        assert_eq!(o(None, Some(&store), Some(&legacy)).as_deref(), Some("/s"));
        assert_eq!(o(None, None, Some(&legacy)).as_deref(), Some("/l"));
        assert_eq!(o(Some(Some("/p".into())), Some(&store), None).as_deref(), Some("/p"));
        assert_eq!(o(Some(None), Some(&store), Some(&legacy)), None);
        assert_eq!(o(None, None, None), None);
        let cleared = serde_json::json!({ "cgbuy.journalDir": "" });
        assert_eq!(o(None, Some(&cleared), Some(&legacy)), None);
    }

    #[test]
    fn names() {
        assert!(safe_name("Journal.2024-01-01T000000.01.log"));
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", "..\\x", "a..b"] {
            assert!(!safe_name(bad), "{bad}");
        }
    }

    #[test]
    fn newest_journal_wins_and_override() {
        let t = tempfile::tempdir().unwrap();
        let mk = |n: &str, age: u64| {
            let d = t.path().join(n);
            std::fs::create_dir(&d).unwrap();
            let f = std::fs::File::create(d.join("Journal.1.log")).unwrap();
            f.set_modified(SystemTime::now() - Duration::from_secs(age)).unwrap();
            d
        };
        let old = mk("old", 1000);
        let new = mk("new", 10);
        let pats = vec![
            format!("{}/old", t.path().display()),
            format!("{}/*", t.path().display()),
            format!("{}/missing", t.path().display()),
        ];
        assert_eq!(find_journal_dir(None, &pats), Some(new));
        assert_eq!(find_journal_dir(Some(old.to_str().unwrap()), &pats), Some(old));
        assert_eq!(find_journal_dir(Some("/nonexistent/x"), &[]), None);
    }
}
