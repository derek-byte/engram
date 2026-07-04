use std::path::{Path, PathBuf};
use std::process::Command;

/// Resolved filesystem seams the app needs. All three are env-overridable so the
/// tester can point the app at a stub repo / temp engram dir with zero live-data
/// risk. The bun CLI itself does NOT honor these — they are Rust-side only.
#[derive(Clone, Debug)]
pub struct Paths {
    /// Absolute path to the `bun` executable.
    pub bun: PathBuf,
    /// engram repo root (cwd for spawned CLI children so Bun auto-loads `.env`).
    pub repo_root: PathBuf,
    /// `~/.engram` (logs + synthesis.lock live here).
    pub engram_dir: PathBuf,
}

impl Paths {
    pub fn resolve() -> Self {
        Paths {
            bun: resolve_bun(),
            repo_root: resolve_repo_root(),
            engram_dir: resolve_engram_dir(),
        }
    }

    /// Whether the resolved bun + repo entrypoint actually exist on disk.
    pub fn validate(&self) -> Result<(), String> {
        if !self.bun.exists() {
            return Err(format!("bun not found at {}", self.bun.display()));
        }
        let entry = self.repo_root.join("src").join("index.ts");
        if !entry.exists() {
            return Err(format!("engram CLI not found at {}", entry.display()));
        }
        Ok(())
    }

    pub fn synthesis_lock(&self) -> PathBuf {
        self.engram_dir.join("synthesis.lock")
    }

    pub fn ui_log(&self) -> PathBuf {
        self.engram_dir.join("app-ui.log")
    }

    pub fn synthesis_log(&self) -> PathBuf {
        self.engram_dir.join("app-synthesis.log")
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn resolve_bun() -> PathBuf {
    if let Some(p) = std::env::var_os("ENGRAM_APP_BUN") {
        return PathBuf::from(p);
    }
    if let Some(p) = which_bun() {
        return p;
    }
    let candidates = [
        PathBuf::from("/opt/homebrew/bin/bun"),
        home().join(".bun").join("bin").join("bun"),
    ];
    for c in candidates {
        if c.exists() {
            return c;
        }
    }
    // Last resort: bare name, resolved via PATH at spawn time.
    PathBuf::from("bun")
}

fn which_bun() -> Option<PathBuf> {
    let out = Command::new("which").arg("bun").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return None;
    }
    let p = PathBuf::from(path);
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

fn resolve_repo_root() -> PathBuf {
    if let Some(p) = std::env::var_os("ENGRAM_APP_REPO") {
        return PathBuf::from(p);
    }
    // CARGO_MANIFEST_DIR = <repo>/app/src-tauri → up two = <repo>.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(|p| p.parent())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| manifest.to_path_buf())
}

fn resolve_engram_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("ENGRAM_DIR") {
        return PathBuf::from(p);
    }
    home().join(".engram")
}
