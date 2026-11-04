import { describe, expect, it } from "vitest";
import { TessarError } from "@tessar/core";
import { contentsInput, vectorsInput, predicate, filterTokens, textTerms } from "../src/vector-validation.js";

describe("MongoDB vector validation", () => {
  it("keeps JSON types, null/missing, scopes and arbitrary keys distinct", () => {
    const contents = contentsInput([{
      text: "", format: "text", source: { uri: "1", page: 1 }, metadata: {
        number: 1, string: "1", boolean: true, null: null, "a.$b": "x", nested: { a: 1 }, array: [1],
      }
    }]);
    expect(filterTokens(contents[0]!)).toEqual([
      '["source","uri","1"]', '["source","page",1]', '["metadata","number",1]',
      '["metadata","string","1"]', '["metadata","boolean",true]', '["metadata","null",null]', '["metadata","a.$b","x"]',
    ]);
    expect(predicate({ metadata: { newlyAdded: "x", missing: null }, source: { uri: "1" } })).toEqual([
      '["source","uri","1"]', '["metadata","newlyAdded","x"]', '["metadata","missing",null]',
    ]);
    expect(predicate({ metadata: JSON.parse('{"__proto__":null,"a\\u0000b":true}') })).toEqual([
      '["metadata","__proto__",null]', '["metadata","a\\u0000b",true]',
    ]);
  });

  it("enforces the UTF-8 term boundary on inserts and filters", () => {
    const prefix = Buffer.byteLength('["metadata","x",""]');
    const value = "a".repeat(32766 - prefix);
    expect(predicate({ metadata: { x: value } })).toHaveLength(1);
    expect(() => predicate({ metadata: { x: value + "a" } })).toThrow();
    expect(() => predicate({ metadata: { x: "é".repeat(17000) } })).toThrow();
    const content = contentsInput([{ text: "", format: "text", metadata: { x: value + "a" } }])[0]!;
    expect(() => filterTokens(content)).toThrow();
  });

  it.each([{}, { source: {} }, { metadata: {} }, { source: { page: 0 } }, { metadata: { x: undefined } },
  { metadata: { x: Infinity } }, { metadata: { x: [] } }, { metadata: { x: {} } }, { other: true }])(
    "rejects invalid filter %j through Tessar errors", value => {
      try { predicate(value); expect.fail("filter accepted"); }
      catch (error) { expect(TessarError.isInstance(error)).toBe(true); expect(error).toMatchObject({ code: "InvalidData" }); }
    },
  );

  it.each([[], [[0, 0]], [[NaN, 1]], [[1, 0], [1]], [[Number.MAX_VALUE, 1]], [[1e-40, 0]]].map(vectors => ({ vectors })))(
    "rejects invalid embeddings $vectors", ({ vectors }) => { expect(() => vectorsInput(vectors, vectors.length)).toThrow(); },
  );

  it("copies and freezes content before async model calls, preserving nested JSON", () => {
    const input = [{ text: "a", format: "markdown", metadata: { nested: { "bad.$key": [1, null] } }, position: { contentIndex: 0, start: 2, end: 3 } }];
    const copied = contentsInput(input);
    input[0]!.metadata.nested["bad.$key"]![0] = 2;
    expect(copied[0]!.metadata).toEqual({ nested: { "bad.$key": [1, null] } });
    expect(Object.isFrozen(copied[0])).toBe(true);
    expect(() => contentsInput([{ ...input[0], position: { contentIndex: 0, start: 0, end: 2 } }])).toThrow();
  });

  it("extracts literal OR terms without text query operators", () => {
    expect(textTerms('hello -world "exact phrase"')).toEqual(["hello", "world", "exact", "phrase"]);
    expect(textTerms("!!!")).toEqual([]);
    expect(() => textTerms("a\u0000b")).toThrow();
  });
});
