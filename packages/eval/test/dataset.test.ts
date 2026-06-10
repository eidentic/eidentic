import { describe, it, expect } from "vitest";
import { toolUseBlock, textBlock } from "@eidentic/types";
import { captureFailure, saveDatasetJsonl, loadDatasetJsonl } from "../src/dataset.js";
import type { StoredEvent } from "@eidentic/types";
import type { EvalDataset } from "../src/index.js";

// Build a minimal event log with a user turn and an assistant response.
function buildEvents(sessionId: string): StoredEvent[] {
  const base = { sessionId, schemaVersion: 1, createdAt: "t" } as const;
  return [
    { ...base, id: "e0", seq: 0, kind: "user" as const, payload: "What is the capital of France?" },
    {
      ...base, id: "e1", seq: 1, kind: "assistant" as const,
      payload: { content: [toolUseBlock("c1", "search", { q: "France capital" })] },
    },
    {
      ...base, id: "e2", seq: 2, kind: "tool_result" as const,
      payload: { callId: "c1", toolName: "search", output: { result: "Paris" } },
    },
    {
      ...base, id: "e3", seq: 3, kind: "assistant" as const,
      payload: { content: [textBlock("The capital of France is Paris.")] },
    },
  ];
}

describe("captureFailure", () => {
  it("creates a DatasetCase with the human-supplied groundTruth (not derived from agent)", () => {
    const events = buildEvents("sess-42");
    const result = captureFailure(
      { sessionId: "sess-42", events },
      { groundTruth: "Paris" },
    );

    // groundTruth must be EXACTLY the value supplied — never derived from events
    expect(result.groundTruth).toBe("Paris");
    // id defaults to failure_<sessionId>
    expect(result.id).toBe("failure_sess-42");
    // input is derived from the first user event
    expect(result.input).toBe("What is the capital of France?");
    // capturedEvents are preserved
    expect(result.capturedEvents).toEqual(events);
  });

  it("uses a custom id when provided", () => {
    const events = buildEvents("s1");
    const result = captureFailure({ sessionId: "s1", events }, { groundTruth: "x", id: "my-custom-id" });
    expect(result.id).toBe("my-custom-id");
  });

  it("uses session.input when provided (overrides event-derived input)", () => {
    const events = buildEvents("s1");
    const result = captureFailure(
      { sessionId: "s1", events, input: "explicit input" },
      { groundTruth: "x" },
    );
    expect(result.input).toBe("explicit input");
  });

  it("attaches expected when provided", () => {
    const events = buildEvents("s1");
    const result = captureFailure(
      { sessionId: "s1", events },
      { groundTruth: "Paris", expected: { expectedTools: ["search"] } },
    );
    expect(result.expected?.expectedTools).toEqual(["search"]);
  });

  it("derives input from events when session.input is absent", () => {
    const events = buildEvents("s2");
    const result = captureFailure({ sessionId: "s2", events }, { groundTruth: "whatever" });
    expect(result.input).toBe("What is the capital of France?");
  });

  it("handles empty events gracefully (empty input)", () => {
    const result = captureFailure({ sessionId: "empty", events: [] }, { groundTruth: 42 });
    expect(result.input).toBe("");
    expect(result.groundTruth).toBe(42);
  });

  it("self-grounding guard: groundTruth is not taken from agent assistant output in events", () => {
    // Even though the events contain assistant text "The capital of France is Paris.",
    // the groundTruth should be ONLY the human-supplied value.
    const events = buildEvents("guard-test");
    const result = captureFailure({ sessionId: "guard-test", events }, { groundTruth: "HUMAN_TRUTH" });
    expect(result.groundTruth).toBe("HUMAN_TRUTH");
    // The assistant text is still in capturedEvents — we just never read it as groundTruth.
    expect(result.capturedEvents).toEqual(events);

    // @ts-expect-error: calling without groundTruth must fail at compile time
    // captureFailure({ sessionId: "s", events: [] }, {});
  });
});

describe("JSONL round-trip (saveDatasetJsonl / loadDatasetJsonl)", () => {
  it("round-trips a simple dataset", () => {
    const ds: EvalDataset = {
      name: "my-dataset",
      cases: [
        { id: "c1", input: "hello", groundTruth: "world" },
        { id: "c2", input: "foo", groundTruth: 42, expected: { expectedTools: ["bar"] } },
      ],
    };
    const jsonl = saveDatasetJsonl(ds);
    const loaded = loadDatasetJsonl(jsonl);
    expect(loaded.name).toBe("my-dataset");
    expect(loaded.cases).toHaveLength(2);
    expect(loaded.cases[0]).toEqual(ds.cases[0]);
    expect(loaded.cases[1]).toEqual(ds.cases[1]);
  });

  it("round-trips a case produced by captureFailure (preserves capturedEvents)", () => {
    const events = buildEvents("sess-rt");
    const captured = captureFailure(
      { sessionId: "sess-rt", events },
      { groundTruth: "Paris", expected: { expectedTools: ["search"] } },
    );
    const ds: EvalDataset = { name: "regression", cases: [captured] };
    const jsonl = saveDatasetJsonl(ds);
    const loaded = loadDatasetJsonl(jsonl);
    expect(loaded.cases[0]).toEqual(captured);
    expect(loaded.name).toBe("regression");
  });

  it("header carries the dataset name as {#dataset: name}", () => {
    const ds: EvalDataset = { name: "test-name", cases: [] };
    const jsonl = saveDatasetJsonl(ds);
    const firstLine = jsonl.split("\n")[0]!;
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    expect(parsed["#dataset"]).toBe("test-name");
  });

  it("blank lines are tolerated when loading", () => {
    const ds: EvalDataset = {
      name: "with-blanks",
      cases: [{ id: "c1", input: "hi", groundTruth: "there" }],
    };
    const jsonl = saveDatasetJsonl(ds);
    // Inject blank lines
    const withBlanks = "\n" + jsonl.replace("\n", "\n\n") + "\n\n";
    const loaded = loadDatasetJsonl(withBlanks);
    expect(loaded.cases).toHaveLength(1);
    expect(loaded.cases[0]!.id).toBe("c1");
  });

  it("missing header defaults name to 'dataset'", () => {
    const line = JSON.stringify({ id: "c1", input: "x", groundTruth: "y" });
    const loaded = loadDatasetJsonl(line + "\n");
    expect(loaded.name).toBe("dataset");
    expect(loaded.cases[0]!.id).toBe("c1");
  });

  it("throws with the 1-based line number when a line contains malformed JSON", () => {
    const header = JSON.stringify({ "#dataset": "bad-test" });
    const goodLine = JSON.stringify({ id: "c1", input: "hi", groundTruth: "there" });
    const badLine = "{ not valid json !!";
    const jsonl = [header, goodLine, badLine].join("\n") + "\n";
    expect(() => loadDatasetJsonl(jsonl)).toThrow(/line 3/);
  });

  it("a clean dataset still round-trips after the malformed-JSON guard is in place", () => {
    const ds: EvalDataset = {
      name: "clean",
      cases: [{ id: "c1", input: "a", groundTruth: "b" }],
    };
    const jsonl = saveDatasetJsonl(ds);
    const loaded = loadDatasetJsonl(jsonl);
    expect(loaded.name).toBe("clean");
    expect(loaded.cases).toHaveLength(1);
    expect(loaded.cases[0]!.id).toBe("c1");
  });
});
