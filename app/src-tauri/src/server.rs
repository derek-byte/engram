use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::paths::Paths;

const READY_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const MAX_ATTEMPTS: u32 = 3;

/// A supervised `engram ui` child bound to a loopback port.
pub struct UiServer {
    pub port: u16,
    pub child: Child,
}

impl UiServer {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }

    /// Kill the child and reap it. Best-effort; safe to call more than once.
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Bind :0 to let the OS hand us a free port, read it, then drop the listener so
/// the bun child can grab it. A pathological squatter is handled by the caller's
/// retry-with-new-port loop.
pub fn pick_free_port() -> io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    Ok(port)
}

/// Spawn `bun run src/index.ts ui --port <port>` with cwd = repo root (so Bun
/// auto-loads the repo `.env`, i.e. OPENAI_API_KEY) and stdio appended to the log.
pub fn spawn_ui(paths: &Paths, port: u16) -> io::Result<Child> {
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.ui_log())?;
    let err = log.try_clone()?;
    Command::new(&paths.bun)
        .args(["run", "src/index.ts", "ui", "--port", &port.to_string()])
        .current_dir(&paths.repo_root)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .stdin(Stdio::null())
        .spawn()
}

/// One readiness probe: raw HTTP/1.1 GET /api/stats, success iff the status line
/// carries `200`. No HTTP-client crate — the route is the cheap existing one.
pub fn probe_ready(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let req = format!(
        "GET /api/stats HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

/// Read the last `n` non-empty lines of the ui log, for error dialogs.
pub fn log_tail(paths: &Paths, n: usize) -> String {
    let Ok(contents) = std::fs::read_to_string(paths.ui_log()) else {
        return String::new();
    };
    let lines: Vec<&str> = contents.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Start the ui server: up to MAX_ATTEMPTS spawns, re-picking a port each time
/// (covers the free-port race), each awaited to readiness within READY_TIMEOUT.
/// Errors carry the tail of the ui log so the caller can surface it.
pub fn start(paths: &Paths) -> Result<UiServer, String> {
    let mut last_err = String::from("ui server did not become ready");
    for attempt in 1..=MAX_ATTEMPTS {
        let port = match pick_free_port() {
            Ok(p) => p,
            Err(e) => {
                last_err = format!("could not pick a free port: {e}");
                continue;
            }
        };
        let mut child = match spawn_ui(paths, port) {
            Ok(c) => c,
            Err(e) => {
                last_err = format!("failed to spawn bun: {e}");
                continue;
            }
        };
        match await_ready(&mut child, port) {
            Ok(()) => return Ok(UiServer { port, child }),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                last_err = e;
                if attempt < MAX_ATTEMPTS {
                    std::thread::sleep(Duration::from_millis(500 * attempt as u64));
                }
            }
        }
    }
    Err(format!("{last_err}\n{}", log_tail(paths, 10)))
}

/// Poll for readiness, bailing early if the child exits before serving.
fn await_ready(child: &mut Child, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!("ui child exited early ({status}) before readiness"));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("failed to poll ui child: {e}")),
        }
        if probe_ready(port) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("ui server readiness timed out (20s)".to_string());
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_port_is_bindable() {
        let port = pick_free_port().expect("should pick a port");
        assert!(port > 0);
        // The port must be immediately bindable (listener was dropped).
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).expect("port must be bindable");
        drop(l);
    }

    #[test]
    fn probe_ready_false_when_nothing_listening() {
        // pick_free_port drops the listener, so nothing is serving there.
        let port = pick_free_port().unwrap();
        assert!(!probe_ready(port));
    }

    // End-to-end supervisor lifecycle against a real bun child (no GUI): spawn
    // `ui --port N`, poll to readiness, confirm it serves, kill, confirm the port
    // is no longer served (no orphan). Skips cleanly if bun isn't installed.
    #[test]
    fn ui_lifecycle_spawn_ready_kill() {
        let Some(bun) = crate::testkit::find_bun() else {
            eprintln!("skip ui_lifecycle_spawn_ready_kill: bun not found");
            return;
        };
        let repo = crate::testkit::stub_repo();
        let engram = crate::testkit::temp_dir("engram");
        let paths = Paths {
            bun,
            repo_root: repo.clone(),
            engram_dir: engram.clone(),
        };

        let mut srv = start(&paths).expect("stub ui server should reach readiness");
        let port = srv.port;
        assert!(probe_ready(port), "server must serve 200 on /api/stats");

        srv.kill();
        // Give the OS a moment to tear the listener down.
        for _ in 0..40 {
            if !probe_ready(port) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!probe_ready(port), "no orphan should serve after kill");

        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&engram);
    }
}
