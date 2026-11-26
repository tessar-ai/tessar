mod edit;
mod error;
mod read;

pub use read::read_file;

use error::{Failure, Result, CANCELLED, INVALID_EDIT, INVALID_PATCH, INVALID_PATH};
use napi::bindgen_prelude::{AsyncTask, Utf16String};
use napi::{Env, Task};
use napi_derive::napi;
use std::collections::HashSet;
use std::fs::{self, Metadata, OpenOptions, Permissions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const BEGIN: &str = "*** Begin Patch";
const END: &str = "*** End Patch";
const ADD: &str = "*** Add File: ";
const UPDATE: &str = "*** Update File: ";
const HUNK: &str = "@@";
const BOM: char = '\u{feff}';
static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

struct Hunk<'a> {
    edits: Vec<(u8, &'a str)>,
    before: Vec<&'a str>,
}

enum Change<'a> {
    Add(&'a str, String),
    Update(&'a str, Vec<Hunk<'a>>),
}

impl<'a> Change<'a> {
    fn path(&self) -> &'a str {
        match self {
            Self::Add(path, _) | Self::Update(path, _) => path,
        }
    }
}

fn invalid_patch(message: impl Into<String>) -> Failure {
    Failure::new(INVALID_PATCH, message)
}

fn invalid_path(message: impl Into<String>) -> Failure {
    Failure::new(INVALID_PATH, message)
}

#[napi]
#[derive(Default)]
pub struct Cancellation {
    flag: Arc<AtomicBool>,
}

#[napi]
impl Cancellation {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Relaxed);
    }
}

fn check_cancelled(flag: &AtomicBool) -> Result<()> {
    if flag.load(Ordering::Relaxed) {
        return Err(Failure::new(CANCELLED, "Filesystem operation cancelled"));
    }
    Ok(())
}

fn parse(patch: &str) -> Result<Vec<Change<'_>>> {
    let lines: Vec<_> = patch.split_terminator('\n').collect();
    if lines.len() < 3 || lines[0] != BEGIN || lines[lines.len() - 1] != END {
        return Err(invalid_patch(
            "Expected a patch with begin and end markers and at least one file",
        ));
    }
    let lines = &lines[..lines.len() - 1];
    let mut index = 1;
    let mut changes = Vec::new();
    while index < lines.len() {
        let header = lines[index];
        index += 1;
        if let Some(path) = header.strip_prefix(ADD) {
            let mut text = String::new();
            while let Some(line) = lines.get(index).and_then(|line| line.strip_prefix('+')) {
                text.push_str(line);
                text.push('\n');
                index += 1;
            }
            changes.push(Change::Add(path, text));
        } else if let Some(path) = header.strip_prefix(UPDATE) {
            let mut hunks = Vec::new();
            while lines.get(index) == Some(&HUNK) {
                index += 1;
                let mut edits = Vec::new();
                let mut before = Vec::new();
                while let Some(line) = lines.get(index) {
                    let Some(&prefix @ (b' ' | b'-' | b'+')) = line.as_bytes().first() else {
                        break;
                    };
                    let text = &line[1..];
                    edits.push((prefix, text));
                    if prefix != b'+' {
                        before.push(text);
                    }
                    index += 1;
                }
                if !edits.iter().any(|(prefix, _)| *prefix != b' ') {
                    return Err(invalid_patch("Hunk requires an addition or removal"));
                }
                hunks.push(Hunk { edits, before });
            }
            if hunks.is_empty() {
                return Err(invalid_patch("Update requires an @@ hunk"));
            }
            changes.push(Change::Update(path, hunks));
        } else {
            return Err(invalid_patch(format!(
                "Expected an Add File or Update File directive at line {index}"
            )));
        }
    }
    Ok(changes)
}

#[derive(Clone, Copy)]
struct Line<'a> {
    text: &'a str,
    ending: &'static str,
    added: bool,
}

