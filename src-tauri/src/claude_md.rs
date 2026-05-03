// Idempotent injection of the Deepthix dashboard convention into a
// project's `CLAUDE.md`. Called when a new project is added so every
// claude session in that project knows it can publish a live HTML
// dashboard via $DEEPTHIX_DASHBOARD_PATH (set by pty.rs::spawn_claude).
//
// We delimit our block with HTML-comment markers so subsequent runs can
// detect, replace, or skip our content WITHOUT clobbering whatever the
// user has written around it. If the markers exist the block between
// them is overwritten (so we can iterate on the wording without leaving
// stale copies behind); if the file exists but our block doesn't, we
// append; if the file doesn't exist, we create it.
//
// All operations are best-effort: a failure to write CLAUDE.md must not
// block the project from being added (the caller logs and ignores).

use std::path::Path;

const BEGIN: &str = "<!-- DEEPTHIX_DASHBOARD_BEGIN -->";
const END: &str = "<!-- DEEPTHIX_DASHBOARD_END -->";

/// The block we inject. Kept short on purpose — long instructions get
/// ignored by claude in busy sessions. Uses $DEEPTHIX_DASHBOARD_PATH
/// (which pty.rs::spawn_claude sets) so the same text works for every
/// session without needing the per-session UUID baked in.
fn block() -> String {
    let body = r#"## Deepthix Dashboard

This project is being run inside the Deepthix Agent. The OVERVIEW pane shows
ONE shared HTML iframe per project — every session in this project writes to
the same `dashboard.html`. Treat it as the project's status board: any session
that does meaningful work updates it so the user (and the other sessions) get
a glanceable snapshot.

- The path is in the `DEEPTHIX_DASHBOARD_PATH` environment variable. Use the
  Write tool with that exact path. (Same path for every session in this
  project — last writer wins; merge thoughtfully when you change it.)
- Self-contained HTML only (inline CSS, no external network). The iframe
  has `sandbox="allow-scripts"` so inline `<script>` works for charts/counters
  but `fetch` to other origins is blocked.
- Update by overwriting the file. The OVERVIEW iframe re-renders within ~2s
  of the file's mtime changing.
- Show: current task, key facts the user asked you to track, blockers, what
  you need from them next. Aim for ~100 lines max so it stays glanceable.

### Custom action buttons

Any element in the dashboard with a `data-deepthix-action="..."` attribute
becomes an interactive button that, when clicked, types the action label
into THIS session's prompt and submits it. Use this to give the user one-click
shortcuts for things they would otherwise have to type:

```html
<button data-deepthix-action="refresh meta ads dashboard">Refresh</button>
<button data-deepthix-action="run health check on production">Health check</button>
<button data-deepthix-action="show last 24h errors" data-deepthix-payload="prod">Errors (prod)</button>
```

Optional `data-deepthix-payload` is appended to the action with a single space.
The shim wiring is injected automatically — no need to write `postMessage`
yourself. Style buttons however you like; click handling is delegated.

### Notifications

Use the `mcp__deepthix-mcp__notify_user` tool to push a toast (and a macOS
banner) to the user. Reserve it for things they actually need to react to —
build done, tests failed, ambiguous decision. The user is watching multiple
sessions; every notification interrupts whatever they're looking at.

Args: `title` (required, ~5-8 words), `body` (optional one-line detail),
`kind` (`info` | `success` | `warn` | `error`), `source` (free-form origin tag,
ideally the session label so the user knows who fired it).
"#;
    format!("{BEGIN}\n{body}{END}\n")
}

