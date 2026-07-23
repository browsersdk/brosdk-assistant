use serde_json::{Value, json};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub(crate) fn definitions(chat_mode: bool) -> Vec<Value> {
    let mut tools = vec![
        json!({
            "name": "workspace_ls",
            "description": "List files and folders under the selected workspace. Paths must be relative to the workspace.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Directory path relative to the selected workspace. Defaults to ."
                    }
                }
            }
        }),
        json!({
            "name": "workspace_read_file",
            "description": "Read a UTF-8 text file from the selected workspace. Paths must be relative to the workspace.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the selected workspace."
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Starting line number, 1-indexed."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of lines to return. Defaults to 400, maximum 1000."
                    }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "workspace_search",
            "description": "Search file names and UTF-8 text file contents under the selected workspace. Skips common dependency/build directories.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Case-insensitive text to search for."
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory or file path relative to the selected workspace. Defaults to ."
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum matches to return. Defaults to 80, maximum 200."
                    }
                },
                "required": ["query"]
            }
        }),
    ];
    if chat_mode {
        return tools;
    }
    tools.extend([
        json!({
            "name": "workspace_write_file",
            "description": "Create or overwrite a UTF-8 text file inside the selected workspace. Creates parent directories when needed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the selected workspace."
                    },
                    "content": {
                        "type": "string",
                        "description": "Complete file content to write."
                    }
                },
                "required": ["path", "content"]
            }
        }),
        json!({
            "name": "workspace_edit_file",
            "description": "Edit a UTF-8 text file inside the selected workspace by replacing exact text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the selected workspace."
                    },
                    "find": {
                        "type": "string",
                        "description": "Exact text to replace."
                    },
                    "replace": {
                        "type": "string",
                        "description": "Replacement text."
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "Replace every occurrence when true; otherwise replace only the first occurrence."
                    }
                },
                "required": ["path", "find", "replace"]
            }
        }),
    ]);
    tools
}

pub(crate) fn is_tool(name: &str) -> bool {
    matches!(
        name,
        "workspace_ls"
            | "workspace_read_file"
            | "workspace_write_file"
            | "workspace_edit_file"
            | "workspace_search"
    )
}

pub(crate) fn call(root: &Path, name: &str, arguments: Value) -> Result<Value, String> {
    match name {
        "workspace_ls" => workspace_ls(root, &arguments),
        "workspace_read_file" => workspace_read_file(root, &arguments),
        "workspace_write_file" => workspace_write_file(root, &arguments),
        "workspace_edit_file" => workspace_edit_file(root, &arguments),
        "workspace_search" => workspace_search(root, &arguments),
        _ => Err(format!("unknown workspace tool: {name}")),
    }
}

fn workspace_ls(root: &Path, arguments: &Value) -> Result<Value, String> {
    let input_path = optional_string(arguments, "path").unwrap_or(".");
    let dir = resolve_workspace_existing_path(root, input_path)?;
    let metadata = fs::metadata(&dir).map_err(|error| format!("failed to stat path: {error}"))?;
    if !metadata.is_dir() {
        return Err("workspace_ls path must be a directory".to_string());
    }

    let mut entries = Vec::new();
    for item in fs::read_dir(&dir).map_err(|error| format!("failed to list directory: {error}"))? {
        let item = item.map_err(|error| format!("failed to read directory entry: {error}"))?;
        let path = item.path();
        let metadata = item
            .metadata()
            .map_err(|error| format!("failed to read entry metadata: {error}"))?;
        entries.push(json!({
            "name": item.file_name().to_string_lossy(),
            "path": workspace_relative_path(root, &path),
            "kind": if metadata.is_dir() { "directory" } else { "file" },
            "size": if metadata.is_file() { Some(metadata.len()) } else { None },
        }));
    }
    entries.sort_by(|left, right| {
        let left_key = left
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase();
        let right_key = right
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase();
        left_key.cmp(&right_key)
    });
    let lines = entries
        .iter()
        .map(|entry| {
            let kind = entry.get("kind").and_then(Value::as_str).unwrap_or("entry");
            let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
            format!("{kind}\t{path}")
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "content": [{ "type": "text", "text": if lines.is_empty() { "(empty directory)".to_string() } else { lines.join("\n") } }],
        "entries": entries,
    }))
}

