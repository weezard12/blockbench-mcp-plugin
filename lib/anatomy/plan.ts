/**
 * Plans the repair of a creature model: which parts to slide so that every limb, head and tail
 * touches what it belongs to, and how far to lift the whole model so it stands on the ground.
 *
 * The planner is deterministic and idempotent: running it on its own result plans nothing. It
 * changes nothing itself; it returns moves, and an adapter applies them. It abstains rather than
 * guesses: a part without a clear role, host or geometry is reported as skipped, and a fix that
 * would move a part further than its own size is reported as unfixed together with the numbers.
 *
 * @module
 */

import { centerOf, overlapPerAxis, roundBox, roundTo, roundVec, shareInside, shiftBox, sizeOf, touches, unionBox } from "./boxes";
import { readRole, sideOfName, specOf, type IRoleSpec } from "./roles";
import {
  DEFAULT_CONNECT_OPTIONS,
  type AnatomyRole,
  type IAnatomyPart,
  type IAnatomyPlan,
  type IAppliedFix,
  type IBox,
  type IConnectOptions,
  type IFace,
  type IMove,
  type IPartHint,
  type ISkippedPart,
  type IUnfixedPart,
  type Vec3,
} from "./types";

/** Part id that stands for the whole model in a move. */
export const WHOLE_MODEL = "*";

/** Which repairs to plan. */
export type AnatomyStrategy = "connect" | "ground";

/** Everything the planner takes besides the parts. */
export interface IPlanRequest {
  strategies: readonly AnatomyStrategy[];
  hints: readonly IPartHint[];
  options: Partial<IConnectOptions>;
  /** Height the lowest point of the model is lifted or lowered to by `ground`. */
  groundY: number;
  /** `ground` does nothing when the lowest point is within this many units of `groundY`. */
  groundTolerance: number;
  /** Geometry that sits in no group. It counts for `ground` (the whole model moves) and for nothing else. */
  looseBoxes: readonly IBox[];
}

/** Defaults for {@link IPlanRequest}. */
export const DEFAULT_PLAN_REQUEST: IPlanRequest = {
  strategies: ["connect", "ground"],
  hints: [],
  options: {},
  groundY: 0,
  groundTolerance: 0.01,
  looseBoxes: [],
};

const AXIS_NAMES = ["x", "y", "z"] as const;

interface IResolvedPart {
  part: IAnatomyPart;
  spec: IRoleSpec;
}

/** The measurements of every part, moved as the plan moves parts. Planning never touches the parts it was given. */
class LiveModel {
  private readonly own = new Map<string, IBox[]>();
  readonly children: Map<string | null, IAnatomyPart[]>;

  constructor(readonly parts: readonly IAnatomyPart[]) {
    for (const part of parts) this.own.set(part.id, part.ownElements);
    this.children = new Map();
    for (const part of parts) this.children.set(part.parent, [...(this.children.get(part.parent) ?? []), part]);
  }

  /** Ids of a part and everything below it. */
  subtree(id: string): string[] {
    return [id, ...(this.children.get(id) ?? []).flatMap((child) => this.subtree(child.id))];
  }

  ownElements(id: string): IBox[] {
    return this.own.get(id) ?? [];
  }

  /** Elements of a part and everything below it. */
  elements(id: string): IBox[] {
    return this.subtree(id).flatMap((child) => this.ownElements(child));
  }

  ownBox(id: string): IBox | null {
    return unionBox(this.ownElements(id));
  }

  box(id: string): IBox | null {
    return unionBox(this.elements(id));
  }

  shift(id: string, delta: readonly number[]): void {
    for (const child of this.subtree(id)) this.own.set(child, this.ownElements(child).map((box) => shiftBox(box, delta)));
  }

  reset(): void {
    for (const part of this.parts) this.own.set(part.id, part.ownElements);
  }
}

/** Human-readable name of a face of a host. */
function describeFace(face: IFace, host: string): string {
  if (face.axis === 1) return face.sign > 0 ? `on top of '${host}'` : `below '${host}'`;
  if (face.axis === 2) return face.sign > 0 ? `behind '${host}'` : `in front of '${host}'`;
  return `beside '${host}' (${face.sign > 0 ? "+" : "-"}x)`;
}

