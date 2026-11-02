/**
 * Builds {@link IAnatomyPart} trees for the anatomy tests from a list of groups with their own boxes.
 *
 * @module
 */

import type { IAnatomyPart, IBox, Vec3 } from "./types";

/** One group of a test creature. */
export interface ITestGroup {
  name: string;
  /** Name of the parent group, or empty at the root. */
  parent?: string;
  /** The group's own geometry as one element, `[min, max]`. */
  own?: [Vec3, Vec3];
  /** The group's own geometry as several elements. */
  elements?: [Vec3, Vec3][];
  /** Marks a group above this one as rotated. */
  tilted?: boolean;
}

const toBox = ([min, max]: [Vec3, Vec3]): IBox => ({ min: [...min], max: [...max] });

/** Builds the parts. Ids are the names. */
export function buildParts(groups: readonly ITestGroup[]): IAnatomyPart[] {
  return groups.map((group) => ({
    id: group.name,
    name: group.name,
    parent: group.parent ? group.parent : null,
    ownElements: [...(group.own ? [toBox(group.own)] : []), ...(group.elements ?? []).map(toBox)],
    tiltedAncestor: group.tilted ?? false,
  }));
}