fn workspace_read_file(root: &Path, arguments: &Value) -> Result<Value, String> {
    let input_path = required_string(arguments, "path")?;
    let path = resolve_workspace_existing_path(root, input_path)?;
    let metadata = fs::metadata(&path).map_err(|error| format!("failed to stat file: {error}"))?;
    if !metadata.is_file() {
        return Err("workspace_read_file path must be a file".to_string());
    }
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read UTF-8 text file: {error}"))?;
    let lines = text.lines().collect::<Vec<_>>();
    let offset = optional_u64(arguments, "offset").unwrap_or(1).max(1) as usize;
    let limit = optional_u64(arguments, "limit")
        .unwrap_or(400)
        .clamp(1, 1000) as usize;
    let start = offset.saturating_sub(1);
    let selected = lines
        .iter()
        .enumerate()
        .skip(start)
        .take(limit)
        .map(|(index, line)| format!("{:>5}: {}", index + 1, line))
        .collect::<Vec<_>>();
    Ok(json!({
        "content": [{ "type": "text", "text": selected.join("\n") }],
        "path": workspace_relative_path(root, &path),
        "total_lines": lines.len(),
        "offset": offset,
        "limit": limit,
    }))
}

fn workspace_write_file(root: &Path, arguments: &Value) -> Result<Value, String> {
    let input_path = required_string(arguments, "path")?;
    let content = required_string(arguments, "content")?;
    let path = resolve_workspace_write_path(root, input_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create parent directories: {error}"))?;
    }
    fs::write(&path, content).map_err(|error| format!("failed to write file: {error}"))?;
    let bytes = content.len();
    Ok(json!({
        "content": [{ "type": "text", "text": format!("Wrote {bytes} bytes to {}", workspace_relative_path(root, &path)) }],
        "path": workspace_relative_path(root, &path),
        "bytes": bytes,
    }))
}

fn workspace_edit_file(root: &Path, arguments: &Value) -> Result<Value, String> {
    let input_path = required_string(arguments, "path")?;
    let find = required_string(arguments, "find")?;
    let replace = required_string(arguments, "replace")?;
    if find.is_empty() {
        return Err("find must not be empty".to_string());
    }
    let replace_all = arguments
        .get("replace_all")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let path = resolve_workspace_existing_path(root, input_path)?;
    let original = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read UTF-8 text file: {error}"))?;
    let count = original.matches(find).count();
    if count == 0 {
        return Err("text to replace was not found".to_string());
    }
    let updated = if replace_all {
        original.replace(find, replace)
    } else {
        original.replacen(find, replace, 1)
    };
    fs::write(&path, updated).map_err(|error| format!("failed to write edited file: {error}"))?;
    let replaced = if replace_all { count } else { 1 };
    Ok(json!({
        "content": [{ "type": "text", "text": format!("Replaced {replaced} occurrence(s) in {}", workspace_relative_path(root, &path)) }],
        "path": workspace_relative_path(root, &path),
        "replaced": replaced,
    }))
}