/// Ensure `<project_root>/CLAUDE.md` contains the dashboard block.
/// Returns `true` if the file was created or modified, `false` if it
/// already had an up-to-date copy.
pub fn inject_into_project(project_root: &Path) -> std::io::Result<bool> {
    let path = project_root.join("CLAUDE.md");
    let new_block = block();

    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };

    let next = match existing {
        None => new_block,
        Some(content) => {
            if let (Some(begin_idx), Some(end_idx)) = (content.find(BEGIN), content.find(END)) {
                if end_idx <= begin_idx {
                    // Marker order is corrupted — bail out rather than mangle.
                    tracing::warn!(target: "deepthix::claude_md", ?path, "marker order corrupted; leaving CLAUDE.md alone");
                    return Ok(false);
                }
                let end_line_end = end_idx + END.len();
                let already = &content[begin_idx..end_line_end];
                // Compare against the trimmed new block (no trailing newline)
                // so we don't churn just because of whitespace differences.
                if already.trim_end() == new_block.trim_end() {
                    return Ok(false);
                }
                let mut out = String::with_capacity(content.len());
                out.push_str(&content[..begin_idx]);
                out.push_str(new_block.trim_end());
                out.push_str(&content[end_line_end..]);
                out
            } else {
                // File exists but no markers — append with a leading blank
                // line so we don't fuse with whatever the user had at the
                // bottom of their existing CLAUDE.md.
                let mut out = content;
                if !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push('\n');
                out.push_str(&new_block);
                out
            }
        }
    };

    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, next.as_bytes())?;
    std::fs::rename(&tmp, &path)?;
    tracing::info!(target: "deepthix::claude_md", ?path, "injected dashboard block");
    Ok(true)
}

// ─── Global Deepthix brief ──────────────────────────────────────────────
// Injected once into ~/.claude/CLAUDE.md (the user-level claude code
// memory) so EVERY claude session — regardless of project — knows about
// the env vars Deepthix exposes and how to use them.

const GLOBAL_BEGIN: &str = "<!-- DEEPTHIX_AGENT_BRIEF_BEGIN -->";
const GLOBAL_END: &str = "<!-- DEEPTHIX_AGENT_BRIEF_END -->";

fn global_brief() -> String {
    let body = r#"## Deepthix Agent — environment hooks

You are running inside the Deepthix Agent desktop app. The app injects
several environment variables into every session and a few JSON files
on disk that you can use to coordinate with the user across sessions.

### `$DEEPTHIX_PROJECT_ID`
Stable id of the Deepthix project this session belongs to. Mostly
informational — log it if you need to disambiguate runs.

### `$DEEPTHIX_DASHBOARD_PATH`
Absolute path to the project's at-a-glance dashboard.html (one per
project). The app's OVERVIEW tab renders it in a sandboxed iframe.
- Use the `Write` tool with that EXACT path to publish a status board.
- Self-contained HTML (inline CSS, no external network — `fetch` is
  blocked). Inline `<script>` works for charts/counters.
- Buttons with `data-deepthix-action="..."` get auto-wired to fire
  that text into THIS session's prompt on click. Use it to give the
  user one-click shortcuts.
- Aim for ~100 lines max. Last writer wins; merge thoughtfully.

### `$DEEPTHIX_WORKFLOWS_PATH`
Absolute path to the global workflows catalog (`workflows.json`). Each
entry is `{id, name, description, prompt, tags, created_ms,
updated_ms}`. The app's WORKFLOW tab lists every entry and lets the
user re-fire any of them with one click.

You can manage workflows directly:
- **List**: `Read $DEEPTHIX_WORKFLOWS_PATH` to see what's saved.
- **Add**: read the file, append a new entry to the JSON array, write
  it back. Required fields: `id` (any unique string), `name`,
  `prompt`. Set `created_ms` and `updated_ms` to the current epoch
  millis if you can.
- **Modify**: edit the entry in place; bump `updated_ms`.
- **Delete**: drop the entry from the array.

When saving a workflow, write a self-contained `prompt` — the future
session won't have any extra context beyond what you put there.

### When to suggest a workflow
If you notice the user re-typing the same kind of request (deploy
steps, sweep scripts, weekly report, daily standup, repetitive
maintenance), proactively offer to save it: "I can save this as a
workflow you can re-run with one click — want me to add it?". On
yes, write it to `$DEEPTHIX_WORKFLOWS_PATH`.

### `$DEEPTHIX_VARIABLES_PATH`
Absolute path to the shared variables catalog (`variables.json`).
Each entry is `{key, value, description, created_ms, updated_ms}`.
The app's VARIABLES tab lists every entry; both the user and you can
read/write them. Use this as a cross-session scratchpad — share
context that should outlive a single conversation.

Examples worth saving:
- `current_sprint = "S-42"` so every session knows the active sprint
- `prod_host = "post2reach.com"` to avoid re-asking the user
- `last_deploy_sha = "abc123"` so a follow-up session can compare

