/**
 * Joins the anatomy repair core to `.bbmodel` documents: reads a document as a tree of parts with
 * world boxes, and applies the core's moves to the document.
 *
 * Boxes come from the same code the geometry gates use ({@link elementBoxes}), so a part's rotation
 * and its ancestors' rotations are respected and a repair is judged by the gates' own measure.
 *
 * @module
 */

import { type IAnatomyPart, type IBox, type IMove, type Vec3 } from "@/lib/anatomy/types";
import { WHOLE_MODEL } from "@/lib/anatomy/plan";
import { unionBox } from "@/lib/anatomy/boxes";
import type { IBBModel, IElement } from "../document/schema";
import { ancestorsOf, descendantsOf, directElementsOf, type IModelIndex, indexModel } from "../document/tree";
import { elementBoxes } from "../geometry/bounds";

/** A document read as parts. */
export interface IModelParts {
  parts: IAnatomyPart[];
  /** Boxes of geometry that sits in no group. */
  looseBoxes: IBox[];
  index: IModelIndex;
}

const isTilted = (rotation: readonly number[] | undefined): boolean => (rotation ?? []).some((value) => Math.abs(value) > 1e-6);

/** Reads a document as parts: one per group, with the world box of every element directly in it. */
export function readParts(doc: IBBModel): IModelParts {
  const index = indexModel(doc);
  const boxes = elementBoxes(doc, index, undefined, (element) => index.placement.has(element.uuid));
  const parts: IAnatomyPart[] = index.order
    .filter((id) => index.placement.get(id)?.kind === "group")
    .map((id) => ({
      id,
      name: index.groups.get(id)?.name ?? id,
      parent: index.placement.get(id)?.parent ?? null,
      ownElements: directElementsOf(index, id).flatMap((element) => boxes.get(element) ?? []),
      tiltedAncestor: ancestorsOf(index, id).some((ancestor) => isTilted(index.groups.get(ancestor)?.rotation)),
    }));
  const looseBoxes = directElementsOf(index, null).flatMap((element) => boxes.get(element) ?? []);
  return { parts, looseBoxes, index };
}

/** Box around all geometry of a document, or null when there is none. */
export function modelBounds(doc: IBBModel): IBox | null {
  const { parts, looseBoxes } = readParts(doc);
  return unionBox([...parts.flatMap((part) => part.ownElements), ...looseBoxes]);
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

function shiftTriple(value: unknown, delta: readonly number[]): Vec3 | undefined {
  if (!Array.isArray(value) || value.length < 3 || value.some((entry) => typeof entry !== "number")) return undefined;
  return [round6((value[0] as number) + (delta[0] ?? 0)), round6((value[1] as number) + (delta[1] ?? 0)), round6((value[2] as number) + (delta[2] ?? 0))];
}

/** Shifts an element in place. A mesh's vertices are relative to its origin, so only the origin moves. */
function shiftElement(element: IElement & Record<string, unknown>, delta: readonly number[]): void {
  for (const key of ["from", "to", "origin", "position"] as const) {
    const shifted = shiftTriple(element[key], delta);
    if (shifted) element[key] = shifted;
  }
}

/** Applies moves to a copy of the document. Animations are keyed relative to the rest pose, so they stay as they are. */
export function applyMoves(doc: IBBModel, moves: readonly IMove[]): IBBModel {
  const copy = structuredClone(doc);
  const index = indexModel(copy);
  for (const move of moves) {
    const ids = move.part === WHOLE_MODEL ? [...index.groups.keys(), ...index.elements.keys()] : [move.part, ...descendantsOf(index, move.part)];
    for (const id of ids) {
      const group = index.groups.get(id);
      if (group) {
        const shifted = shiftTriple(group.origin, move.delta);
        if (shifted) group.origin = shifted;
      }
      const element = index.elements.get(id);
      if (element) shiftElement(element as IElement & Record<string, unknown>, move.delta);
    }
  }
  return copy;
}