fn workspace_search(root: &Path, arguments: &Value) -> Result<Value, String> {
    let query = required_string(arguments, "query")?.to_lowercase();
    if query.trim().is_empty() {
        return Err("query must not be empty".to_string());
    }
    let input_path = optional_string(arguments, "path").unwrap_or(".");
    let start = resolve_workspace_existing_path(root, input_path)?;
    let max_results = optional_u64(arguments, "max_results")
        .unwrap_or(80)
        .clamp(1, 200) as usize;
    let mut results = Vec::new();
    let mut stack = vec![start];
    let mut visited = 0usize;

    while let Some(path) = stack.pop() {
        if results.len() >= max_results || visited >= 5000 {
            break;
        }
        visited += 1;
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if should_skip_search_dir(&path) {
                continue;
            }
            let Ok(read_dir) = fs::read_dir(&path) else {
                continue;
            };
            for item in read_dir.flatten() {
                stack.push(item.path());
            }
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let relative = workspace_relative_path(root, &path);
        if relative.to_lowercase().contains(&query) {
            results.push(json!({
                "path": relative,
                "match": "filename",
            }));
            if results.len() >= max_results {
                break;
            }
        }
        if metadata.len() > 512 * 1024 {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        for (index, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&query) {
                results.push(json!({
                    "path": workspace_relative_path(root, &path),
                    "match": "content",
                    "line": index + 1,
                    "text": line.trim(),
                }));
                if results.len() >= max_results {
                    break;
                }
            }
        }
    }

    let text = if results.is_empty() {
        "(no matches)".to_string()
    } else {
        results
            .iter()
            .map(|result| {
                let path = result.get("path").and_then(Value::as_str).unwrap_or("");
                let line = result.get("line").and_then(Value::as_u64);
                let text = result.get("text").and_then(Value::as_str).unwrap_or("");
                match line {
                    Some(line) => format!("{path}:{line}: {text}"),
                    None => format!("{path}: filename match"),
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok(json!({
        "content": [{ "type": "text", "text": text }],
        "results": results,
        "visited": visited,
    }))
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} is required"))
}

fn optional_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn optional_u64(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

fn reject_unsafe_relative_path(input: &str) -> Result<(), String> {
    let path = Path::new(input);
    if path.is_absolute() {
        return Err("path must be relative to the selected workspace".to_string());
    }
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => {
                return Err("path must be relative to the selected workspace".to_string());
            }
            Component::ParentDir => {
                return Err("path cannot contain parent traversal".to_string());
            }
            _ => {}
        }
    }
    Ok(())
}

fn resolve_workspace_existing_path(root: &Path, input: &str) -> Result<PathBuf, String> {
    reject_unsafe_relative_path(input)?;
    let candidate = root.join(input);
    let canonical = fs::canonicalize(&candidate)
        .map_err(|error| format!("failed to resolve workspace path {input}: {error}"))?;
    ensure_inside_workspace(root, &canonical)?;
    Ok(canonical)
}

fn resolve_workspace_write_path(root: &Path, input: &str) -> Result<PathBuf, String> {
    reject_unsafe_relative_path(input)?;
    let candidate = root.join(input);
    if let Ok(canonical) = fs::canonicalize(&candidate) {
        ensure_inside_workspace(root, &canonical)?;
        return Ok(canonical);
    }

    let mut parent = candidate
        .parent()
        .ok_or_else(|| "write path has no parent directory".to_string())?
        .to_path_buf();
    loop {
        if parent.exists() {
            let canonical_parent = fs::canonicalize(&parent)
                .map_err(|error| format!("failed to resolve write parent: {error}"))?;
            ensure_inside_workspace(root, &canonical_parent)?;
            return Ok(candidate);
        }
        let Some(next) = parent.parent() else {
            break;
        };
        parent = next.to_path_buf();
    }
    Err("write path is outside the selected workspace".to_string())
}

fn ensure_inside_workspace(root: &Path, candidate: &Path) -> Result<(), String> {
    if path_is_inside(root, candidate) {
        Ok(())
    } else {
        Err("path is outside the selected workspace".to_string())
    }
}

#[cfg(target_os = "windows")]
fn path_is_inside(root: &Path, candidate: &Path) -> bool {
    let root = root.to_string_lossy().replace('/', "\\").to_lowercase();
    let candidate = candidate
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase();
    candidate == root || candidate.starts_with(&format!("{root}\\"))
}

#[cfg(not(target_os = "windows"))]
fn path_is_inside(root: &Path, candidate: &Path) -> bool {
    candidate.strip_prefix(root).is_ok()
}

fn workspace_relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn should_skip_search_dir(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".wxt"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::process;

    #[test]
    fn write_and_read_are_scoped() {
        let root = test_workspace("workspace_write_and_read_are_scoped");
        let write = call(
            &root,
            "workspace_write_file",
            json!({
                "path": "notes/example.txt",
                "content": "hello\nworkspace"
            }),
        )
        .expect("write file");
        assert!(
            write["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("notes/example.txt")
        );

        let read = call(
            &root,
            "workspace_read_file",
            json!({ "path": "notes/example.txt" }),
        )
        .expect("read file");
        assert!(
            read["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("workspace")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tools_reject_parent_traversal() {
        let root = test_workspace("workspace_tools_reject_parent_traversal");
        let error = call(
            &root,
            "workspace_read_file",
            json!({ "path": "../secret.txt" }),
        )
        .expect_err("parent traversal should fail");
        assert!(error.contains("parent traversal"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn chat_mode_tools_are_read_only() {
        let tools = definitions(true);
        let names = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(names.contains(&"workspace_ls"));
        assert!(names.contains(&"workspace_read_file"));
        assert!(names.contains(&"workspace_search"));
        assert!(!names.contains(&"workspace_write_file"));
        assert!(!names.contains(&"workspace_edit_file"));
    }

    #[test]
    fn write_path_rejects_symlink_escape_when_supported() {
        let root = test_workspace("workspace_symlink_escape");
        let outside = test_workspace("workspace_symlink_escape_outside");
        let link = root.join("outside");
        if create_dir_symlink(&outside, &link).is_err() {
            let _ = fs::remove_dir_all(root);
            let _ = fs::remove_dir_all(outside);
            return;
        }

        let error = call(
            &root,
            "workspace_write_file",
            json!({ "path": "outside/escaped.txt", "content": "blocked" }),
        )
        .expect_err("symlink escape should fail");
        assert!(error.contains("outside the selected workspace"));
        assert!(!outside.join("escaped.txt").exists());

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(target_os = "windows")]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(not(target_os = "windows"))]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    fn test_workspace(name: &str) -> PathBuf {
        let root = env::temp_dir().join(format!("brosdk-assistant-{name}-{}", process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create test workspace");
        fs::canonicalize(root).expect("canonical test workspace")
    }
}
