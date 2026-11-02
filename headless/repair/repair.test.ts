import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { IBBModel, ICube } from "../document/schema";
import { applyOperations, operationSchema } from "../edit/operations";
import { runGeometryGates } from "../gates/geometry";
import { ModelStore } from "../document/store";
import { BbRenderer } from "../render/bb-render";
import { createHeadlessServer } from "../server";
import { creatureModel } from "../test-fixtures";
import { emptyModel } from "../tools/edit";
import { repairDocument, type IRepairReport } from "./repair-document";

const build = (operations: unknown[]): IBBModel =>
  applyOperations(emptyModel("free", "penguin", false, { width: 64, height: 64 }), operationSchema.array().parse(operations)).doc;

/** The run 4 penguin, as a model: a body on the ground with a head, a beak and a tail attached, and both legs standing inside the body. */
const buriedPenguin = (): IBBModel =>
  build([
    { op: "add_group", name: "body", origin: [0, 6, 0] },
    { op: "add_cube", name: "body_cube", from: [-4, 0, -5], to: [4, 12, 5], parent: "body" },
    { op: "add_group", name: "head", origin: [0, 12, -3], parent: "body" },
    { op: "add_cube", name: "head_cube", from: [-3, 11.75, -6], to: [3, 17.75, 0], parent: "head" },
    { op: "add_group", name: "beak", origin: [0, 14, -6], parent: "head" },
    { op: "add_cube", name: "beak_cube", from: [-1, 13, -8], to: [1, 15, -5.75], parent: "beak" },
    { op: "add_group", name: "tail", origin: [0, 3, 5], parent: "body" },
    { op: "add_cube", name: "tail_cube", from: [-1, 2, 4.75], to: [1, 4, 8], parent: "tail" },
    { op: "add_group", name: "leg_right", origin: [2, 6, 2], parent: "body" },
    { op: "add_cube", name: "leg_right_cube", from: [1, 0, 1], to: [3, 6, 3], parent: "leg_right" },
    { op: "add_group", name: "leg_left", origin: [-2, 6, 2], parent: "body" },
    { op: "add_cube", name: "leg_left_cube", from: [-3, 0, 1], to: [-1, 6, 3], parent: "leg_left" },
  ]);

const cube = (doc: IBBModel, name: string): ICube => {
  const found = doc.elements.find((element) => element.name === name);
  if (!found || found.type !== "cube") throw new Error(`no cube ${name}`);
  return found as ICube;
};

describe("repairDocument", () => {
  test("slides buried legs under the body and stands the model on the ground", () => {
    const doc = buriedPenguin();
    const { doc: repaired, report } = repairDocument(doc, {}, false);

    expect(report.committed).toBe(true);
    expect(report.applied.map((fix) => fix.part).toSorted()).toEqual(["*", "leg_left", "leg_right"]);
    // Legs: 5.75 down (flush under the body with a 0.25 seat), then the whole model 5.75 up.
    expect(cube(repaired, "leg_right_cube").from).toEqual([1, 0, 1]);
    expect(cube(repaired, "leg_right_cube").to).toEqual([3, 6, 3]);
    expect(cube(repaired, "body_cube").from).toEqual([-4, 5.75, -5]);
    expect(cube(repaired, "head_cube").from[1]).toBeCloseTo(17.5, 6);
    // Groups follow their geometry, so a pivot stays where it was relative to its part.
    expect(repaired.groups.find((group) => group.name === "leg_right")?.origin).toEqual([2, 6, 2]);
    expect(report.checks.before.total).toBeGreaterThan(report.checks.after.total);
    expect(report.checks.after.total).toBe(0);
    expect(report.bounds?.min[1]).toBe(0);
    // The input is not touched.
    expect(cube(doc, "leg_right_cube").from).toEqual([1, 0, 1]);
  });

  test("is idempotent", () => {
    const first = repairDocument(buriedPenguin(), {}, false);
    const second = repairDocument(first.doc, {}, false);
    expect(second.report.applied).toEqual([]);
    expect(second.report.changed).toBe(false);
    expect(second.doc).toBe(first.doc);
  });

  test("a dry run plans and reports but keeps nothing", () => {
    const doc = buriedPenguin();
    const { doc: result, report } = repairDocument(doc, {}, true);
    expect(report.dry_run).toBe(true);
    expect(report.committed).toBe(false);
    expect(report.applied).toHaveLength(3);
    expect(result).toBe(doc);
  });

  test("leaves a sound model alone", () => {
    const { report } = repairDocument(creatureModel(), { strategies: ["connect"] }, false);
    expect(report.applied).toEqual([]);
    expect(report.unfixed).toEqual([]);
  });

  test("drops moves that would add findings to the gates", () => {
    const doc = applyOperations(buriedPenguin(), operationSchema.array().parse([
      { op: "add_group", name: "rock_a" },
      { op: "add_cube", name: "rock_a_cube", from: [1, -5, 1], to: [3, -2, 3], parent: "rock_a" },
      { op: "add_group", name: "rock_b" },
      { op: "add_cube", name: "rock_b_cube", from: [1, -4, 1], to: [3, -1, 3], parent: "rock_b" },
    ])).doc;
    const { doc: result, report } = repairDocument(doc, { strategies: ["connect"], hints: [{ name: "leg_left", keep: true }] }, false);
    expect(report.rolled_back).toContain("raised the gate findings");
    expect(report.committed).toBe(false);
    expect(report.applied).toEqual([]);
    expect(report.unfixed.some((item) => item.part === "leg_right" && Array.isArray((item.numbers as { suggestedDelta?: unknown }).suggestedDelta))).toBe(true);
    expect(result).toBe(doc);
  });

  test("keep hints leave a part alone and the floating gate is told", () => {
    const doc = applyOperations(buriedPenguin(), operationSchema.array().parse([
      { op: "add_group", name: "halo", parent: "head" },
      { op: "add_cube", name: "halo_cube", from: [-2, 25, -3], to: [2, 26, -1], parent: "halo" },
    ])).doc;
    const { report } = repairDocument(doc, { hints: [{ name: "halo", role: "top_attachment", keep: true }] }, false);
    expect(report.skipped).toContainEqual({ part: "halo", reason: "Kept where it is (keep hint)." });
    expect(report.checks.before.byGate.floating).toBe(0);
  });

  test("moves a rotated part by its rotated bounds, and abstains under a rotated group", () => {
    const doc = applyOperations(buriedPenguin(), operationSchema.array().parse([{ op: "update_node", target: "head", rotation: [0, 0, 20] }])).doc;
    const { report } = repairDocument(doc, { strategies: ["connect"] }, false);
    // The head group itself is rotated (allowed); the beak sits under a rotated group (skipped).
    expect(report.skipped.some((item) => item.part === "beak" && item.reason.includes("rotated"))).toBe(true);
  });
});

