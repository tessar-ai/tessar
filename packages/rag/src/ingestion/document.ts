import { immutable, requireId, type JsonObject } from "@tessar/core";
import { TessarRagError, asRagError } from "../errors.js";
import { extract } from "./formats.js";
import { loadSource, snapshotSource } from "./source.js";
import { keys, object } from "./validation.js";
import type { Content, ReadInput, ReadOptions, ReadTask } from "./types.js";

export class DocumentReader {
  readonly #active = new Set<string>();

  load(input: ReadInput, options: ReadOptions = {}): ReadTask {
    try {
      return this.#start(input, options);
    } catch (error) {
      throw asRagError(error);
    }
  }

  #start(input: ReadInput, options: ReadOptions): ReadTask {
    object(input, "input");
    keys(input, ["id", "source"]);
    object(options, "options");
    keys(options, ["metadata"]);
    const source = snapshotSource(input.source);
    const suppliedMetadata =
      options.metadata === undefined ? {} : options.metadata;
    object(suppliedMetadata, "metadata");
    const metadata = immutable(suppliedMetadata) as JsonObject;
    const id = requireId(
      input.id === undefined ? crypto.randomUUID() : input.id,
      "read id",
    );
    if (this.#active.has(id))
      throw new TessarRagError(
        "RegistrationConflict",
        "Read ID is already active: " + id,
      );
    this.#active.add(id);

    const controller = new AbortController();
    const completion = Promise.withResolvers<Content[]>();
    // A task may reject before an application calls result(). Preserve the
    // original rejecting promise while preventing unhandled-rejection noise.
    void completion.promise.catch(() => {});
    let settled = false;
    const work = Promise.resolve()
      .then(async () => {
        controller.signal.throwIfAborted();
        const loaded = await loadSource(source, controller.signal);
        const contents = await extract(loaded, controller.signal);
        controller.signal.throwIfAborted();
        return immutable(
          contents.map((content) => ({ ...content, metadata })),
        ) as Content[];
      })
      .finally(() => {
        this.#active.delete(id);
      });
    void work.then(
      (contents) => {
        if (!settled) {
          settled = true;
          completion.resolve(contents);
        }
      },
      (error) => {
        if (!settled) {
          settled = true;
          completion.reject(asRagError(error));
        }
      },
    );
    return Object.freeze({
      id,
      result: () => completion.promise,
      cancel: (reason?: string) => {
        if (settled) return;
        if (reason !== undefined && typeof reason !== "string")
          throw new TessarRagError(
            "InvalidConfiguration",
            "Cancellation reason must be a string",
          );
        const error = new TessarRagError(
          "Cancelled",
          reason ?? "Content reading cancelled",
        );
        settled = true;
        controller.abort(error);
        completion.reject(error);
      },
    });
  }
}
