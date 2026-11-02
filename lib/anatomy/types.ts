/**
 * Shared types of the anatomy repair core.
 *
 * The core is pure geometry. It sees a model as a tree of parts (Blockbench groups, "bones") with
 * world-space boxes, and answers with moves. It touches no Blockbench global and no `.bbmodel`
 * JSON, so the plugin tool (live Blockbench objects) and the headless tool (the document file)
 * can both feed it through a small adapter and apply its moves their own way.
 *
 * @module
 */

/** `[x, y, z]` in model units. */
export type Vec3 = [number, number, number];

/** Axis-aligned world-space box. */
export interface IBox {
  min: Vec3;
  max: Vec3;
}

/** What a part is, as far as its name says. */
export type AnatomyRole = "torso" | "head" | "neck" | "leg" | "limb" | "tail" | "top_attachment" | "face_attachment";

/** One face of a host box: the axis (0 = x, 1 = y, 2 = z) and which end (-1 low, +1 high). */
export interface IFace {
  axis: 0 | 1 | 2;
  sign: -1 | 1;
}

/**
 * A part of the model as an adapter sees it. A part is a group; the planner derives every other box from
 * the world boxes of the elements directly in it, so an adapter only measures elements.
 */
export interface IAnatomyPart {
  /** Stable identifier (the group UUID). */
  id: string;
  name: string;
  /** Parent part, or null at the root. */
  parent: string | null;
  /** World boxes of the elements directly in this group (sub-groups excluded), one per element. */
  ownElements: IBox[];
  /** True when a group above this part is rotated, so a world-space shift is not a shift in its frame. */
  tiltedAncestor: boolean;
}

/** A caller's knowledge about one part. It wins over what the name suggests. */
export interface IPartHint {
  /** Part (group) name. */
  name: string;
  /** Role of the part; `"none"` takes the part out of every repair. */
  role?: AnatomyRole | "none";
  /** Name of the part this one attaches to. Defaults to the nearest ancestor that holds geometry. */
  host?: string;
  /** Leave the part exactly where it is (a deliberately detached or overlapping part). */
  keep?: boolean;
}

/** Tunable limits. */
export interface IConnectOptions {
  /** Units a connected part sinks into its host, so no seam shows. */
  seat: number;
  /** Largest gap on the third axis that still counts as touching (same rule as the floating gate). */
  contactTolerance: number;
  /** Overlap on two axes needed for a real contact face (same rule as the floating gate). */
  contactOverlap: number;
  /**
   * A part with more than this share of its volume inside its host is buried. Deliberately high: a foot that is
   * wider than its leg, or a wing that rests against the body, overlaps its host by half and is fine.
   */
  buriedShare: number;
  /** A part moves by at most this many times its own size along the axis, plus the seat. */
  maxMoveRatio: number;
  /** When more than this share of all parts that hold geometry would move, nothing moves: the model is wrong, not slightly off. */
  maxChangedShare: number;
}

/** Defaults for {@link IConnectOptions}. */
export const DEFAULT_CONNECT_OPTIONS: IConnectOptions = {
  seat: 0.25,
  contactTolerance: 0.12,
  contactOverlap: 0.15,
  buriedShare: 0.8,
  maxMoveRatio: 1,
  maxChangedShare: 0.5,
};

/** A shift of one part together with everything below it. */
export interface IMove {
  /** Part id. */
  part: string;
  delta: Vec3;
}

/** One fix the planner decided on. */
export interface IAppliedFix {
  strategy: "connect" | "ground";
  /** Name of the part (`"*"` for the whole model). */
  part: string;
  role?: AnatomyRole;
  host?: string;
  /** Human-readable direction, such as `"below torso"`. */
  direction: string;
  delta: Vec3;
  before: IBox;
  after: IBox;
  reason: string;
}

/** A part the planner left alone, and why. */
export interface ISkippedPart {
  part: string;
  reason: string;
}

/** A defect the planner found but would not fix, with the numbers a caller needs to act on it. */
export interface IUnfixedPart {
  part: string;
  finding: string;
  numbers?: Record<string, unknown>;
}

/** What the planner decided. */
export interface IAnatomyPlan {
  moves: IMove[];
  applied: IAppliedFix[];
  skipped: ISkippedPart[];
  unfixed: IUnfixedPart[];
}
