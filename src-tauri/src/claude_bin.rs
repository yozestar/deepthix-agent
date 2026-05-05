//! Cross-platform `claude` CLI resolution + spawn helpers.
//!
//! Why this module exists:
//!
//! 1. macOS GUI apps inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`)
//!    so a Finder-launched build cannot see `~/.local/bin`, npm/bun/nvm/volta,
//!    or `/opt/homebrew/bin`. The resolver below walks a hand-rolled list of
//!    every place modern installers actually drop the binary.
//!
//! 2. Windows installs claude as a `.cmd` shim (`%APPDATA%\npm\claude.cmd`).
//!    `Command::new("claude.cmd").spawn()` fails with **OS error 193**
//!    ("%1 is not a valid Win32 application") because `CreateProcess` won't
//!    execute batch files directly. The build helpers wrap `.cmd`/`.bat`
//!    with `cmd.exe /C` and `.ps1` with `powershell.exe -File`.

use portable_pty::CommandBuilder;
use std::path::{Path, PathBuf};
use std::process::Command;

// Windows: suppress the console window that would otherwise pop up
// when a GUI process spawns a console child (cmd.exe, powershell.exe,
// or claude.exe itself if it's a console app). Without this flag the
// user sees an external terminal window flash open every time a chat
// session spawns — exactly the v0.3.7 regression report.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Find the claude CLI binary. Returns `Err` with a helpful install hint
/// if nothing matches.
pub fn resolve() -> Result<PathBuf, String> {
    if let Some(p) = resolve_opt() {
        return Ok(p);
    }
    Err(claude_not_found_message())
}

/// Same as [`resolve`] but returns `None` instead of an error message.
pub fn resolve_opt() -> Option<PathBuf> {
    let names = candidate_names();

    // 1. PATH walk — works in `npm run dev` from terminal and is the
    //    happy path for users who launched Deepthix Agent from a shell.
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in names {
                let p = dir.join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }

    // 2. Shell out to `which`/`where` — same caveat as #1 but it's free
    //    and occasionally rescues installs PATH didn't catch.
    if let Some(p) = shell_lookup() {
        return Some(p);
    }

    // 3. Hand-rolled candidates — what actually rescues GUI launches.
    candidate_paths().into_iter().find(|p| p.is_file())
}

/// Build a `std::process::Command` ready to run claude. On Windows wraps
/// `.cmd`/`.bat` shims with `cmd.exe /C` so `CreateProcess` doesn't fail
/// with OS error 193, and `.ps1` shims with `powershell.exe -File`. All
/// three Windows variants get `CREATE_NO_WINDOW` so no terminal pops
/// up — chat-mode claude is piped, the UI doesn't want a visible
/// console.
pub fn build_command(bin: &Path) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = match shim_kind(bin) {
            ShimKind::Cmd => {
                let mut c = Command::new("cmd.exe");
                c.arg("/C").arg(bin);
                c
            }
            ShimKind::PowerShell => {
                let mut c = Command::new("powershell.exe");
                c.arg("-NoProfile").arg("-File").arg(bin);
                c
            }
            ShimKind::Direct => Command::new(bin),
        };
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new(bin)
    }
}

/// Same as [`build_command`] but for portable-pty (which speaks
/// `CommandBuilder`, not `std::process::Command`).
pub fn build_pty_command_builder(bin: &Path) -> CommandBuilder {
    #[cfg(windows)]
    {
        match shim_kind(bin) {
            ShimKind::Cmd => {
                let mut cmd = CommandBuilder::new("cmd.exe");
                cmd.arg("/C");
                cmd.arg(bin);
                cmd
            }
            ShimKind::PowerShell => {
                let mut cmd = CommandBuilder::new("powershell.exe");
                cmd.arg("-NoProfile");
                cmd.arg("-File");
                cmd.arg(bin);
                cmd
            }
            ShimKind::Direct => CommandBuilder::new(bin),
        }
    }
    #[cfg(not(windows))]
    {
        CommandBuilder::new(bin)
    }
}

#[cfg(windows)]
enum ShimKind {
    Cmd,
    PowerShell,
    Direct,
}

#[cfg(windows)]
fn shim_kind(bin: &Path) -> ShimKind {
    let ext = bin
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("cmd") | Some("bat") => ShimKind::Cmd,
        Some("ps1") => ShimKind::PowerShell,
        _ => ShimKind::Direct,
    }
}