fn update_text(original: &str, hunks: &[Hunk<'_>], path: &str) -> Result<String> {
    let text = original.strip_prefix(BOM).unwrap_or(original);
    let lines: Vec<_> = text
        .split_inclusive('\n')
        .map(|line| {
            let (text, ending) = if let Some(text) = line.strip_suffix("\r\n") {
                (text, "\r\n")
            } else if let Some(text) = line.strip_suffix('\n') {
                (text, "\n")
            } else {
                (line, "")
            };
            Line {
                text,
                ending,
                added: false,
            }
        })
        .collect();
    let default_ending = lines
        .iter()
        .find(|line| !line.ending.is_empty())
        .map_or("\n", |line| line.ending);
    let final_ending = lines.last().map_or(default_ending, |line| line.ending);
    let mut result = Vec::with_capacity(lines.len());
    let mut cursor = 0;
    for hunk in hunks {
        let mut matched = None;
        if hunk.before.is_empty() {
            if lines.is_empty() && result.is_empty() {
                matched = Some(0);
            }
        } else {
            for (offset, window) in lines[cursor..].windows(hunk.before.len()).enumerate() {
                if window
                    .iter()
                    .map(|line| line.text)
                    .eq(hunk.before.iter().copied())
                {
                    if matched.is_some() {
                        return Err(invalid_patch(format!("Patch context is ambiguous: {path}")));
                    }
                    matched = Some(cursor + offset);
                }
            }
        }
        let start =
            matched.ok_or_else(|| invalid_patch(format!("Patch context was not found: {path}")))?;
        result.extend_from_slice(&lines[cursor..start]);
        cursor = start;
        let ending = lines
            .get(start)
            .filter(|line| !line.ending.is_empty())
            .map_or(default_ending, |line| line.ending);
        for &(prefix, text) in &hunk.edits {
            if prefix == b'+' {
                result.push(Line {
                    text,
                    ending,
                    added: true,
                });
            } else {
                if prefix == b' ' {
                    result.push(lines[cursor]);
                }
                cursor += 1;
            }
        }
    }
    result.extend_from_slice(&lines[cursor..]);
    let mut output = String::with_capacity(original.len());
    if original.starts_with(BOM) {
        output.push(BOM);
    }
    for (index, line) in result.iter().enumerate() {
        output.push_str(line.text);
        output.push_str(if index + 1 == result.len() {
            if line.added {
                final_ending
            } else {
                line.ending
            }
        } else if line.ending.is_empty() {
            default_ending
        } else {
            line.ending
        });
    }
    Ok(output)
}

fn inspect(path: &Path) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn path_key(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_owned()
    }
}

fn checked_parent(root: &Path, path: &Path) -> Result<PathBuf> {
    if inspect(path)?.is_none() {
        let parent = path
            .parent()
            .ok_or_else(|| invalid_path("Missing workspace ancestor"))?;
        let component = path
            .file_name()
            .ok_or_else(|| invalid_path("Missing workspace component"))?;
        return Ok(checked_parent(root, parent)?.join(component));
    }
    let location = fs::canonicalize(path)?;
    let name = path.strip_prefix(root).unwrap_or(path).display();
    if !location.starts_with(root) {
        return Err(invalid_path(format!(
            "Path is outside the workspace: {name}"
        )));
    }
    if !fs::metadata(&location)?.is_dir() {
        return Err(invalid_path(format!("Expected a parent directory: {name}")));
    }
    Ok(location)
}

struct PendingWrite {
    path: String,
    target: PathBuf,
    text: String,
    permissions: Option<Permissions>,
}

fn publish(
    write: &PendingWrite,
    paths: &mut Vec<String>,
    check: impl Fn() -> Result<()>,
) -> Result<()> {
    check()?;
    let parent = write
        .target
        .parent()
        .ok_or_else(|| invalid_path("Missing workspace parent"))?;
    if write.permissions.is_none() {
        fs::create_dir_all(parent)?;
    }
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = parent.join(format!(
        ".tessar-patch-{}-{time}-{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    let staged = (|| {
        file.write_all(write.text.as_bytes())?;
        if let Some(permissions) = &write.permissions {
            file.set_permissions(permissions.clone())?;
        }
        Ok::<_, Failure>(())
    })();
    drop(file);
    let result = staged.and_then(|()| {
        check()?;
        if write.permissions.is_some() {
            fs::rename(&temp, &write.target)
        } else {
            fs::hard_link(&temp, &write.target)
        }
        .map_err(Failure::from)
    });
    if result.is_ok() {
        paths.push(write.path.clone());
    }
    if result.is_err() || write.permissions.is_none() {
        let cleanup = fs::remove_file(&temp);
        result?;
        cleanup?;
    } else {
        result?;
    }
    Ok(())
}

fn reserved_windows_component(part: &str) -> bool {
    if part.ends_with(['.', ' ']) || part.chars().any(|c| c < '\u{20}' || "<>\"|?*".contains(c)) {
        return true;
    }
    let stem = part
        .split('.')
        .next()
        .unwrap_or(part)
        .trim_end()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
}

fn workspace_root(root: &Path) -> Result<PathBuf> {
    let root = fs::canonicalize(root)?;
    if !fs::metadata(&root)?.is_dir() {
        return Err(invalid_path("The workspace root must be a directory"));
    }
    Ok(root)
}

