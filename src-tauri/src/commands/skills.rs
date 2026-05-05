// Discover + toggle claude code skills.
//
// Skills live as <dir>/SKILL.md files under three roots:
//   - global:  ~/.claude/skills/<name>/SKILL.md
//   - project: <project>/.claude/skills/<name>/SKILL.md
//   - plugin:  <plugin>/skills/<name>/SKILL.md  (namespaced as plugin:name)
//
// Claude doesn't have a global "disabledSkills" array. The canonical way
// to disable a skill (without deleting it) is to flip
// `disable-model-invocation: true` in the frontmatter. Claude then stops
// auto-loading it, but the user can still invoke it manually via
// `/skill-name`. We expose a UI for that toggle here.
//
// Plugin skills are read-only — we list them so the user knows what's
// active but the toggle is disabled (editing files inside a plugin dir
// would get clobbered on next plugin update).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SkillScope {
    Global,
    Project,
    Plugin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillInfo {
    pub scope: SkillScope,
    /// Display name. Falls back to dir name if `name:` missing in frontmatter.
    pub name: String,
    pub description: String,
    /// Absolute path to the SKILL.md.
    pub path: String,
    /// True when `disable-model-invocation: true` is set.
    pub disabled: bool,
    /// True when `user-invocable: false` is set (skill is hidden from /menu).
    pub hidden_from_menu: bool,
    /// For plugin skills — namespace prefix e.g. "superpowers".
    pub plugin: Option<String>,
}

fn read_skill_md(path: &Path) -> Option<(String, String, bool, bool)> {
    let content = std::fs::read_to_string(path).ok()?;
    let (name, description, disabled, hidden) = parse_frontmatter(&content);
    Some((name, description, disabled, hidden))
}

/// Parse the YAML-ish frontmatter of a SKILL.md and pull just the
/// fields we care about. Returns (name, description, disabled, hidden).
/// We intentionally don't pull in a YAML crate — the frontmatter format
/// is simple enough (key: value, one per line) that a hand-roll handles
/// every real-world case.
fn parse_frontmatter(body: &str) -> (String, String, bool, bool) {
    let mut name = String::new();
    let mut description = String::new();
    let mut disabled = false;
    let mut hidden = false;

    let trimmed = body.trim_start();
    if !trimmed.starts_with("---") {
        return (name, description, disabled, hidden);
    }
    // Drop the leading `---\n`, keep until the next `---`.
    let after_first = &trimmed[3..];
    let end = after_first.find("\n---").map(|i| i).unwrap_or(after_first.len());
    let frontmatter = &after_first[..end];

    for raw_line in frontmatter.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // key: value
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let key = k.trim().to_lowercase();
        let value = v.trim().trim_matches('"').trim_matches('\'').to_string();
        match key.as_str() {
            "name" => name = value,
            "description" => description = value,
            "disable-model-invocation" => {
                disabled = value.eq_ignore_ascii_case("true");
            }
            "user-invocable" => {
                hidden = value.eq_ignore_ascii_case("false");
            }
            _ => {}
        }
    }
    (name, description, disabled, hidden)
}

fn scan_skills_dir(root: &Path, scope: SkillScope, plugin: Option<String>, out: &mut Vec<SkillInfo>) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        // Some dirs (e.g. dotfile metadata) are not skills.
        let dir_name = entry.file_name().to_string_lossy().into_owned();
        if dir_name.starts_with('.') {
            continue;
        }
        let skill_md = dir.join("SKILL.md");
        if !skill_md.exists() {
            // Recurse one level for monorepo-style nested skills.
            scan_skills_dir(&dir, scope.clone(), plugin.clone(), out);
            continue;
        }
        let (mut name, description, disabled, hidden) =
            read_skill_md(&skill_md).unwrap_or_default();
        if name.is_empty() {
            name = dir_name.clone();
        }
        out.push(SkillInfo {
            scope: scope.clone(),
            name,
            description,
            path: skill_md.to_string_lossy().into_owned(),
            disabled,
            hidden_from_menu: hidden,
            plugin: plugin.clone(),
        });
    }
}

