import { Hono } from "hono";
import { createAdaptorServer } from "@hono/node-server";
import type { Server } from "node:http";

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 4117;
/** CLI bootstrap. Application integrations own their own listener instead. */
interface Runtime { readonly server: { hostname?: string; port?: number }; shutdown(): Promise<void> }
interface Adapter { init(): Promise<void>; shutdown(): Promise<void> }

export async function startServer(tessar: Runtime, createAdapter: (app: Hono) => Adapter): Promise<{ shutdown(): Promise<void> }> {
  const { hostname = DEFAULT_HOSTNAME, port = DEFAULT_PORT } = tessar.server;
  let adapter: Adapter | undefined;
  let listener: Server | undefined;
  let disposal: Promise<void> | undefined;
  const shutdown = () => disposal ??= (async () => {
    await adapter?.shutdown();
    const stopped = listener?.listening ? new Promise<void>((resolve, reject) => {
      listener!.close(error => error ? reject(error) : resolve());
      listener!.closeAllConnections();
    }) : Promise.resolve();
    const results = await Promise.allSettled([stopped, tessar.shutdown()]);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Server cleanup failed");
  })();
  try {
    const app = new Hono();
    adapter = createAdapter(app);
    await adapter.init();
    listener = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false }) as Server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      listener!.once("error", onError);
      listener!.listen(port, hostname, () => { listener!.off("error", onError); resolve(); });
    });
    const address = listener.address();
    if (address && typeof address !== "string") console.log(`Tessar listening at http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${address.port}`);
    return { shutdown };
  } catch (error) {
    await shutdown().catch(cleanup => console.error(cleanup));
    throw error;
  }
}
