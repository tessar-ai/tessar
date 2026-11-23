use napi::{bindgen_prelude::*, sys, JsValue, Property, PropertyAttributes, ValueType};
use napi_derive::napi;

use crate::transport::write_console;

const SHUTDOWN: &str = "shutdown";
const SUSPENDED: &str = "stream.suspended";
const TRANSPORTS: &str = "transports";
const PENDING: &str = "pending";

const EVENTS: &[(&str, Level)] = &[
    ("ready", Level::Info),
    ("thread.started", Level::Info),
    ("thread.forked", Level::Info),
    ("thread.renamed", Level::Info),
    ("thread.deleted", Level::Info),
    ("stream.started", Level::Info),
    ("stream.end", Level::Info),
    ("stream.error", Level::Info),
    (SUSPENDED, Level::Warn),
    ("stream.resumed", Level::Info),
    ("stream.cancel", Level::Info),
    ("turn.start", Level::Info),
    ("turn.end", Level::Info),
    ("text.start", Level::Info),
    ("text.end", Level::Info),
    ("reasoning.start", Level::Info),
    ("reasoning.end", Level::Info),
    ("tool.call.start", Level::Info),
    ("tool.call.end", Level::Info),
    ("model.start", Level::Info),
    ("model.end", Level::Info),
    ("model.error", Level::Info),
    ("tool.start", Level::Info),
    ("tool.end", Level::Info),
    ("tool.error", Level::Info),
    ("diagnostic", Level::Info),
    ("session.created", Level::Info),
    ("session.model-changed", Level::Info),
    ("session.model.options-changed", Level::Info),
    ("session.thread-switched", Level::Info),
    ("session.input-queued", Level::Info),
    ("session.input-discarded", Level::Info),
    ("session.closed", Level::Info),
    ("input.received", Level::Debug),
    ("text.delta", Level::Debug),
    ("reasoning.delta", Level::Debug),
    ("tool.update", Level::Debug),
    ("model.usage", Level::Debug),
];

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn parse(level: &str) -> Result<Self> {
        match level {
            "debug" => Ok(Self::Debug),
            "info" => Ok(Self::Info),
            "warn" => Ok(Self::Warn),
            "error" => Ok(Self::Error),
            _ => Err(Error::from_reason("Invalid logger level")),
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[napi]
pub struct LoggerPlugin {
    level: Level,
    default_console: bool,
}

#[napi]
impl LoggerPlugin {
    #[napi(constructor)]
    pub fn new(env: Env, mut this: This, options: Option<Object>) -> Result<Self> {
        let options = options.unwrap_or(Object::new(&env)?);
        let level = options.get::<Option<String>>("level")?.flatten();
        let level = Level::parse(level.as_deref().unwrap_or("info"))?;
        let transports = options.get::<Option<Array>>(TRANSPORTS)?.flatten();
        let default_console = transports.is_none();
        let mut snapshot = env.create_array(0)?;
        if let Some(transports) = transports {
            for index in 0..transports.len() {
                let transport: Object = transports.get(index)?.ok_or_else(invalid_transport)?;
                let write: Unknown = transport.get_named_property("write")?;
                let close: Unknown = transport.get_named_property("close")?;
                if write.get_type()? != ValueType::Function
                    || !matches!(
                        close.get_type()?,
                        ValueType::Function | ValueType::Undefined
                    )
                {
                    return Err(invalid_transport());
                }
                snapshot.set(index, transport)?;
            }
        }
        // Store JS transports on their JS owner so references remain visible to the garbage collector.
        this.define_properties(&[Property::new()
            .with_utf8_name(TRANSPORTS)?
            .with_value(&snapshot)
            .with_property_attributes(PropertyAttributes::empty())])?;
        Ok(Self {
            level,
            default_console,
        })
    }

    #[napi(getter)]
    pub fn id(&self) -> &'static str {
        "logger"
    }

    #[napi]
    pub fn setup(&self, env: Env, this: This, tessar: Object) -> Result<()> {
        let transports: Array = this.get_named_property(TRANSPORTS)?;
        let mut state = Object::new(&env)?;
        state.set(TRANSPORTS, transports)?;
        let set: Function<(), Unknown> = env.get_global()?.get_named_property("Set")?;
        state.set(PENDING, set.new_instance(())?)?;

        let shutdown = env.create_function_from_closure::<(), _, _>("drainLogger", |ctx| {
            let state: Object = ctx.this()?;
            drain(ctx.env, state.get_named_property(PENDING)?)
        })?;
        let hook: Function<FnArgs<(&str, Unknown)>, ()> = tessar.get_named_property("hook")?;
        hook.apply(&tessar, (SHUTDOWN, bind(shutdown, &state)?).into())?;

        let close = env.create_function_from_closure::<(), _, _>("closeLogger", |ctx| {
            let state: Object = ctx.this()?;
            settle(ctx.env, state.get_named_property(TRANSPORTS)?, None, false)
        })?;
        let defer: Function<Unknown, ()> = tessar.get_named_property("defer")?;
        defer.apply(&tessar, bind(close, &state)?)?;

        for &(name, base_level) in EVENTS {
            let level = self.level;
            let default_console = self.default_console;
            let logger =
                env.create_function_from_closure::<Object, _, _>("writeLog", move |ctx| {
                    log(
                        ctx.env,
                        ctx.this()?,
                        ctx.first_arg()?,
                        base_level,
                        level,
                        default_console,
                    )
                })?;
            hook.apply(&tessar, (name, bind(logger, &state)?).into())?;
        }
        Ok(())
    }
}

fn invalid_transport() -> Error {
    Error::from_reason("Logger transports must implement LogTransport")
}

fn bind<'env, Args: JsValuesTupleIntoVec, Return>(
    callback: Function<'_, Args, Return>,
    receiver: &Object<'_>,
) -> Result<Unknown<'env>> {
    let bind: Function<&Object, Unknown> = callback.get_named_property("bind")?;
    bind.apply(callback, receiver)
}