fn scan_plugins(root: &Path, out: &mut Vec<SkillInfo>) {
    // Plugin layouts seen in the wild:
    //   ~/.claude/plugins/<plugin>/skills/<skill>/SKILL.md
    //   ~/.claude/plugins/cache/<owner>/<plugin>/<version>/skills/<skill>/SKILL.md
    //   ~/.claude/plugins/cache/temp_git_<hash>/skills/<skill>/SKILL.md
    //   ~/.claude/plugins/marketplaces/<owner>/external_plugins/<plugin>/skills/<skill>/SKILL.md
    //
    // Walk to find every `skills` subdir, then derive the plugin name
    // for each by walking UP from the skills dir until we hit a name
    // that is neither a version (5.1.0, v1.2) nor a hash (12+ hex
    // chars) nor "unknown" nor `temp_git_*`. Reading package.json's
    // `name` field is preferred when present and not version-like —
    // this is what merges superpowers/5.0.7 + superpowers/5.1.0 +
    // temp_git_<hash> (which all have package.json with name=superpowers)
    // into one logical plugin so the dedupe pass collapses them.
    fn walk(dir: &Path, depth: u8, out: &mut Vec<SkillInfo>) {
        if depth > 6 {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "skills" {
                let plugin = infer_plugin_name(&p);
                scan_skills_dir(&p, SkillScope::Plugin, Some(plugin), out);
                continue;
            }
            walk(&p, depth + 1, out);
        }
    }
    walk(root, 0, out);
}

fn looks_like_version(name: &str) -> bool {
    if name.is_empty() {
        return true;
    }
    if name == "unknown" || name.starts_with("temp_git_") {
        return true;
    }
    // semver-ish: starts with optional v then digit.digit
    let bytes = name.as_bytes();
    let mut i = 0;
    if bytes.first() == Some(&b'v') || bytes.first() == Some(&b'V') {
        i = 1;
    }
    let mut saw_digit_dot_digit = false;
    if i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b'.' {
            i += 1;
            if i < bytes.len() && bytes[i].is_ascii_digit() {
                saw_digit_dot_digit = true;
            }
        }
    }
    if saw_digit_dot_digit {
        return true;
    }
    // hex hash: 8+ chars all hex digits
    if name.len() >= 8 && name.chars().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }
    false
}

fn read_pkg_name(d: &Path) -> Option<String> {
    let pkg = d.join("package.json");
    let text = std::fs::read_to_string(&pkg).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let n = v.get("name")?.as_str()?;
    if n.is_empty() {
        return None;
    }
    // Strip @scope/ prefix if any.
    Some(n.rsplit('/').next().unwrap_or(n).to_string())
}

fn infer_plugin_name(skills_dir: &Path) -> String {
    // Pass 1: walk up looking for a package.json whose `name` is not
    // version-like. Catches superpowers/5.1.0/package.json (name=superpowers)
    // and temp_git_<hash>/package.json (name=superpowers).
    let mut cur = skills_dir.parent();
    for _ in 0..5 {
        let Some(d) = cur else { break };
        if let Some(name) = read_pkg_name(d) {
            if !looks_like_version(&name) {
                return name;
            }
        }
        cur = d.parent();
    }
    // Pass 2: walk up using directory names, skipping anything that
    // looks like a version/hash. Catches frontend-design/<commit>/skills/
    // where the version dirs have no package.json but the parent dir
    // name IS the plugin name.
    let mut cur = skills_dir.parent();
    for _ in 0..5 {
        let Some(d) = cur else { break };
        if let Some(name) = d.file_name().and_then(|f| f.to_str()) {
            if !name.is_empty() && !looks_like_version(name) {
                return name.to_string();
            }
        }
        cur = d.parent();
    }
    skills_dir
        .parent()
        .and_then(|p| p.file_name())
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| "plugin".to_string())
}

