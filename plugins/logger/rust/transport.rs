use std::{
    cell::RefCell,
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
};

use napi::{bindgen_prelude::*, JsDeferred};
use napi_derive::napi;

const GROUP_NONE: &str = "none";
const GROUP_THREAD: &str = "thread";
const GROUP_SESSION: &str = "session";
const GROUP_STREAM: &str = "stream";

pub(crate) fn stringify(env: &Env, entry: Object) -> Result<String> {
    let json: Object = env.get_global()?.get_named_property("JSON")?;
    let stringify: Function<Object, String> = json.get_named_property("stringify")?;
    stringify.apply(&json, entry)
}

pub(crate) fn write_console(env: &Env, entry: Object) -> Result<()> {
    let line = stringify(env, entry)?;
    let console: Object = env.get_global()?.get_named_property("console")?;
    let error: Function<String, ()> = console.get_named_property("error")?;
    error.apply(&console, line)
}

#[napi]
pub struct ConsoleTransport;

#[napi]
impl ConsoleTransport {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self
    }

    #[napi]
    pub fn write(&self, env: Env, entry: Object) -> Result<()> {
        write_console(&env, entry)
    }
}

#[napi]
pub fn log_groups(env: &Env) -> Result<Object<'_>> {
    let mut groups = Object::new(env)?;
    for name in [GROUP_NONE, GROUP_THREAD, GROUP_SESSION, GROUP_STREAM] {
        groups.set(name, name)?;
    }
    Ok(groups)
}

#[derive(PartialEq, Eq)]
enum Group {
    None,
    Thread,
    Session,
    Stream,
}

#[napi(object)]
pub struct FileTransportOptions {
    pub path: String,
    pub group_by: Option<String>,
}

#[derive(Default)]
struct PendingWrites {
    sender: Option<mpsc::Sender<LogWrite>>,
    waiters: CloseWaiters,
    closed: bool,
}

type Completion = JsDeferred<(), fn(Env) -> Result<()>>;
type CloseWaiters = Arc<Mutex<Option<Vec<Completion>>>>;

struct LogWrite {
    path: PathBuf,
    line: String,
    done: Completion,
}

fn run_writer(receiver: mpsc::Receiver<LogWrite>, waiters: CloseWaiters) {
    for LogWrite { path, line, done } in receiver {
        let result = (|| -> std::io::Result<()> {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?
                .write_all(line.as_bytes())
        })();
        match result {
            Ok(()) => done.resolve(|_| Ok(())),
            Err(error) => done.reject(error.into()),
        }
    }
    let waiting = waiters
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    for done in waiting.into_iter().flatten() {
        done.resolve(|_| Ok(()));
    }
}

#[napi]
pub struct FileTransport {
    path: PathBuf,
    group: Group,
    pending: RefCell<PendingWrites>,
}

#[napi]
impl FileTransport {
    #[napi(constructor)]
    pub fn new(options: FileTransportOptions) -> Result<Self> {
        let name = options.path.rsplit(['/', '\\']).next().unwrap_or_default();
        if options.path.trim().is_empty() || matches!(name, "" | "." | "..") {
            return Err(Error::from_reason("FileTransport path must name a file"));
        }
        let mut path = PathBuf::new();
        for component in std::path::absolute(options.path)?.components() {
            match component {
                Component::ParentDir => {
                    path.pop();
                }
                _ => path.push(component),
            }
        }
        let group = match options.group_by.as_deref().unwrap_or(GROUP_NONE) {
            GROUP_NONE => Group::None,
            GROUP_THREAD => Group::Thread,
            GROUP_SESSION => Group::Session,
            GROUP_STREAM => Group::Stream,
            _ => return Err(Error::from_reason("Invalid FileTransport groupBy")),
        };
        Ok(Self {
            path,
            group,
            pending: RefCell::new(PendingWrites::default()),
        })
    }

    #[napi]
    pub fn write<'env>(&self, env: &'env Env, entry: Object<'env>) -> Result<Object<'env>> {
        if self.pending.borrow().closed {
            let (done, promise): (Completion, _) = env.create_deferred()?;
            done.reject(Error::from_reason("FileTransport is closed"));
            return Ok(promise);
        }
        let path = self.destination(&entry)?;
        let mut line = stringify(env, entry)?;
        line.push('\n');
        let sender = {
            let mut pending = self.pending.borrow_mut();
            if let Some(sender) = &pending.sender {
                sender.clone()
            } else {
                let (sender, receiver) = mpsc::channel();
                let waiters = Arc::new(Mutex::new(Some(Vec::new())));
                let worker_waiters = waiters.clone();
                thread::Builder::new()
                    .name("tessar-logger".into())
                    .spawn(move || run_writer(receiver, worker_waiters))?;
                pending.waiters = waiters;
                pending.sender.insert(sender).clone()
            }
        };
        let (done, promise): (Completion, _) = env.create_deferred()?;
        if let Err(error) = sender.send(LogWrite { path, line, done }) {
            error
                .0
                .done
                .reject(Error::from_reason("FileTransport writer stopped"));
        }
        Ok(promise)
    }

    #[napi]
    pub fn close<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let (done, promise): (Completion, _) = env.create_deferred()?;
        let mut pending = self.pending.borrow_mut();
        pending.closed = true;
        let mut done = Some(done);
        if let Some(waiting) = pending
            .waiters
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_mut()
        {
            waiting.extend(done.take());
        }
        pending.sender.take();
        drop(pending);
        if let Some(done) = done {
            done.resolve(|_| Ok(()));
        }
        Ok(promise)
    }
}

impl FileTransport {
    fn destination(&self, entry: &Object) -> Result<PathBuf> {
        let grouped = match self.group {
            Group::None => None,
            Group::Thread => id(entry, "threadId")?.map(|thread| ("threads", None, thread)),
            Group::Session => match (id(entry, "sessionId")?, id(entry, "threadId")?) {
                (Some(session), Some(thread)) => Some(("sessions", Some(session), thread)),
                _ => None,
            },
            Group::Stream => id(entry, "streamId")?.map(|stream| ("streams", None, stream)),
        };
        let Some((directory, session, item)) = grouped else {
            return Ok(self.path.clone());
        };
        let mut path = self.path.with_file_name(directory);
        if let Some(session) = session {
            path.push(filename(&session));
        }
        path.push(filename(&item));
        if let Some(extension) = self.path.extension() {
            path.set_extension(extension);
        }
        Ok(path)
    }
}

fn id(entry: &Object, key: &str) -> Result<Option<String>> {
    Ok(entry
        .get::<Option<String>>(key)?
        .flatten()
        .filter(|value| !value.is_empty()))
}

fn filename(id: &str) -> String {
    use std::fmt::Write;
    let bytes = id.as_bytes();
    let reserved = matches!(id, "con" | "prn" | "aux" | "nul")
        || matches!(
            bytes,
            [b'c', b'o', b'm', b'0'..=b'9'] | [b'l', b'p', b't', b'0'..=b'9']
        );
    let mut output = String::with_capacity(id.len());
    for (index, &byte) in bytes.iter().enumerate() {
        if (byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || matches!(byte, b'-' | b'_' | b'~'))
            && !(reserved && index == 0)
        {
            output.push(char::from(byte));
        } else {
            let _ = write!(output, "%{byte:02X}");
        }
    }
    output
}
