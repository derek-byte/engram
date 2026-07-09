//! Launch-time auto-update: fast-forward the repo to origin/main before the ui
//! server spawns, so every app launch runs the freshest merged code without a
//! reinstall. The Rust shell itself can't hot-swap — when a pull touches
//! app/src-tauri the frontend shows a rebuild banner and `rebuild_shell` runs
//! `make app` detached (build → quit → swap /Applications → relaunch).
//!
//! Dev-safe by construction: the pull runs ONLY when the checkout is on `main`
//! with no tracked changes — a feature branch or dirty tree (normal dev state)
//! skips silently. Never prompts (GIT_TERMINAL_PROMPT=0, ssh BatchMode), and a
//! hung network fetch is killed after PULL_TIMEOUT rather than stalling launch.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::paths::Paths;

const PULL_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Default)]
pub struct UpdateOutcome {
    /// HEAD moved (a fast-forward landed).
    pub pulled: bool,
    /// The pull touched app/src-tauri → the installed shell is now stale.
    pub shell_changed: bool,
    /// Why nothing was pulled (skip reason or error), for the log line.
    pub note: Option<String>,
}

/// One quick git invocation in `root`; stdout on success, Err on any failure.
fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("git spawn failed: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `git pull --ff-only`, killed if the network hangs past PULL_TIMEOUT.
fn pull_with_timeout(root: &Path) -> Result<(), String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["pull", "--ff-only"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=5")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git spawn failed: {e}"))?;
    let deadline = Instant::now() + PULL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                let mut err = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    use std::io::Read;
                    let _ = stderr.read_to_string(&mut err);
                }
                return Err(err.trim().to_string());
            }
            Ok(None) => {}
            Err(e) => return Err(format!("failed to poll git: {e}")),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("pull timed out".to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Guarded launch-time pull. Never blocks past PULL_TIMEOUT, never touches a
/// branch checkout or a dirty tree, and reports rather than errors.
pub fn auto_pull(root: &Path) -> UpdateOutcome {
    let skip = |note: &str| UpdateOutcome { note: Some(note.to_string()), ..Default::default() };

    match git(root, &["symbolic-ref", "--short", "HEAD"]) {
        Ok(branch) if branch == "main" => {}
        Ok(branch) => return skip(&format!("on branch {branch}, not main")),
        Err(e) => return skip(&format!("branch check failed: {e}")),
    }
    match git(root, &["status", "--porcelain", "--untracked-files=no"]) {
        Ok(s) if s.is_empty() => {}
        Ok(_) => return skip("tracked changes in working tree"),
        Err(e) => return skip(&format!("status failed: {e}")),
    }

    let old = match git(root, &["rev-parse", "HEAD"]) {
        Ok(sha) => sha,
        Err(e) => return skip(&format!("rev-parse failed: {e}")),
    };
    if let Err(e) = pull_with_timeout(root) {
        return skip(&format!("pull failed: {e}"));
    }
    let new = match git(root, &["rev-parse", "HEAD"]) {
        Ok(sha) => sha,
        Err(e) => return skip(&format!("rev-parse after pull failed: {e}")),
    };
    if old == new {
        return UpdateOutcome { note: Some("already up to date".to_string()), ..Default::default() };
    }

    let shell_changed = git(root, &["diff", "--name-only", &old, &new, "--", "app/src-tauri"])
        .map(|out| !out.is_empty())
        .unwrap_or(false);
    UpdateOutcome { pulled: true, shell_changed, note: None }
}

/// Append one line to ~/.engram/app-update.log (best-effort).
pub fn log_outcome(paths: &Paths, outcome: &UpdateOutcome) {
    let line = match (&outcome.note, outcome.pulled, outcome.shell_changed) {
        (Some(note), _, _) => format!("skip: {note}"),
        (None, true, true) => "pulled; shell changed — rebuild pending".to_string(),
        (None, true, false) => "pulled".to_string(),
        _ => "no-op".to_string(),
    };
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(paths.update_log()) {
        let _ = writeln!(f, "[auto-update] {line}");
    }
}

/// Spawn `make app` detached from the repo root: build → quit this app → swap
/// /Applications/Engram.app → relaunch. The child survives our exit. PATH is
/// widened because a .app inherits a minimal launchd environment without the
/// toolchain (bun, cargo) a terminal shell has.
pub fn spawn_rebuild(paths: &Paths) -> Result<(), String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut path = std::env::var("PATH").unwrap_or_default();
    for extra in [
        paths.bun.parent().map(|p| p.display().to_string()).unwrap_or_default(),
        format!("{home}/.cargo/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ] {
        if !extra.is_empty() && !path.split(':').any(|p| p == extra) {
            path = format!("{path}:{extra}");
        }
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.update_log())
        .map_err(|e| format!("can't open update log: {e}"))?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    Command::new("make")
        .arg("app")
        .current_dir(&paths.repo_root)
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("failed to spawn make app: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &Path, cmd: &str) {
        let out = Command::new("sh").arg("-c").arg(cmd).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "cmd failed: {cmd}\n{}", String::from_utf8_lossy(&out.stderr));
    }

    // Distinct prefix per test: testkit::unique is timestamp-based and the four
    // tests run concurrently — same-prefix calls can land in the same nanosecond.
    fn temp_git_repo(prefix: &str) -> std::path::PathBuf {
        let dir = crate::testkit::temp_dir(prefix);
        sh(&dir, "git init -q -b main && git config user.email t@t && git config user.name t");
        sh(&dir, "echo hi > f.txt && git add . && git commit -qm init");
        dir
    }

    #[test]
    fn skips_on_feature_branch() {
        let repo = temp_git_repo("upd-branch");
        sh(&repo, "git checkout -qb dev");
        let out = auto_pull(&repo);
        assert!(!out.pulled);
        assert!(out.note.unwrap().contains("not main"));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn skips_on_dirty_tree() {
        let repo = temp_git_repo("upd-dirty");
        sh(&repo, "echo dirty >> f.txt");
        let out = auto_pull(&repo);
        assert!(!out.pulled);
        assert_eq!(out.note.unwrap(), "tracked changes in working tree");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn reports_pull_failure_without_remote_as_skip() {
        let repo = temp_git_repo("upd-noremote");
        let out = auto_pull(&repo);
        assert!(!out.pulled);
        assert!(out.note.unwrap().starts_with("pull failed:"));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn pulls_fast_forward_and_flags_shell_changes() {
        // origin with two commits (the second touches app/src-tauri); clone at
        // the first → auto_pull fast-forwards and sets shell_changed.
        let origin = temp_git_repo("upd-origin");
        let clone = crate::testkit::temp_dir("upd-clone");
        let _ = std::fs::remove_dir_all(&clone);
        sh(origin.parent().unwrap(), &format!(
            "git clone -q {} {}",
            origin.display(),
            clone.display()
        ));
        sh(&clone, "git config user.email t@t && git config user.name t");
        sh(&origin, "mkdir -p app/src-tauri && echo shell > app/src-tauri/x.rs && git add . && git commit -qm shell");

        let out = auto_pull(&clone);
        assert!(out.pulled, "note: {:?}", out.note);
        assert!(out.shell_changed);

        let _ = std::fs::remove_dir_all(&origin);
        let _ = std::fs::remove_dir_all(&clone);
    }
}
