use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime};

use crate::paths::Paths;

/// Mirror of `STALE_MS` in src/commands/synthesisLock.ts. A lock older than this
/// is considered stale (the CLI reclaims it), so no run is actually active.
pub const STALE: Duration = Duration::from_secs(30 * 60);

/// True iff a synthesis run is active: the lock file exists AND its mtime is
/// fresher than STALE relative to `now`. READ-ONLY — never creates/deletes it.
/// A clock skew that puts mtime in the future counts as active (age 0).
pub fn synthesis_active(lock_path: &Path, now: SystemTime) -> bool {
    let Ok(meta) = std::fs::metadata(lock_path) else {
        return false;
    };
    let Ok(mtime) = meta.modified() else {
        return false;
    };
    match now.duration_since(mtime) {
        Ok(age) => age < STALE,
        Err(_) => true, // mtime is in the future → treat as fresh.
    }
}

/// Spawn `bun run src/index.ts synthesis-run` (cwd = repo root; output appended
/// to app-synthesis.log). The CLI takes the shared advisory lock itself and
/// exits `{skipped:'locked'}` if held — this is a UX guard, not the correctness one.
pub fn spawn_synthesis_run(paths: &Paths) -> io::Result<Child> {
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.synthesis_log())?;
    let err = log.try_clone()?;
    Command::new(&paths.bun)
        .args(["run", "src/index.ts", "synthesis-run"])
        .current_dir(&paths.repo_root)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .stdin(Stdio::null())
        .spawn()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn temp_lock() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let uniq = format!(
            "engram-test-lock-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        p.push(uniq);
        std::fs::write(&p, b"12345\n").unwrap();
        p
    }

    #[test]
    fn missing_lock_is_inactive() {
        let p = std::env::temp_dir().join("engram-test-does-not-exist-xyz");
        let _ = std::fs::remove_file(&p);
        assert!(!synthesis_active(&p, SystemTime::now()));
    }

    #[test]
    fn fresh_lock_is_active_at_0_and_29_min() {
        let p = temp_lock();
        let mtime = std::fs::metadata(&p).unwrap().modified().unwrap();
        assert!(synthesis_active(&p, mtime), "age 0 must be active");
        assert!(
            synthesis_active(&p, mtime + Duration::from_secs(29 * 60)),
            "29 min must be active"
        );
        std::fs::remove_file(&p).unwrap();
    }

    #[test]
    fn stale_lock_is_inactive_at_31_min() {
        let p = temp_lock();
        let mtime = std::fs::metadata(&p).unwrap().modified().unwrap();
        assert!(
            !synthesis_active(&p, mtime + Duration::from_secs(31 * 60)),
            "31 min must be inactive"
        );
        std::fs::remove_file(&p).unwrap();
    }

    #[test]
    fn future_mtime_counts_as_active() {
        let p = temp_lock();
        let mtime = std::fs::metadata(&p).unwrap().modified().unwrap();
        // now earlier than mtime → duration_since errs → active.
        let earlier = mtime - Duration::from_secs(60);
        assert!(synthesis_active(&p, earlier));
        std::fs::remove_file(&p).unwrap();
    }

    // Real spawn of `synthesis-run` against the stub: confirms cwd + argv wiring.
    // The stub appends its argv to spawn.log (in cwd = repo root here).
    #[test]
    fn spawn_synthesis_run_invokes_cli() {
        let Some(bun) = crate::testkit::find_bun() else {
            eprintln!("skip spawn_synthesis_run_invokes_cli: bun not found");
            return;
        };
        let repo = crate::testkit::stub_repo();
        let engram = crate::testkit::temp_dir("engram-syn");
        let paths = Paths {
            bun,
            repo_root: repo.clone(),
            engram_dir: engram.clone(),
        };
        let mut child = spawn_synthesis_run(&paths).expect("spawn synthesis-run");
        let status = child.wait().expect("wait synthesis-run");
        assert!(status.success(), "synthesis-run exited non-zero");
        // stub writes to cwd (= repo root) when ENGRAM_DIR is unset.
        let log = std::fs::read_to_string(repo.join("spawn.log")).expect("spawn.log written");
        assert!(log.contains("synthesis-run"), "argv not logged: {log}");

        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&engram);
    }
}