/** Plans a repair. */
export function planAnatomy(parts: readonly IAnatomyPart[], request: Partial<IPlanRequest> = {}): IAnatomyPlan {
  const { strategies, hints, groundY, groundTolerance, looseBoxes, options: partialOptions } = { ...DEFAULT_PLAN_REQUEST, ...request };
  const options: IConnectOptions = { ...DEFAULT_CONNECT_OPTIONS, ...partialOptions };
  const live = new LiveModel(parts);
  const plan: IAnatomyPlan = { moves: [], applied: [], skipped: [], unfixed: [] };

  if (strategies.includes("connect")) planConnect(hints, options, live, plan);
  if (strategies.includes("ground")) planGround(live, looseBoxes, groundY, groundTolerance, plan);
  return plan;
}

function depthOf(part: IAnatomyPart, byId: ReadonlyMap<string, IAnatomyPart>): number {
  let depth = 0;
  for (let current = part.parent === null ? undefined : byId.get(part.parent); current; current = current.parent === null ? undefined : byId.get(current.parent)) depth += 1;
  return depth;
}

function volumeOf(box: IBox): number {
  const [x, y, z] = sizeOf(box);
  return x * y * z;
}

const largest = (boxes: readonly IBox[]): IBox | undefined => boxes.toSorted((a, b) => volumeOf(b) - volumeOf(a))[0];

/** Share of the elements' volume that lies inside `host`. Flat elements have no volume and do not count. */
function shareOfElementsInside(elements: readonly IBox[], host: IBox): number {
  const total = elements.reduce((sum, box) => sum + volumeOf(box), 0);
  if (!(total > 0)) return 0;
  return elements.reduce((sum, box) => sum + shareInside(box, host) * volumeOf(box), 0) / total;
}