fn log<'env>(
    env: &Env,
    state: Object,
    event: Object,
    base: Level,
    minimum: Level,
    console: bool,
) -> Result<Either<(), PromiseRaw<'env, ()>>> {
    let payload: Object = event.get_named_property("payload")?;
    let error: Unknown = payload.get_named_property("error")?;
    let level = if error.coerce_to_bool()? {
        Level::Error
    } else {
        base
    };
    if level < minimum {
        return Ok(Either::A(()));
    }

    let object: Function<(), Unknown> = env.get_global()?.get_named_property("Object")?;
    let assign: Function<FnArgs<(Object, Object)>, Object> = object.get_named_property("assign")?;
    let mut entry = assign.apply(object, (Object::new(env)?, event).into())?;
    entry.set("level", level.as_str())?;
    entry.freeze()?;
    let writing = settle(
        env,
        state.get_named_property(TRANSPORTS)?,
        Some(entry),
        console,
    )?;
    let pending: Object = state.get_named_property(PENDING)?;
    let add: Function<PromiseRaw<()>, ()> = pending.get_named_property("add")?;
    add.apply(&pending, writing)?;
    let delete: Function<PromiseRaw<()>, bool> = pending.get_named_property("delete")?;
    let bind_delete: Function<FnArgs<(&Object, PromiseRaw<()>)>, Unknown> =
        delete.get_named_property("bind")?;
    let remove = bind_delete.apply(delete, (&pending, writing).into())?;
    let finally: Function<Unknown, PromiseRaw<()>> = writing.get_named_property("finally")?;
    Ok(Either::B(finally.apply(writing, remove)?))
}

fn all_settled<'env, T: ToNapiValue>(env: &Env, calls: T) -> Result<PromiseRaw<'env, Array<'env>>> {
    let promise: Function<(), Unknown> = env.get_global()?.get_named_property("Promise")?;
    let method: Function<T, PromiseRaw<Array>> = promise.get_named_property("allSettled")?;
    method.apply(promise, calls)
}

fn catch_exception<T>(env: &Env, result: Result<T>) -> Result<T> {
    if !matches!(&result, Err(error) if error.status == Status::PendingException) {
        return result;
    }
    // Function::apply leaves thrown exceptions pending. Capture the original
    // JS value before starting the next transport.
    let mut exception = std::ptr::null_mut();
    let status = unsafe { sys::napi_get_and_clear_last_exception(env.raw(), &mut exception) };
    if status != sys::Status::napi_ok || exception.is_null() {
        return result;
    }
    Err(Error::from(unsafe {
        Unknown::from_raw_unchecked(env.raw(), exception)
    }))
}

fn settle<'env>(
    env: &Env,
    transports: Array,
    entry: Option<Object>,
    console: bool,
) -> Result<PromiseRaw<'env, ()>> {
    let mut calls = env.create_array(0)?;
    if let (true, Some(entry)) = (console, entry) {
        if let Err(error) = catch_exception(env, write_console(env, entry)) {
            calls.set(0, PromiseRaw::<()>::reject(env, error)?)?;
        }
    }
    for index in 0..transports.len() {
        let transport: Object = transports.get(index)?.ok_or_else(invalid_transport)?;
        let result = (|| {
            if let Some(entry) = entry {
                let write: Function<Object, Unknown> = transport.get_named_property("write")?;
                return write.apply(&transport, entry).map(Some);
            }
            let close: Unknown = transport.get_named_property("close")?;
            if close.get_type()? == ValueType::Undefined {
                return Ok(None);
            }
            let close: Function<(), Unknown> = transport.get_named_property("close")?;
            close.apply(&transport, ()).map(Some)
        })();
        match catch_exception(env, result) {
            Ok(Some(result)) => calls.set(calls.len(), result)?,
            Ok(None) => {}
            Err(error) => calls.set(calls.len(), PromiseRaw::<()>::reject(env, error)?)?,
        }
    }
    all_settled(env, calls)?.then(|result| {
        let mut errors = result.env.create_array(0)?;
        for i in 0..result.value.len() {
            let Some(call) = result.value.get::<Object>(i)? else {
                continue;
            };
            if call.get_named_property::<String>("status")? == "rejected" {
                errors.set(errors.len(), call.get_named_property::<Unknown>("reason")?)?;
            }
        }
        if errors.len() == 0 {
            return Ok(());
        }
        let aggregate: Function<FnArgs<(Array, &str)>, Unknown> = result
            .env
            .get_global()?
            .get_named_property("AggregateError")?;
        Err(Error::from(
            aggregate.new_instance((errors, "Logger transport failed").into())?,
        ))
    })
}

fn drain<'env>(env: &Env, pending: Object) -> Result<Either<(), PromiseRaw<'env, ()>>> {
    if pending.get_named_property::<u32>("size")? == 0 {
        return Ok(Either::A(()));
    }
    let wait = all_settled(env, &pending)?;
    let again = env.create_function_from_closure::<(), _, _>("drainLogger", |ctx| {
        drain(ctx.env, ctx.this()?)
    })?;
    let then: Function<Unknown, PromiseRaw<()>> = wait.get_named_property("then")?;
    Ok(Either::B(then.apply(wait, bind(again, &pending)?)?))
}