#[tauri::command]
pub fn list_skills(project_path: Option<String>) -> Result<Vec<SkillInfo>, String> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        // Global
        scan_skills_dir(&home.join(".claude").join("skills"), SkillScope::Global, None, &mut out);
        // Plugins (recursive walk)
        scan_plugins(&home.join(".claude").join("plugins"), &mut out);
    }
    if let Some(p) = project_path {
        let root = PathBuf::from(p).join(".claude").join("skills");
        scan_skills_dir(&root, SkillScope::Project, None, &mut out);
    }
    let before_dedupe = out.len();
    dedupe_plugin_versions(&mut out);
    let dropped = before_dedupe - out.len();
    out.sort_by(|a, b| {
        // scope order: project → global → plugin
        let order = |s: &SkillScope| match s {
            SkillScope::Project => 0,
            SkillScope::Global => 1,
            SkillScope::Plugin => 2,
        };
        order(&a.scope)
            .cmp(&order(&b.scope))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    tracing::debug!(
        target: "deepthix::commands",
        count = out.len(), %dropped,
        "list_skills",
    );
    Ok(out)
}

/// Plugin caches keep older versions of every skill alongside the
/// current one (e.g. `superpowers/5.0.7/skills/foo/SKILL.md` AND
/// `superpowers/5.1.0/skills/foo/SKILL.md` AND a `temp_git_*` install
/// scratch dir). Claude itself only loads the newest one, so showing
/// 3 entries for the same skill in the UI is misleading — the older
/// versions appear ACTIVE while the actually-loaded one might be
/// DISABLED, exactly the confusion the user reported.
///
/// We keep the entry whose SKILL.md mtime is newest within each
/// (plugin_namespace, skill_name) group. Mtime is the most reliable
/// signal because the plugin manager touches the file when it caches
/// the new version. Project + global skills are never deduped (the
/// user owns those, every entry is intentional).
fn dedupe_plugin_versions(skills: &mut Vec<SkillInfo>) {
    use std::collections::HashMap;
    use std::time::SystemTime;
    type Key = (String, String); // (plugin_namespace, skill_name)
    let mut groups: HashMap<Key, Vec<(usize, SystemTime)>> = HashMap::new();
    for (i, s) in skills.iter().enumerate() {
        if !matches!(s.scope, SkillScope::Plugin) {
            continue;
        }
        let plugin = s.plugin.clone().unwrap_or_default();
        let mtime = std::fs::metadata(&s.path)
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        groups.entry((plugin, s.name.clone())).or_default().push((i, mtime));
    }
    let mut to_drop: Vec<usize> = Vec::new();
    for (_key, mut entries) in groups {
        if entries.len() <= 1 {
            continue;
        }
        // Sort newest mtime first; keep entries[0], drop the rest.
        entries.sort_by(|a, b| b.1.cmp(&a.1));
        for (i, _) in entries.iter().skip(1) {
            to_drop.push(*i);
        }
    }
    // Drop in descending index order so earlier indices stay valid.
    to_drop.sort_unstable();
    to_drop.dedup();
    to_drop.reverse();
    for i in to_drop {
        skills.remove(i);
    }
}

/// Toggle `disable-model-invocation` in a SKILL.md's frontmatter. We
/// allow plugin paths too — the change CAN be wiped by a plugin
/// update, but the user explicitly asked for the toggle so we honor
/// it. UI shows a warning.
#[tauri::command]
pub fn set_skill_enabled(path: String, enabled: bool) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let body = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let updated = set_disable_model_invocation(&body, !enabled);
    let tmp = p.with_extension("md.tmp");
    std::fs::write(&tmp, updated.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    tracing::info!(target: "deepthix::commands", %path, enabled, "set_skill_enabled");
    Ok(())
}

/// Read the raw SKILL.md content (full file, frontmatter + body).
/// Used by the SkillsPane viewer modal to render the markdown.
#[tauri::command]
pub fn read_skill_file(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    // Hard cap so a malformed huge file can't OOM the webview.
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > 1_048_576 {
        return Err(format!("SKILL.md too large ({} bytes)", meta.len()));
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

/// Install a skill from raw text content (used by the marketplace
/// flow: webview fetches the SKILL.md from a public URL, then sends
/// us the bytes + the desired install location). Writes to
/// `<scope-root>/.claude/skills/<name>/SKILL.md`. Refuses to clobber
/// an existing skill unless `overwrite` is true.
#[tauri::command]
pub fn install_skill_from_text(
    name: String,
    content: String,
    scope: String,
    project_path: Option<String>,
    overwrite: Option<bool>,
) -> Result<String, String> {
    let safe = sanitize_skill_name(&name)?;
    let root = scope_root(&scope, project_path.as_deref())?;
    let target_dir = root.join(&safe);
    let target_md = target_dir.join("SKILL.md");
    if target_md.exists() && !overwrite.unwrap_or(false) {
        return Err(format!(
            "skill `{safe}` already exists at {} — pass overwrite=true to replace it",
            target_md.display(),
        ));
    }
    std::fs::create_dir_all(&target_dir).map_err(|e| format!("mkdir {}: {e}", target_dir.display()))?;
    let tmp = target_md.with_extension("md.tmp");
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &target_md).map_err(|e| format!("rename: {e}"))?;
    tracing::info!(
        target: "deepthix::commands",
        skill = %safe, scope, path = %target_md.display(),
        "install_skill_from_text",
    );
    Ok(target_md.to_string_lossy().into_owned())
}

/// Install a skill from a local file or directory the user dropped on
/// the SkillsPane. Two shapes accepted:
///
///  1. A directory containing SKILL.md → copy the whole directory tree
///     into `<scope-root>/.claude/skills/<dir-name>/`.
///  2. A single .md file → wrap it as
///     `<scope-root>/.claude/skills/<base-name>/SKILL.md`.
///
/// Anything else returns an error so we don't litter the skills dir
/// with random files. `overwrite` semantics match `install_skill_from_text`.
#[tauri::command]
pub fn install_skill_from_path(
    source_path: String,
    scope: String,
    project_path: Option<String>,
    overwrite: Option<bool>,
) -> Result<String, String> {
    let src = PathBuf::from(&source_path);
    if !src.exists() {
        return Err(format!("source does not exist: {source_path}"));
    }
    let root = scope_root(&scope, project_path.as_deref())?;
    let overwrite = overwrite.unwrap_or(false);

    if src.is_dir() {
        if !src.join("SKILL.md").is_file() {
            return Err(format!(
                "directory does not contain a SKILL.md: {source_path}"
            ));
        }
        let raw_name = src
            .file_name()
            .ok_or_else(|| format!("can't get directory name from {source_path}"))?
            .to_string_lossy()
            .into_owned();
        let safe = sanitize_skill_name(&raw_name)?;
        let target_dir = root.join(&safe);
        if target_dir.exists() && !overwrite {
            return Err(format!(
                "skill `{safe}` already exists at {} — pass overwrite=true to replace it",
                target_dir.display(),
            ));
        }
        if target_dir.exists() {
            std::fs::remove_dir_all(&target_dir).map_err(|e| format!("rm existing: {e}"))?;
        }
        std::fs::create_dir_all(&target_dir).map_err(|e| format!("mkdir: {e}"))?;
        copy_dir_recursive(&src, &target_dir)?;
        tracing::info!(
            target: "deepthix::commands",
            skill = %safe, scope, src = %src.display(), dst = %target_dir.display(),
            "install_skill_from_path (dir)",
        );
        return Ok(target_dir.join("SKILL.md").to_string_lossy().into_owned());
    }

    if src.is_file() {
        let ext = src
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());
        if ext.as_deref() != Some("md") {
            return Err(format!(
                "single-file install only accepts .md (got {})",
                ext.unwrap_or_else(|| "no-extension".into()),
            ));
        }
        let raw_name = src
            .file_stem()
            .ok_or_else(|| format!("can't get filename stem from {source_path}"))?
            .to_string_lossy()
            .into_owned();
        let safe = sanitize_skill_name(&raw_name)?;
        let content = std::fs::read_to_string(&src).map_err(|e| format!("read: {e}"))?;
        return install_skill_from_text(safe, content, scope, project_path, Some(overwrite));
    }

    Err(format!("unsupported source: {source_path}"))
}

/// Delete a skill (the whole directory containing the SKILL.md).
/// Refuses plugin paths since those should be removed via the plugin
/// manager. Used by the SkillsPane "delete" affordance.
#[tauri::command]
pub fn delete_skill(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() || p.file_name().and_then(|s| s.to_str()) != Some("SKILL.md") {
        return Err(format!("not a SKILL.md: {path}"));
    }
    let dir = p
        .parent()
        .ok_or_else(|| format!("can't resolve parent of {path}"))?;
    // Refuse to delete plugin-managed skills.
    let dir_str = dir.to_string_lossy();
    if dir_str.contains("/.claude/plugins/") || dir_str.contains("\\.claude\\plugins\\") {
        return Err(format!(
            "refusing to delete plugin-managed skill at {} — use the plugin manager",
            dir.display()
        ));
    }
    std::fs::remove_dir_all(dir).map_err(|e| format!("rm: {e}"))?;
    tracing::info!(target: "deepthix::commands", %path, "delete_skill");
    Ok(())
}

/// Resolve the root directory for a given scope. "global" → ~/.claude/skills,
/// "project" → <project_path>/.claude/skills (project_path required).
fn scope_root(scope: &str, project_path: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => {
            let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
            Ok(home.join(".claude").join("skills"))
        }
        "project" => {
            let p = project_path
                .ok_or_else(|| "project scope requires a project_path".to_string())?;
            Ok(PathBuf::from(p).join(".claude").join("skills"))
        }
        other => Err(format!("unknown scope: {other} (expected `global` or `project`)")),
    }
}