function planConnect(hints: readonly IPartHint[], options: IConnectOptions, live: LiveModel, plan: IAnatomyPlan): void {
  const parts = live.parts;
  const byId = new Map(parts.map((part) => [part.id, part]));
  const byName = new Map<string, IAnatomyPart>();
  for (const part of parts) if (!byName.has(part.name)) byName.set(part.name, part);
  const hintOf = new Map(hints.map((hint) => [hint.name, hint]));
  const skip = (part: string, reason: string): void => void plan.skipped.push({ part, reason });

  // 1. Roles.
  const resolved: IResolvedPart[] = [];
  for (const part of parts) {
    const hint = hintOf.get(part.name);
    if (hint?.role === "none") continue;
    if (live.elements(part.id).length === 0) continue;
    if (hint?.role) {
      resolved.push({ part, spec: specOf(hint.role) });
      continue;
    }
    const reading = readRole(part.name);
    if (reading.kind === "role") resolved.push({ part, spec: reading.spec });
    else if (reading.kind === "ambiguous") skip(part.name, `The name matches several roles (${reading.roles.join(", ")}); pass a role hint.`);
    else skip(part.name, "No role from the name; pass a role hint to repair it.");
  }

  const wholeVolume = (id: string): number => {
    const box = live.box(id);
    return box ? volumeOf(box) : 0;
  };
  const primary = resolved.filter(({ spec }) => spec.role === "torso").toSorted((a, b) => wholeVolume(b.part.id) - wholeVolume(a.part.id))[0];
  if (!primary) {
    skip(WHOLE_MODEL, "No part is named like a torso (body, torso, trunk, chest, abdomen, pelvis, belly); pass a role hint to repair the model.");
    return;
  }

  const candidates = resolved.filter(({ spec }) => spec.role !== "torso").toSorted((a, b) => depthOf(a.part, byId) - depthOf(b.part, byId));
  const pending: { fix: IAppliedFix; move: IMove }[] = [];

  for (const { part, spec } of candidates) {
    const hint = hintOf.get(part.name);
    if (hint?.keep) {
      skip(part.name, "Kept where it is (keep hint).");
      continue;
    }
    if (part.tiltedAncestor) {
      skip(part.name, "A group above it is rotated, so a world-space shift would not stay a shift in its frame.");
      continue;
    }
    const host = findHost(part, spec, hint, byId, byName, live, resolved, primary.part);
    if (typeof host === "string") {
      skip(part.name, host);
      continue;
    }
    const partElements = live.elements(part.id);
    const partBox = live.box(part.id);
    const hostElements = live.ownElements(host.id);
    const hostBox = live.ownBox(host.id);
    if (!partBox || !hostBox) {
      skip(part.name, `'${host.name}' has no geometry to attach to.`);
      continue;
    }

    // The gates' view of contact: some element of the part touches some element of the host.
    const isTouching = partElements.some((element) => hostElements.some((other) => touches(element, other, options.contactTolerance, options.contactOverlap)));
    const buriedShare = spec.buriedShare ?? options.buriedShare;
    const inside = shareOfElementsInside(partElements, hostBox);
    if (isTouching && inside <= buriedShare) continue;

    // The part's main block, not its overall extent, is what must sit on the host: a head with a beak
    // is attached by the skull, even when the beak makes the head's box overlap the body.
    const core = largest(live.ownElements(part.id)) ?? largest(partElements) ?? partBox;
    const placement = choosePlacement(core, hostBox, spec.faces, sideOfName(part.name), options);
    if (!placement) {
      skip(part.name, `Role ${spec.role} has no host face to attach to.`);
      continue;
    }
    const delta = placement.delta;
    const sizes = sizeOf(partBox);
    const state = inside > buriedShare ? "is buried in" : "floats away from";
    const overBudget = ([0, 1, 2] as const).find((axis) => Math.abs(delta[axis]) > options.maxMoveRatio * Math.max(sizes[axis], 0) + options.seat + 1e-9);
    if (overBudget !== undefined) {
      plan.unfixed.push({
        part: part.name,
        finding: `${spec.role} '${part.name}' ${state} '${host.name}', and putting it ${describeFace(placement.face, host.name)} needs ${roundTo(Math.abs(delta[overBudget]), 2)} units along ${AXIS_NAMES[overBudget]}, more than the allowed ${roundTo(options.maxMoveRatio * sizes[overBudget] + options.seat, 2)}.`,
        numbers: { partBox: roundBox(partBox), hostBox: roundBox(hostBox), suggestedDelta: roundVec(delta) },
      });
      continue;
    }
    pending.push({
      move: { part: part.id, delta },
      fix: {
        strategy: "connect",
        part: part.name,
        role: spec.role,
        host: host.name,
        direction: describeFace(placement.face, host.name),
        delta: roundVec(delta),
        before: roundBox(partBox),
        after: roundBox(shiftBox(partBox, delta)),
        reason: `${spec.role} '${part.name}' ${state} '${host.name}' (${Math.round(inside * 100)}% inside, ${isTouching ? "touching" : "not touching"}); slid ${describeFace(placement.face, host.name)}.`,
      },
    });
    // Later parts see this part, and everything below it, in its new place.
    live.shift(part.id, delta);
  }

  const withGeometry = parts.filter((part) => live.elements(part.id).length > 0).length;
  const share = withGeometry === 0 ? 0 : pending.length / withGeometry;
  if (share > options.maxChangedShare) {
    for (const { fix } of pending) {
      plan.unfixed.push({ part: fix.part, finding: fix.reason, numbers: { suggestedDelta: fix.delta, partBox: fix.before } });
    }
    plan.unfixed.push({
      part: WHOLE_MODEL,
      finding: `${pending.length} of ${withGeometry} parts would have to move (more than ${Math.round(options.maxChangedShare * 100)}%): the model is wrong, not slightly off, so nothing was moved.`,
    });
    live.reset();
    return;
  }
  for (const { fix, move } of pending) {
    plan.applied.push(fix);
    plan.moves.push(move);
  }
}