describe("bbmodel_auto_correct_anatomy", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-repair-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function connect(): Promise<{ client: Client; json<T>(name: string, args: Record<string, unknown>): Promise<T>; store: ModelStore }> {
    const store = new ModelStore({ roots: [root] });
    const server = createHeadlessServer((mcp) => ({
      store,
      renderer: new BbRenderer({ node: "node", concurrency: 1, timeoutMs: 1000, prepare: () => Promise.reject(new Error("disabled")) }),
      scratchDir: join(root, "renders"),
      aiDisclosure: true,
      clientName: () => mcp.server.getClientVersion()?.name ?? "unknown",
      webApp: { enabled: false, baseUrl: "", inlineMax: 0, browserMax: 0, launcherDir: "" },
      desktop: { executable: process.execPath, mcpUrl: "http://127.0.0.1:9/bb-mcp" },
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "repair-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const json = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      if (result.isError) throw new Error(text);
      return JSON.parse(text) as T;
    };
    return { client, json, store };
  }

  test("repairs the file, returns the report and a new revision, and validation then passes", async () => {
    const { json, store } = await connect();
    await store.create("penguin.bbmodel", buriedPenguin(), false);
    const before = await json<{ gates: { id: string; violations: unknown[] }[]; revision: string }>("bbmodel_validate", { file: "penguin.bbmodel", gates: ["floating", "interpenetration"] });
    expect(before.gates.find((gate) => gate.id === "interpenetration")?.violations.length).toBeGreaterThan(0);

    const report = await json<IRepairReport & { revision: string }>("bbmodel_auto_correct_anatomy", { file: "penguin.bbmodel", expected_revision: before.revision });
    expect(report.committed).toBe(true);
    expect(report.revision).not.toBe(before.revision);
    expect(report.applied.map((fix) => fix.strategy).toSorted()).toEqual(["connect", "connect", "ground"]);

    const after = await store.read("penguin.bbmodel");
    expect(runGeometryGates(after.doc, {}, ["floating", "interpenetration", "mirror"]).flatMap((gate) => gate.violations)).toEqual([]);
  });

  test("a dry run writes nothing", async () => {
    const { json, store } = await connect();
    await store.create("penguin.bbmodel", buriedPenguin(), false);
    const before = await store.read("penguin.bbmodel");
    const report = await json<IRepairReport>("bbmodel_auto_correct_anatomy", { file: "penguin.bbmodel", dry_run: true });
    expect(report.applied.length).toBe(3);
    expect((await store.read("penguin.bbmodel")).revision).toBe(before.revision);
  });

  test("refuses a stale revision like the other writers", async () => {
    const { client, store } = await connect();
    await store.create("penguin.bbmodel", buriedPenguin(), false);
    const result = (await client.callTool({ name: "bbmodel_auto_correct_anatomy", arguments: { file: "penguin.bbmodel", expected_revision: "stale" } })) as CallToolResult;
    expect(result.isError).toBe(true);
  });
});