fn candidate_names() -> &'static [&'static str] {
    #[cfg(windows)]
    {
        // Order matters: .cmd is the npm-shim default on Windows, .exe
        // is what the Anthropic native installer drops.
        &["claude.cmd", "claude.exe", "claude.bat", "claude.ps1", "claude"]
    }
    #[cfg(not(windows))]
    {
        &["claude"]
    }
}

fn shell_lookup() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let out = Command::new("which").arg("claude").output().ok()?;
        if !out.status.success() {
            return None;
        }
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if p.is_empty() {
            return None;
        }
        let pb = PathBuf::from(p);
        if pb.is_file() { Some(pb) } else { None }
    }
    #[cfg(windows)]
    {
        // `where` prints every match on its own line, picks up PATHEXT
        // (so `where claude` finds `claude.cmd`). CREATE_NO_WINDOW so
        // the user doesn't see a console flash on every app launch.
        use std::os::windows::process::CommandExt;
        let out = Command::new("where")
            .arg("claude")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        for line in stdout.lines() {
            let p = line.trim();
            if p.is_empty() {
                continue;
            }
            let pb = PathBuf::from(p);
            if pb.is_file() {
                return Some(pb);
            }
        }
        None
    }
}

fn candidate_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    #[cfg(unix)]
    {
        out.extend([
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
            PathBuf::from("/usr/bin/claude"),
        ]);
        if let Ok(home) = std::env::var("HOME") {
            let hp = PathBuf::from(home);
            out.extend([
                hp.join(".local/bin/claude"),       // Anthropic native installer / pipx
                hp.join(".npm-global/bin/claude"),  // npm with --prefix
                hp.join(".bun/bin/claude"),         // Bun
                hp.join(".volta/bin/claude"),       // Volta
                hp.join(".cargo/bin/claude"),       // Cargo (rare but cheap)
            ]);
            // NVM: scan every installed node version.
            let nvm_versions = hp.join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                for e in entries.flatten() {
                    out.push(e.path().join("bin/claude"));
                }
            }
        }
    }

    #[cfg(windows)]
    {
        let appdata = std::env::var("APPDATA").ok();
        let local_appdata = std::env::var("LOCALAPPDATA").ok();
        let user_profile = std::env::var("USERPROFILE").ok();
        let program_files = std::env::var("ProgramFiles").ok();

        // npm global: %APPDATA%\npm\claude.cmd is the default install
        // location for `npm i -g @anthropic-ai/claude-code` on Windows.
        if let Some(p) = appdata.as_ref() {
            let base = PathBuf::from(p).join("npm");
            for name in ["claude.cmd", "claude.exe", "claude.ps1"] {
                out.push(base.join(name));
            }
        }
        if let Some(p) = local_appdata.as_ref() {
            let base = PathBuf::from(p);
            // Anthropic-style installers
            for name in ["claude.exe", "claude.cmd"] {
                out.push(base.join("Programs").join("claude").join(name));
            }
            // Volta on Windows
            for name in ["claude.cmd", "claude.exe"] {
                out.push(base.join("Volta").join("bin").join(name));
            }
            // pnpm global
            for name in ["claude.cmd", "claude.exe"] {
                out.push(base.join("pnpm").join(name));
            }
        }
        if let Some(p) = user_profile.as_ref() {
            let up = PathBuf::from(p);
            // Scoop shims
            for name in ["claude.cmd", "claude.exe"] {
                out.push(up.join("scoop").join("shims").join(name));
            }
            // Bun
            for name in ["claude.exe", "claude.cmd"] {
                out.push(up.join(".bun").join("bin").join(name));
            }
            // Anthropic native installer (parallels ~/.local/bin on Unix)
            for name in ["claude.exe", "claude.cmd", "claude.ps1"] {
                out.push(up.join(".local").join("bin").join(name));
            }
        }
        if let Some(p) = program_files.as_ref() {
            let pf = PathBuf::from(p);
            for name in ["claude.cmd", "claude.exe"] {
                out.push(pf.join("nodejs").join(name));
            }
            for name in ["claude.exe", "claude.cmd"] {
                out.push(pf.join("Anthropic").join("Claude").join(name));
            }
        }
    }

    out
}

fn claude_not_found_message() -> String {
    #[cfg(windows)]
    {
        "claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code (drops it at %APPDATA%\\npm\\claude.cmd) or use the Anthropic native installer.".to_string()
    }
    #[cfg(not(windows))]
    {
        "claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code, brew install claude, or use the Anthropic native installer (drops it at ~/.local/bin/claude).".to_string()
    }
}