/// Sanitize a skill name to a directory-safe slug. Skill names are
/// user-supplied, so we trim, lowercase, replace whitespace with
/// hyphens, and reject anything containing path separators or shell
/// metacharacters. This is a defensive layer — without it, a marketplace
/// entry named "../../etc/passwd" could escape the skills dir.
fn sanitize_skill_name(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty skill name".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(format!("skill name contains path separator: {raw}"));
    }
    let slug: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else if c.is_whitespace() {
                '-'
            } else {
                '_'
            }
        })
        .collect();
    if slug.is_empty() {
        return Err(format!("skill name reduced to empty after sanitize: {raw}"));
    }
    Ok(slug)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(src).map_err(|e| format!("readdir {}: {e}", src.display()))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry.file_type().map_err(|e| format!("filetype: {e}"))?;
        if ft.is_dir() {
            std::fs::create_dir_all(&to).map_err(|e| format!("mkdir {}: {e}", to.display()))?;
            copy_dir_recursive(&from, &to)?;
        } else if ft.is_file() {
            std::fs::copy(&from, &to).map_err(|e| format!("copy {}: {e}", from.display()))?;
        }
        // Symlinks are skipped intentionally — copying them as-is would
        // create dangling links if the user moves the source later.
    }
    Ok(())
}

