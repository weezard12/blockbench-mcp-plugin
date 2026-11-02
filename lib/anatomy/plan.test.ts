import { describe, expect, test } from "bun:test";
import { nameWords, readRole, sideOfName } from "./roles";
import { planAnatomy, WHOLE_MODEL } from "./plan";
import { buildParts, type ITestGroup } from "./test-parts";
import type { AnatomyRole, IAnatomyPart, IMove, Vec3 } from "./types";

/** A body with a head, a beak and a tail that are already attached; tests add the parts under repair. */
const SOUND: ITestGroup[] = [
  { name: "body", own: [[-4, 0, -5], [4, 12, 5]] },
  { name: "head", parent: "body", own: [[-3, 11.75, -6], [3, 17.75, 0]] },
  { name: "beak", parent: "head", own: [[-1, 13, -8], [1, 15, -5.75]] },
  { name: "tail", parent: "body", own: [[-1, 2, 4.75], [1, 4, 8]] },
];

/** The run 4 penguin: both legs stand inside a body that starts on the ground. */
const BURIED_PENGUIN: ITestGroup[] = [
  ...SOUND,
  { name: "leg_right", parent: "body", own: [[1, 0, 1], [3, 6, 3]] },
  { name: "leg_left", parent: "body", own: [[-3, 0, 1], [-1, 6, 3]] },
];

/** Applies moves to parts the way an adapter would: the part and everything below it shifts. */
function apply(parts: readonly IAnatomyPart[], moves: readonly IMove[]): IAnatomyPart[] {
  const shifted = parts.map((part) => ({ ...part }));
  const below = (id: string): string[] => [id, ...shifted.filter((part) => part.parent === id).flatMap((part) => below(part.id))];
  for (const move of moves) {
    const ids = move.part === WHOLE_MODEL ? shifted.map((part) => part.id) : below(move.part);
    for (const part of shifted.filter((candidate) => ids.includes(candidate.id))) {
      part.ownElements = part.ownElements.map((box) => ({
        min: box.min.map((value, axis) => value + (move.delta[axis] ?? 0)) as Vec3,
        max: box.max.map((value, axis) => value + (move.delta[axis] ?? 0)) as Vec3,
      }));
    }
  }
  return shifted;
}

describe("names to roles", () => {
  test.each<[string, AnatomyRole]>([
    ["front_leg_right", "leg"],
    ["legL", "leg"],
    ["Hind Leg 2", "leg"],
    ["wings", "limb"],
    ["Torso", "torso"],
    ["neck_1", "neck"],
    ["horn_left", "top_attachment"],
    ["beak", "face_attachment"],
  ])("%s is a %s", (name, role) => {
    const reading = readRole(name);
    expect(reading.kind === "role" ? reading.spec.role : reading.kind).toBe(role);
  });

  test("unknown and ambiguous names have no role", () => {
    expect(readRole("root").kind).toBe("none");
    expect(readRole("tail_fin")).toEqual({ kind: "ambiguous", roles: ["tail", "limb"] });
  });

  test("words and sides", () => {
    expect(nameWords("legL")).toEqual(["leg", "l"]);
    expect(sideOfName("wing_right")).toBe("right");
    expect(sideOfName("Arm.L")).toBe("left");
    expect(sideOfName("body")).toBeUndefined();
  });
});