struct Target {
    path: String,
    location: PathBuf,
    metadata: Option<Metadata>,
}

impl Target {
    fn regular_file(&self) -> Result<&Metadata> {
        self.metadata
            .as_ref()
            .filter(|file| file.is_file())
            .ok_or_else(|| {
                invalid_path(format!("Expected an existing regular file: {}", self.path))
            })
    }

    fn key(&self) -> Result<PathBuf> {
        if self
            .metadata
            .as_ref()
            .is_some_and(|file| !file.is_symlink())
        {
            return Ok(path_key(&fs::canonicalize(&self.location)?));
        }
        Ok(path_key(&self.location))
    }
}

fn workspace_target(root: &Path, requested: &str) -> Result<Target> {
    let path = requested.replace('\\', "/");
    if path.contains([':', '\0'])
        || path.split('/').any(|part| {
            matches!(part, "" | "." | "..") || (cfg!(windows) && reserved_windows_component(part))
        })
    {
        return Err(invalid_path(format!(
            "Expected a workspace-relative path: {requested}"
        )));
    }
    let name = root.join(&path);
    let parent = name
        .parent()
        .ok_or_else(|| invalid_path("Missing workspace parent"))?;
    let basename = name
        .file_name()
        .ok_or_else(|| invalid_path("Missing workspace file name"))?;
    let location = checked_parent(root, parent)?.join(basename);
    let metadata = inspect(&location)?;
    Ok(Target {
        path,
        location,
        metadata,
    })
}

fn read_existing(target: &Target, code: &str) -> Result<(String, Permissions)> {
    let path = &target.path;
    let metadata = target.regular_file()?;
    let text = match fs::read_to_string(&target.location) {
        Ok(text) if !text.contains('\0') => text,
        Ok(_) => {
            return Err(Failure::new(
                code,
                format!("Cannot edit a non-text file: {path}"),
            ))
        }
        Err(error) if error.kind() == ErrorKind::InvalidData => {
            return Err(Failure::new(
                code,
                format!("Cannot edit a non-text file: {path}"),
            ));
        }
        Err(error) => return Err(error.into()),
    };
    let permissions = metadata.permissions();
    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        Permissions::from_mode(permissions.mode() & 0o777)
    };
    Ok((text, permissions))
}

fn normalize_patch(patch: &str) -> Result<String> {
    if patch.contains('\0') {
        return Err(invalid_patch("Patch must be UTF-8 text"));
    }
    Ok(patch.replace("\r\n", "\n"))
}

fn collect_patch_targets(root: &Path, patch: &str) -> Result<Vec<String>> {
    let normalized = normalize_patch(patch)?;
    let changes = parse(&normalized)?;
    let root = workspace_root(root)?;
    let mut seen = HashSet::new();
    let mut paths = Vec::with_capacity(changes.len());
    for change in changes {
        let target = workspace_target(&root, change.path())?;
        if target.metadata.as_ref().is_some_and(|file| !file.is_file()) {
            return Err(invalid_path(format!(
                "Expected a regular file: {}",
                target.path
            )));
        }
        if !seen.insert(target.key()?) {
            return Err(invalid_patch(format!(
                "Patch contains the same file twice: {}",
                target.path
            )));
        }
        paths.push(target.path);
    }
    Ok(paths)
}

fn apply(root: &Path, patch: &str, cancelled: &AtomicBool) -> Result<Vec<String>> {
    check_cancelled(cancelled)?;
    let normalized = normalize_patch(patch)?;
    let changes = parse(&normalized)?;
    let root = workspace_root(root)?;
    let mut targets = HashSet::new();
    let mut writes = Vec::new();
    for change in changes {
        check_cancelled(cancelled)?;
        let target = workspace_target(&root, change.path())?;
        let path = &target.path;
        if !targets.insert(target.key()?) {
            return Err(invalid_patch(format!(
                "Patch contains the same file twice: {path}"
            )));
        }
        let (text, permissions) = match change {
            Change::Add(_, text) => {
                if target.metadata.is_some() {
                    return Err(invalid_patch(format!("File already exists: {path}")));
                }
                (text, None)
            }
            Change::Update(_, hunks) => {
                let (text, permissions) = read_existing(&target, INVALID_PATCH)?;
                (update_text(&text, &hunks, path)?, Some(permissions))
            }
        };
        writes.push(PendingWrite {
            path: target.path,
            target: target.location,
            text,
            permissions,
        });
    }
    let root_key = path_key(&root);
    for write in &writes {
        for parent in write.target.ancestors().skip(1) {
            let key = path_key(parent);
            if key == root_key {
                break;
            }
            if targets.contains(&key) {
                return Err(invalid_patch(format!(
                    "Patch targets a file and its child: {}",
                    write.path
                )));
            }
        }
    }
    let mut paths = Vec::with_capacity(writes.len());
    for write in &writes {
        if let Err(error) = publish(write, &mut paths, || check_cancelled(cancelled)) {
            if paths.is_empty() {
                return Err(error);
            }
            return Err(error.partial(paths));
        }
    }
    Ok(paths)
}

