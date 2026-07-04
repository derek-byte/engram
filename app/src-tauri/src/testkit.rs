//! Test-only helpers: locate a real `bun` and materialize a stub engram repo so
//! the supervisor logic (spawn → readiness → kill; synthesis-run spawn) can be
//! exercised end-to-end against a real child process, no GUI required.

use std::path::PathBuf;
use std::process::Command;
use std::time::SystemTime;

/// A stub `src/index.ts` that answers both commands the app spawns:
/// `ui --port N` (a 200-on-everything Bun server) and `synthesis-run`
/// (append its argv to `$ENGRAM_DIR/spawn.log`, falling back to cwd).
const STUB_INDEX: &str = r#"
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const cmd = process.argv[2];
if (cmd === 'ui') {
  const i = process.argv.indexOf('--port');
  const port = Number(i >= 0 ? process.argv[i + 1] : 7777);
  Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch() {
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    },
  });
  console.log('stub ui ready on ' + port);
} else if (cmd === 'synthesis-run') {
  const dir = process.env.ENGRAM_DIR ?? process.cwd();
  appendFileSync(join(dir, 'spawn.log'), process.argv.slice(2).join(' ') + '\n');
  console.log('stub synthesis-run done');
}
"#;

pub fn find_bun() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("ENGRAM_APP_BUN") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let hb = PathBuf::from("/opt/homebrew/bin/bun");
    if hb.exists() {
        return Some(hb);
    }
    let out = Command::new("which").arg("bun").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string());
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

fn unique(prefix: &str) -> PathBuf {
    let n = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("engram-{prefix}-{}-{n}", std::process::id()))
}

/// Create a temp stub repo with `src/index.ts` and return its root.
pub fn stub_repo() -> PathBuf {
    let root = unique("stub-repo");
    let src = root.join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("index.ts"), STUB_INDEX).unwrap();
    root
}

/// Create a temp dir (e.g. a stand-in for `~/.engram`) and return it.
pub fn temp_dir(prefix: &str) -> PathBuf {
    let p = unique(prefix);
    std::fs::create_dir_all(&p).unwrap();
    p
}
