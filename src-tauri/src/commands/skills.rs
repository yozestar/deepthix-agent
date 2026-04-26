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
    // Plugin layout: ~/.claude/plugins/<plugin-name>/skills/<skill-name>/SKILL.md
    // Variant we've also seen: ~/.claude/plugins/cache/<owner>/<plugin>/<version>/skills/...
    // Walk up to 5 levels deep looking for `skills` subdirs.
    fn walk(dir: &Path, depth: u8, plugin_name: Option<String>, out: &mut Vec<SkillInfo>) {
        if depth > 5 {
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
                let inferred = plugin_name.clone().unwrap_or_else(|| {
                    p.parent()
                        .and_then(|q| q.file_name())
                        .map(|f| f.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "plugin".to_string())
                });
                scan_skills_dir(&p, SkillScope::Plugin, Some(inferred), out);
                continue;
            }
            // Heuristic: if this dir contains a `plugin.json` or `package.json`,
            // remember its name as the plugin name when we descend.
            let next_plugin = if p.join("plugin.json").exists() || p.join("package.json").exists() {
                Some(name.clone())
            } else {
                plugin_name.clone()
            };
            walk(&p, depth + 1, next_plugin, out);
        }
    }
    walk(root, 0, None, out);
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
    tracing::debug!(target: "deepthix::commands", count = out.len(), "list_skills");
    Ok(out)
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