#[napi(object)]
pub struct EditReplacement {
    pub old_text: Utf16String,
    pub new_text: Utf16String,
}

enum Operation {
    Patch(String),
    Edit(String, Vec<EditReplacement>),
    FindEditTarget(String),
    FindPatchTargets(String),
}

#[napi(object)]
pub struct FileResult {
    pub paths: Option<Vec<String>>,
    pub error: Option<Failure>,
}

pub struct FileTask {
    root: String,
    operation: Operation,
    cancelled: Arc<AtomicBool>,
}

impl FileTask {
    fn run(&self) -> Result<Vec<String>> {
        check_cancelled(&self.cancelled)?;
        let root = Path::new(&self.root);
        match &self.operation {
            Operation::Patch(patch) => apply(root, patch, &self.cancelled),
            Operation::Edit(path, edits) => {
                let target = workspace_target(&workspace_root(root)?, path)?;
                let (original, permissions) = read_existing(&target, INVALID_EDIT)?;
                let text = edit::replace(&original, edits, &target.path)?;
                let mut paths = Vec::with_capacity(1);
                publish(
                    &PendingWrite {
                        path: target.path,
                        target: target.location,
                        text,
                        permissions: Some(permissions),
                    },
                    &mut paths,
                    || check_cancelled(&self.cancelled),
                )?;
                Ok(paths)
            }
            Operation::FindEditTarget(path) => {
                let target = workspace_target(&workspace_root(root)?, path)?;
                Ok(target
                    .metadata
                    .filter(Metadata::is_file)
                    .map(|_| vec![target.path])
                    .unwrap_or_default())
            }
            Operation::FindPatchTargets(patch) => collect_patch_targets(root, patch),
        }
    }
}

impl Task for FileTask {
    type Output = Result<Vec<String>>;
    type JsValue = FileResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(self.run())
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(match output {
            Ok(paths) => FileResult {
                paths: Some(paths),
                error: None,
            },
            Err(error) => FileResult {
                paths: None,
                error: Some(error),
            },
        })
    }
}

#[napi]
pub fn apply_patch(root: String, patch: String, token: &Cancellation) -> AsyncTask<FileTask> {
    AsyncTask::new(FileTask {
        root,
        operation: Operation::Patch(patch),
        cancelled: token.flag.clone(),
    })
}

#[napi]
pub fn edit_file(
    root: String,
    path: String,
    edits: Vec<EditReplacement>,
    token: &Cancellation,
) -> AsyncTask<FileTask> {
    AsyncTask::new(FileTask {
        root,
        operation: Operation::Edit(path, edits),
        cancelled: token.flag.clone(),
    })
}

#[napi]
pub fn find_edit_target(root: String, path: String) -> AsyncTask<FileTask> {
    AsyncTask::new(FileTask {
        root,
        operation: Operation::FindEditTarget(path),
        cancelled: Arc::default(),
    })
}

#[napi]
pub fn find_patch_targets(root: String, patch: String) -> AsyncTask<FileTask> {
    AsyncTask::new(FileTask {
        root,
        operation: Operation::FindPatchTargets(patch),
        cancelled: Arc::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_after_staging_preserves_original_and_cleans_up() -> Result<()> {
        let directory = std::env::temp_dir().join(format!(
            "tessar-workspace-native-test-{}",
            std::process::id()
        ));
        fs::create_dir(&directory)?;
        let target = directory.join("order.ts");
        fs::write(&target, "before")?;
        let write = PendingWrite {
            path: "order.ts".into(),
            permissions: Some(fs::metadata(&target)?.permissions()),
            target: target.clone(),
            text: "after".into(),
        };
        let checks = std::cell::Cell::new(0);
        let mut paths = Vec::new();
        let result = publish(&write, &mut paths, || {
            checks.set(checks.get() + 1);
            check_cancelled(&AtomicBool::new(checks.get() == 2))
        });
        assert!(matches!(result, Err(error) if error.code == CANCELLED));
        assert!(paths.is_empty());
        assert_eq!(fs::read_to_string(&target)?, "before");
        fs::remove_file(&target)?;
        fs::remove_dir(directory)?;
        Ok(())
    }
}
