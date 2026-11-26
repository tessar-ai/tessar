use napi_derive::napi;
use std::io;

pub(crate) const INVALID_PATCH: &str = "InvalidPatch";
pub(crate) const INVALID_PATH: &str = "InvalidPath";
pub(crate) const INVALID_EDIT: &str = "InvalidEdit";
pub(crate) const INVALID_READ: &str = "InvalidRead";
pub(crate) const CANCELLED: &str = "Cancelled";

pub(crate) type Result<T> = std::result::Result<T, Failure>;

#[napi(object)]
#[derive(Debug)]
pub struct Failure {
    pub code: String,
    pub message: String,
    pub paths: Option<Vec<String>>,
    pub cause_code: Option<String>,
    pub cause_message: Option<String>,
}

impl Failure {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            paths: None,
            cause_code: None,
            cause_message: None,
        }
    }

    pub(crate) fn partial(self, paths: Vec<String>) -> Self {
        Self {
            code: "PatchWriteFailed".into(),
            message: format!("Patch stopped after writing: {}", paths.join(", ")),
            paths: Some(paths),
            cause_code: Some(self.code),
            cause_message: Some(self.message),
        }
    }
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        use io::ErrorKind::*;
        let code = match error.kind() {
            NotFound => "ENOENT",
            PermissionDenied => "EACCES",
            AlreadyExists => "EEXIST",
            NotADirectory => "ENOTDIR",
            IsADirectory => "EISDIR",
            DirectoryNotEmpty => "ENOTEMPTY",
            ReadOnlyFilesystem => "EROFS",
            StorageFull => "ENOSPC",
            CrossesDevices => "EXDEV",
            FileTooLarge => "EFBIG",
            Interrupted => "EINTR",
            _ => "EIO",
        };
        Self::new(code, error.to_string())
    }
}
