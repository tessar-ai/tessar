import { expectTypeOf, test } from "vitest";
import type * as Core from "@tessar/core";
import type * as Client from "../src/index.js";

// Core is a test oracle only; published client declarations must be standalone.
test("client-owned wire DTOs preserve the current server contract", () => {
  expectTypeOf<Client.State>().toEqualTypeOf<Client.Serialized<Core.RuntimeState>>();
  expectTypeOf<Client.GenerateResult>().toEqualTypeOf<Client.Serialized<Core.GenerateOutcome>>();
  expectTypeOf<Client.SessionData>().toEqualTypeOf<Client.Serialized<Core.SessionRecord>>();
  expectTypeOf<Client.ThreadData>().toEqualTypeOf<Client.Serialized<Core.ThreadInfo>>();
  expectTypeOf<Client.CheckpointData>().toEqualTypeOf<Client.Serialized<Core.Checkpoint>>();
  expectTypeOf<Client.CheckpointSummary>().toEqualTypeOf<Client.Serialized<Core.CheckpointInfo>>();
  expectTypeOf<Client.HistoryPage>().toEqualTypeOf<Client.Serialized<Core.HistoryDataPage>>();
  expectTypeOf<Client.StreamData>().toEqualTypeOf<Client.Serialized<Core.StreamRecord>>();
  expectTypeOf<Client.TurnData>().toEqualTypeOf<Client.Serialized<Core.TurnRecord>>();
  expectTypeOf<Client.ModelAttemptData>().toEqualTypeOf<Client.Serialized<Core.ModelAttemptRecord>>();
  expectTypeOf<Client.ToolExecutionData>().toEqualTypeOf<Client.Serialized<Core.ToolExecutionRecord>>();
  expectTypeOf<Client.InterruptData>().toEqualTypeOf<Client.Serialized<Core.InterruptRecord>>();
  expectTypeOf<Client.RecordData>().toEqualTypeOf<Client.Serialized<Core.StoredRecord>>();
  expectTypeOf<Client.InputReceipt>().toEqualTypeOf<Client.Serialized<Core.QueuedInputReceipt>>();
  expectTypeOf<Client.ContinuationReceipt>().toEqualTypeOf<Client.Serialized<Core.ExecutionReceipt>>();
  expectTypeOf<Client.ModelInfo>().toEqualTypeOf<Client.Serialized<Core.SessionModelInfo> & { options?: Core.JsonObject }>();
});
