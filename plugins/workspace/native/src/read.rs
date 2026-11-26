use super::{check_cancelled, workspace_root, workspace_target, Cancellation};
use crate::error::{Failure, Result, INVALID_READ};
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

const MAX_PAGE_BYTES: usize = 50 * 1024;
const READ_BUFFER_BYTES: usize = 8 * 1024;
const PDF_HEADER: &[u8] = b"%PDF-";

pub struct Page {
    text: String,
    next_line: Option<i64>,
}

fn read_page(
    mut reader: impl BufRead,
    start_line: i64,
    limit: i64,
    path: &str,
    cancelled: &AtomicBool,
) -> Result<Page> {
    let invalid_text = || Failure::new(INVALID_READ, format!("Expected a UTF-8 text file: {path}"));
    let mut first_chunk = true;
    let mut line = 1;
    let mut bytes = Vec::new();
    let mut complete_bytes = 0;
    let next_line = 'page: loop {
        check_cancelled(cancelled)?;
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            break None;
        }
        if first_chunk && chunk.starts_with(PDF_HEADER) {
            return Err(invalid_text());
        }
        first_chunk = false;
        let mut offset = 0;
        while offset < chunk.len() {
            let newline = chunk[offset..].iter().position(|&byte| byte == b'\n');
            let end = newline.map_or(chunk.len(), |index| offset + index + 1);
            if line >= start_line {
                if line - start_line >= limit {
                    break 'page Some(line);
                }
                if bytes.len() + end - offset > MAX_PAGE_BYTES {
                    if complete_bytes == 0 {
                        return Err(Failure::new(
                            INVALID_READ,
                            format!("Line {line} exceeds {MAX_PAGE_BYTES} bytes: {path}"),
                        ));
                    }
                    bytes.truncate(complete_bytes);
                    break 'page Some(line);
                }
                bytes.extend_from_slice(&chunk[offset..end]);
            }
            if newline.is_some() {
                line += 1;
                complete_bytes = bytes.len();
            }
            offset = end;
        }
        let consumed = chunk.len();
        reader.consume(consumed);
    };
    check_cancelled(cancelled)?;
    let text = String::from_utf8(bytes).map_err(|_| invalid_text())?;
    if text.contains('\0') {
        return Err(invalid_text());
    }
    Ok(Page { text, next_line })
}

#[napi(object)]
pub struct ReadResult {
    pub text: Option<String>,
    pub next_line: Option<i64>,
    pub error: Option<Failure>,
}

pub struct ReadTask {
    root: String,
    path: String,
    start_line: i64,
    limit: i64,
    cancelled: Arc<AtomicBool>,
}

impl ReadTask {
    fn run(&self) -> Result<Page> {
        check_cancelled(&self.cancelled)?;
        if self.start_line < 1 || self.limit < 1 {
            return Err(Failure::new(
                INVALID_READ,
                "startLine and limit must be positive",
            ));
        }
        let root = workspace_root(Path::new(&self.root))?;
        let target = workspace_target(&root, &self.path)?;
        target.regular_file()?;
        let reader = BufReader::with_capacity(READ_BUFFER_BYTES, File::open(&target.location)?);
        read_page(
            reader,
            self.start_line,
            self.limit,
            &target.path,
            &self.cancelled,
        )
    }
}

impl Task for ReadTask {
    type Output = Result<Page>;
    type JsValue = ReadResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(self.run())
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(match output {
            Ok(page) => ReadResult {
                text: Some(page.text),
                next_line: page.next_line,
                error: None,
            },
            Err(error) => ReadResult {
                text: None,
                next_line: None,
                error: Some(error),
            },
        })
    }
}

#[napi]
pub fn read_file(
    root: String,
    path: String,
    start_line: i64,
    limit: i64,
    token: &Cancellation,
) -> AsyncTask<ReadTask> {
    AsyncTask::new(ReadTask {
        root,
        path,
        start_line,
        limit,
        cancelled: token.flag.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_utf8_and_crlf_across_chunks() -> Result<()> {
        let reader = BufReader::with_capacity(2, "\u{1f642}\r\nnext".as_bytes());
        let page = read_page(reader, 1, 1, "example.txt", &AtomicBool::default())?;
        assert_eq!(page.text, "\u{1f642}\r\n");
        assert_eq!(page.next_line, Some(2));
        Ok(())
    }
}