/// Insert / update / remove the `disable-model-invocation` line in the
/// frontmatter, preserving everything else byte-for-byte. Creates a
/// frontmatter block if none exists (rare but possible for
/// hand-written skills).
fn set_disable_model_invocation(body: &str, value: bool) -> String {
    let target_line = format!("disable-model-invocation: {value}");
    let trimmed = body.trim_start();
    if !trimmed.starts_with("---") {
        // No frontmatter at all — wrap the whole body in one.
        return format!("---\n{target_line}\n---\n{body}");
    }
    let lead_offset = body.len() - trimmed.len();
    let lead = &body[..lead_offset];
    let after_first = &trimmed[3..];
    let end_rel = match after_first.find("\n---") {
        Some(i) => i,
        None => {
            // Malformed — append the field just inside the open delimiter.
            return format!("{lead}---\n{target_line}\n{after_first}");
        }
    };
    let frontmatter = &after_first[..end_rel];
    let after_close = &after_first[end_rel..]; // starts with "\n---"
    let mut new_lines: Vec<String> = Vec::new();
    let mut found = false;
    for line in frontmatter.lines() {
        let key = line.split_once(':').map(|(k, _)| k.trim().to_lowercase());
        if key.as_deref() == Some("disable-model-invocation") {
            new_lines.push(target_line.clone());
            found = true;
        } else {
            new_lines.push(line.to_string());
        }
    }
    if !found {
        new_lines.push(target_line);
    }
    let mut rebuilt = String::new();
    rebuilt.push_str(lead);
    rebuilt.push_str("---\n");
    rebuilt.push_str(&new_lines.join("\n"));
    if !rebuilt.ends_with('\n') {
        rebuilt.push('\n');
    }
    rebuilt.push_str(after_close);
    rebuilt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_frontmatter_basic() {
        let body = r#"---
name: foo
description: A foo skill
disable-model-invocation: true
user-invocable: false
---
body content
"#;
        let (n, d, dis, hid) = parse_frontmatter(body);
        assert_eq!(n, "foo");
        assert_eq!(d, "A foo skill");
        assert!(dis);
        assert!(hid);
    }

    #[test]
    fn parse_frontmatter_quoted() {
        let body = "---\nname: \"with spaces\"\ndescription: 'q'\n---\nbody";
        let (n, d, _, _) = parse_frontmatter(body);
        assert_eq!(n, "with spaces");
        assert_eq!(d, "q");
    }

    #[test]
    fn parse_frontmatter_missing() {
        let (n, d, dis, hid) = parse_frontmatter("just plain text, no frontmatter");
        assert_eq!(n, "");
        assert_eq!(d, "");
        assert!(!dis);
        assert!(!hid);
    }

    #[test]
    fn set_disable_inserts_when_missing() {
        let body = "---\nname: foo\n---\nbody\n";
        let out = set_disable_model_invocation(body, true);
        assert!(out.contains("disable-model-invocation: true"));
        assert!(out.contains("name: foo"));
        assert!(out.contains("body"));
    }

    #[test]
    fn set_disable_replaces_when_present() {
        let body = "---\nname: foo\ndisable-model-invocation: true\n---\nbody\n";
        let out = set_disable_model_invocation(body, false);
        assert!(out.contains("disable-model-invocation: false"));
        assert!(!out.contains("disable-model-invocation: true"));
    }

    #[test]
    fn set_disable_no_frontmatter_creates_one() {
        let body = "no frontmatter here";
        let out = set_disable_model_invocation(body, true);
        assert!(out.starts_with("---\ndisable-model-invocation: true\n---\n"));
        assert!(out.contains("no frontmatter here"));
    }

    #[test]
    fn set_skill_writes_plugin_paths_now() {
        // Plugin paths are allowed (with a UI warning) — the toggle still
        // returns an error here because the file doesn't exist, but the
        // error must NOT mention "read-only" anymore.
        let result =
            set_skill_enabled("/Users/x/.claude/plugins/foo/skills/bar/SKILL.md".into(), false);
        assert!(result.is_err());
        assert!(!result.unwrap_err().contains("read-only"));
    }
}