describe("connect", () => {
  test("slides legs that stand inside the body down to its underside, then grounds the model", () => {
    const plan = planAnatomy(buildParts(BURIED_PENGUIN));

    const right = plan.applied.find((fix) => fix.part === "leg_right");
    expect(right?.delta).toEqual([0, -5.75, 0]);
    expect(right?.before).toEqual({ min: [1, 0, 1], max: [3, 6, 3] });
    expect(right?.after).toEqual({ min: [1, -5.75, 1], max: [3, 0.25, 3] });
    expect(right?.direction).toBe("below 'body'");
    expect(plan.applied.find((fix) => fix.part === "leg_left")?.delta).toEqual([0, -5.75, 0]);
    // The lowest point is now -5.75: the whole model is lifted onto the ground.
    expect(plan.applied.find((fix) => fix.strategy === "ground")?.delta).toEqual([0, 5.75, 0]);
    expect(plan.unfixed).toEqual([]);
  });

  test("is idempotent", () => {
    const parts = buildParts(BURIED_PENGUIN);
    const first = planAnatomy(parts);
    const second = planAnatomy(apply(parts, first.moves));
    expect(second.moves).toEqual([]);
    expect(second.applied).toEqual([]);
  });

  test("pulls a floating head down onto the top of the body, not around to its front", () => {
    const parts = buildParts([
      ...SOUND.filter((group) => group.name !== "head" && group.name !== "beak"),
      { name: "head", parent: "body", own: [[-3, 16.8, -6], [3, 22.8, 0]] },
      { name: "leg_right", parent: "body", own: [[1, -6, 1], [3, 0.25, 3]] },
    ]);
    const plan = planAnatomy(parts, { strategies: ["connect"] });
    expect(plan.applied).toHaveLength(1);
    expect(plan.applied[0]?.direction).toBe("on top of 'body'");
    expect(plan.applied[0]?.delta).toEqual([0, -5.05, 0]);
  });

  test("judges contact per element, the way the gates do: a head whose skull floats in front of the body is moved", () => {
    // The real run 3 penguin: the head group's box overlaps the body's, but the skull and cheeks touch nothing.
    const parts = buildParts([
      { name: "body", elements: [[[-3, 2, -3], [3, 7, 3]], [[-3, 0, -3], [3, 2, 3]], [[-3, 7, -3], [3, 8, 3]]] },
      { name: "head", parent: "body", elements: [[[-3, 10, -8], [3, 16, -4]], [[-3, 12, -8], [3, 16, -2]]] },
      { name: "beak", parent: "head", own: [[-1, 11, -11], [1, 13, -8]] },
    ]);
    const plan = planAnatomy(parts, { strategies: ["connect"] });
    expect(plan.applied.map((fix) => fix.part)).toEqual(["head"]);
    expect(plan.applied[0]?.direction).toBe("on top of 'body'");
    expect(plan.applied[0]?.delta).toEqual([0, -2.25, 5]);
    // The beak follows the head and is not planned on its own.
    expect(plan.moves.map((move) => move.part)).toEqual(["head"]);
  });

  test("the main block of a part is what sits on the host, not a beak or a horn that sticks out", () => {
    const parts = buildParts([
      { name: "body", own: [[-4, 0, -5], [4, 12, 5]] },
      { name: "head", parent: "body", elements: [[[-3, 16, -3], [3, 22, 3]], [[-1, 17, -8], [1, 19, -3]]] },
    ]);
    const [fix] = planAnatomy(parts, { strategies: ["connect"] }).applied;
    // The skull (the larger element) lands on the top face with its seat, so the beak ends up in front of the body.
    expect(fix?.direction).toBe("on top of 'body'");
    expect(fix?.delta).toEqual([0, -4.25, 0]);
  });

  test("a part that touches its host through one of its elements stays", () => {
    const parts = buildParts([
      { name: "body", own: [[-4, 0, -5], [4, 12, 5]] },
      { name: "tail", parent: "body", elements: [[[-1, 4, 5], [1, 6, 8]], [[-1, 4, 8], [1, 8, 12]]] },
    ]);
    expect(planAnatomy(parts, { strategies: ["connect"] }).moves).toEqual([]);
  });

  test("leaves a part that already touches its host alone", () => {
    const parts = buildParts([
      { name: "body", own: [[-4, 6, -5], [4, 18, 5]] },
      { name: "leg_right", parent: "body", own: [[1, 0, 1], [3, 6.5, 3]] },
    ]);
    expect(planAnatomy(parts, { strategies: ["connect"] }).moves).toEqual([]);
    expect(planAnatomy(buildParts(SOUND), { strategies: ["connect"] }).moves).toEqual([]);
  });

  test("moves a part's whole subtree and lets later parts see the new place", () => {
    const parts = buildParts([
      ...SOUND,
      { name: "leg_right", parent: "body", own: [[1, 0, 1], [3, 6, 3]] },
      { name: "foot_right", parent: "leg_right", own: [[1, 0, 1], [3, 1, 4]] },
    ]);
    const plan = planAnatomy(parts, { strategies: ["connect"] });
    // The leg moves with its foot; the foot, still attached to the leg after that, is not moved again.
    expect(plan.moves.map((move) => move.part)).toEqual(["leg_right"]);
  });

  test("a left part and its right twin buried in the middle go to opposite sides", () => {
    const parts = buildParts([
      ...SOUND,
      { name: "wing_right", parent: "body", own: [[-3, 2, -2], [3, 8, 2]] },
      { name: "wing_left", parent: "body", own: [[-3, 2, -2], [3, 8, 2]] },
    ]);
    // Both start exactly in the middle of the body, so the side in the name decides.
    const plan = planAnatomy(parts, { strategies: ["connect"], options: { maxMoveRatio: 2 } });
    const right = plan.applied.find((fix) => fix.part === "wing_right");
    const left = plan.applied.find((fix) => fix.part === "wing_left");
    expect(right?.delta[0]).toBeGreaterThan(0);
    expect(left?.delta[0]).toBeLessThan(0);
    expect(right?.delta[0]).toBe(-(left?.delta[0] ?? 0));
  });

  test("a move longer than the part is reported with numbers, not made", () => {
    const parts = buildParts([
      ...SOUND.filter((group) => group.name !== "head" && group.name !== "beak"),
      { name: "head", parent: "body", own: [[-3, 40, -6], [3, 44, 0]] },
    ]);
    const plan = planAnatomy(parts, { strategies: ["connect"] });
    expect(plan.moves).toEqual([]);
    const head = plan.unfixed.find((item) => item.part === "head");
    expect(head?.finding).toContain("floats away from 'body'");
    expect(head?.numbers?.suggestedDelta).toEqual([0, -28.25, 0]);
  });

  test("when most parts would move, nothing moves", () => {
    const parts = buildParts([
      { name: "body", own: [[-4, 0, -5], [4, 12, 5]] },
      { name: "leg_right", parent: "body", own: [[1, 0, 1], [3, 6, 3]] },
      { name: "leg_left", parent: "body", own: [[-3, 0, 1], [-1, 6, 3]] },
      { name: "head", parent: "body", own: [[-3, 11.75, -6], [3, 17.75, 0]] },
    ]);
    const plan = planAnatomy(parts, { strategies: ["connect"], options: { maxChangedShare: 0.4 } });
    expect(plan.moves).toEqual([]);
    expect(plan.unfixed.some((item) => item.part === WHOLE_MODEL)).toBe(true);
    expect(plan.unfixed.filter((item) => item.part !== WHOLE_MODEL).map((item) => item.part).toSorted()).toEqual(["leg_left", "leg_right"]);
  });

  test("hints: keep, role, host and none", () => {
    const base: ITestGroup[] = [
      ...SOUND,
      { name: "halo", parent: "body", own: [[-2, 20, -2], [2, 21, 2]] },
      { name: "part_x", parent: "body", own: [[1, 0, 1], [3, 6, 3]] },
    ];
    const parts = buildParts(base);
    const plan = planAnatomy(parts, { strategies: ["connect"], hints: [{ name: "halo", role: "head", keep: true }, { name: "part_x", role: "leg" }] });
    expect(plan.skipped).toContainEqual({ part: "halo", reason: "Kept where it is (keep hint)." });
    expect(plan.applied.map((fix) => fix.part)).toEqual(["part_x"]);
    const none = planAnatomy(parts, { strategies: ["connect"], hints: [{ name: "part_x", role: "none" }] });
    expect(none.moves).toEqual([]);
  });

  test("a host hint beats the group a part sits in", () => {
    const parts = buildParts([
      { name: "body", own: [[-4, 0, -5], [4, 12, 5]] },
      { name: "head", parent: "body", own: [[-3, 12, -6], [3, 18, 0]] },
      { name: "eye_right", own: [[1, 14, -7.5], [2, 15, -6.5]] },
    ]);
    const plan = planAnatomy(parts, { strategies: ["connect"], hints: [{ name: "eye_right", host: "head" }] });
    expect(plan.applied[0]?.host).toBe("head");
    expect(plan.applied[0]?.direction).toBe("in front of 'head'");
  });

  test("abstains for unknown names, rotated groups and a model without a torso", () => {
    const plan = planAnatomy(
      buildParts([
        { name: "body", own: [[-4, 0, -5], [4, 12, 5]] },
        { name: "blob", parent: "body", own: [[10, 0, 0], [12, 2, 2]] },
        { name: "tail_fin", parent: "body", own: [[10, 0, 0], [12, 2, 2]] },
        { name: "leg_right", parent: "body", own: [[1, 0, 1], [3, 6, 3]], tilted: true },
      ]),
      { strategies: ["connect"] },
    );
    expect(plan.moves).toEqual([]);
    expect(plan.skipped.map((item) => item.part).toSorted()).toEqual(["blob", "leg_right", "tail_fin"]);

    const headless = planAnatomy(buildParts([{ name: "leg_right", own: [[1, 0, 1], [3, 6, 3]] }]), { strategies: ["connect"] });
    expect(headless.skipped[0]?.part).toBe(WHOLE_MODEL);
  });

  test("a part with no group that holds geometry falls back to the torso", () => {
    const parts = buildParts([...SOUND, { name: "leg_right", own: [[1, 0, 1], [3, 6, 3]] }]);
    expect(planAnatomy(parts, { strategies: ["connect"] }).applied[0]?.host).toBe("body");
  });
});

describe("ground", () => {
  test("lifts a model that hangs below the ground and lowers one that floats", () => {
    const below = planAnatomy(buildParts([{ name: "body", own: [[-4, -3, -5], [4, 9, 5]] }]), { strategies: ["ground"] });
    expect(below.moves).toEqual([{ part: WHOLE_MODEL, delta: [0, 3, 0] }]);
    const above = planAnatomy(buildParts([{ name: "body", own: [[-4, 2, -5], [4, 14, 5]] }]), { strategies: ["ground"] });
    expect(above.moves).toEqual([{ part: WHOLE_MODEL, delta: [0, -2, 0] }]);
  });

  test("does nothing within the tolerance", () => {
    expect(planAnatomy(buildParts([{ name: "body", own: [[-4, 0.005, -5], [4, 12, 5]] }]), { strategies: ["ground"] }).moves).toEqual([]);
  });

  test("honours another ground height", () => {
    const plan = planAnatomy(buildParts([{ name: "body", own: [[-4, 0, -5], [4, 12, 5]] }]), { strategies: ["ground"], groundY: 16 });
    expect(plan.moves).toEqual([{ part: WHOLE_MODEL, delta: [0, 16, 0] }]);
  });
});
