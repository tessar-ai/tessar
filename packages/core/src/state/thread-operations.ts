import type { Controller } from "../controller.js";
import { Thread } from "../thread.js";
import { thread as threadHooks } from "../events/type.js";
import { fail } from "../errors.js";
import { immutable } from "../json.js";
import { matchesScope } from "./scope.js";
import { canonicalJson } from "./commit.js";
import { ThreadService, type CreateThreadOptions } from "./threads.js";
import { ForkService, type ForkOptions } from "./fork.js";
import type { PageOptions, StateQuery, ThreadInfo } from "./schema.js";
import type { PluginStateDefinition } from "./plugin-state.js";
import type { SessionHookHandle } from "../plugins/context.js";

export async function prepareThread(
  controller: Controller,
  options: CreateThreadOptions = {},
  reservedId?: string,
  session?: SessionHookHandle,
): Promise<ThreadInfo> {
  controller.requireReady();
  const prepared = await controller.hooks.dispatch(
    threadHooks.prepare,
    options,
    {
      session,
      sessionId: session?.id,
      controllerId: controller.id,
      agentId: controller.agent.id,
      scope: options.scope,
    },
  );
  if (
    canonicalJson(prepared.scope ?? {}) !== canonicalJson(options.scope ?? {})
  )
    fail("ThreadScopeMismatch", "Thread preparation cannot change scope");
  const id = reservedId ?? options.id;
  if (id !== undefined && prepared.id !== undefined && prepared.id !== id)
    fail(
      "InvalidConfiguration",
      "Thread preparation cannot change a supplied id",
    );
  const info = await new ThreadService(controller.backend).create({
    ...prepared,
    ...(id !== undefined ? { id } : {}),
  });
  if (!session)
    await controller.hooks.dispatch(threadHooks.started, info, {
      controllerId: controller.id,
      agentId: controller.agent.id,
      threadId: info.id,
      scope: info.scope,
    });
  return info;
}

export async function createThread(
  controller: Controller,
  options: CreateThreadOptions = {},
  session?: SessionHookHandle,
): Promise<Thread> {
  return Thread.create(
    controller,
    await prepareThread(controller, options, undefined, session),
  );
}

export async function getThread(
  controller: Controller,
  id: string,
  query: StateQuery = {},
): Promise<Thread | null> {
  controller.requireReady();
  const info = await controller.queries.getThread(id, query);
  return info ? Thread.create(controller, info) : null;
}

export function listThreads(
  controller: Controller,
  query: StateQuery & PageOptions = {},
) {
  controller.requireReady();
  return controller.queries.listThreads(query);
}

export async function deleteThread(
  controller: Controller,
  id: string,
  query: StateQuery = {},
  session?: SessionHookHandle,
): Promise<void> {
  controller.requireReady();
  query = immutable(query);
  const context = {
    ...(await threadContext(controller, id, query)),
    session,
    sessionId: session?.id,
  };
  await controller.hooks.authorize(
    threadHooks.beforeDelete,
    immutable({ threadId: id }),
    context,
  );
  controller.requireReady();
  await new ThreadService(controller.backend).delete(id, query);
  if (!session)
    await controller.hooks.dispatch(
      threadHooks.deleted,
      { threadId: id },
      context,
    );
}

export async function purgeThread(
  controller: Controller,
  id: string,
  query: StateQuery = {},
  session?: SessionHookHandle,
): Promise<void> {
  controller.requireReady();
  query = immutable(query);
  const info = await controller.backend.threads.get(id, {
    includeDeleted: true,
  });
  if (!info || !matchesScope(info.scope, query.scope))
    fail("ThreadNotFound", "Thread does not match query");
  const context = {
    session,
    sessionId: session?.id,
    controllerId: controller.id,
    agentId: controller.agent.id,
    threadId: id,
    scope: info.scope,
    thread: Thread.create(controller, info),
  };
  const payload = immutable({ threadId: id, permanent: true });
  await controller.hooks.authorize(threadHooks.beforeDelete, payload, context);
  controller.requireReady();
  await new ThreadService(controller.backend).purge(id, query);
  if (!session)
    await controller.hooks.dispatch(threadHooks.deleted, payload, context);
}

export async function renameThread(
  controller: Controller,
  id: string,
  title: string,
  query: StateQuery = {},
  session?: SessionHookHandle,
): Promise<void> {
  controller.requireReady();
  if (typeof title !== "string")
    fail("InvalidConfiguration", "Title must be text");
  query = immutable(query);
  const context = {
    ...(await threadContext(controller, id, query)),
    session,
    sessionId: session?.id,
  };
  const payload = immutable({ threadId: id, title });
  await controller.hooks.authorize(threadHooks.beforeRename, payload, context);
  controller.requireReady();
  await new ThreadService(controller.backend).rename(id, title, query);
  if (!session)
    await controller.hooks.dispatch(threadHooks.renamed, payload, context);
}

export async function forkThread(
  controller: Controller,
  id: string,
  options: ForkOptions & StateQuery = {},
  session?: SessionHookHandle,
): Promise<Thread> {
  controller.requireReady();
  options = immutable(options);
  const context = {
    ...(await threadContext(controller, id, options)),
    session,
    sessionId: session?.id,
  };
  const { scope: _scope, ...forkOptions } = options;
  await controller.hooks.authorize(
    threadHooks.beforeFork,
    immutable({ threadId: id, options: forkOptions }),
    context,
  );
  controller.requireReady();
  const defs = controller.hooks
    .registrations()
    .filter((r) => r.kind === "state")
    .map((r) => r.value as PluginStateDefinition<any>);
  const info = await new ForkService(controller.backend, defs).fork(
    id,
    options,
  );
  if (!session)
    await controller.hooks.dispatch(
      threadHooks.forked,
      { threadId: id, forkedThreadId: info.id },
      context,
    );
  return Thread.create(controller, info);
}

async function threadContext(
  controller: Controller,
  id: string,
  query: StateQuery,
) {
  const info = await controller.queries.requireThread(id, query);
  return {
    controllerId: controller.id,
    agentId: controller.agent.id,
    threadId: id,
    scope: info.scope,
    thread: Thread.create(controller, info),
  };
}
