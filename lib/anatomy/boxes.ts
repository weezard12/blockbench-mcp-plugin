/**
 * Box arithmetic for the anatomy repair core. Pure functions on {@link IBox}.
 *
 * @module
 */

import type { IBox, Vec3 } from "./types";

/** Rounds for reports. */
export const roundTo = (value: number, digits = 3): number => Math.round(value * 10 ** digits) / 10 ** digits;

/** Rounds each component for reports. */
export const roundVec = (vector: readonly number[], digits = 3): Vec3 => vector.map((value) => roundTo(value, digits) + 0) as Vec3;

/** A copy of a box with rounded corners, for reports. */
export const roundBox = (box: IBox): IBox => ({ min: roundVec(box.min), max: roundVec(box.max) });

/** Size of a box. */
export const sizeOf = (box: IBox): Vec3 => [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];

/** Centre of a box. */
export const centerOf = (box: IBox): Vec3 => [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];

/** Per-axis overlap of two boxes; negative values are gaps. */
export function overlapPerAxis(a: IBox, b: IBox): Vec3 {
  return [0, 1, 2].map((axis) => Math.min(a.max[axis] ?? 0, b.max[axis] ?? 0) - Math.max(a.min[axis] ?? 0, b.min[axis] ?? 0)) as Vec3;
}

/** A box shifted by a delta. */
export const shiftBox = (box: IBox, delta: readonly number[]): IBox => ({
  min: [box.min[0] + (delta[0] ?? 0), box.min[1] + (delta[1] ?? 0), box.min[2] + (delta[2] ?? 0)],
  max: [box.max[0] + (delta[0] ?? 0), box.max[1] + (delta[1] ?? 0), box.max[2] + (delta[2] ?? 0)],
});

/** Smallest box around several boxes, or null for none. */
export function unionBox(boxes: readonly (IBox | null | undefined)[]): IBox | null {
  const present = boxes.filter((box): box is IBox => box !== null && box !== undefined);
  const [first] = present;
  if (!first) return null;
  return present.reduce<IBox>(
    (union, box) => ({
      min: [Math.min(union.min[0], box.min[0]), Math.min(union.min[1], box.min[1]), Math.min(union.min[2], box.min[2])],
      max: [Math.max(union.max[0], box.max[0]), Math.max(union.max[1], box.max[1]), Math.max(union.max[2], box.max[2])],
    }),
    { min: [...first.min], max: [...first.max] },
  );
}

/** Volume of the part of `inner` that lies inside `outer`, as a share of `inner`'s own volume; 0 for a flat or empty `inner`. */
export function shareInside(inner: IBox, outer: IBox): number {
  const size = sizeOf(inner);
  const volume = size[0] * size[1] * size[2];
  if (!(volume > 0)) return 0;
  const [x, y, z] = overlapPerAxis(inner, outer).map((value) => Math.max(0, value));
  return ((x ?? 0) * (y ?? 0) * (z ?? 0)) / volume;
}

/** The gates' contact rule: overlap above `overlap` on at least two axes and no gap wider than `tolerance` on the third. */
export function touches(a: IBox, b: IBox, tolerance: number, overlap: number): boolean {
  const per = overlapPerAxis(a, b);
  return Math.min(...per) > -tolerance && per.filter((value) => value > overlap).length >= 2;
}