How to use:
- **Look up** a variable before asking the user: `Read $DEEPTHIX_VARIABLES_PATH`
- **Set / update**: read the JSON, upsert the entry by key (replace
  if `key` matches, else append), bump `updated_ms` to the current
  epoch ms, write back.
- **Delete**: drop the entry from the array.

When you're about to ask the user a clarifying question, check the
variables file first — they may have already pinned the answer.
"#;
    format!("{GLOBAL_BEGIN}\n{body}{GLOBAL_END}\n")
}

/// Append the Deepthix brief to `~/.claude/CLAUDE.md` (creating the
/// file if absent). Idempotent — guarded by marker comments. Safe to
/// call on every app boot. Returns `true` if the file was created or
/// modified.
pub fn ensure_global_brief() -> std::io::Result<bool> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no home dir",
            ))
        }
    };
    let dir = home.join(".claude");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("CLAUDE.md");
    let new_block = global_brief();

    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };

    let next = match existing {
        None => new_block,
        Some(content) => {
            if let (Some(begin_idx), Some(end_idx)) =
                (content.find(GLOBAL_BEGIN), content.find(GLOBAL_END))
            {
                if end_idx <= begin_idx {
                    tracing::warn!(
                        target: "deepthix::claude_md",
                        ?path,
                        "global brief markers corrupted; leaving CLAUDE.md alone"
                    );
                    return Ok(false);
                }
                let end_line_end = end_idx + GLOBAL_END.len();
                let already = &content[begin_idx..end_line_end];
                if already.trim_end() == new_block.trim_end() {
                    return Ok(false);
                }
                let mut out = String::with_capacity(content.len());
                out.push_str(&content[..begin_idx]);
                out.push_str(new_block.trim_end());
                out.push_str(&content[end_line_end..]);
                out
            } else {
                let mut out = content;
                if !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push('\n');
                out.push_str(&new_block);
                out
            }
        }
    };

    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, next.as_bytes())?;
    std::fs::rename(&tmp, &path)?;
    tracing::info!(target: "deepthix::claude_md", ?path, "ensured global Deepthix brief");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn creates_file_when_missing() {
        let dir = tempdir().unwrap();
        let modified = inject_into_project(dir.path()).unwrap();
        assert!(modified);
        let body = std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap();
        assert!(body.contains(BEGIN));
        assert!(body.contains(END));
        assert!(body.contains("DEEPTHIX_DASHBOARD_PATH"));
    }

    #[test]
    fn appends_when_no_markers() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("CLAUDE.md");
        std::fs::write(&path, "# My existing rules\n\n- be nice\n").unwrap();
        let modified = inject_into_project(dir.path()).unwrap();
        assert!(modified);
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.starts_with("# My existing rules"), "user content preserved");
        assert!(body.contains(BEGIN));
        assert!(body.contains("DEEPTHIX_DASHBOARD_PATH"));
    }

    #[test]
    fn idempotent_when_block_already_current() {
        let dir = tempdir().unwrap();
        // First call creates it.
        assert!(inject_into_project(dir.path()).unwrap());
        // Second call should be a no-op.
        assert!(!inject_into_project(dir.path()).unwrap());
    }

    #[test]
    fn replaces_when_block_outdated() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("CLAUDE.md");
        // Pretend an older version of the block was injected previously.
        let older = format!(
            "# Project\n\n{BEGIN}\nOLD CONTENT\n{END}\n\n## Other section\n",
        );
        std::fs::write(&path, &older).unwrap();
        assert!(inject_into_project(dir.path()).unwrap());
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(!body.contains("OLD CONTENT"));
        assert!(body.contains("DEEPTHIX_DASHBOARD_PATH"));
        assert!(body.contains("# Project"), "user header preserved");
        assert!(body.contains("## Other section"), "trailing user content preserved");
    }

    #[test]
    fn refuses_to_mangle_when_markers_inverted() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("CLAUDE.md");
        let busted = format!("{END}\n... weird ...\n{BEGIN}\n");
        std::fs::write(&path, &busted).unwrap();
        let modified = inject_into_project(dir.path()).unwrap();
        assert!(!modified, "should refuse to touch corrupted markers");
        let body = std::fs::read_to_string(&path).unwrap();
        assert_eq!(body, busted, "file untouched");
    }
}