/** Finds the part that `part` attaches to, or says why there is none. */
function findHost(
  part: IAnatomyPart,
  spec: IRoleSpec,
  hint: IPartHint | undefined,
  byId: ReadonlyMap<string, IAnatomyPart>,
  byName: ReadonlyMap<string, IAnatomyPart>,
  live: LiveModel,
  resolved: readonly IResolvedPart[],
  primaryTorso: IAnatomyPart,
): IAnatomyPart | string {
  const below = new Set(live.subtree(part.id));
  if (hint?.host !== undefined) {
    const named = byName.get(hint.host);
    if (!named) return `Its host hint '${hint.host}' names no part.`;
    return below.has(named.id) ? `Its host hint '${hint.host}' is the part itself or something inside it.` : named;
  }
  for (let current = part.parent === null ? undefined : byId.get(part.parent); current; current = current.parent === null ? undefined : byId.get(current.parent)) {
    if (live.ownElements(current.id).length > 0) return current;
  }
  for (const role of spec.fallbackHost ?? []) {
    const match =
      role === "torso"
        ? primaryTorso
        : resolved
            .filter((entry) => entry.spec.role === role && !below.has(entry.part.id))
            .toSorted((a, b) => volumeOf(live.box(b.part.id) ?? { min: [0, 0, 0], max: [0, 0, 0] }) - volumeOf(live.box(a.part.id) ?? { min: [0, 0, 0], max: [0, 0, 0] }))[0]?.part;
    if (match && !below.has(match.id)) return match;
  }
  return "It sits in no group that holds geometry and no fallback host was found; pass a host hint.";
}

interface IPlacement {
  face: IFace;
  delta: Vec3;
}

/**
 * The cheapest slide that puts a part flush against one of the faces its role allows, with a seat,
 * and inside the host's span on the other two axes. "Cheapest" is the total distance moved over all
 * three axes, so a head floating above a body goes down onto its top and not around to its front.
 */
function choosePlacement(
  part: IBox,
  host: IBox,
  faces: readonly IFace[],
  side: "left" | "right" | undefined,
  options: IConnectOptions,
): IPlacement | undefined {
  const candidates = faces.map((face): IPlacement & { total: number } => {
    const delta: Vec3 = [0, 0, 0];
    delta[face.axis] =
      face.sign > 0 ? host.max[face.axis] - options.seat - part.min[face.axis] : host.min[face.axis] + options.seat - part.max[face.axis];
    const moved = shiftBox(part, delta);
    const overlap = overlapPerAxis(moved, host);
    for (const axis of [0, 1, 2] as const) {
      if (axis === face.axis || overlap[axis] > options.contactOverlap) continue;
      const partSpan = moved.max[axis] - moved.min[axis];
      const hostSpan = host.max[axis] - host.min[axis];
      if (partSpan <= hostSpan) {
        delta[axis] = moved.min[axis] < host.min[axis] ? host.min[axis] - moved.min[axis] : host.max[axis] - moved.max[axis];
      } else {
        delta[axis] = centerOf(host)[axis] - centerOf(moved)[axis];
      }
    }
    return { face, delta, total: Math.abs(delta[0]) + Math.abs(delta[1]) + Math.abs(delta[2]) };
  });
  return candidates.reduce<(typeof candidates)[number] | undefined>((current, candidate) => {
    if (!current) return candidate;
    if (Math.abs(candidate.total - current.total) < 1e-9) {
      // A tie on the side axis follows the side in the name, so a left part and its right twin go different ways.
      if (candidate.face.axis === 0 && side) return candidate.face.sign === (side === "right" ? 1 : -1) ? candidate : current;
      return current;
    }
    return candidate.total < current.total ? candidate : current;
  }, undefined);
}

function planGround(live: LiveModel, looseBoxes: readonly IBox[], groundY: number, tolerance: number, plan: IAnatomyPlan): void {
  const whole = unionBox([...live.parts.flatMap((part) => live.ownElements(part.id)), ...looseBoxes]);
  if (!whole) {
    plan.skipped.push({ part: WHOLE_MODEL, reason: "The model holds no geometry to put on the ground." });
    return;
  }
  const lift = groundY - whole.min[1];
  if (Math.abs(lift) <= tolerance) return;
  const delta: Vec3 = [0, lift, 0];
  plan.moves.push({ part: WHOLE_MODEL, delta });
  plan.applied.push({
    strategy: "ground",
    part: WHOLE_MODEL,
    direction: lift > 0 ? "up" : "down",
    delta: roundVec(delta),
    before: roundBox(whole),
    after: roundBox(shiftBox(whole, delta)),
    reason: `The lowest point of the model is at y = ${roundTo(whole.min[1], 2)}; moved ${lift > 0 ? "up" : "down"} ${roundTo(Math.abs(lift), 2)} to stand at y = ${groundY}.`,
  });
}

export type { IUnfixedPart, ISkippedPart, AnatomyRole };
