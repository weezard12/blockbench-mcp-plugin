/**
 * Name to anatomy: which role a part plays, from the words in its name.
 *
 * Names are split into lowercase words at underscores, hyphens, dots, spaces, digits and camelCase
 * boundaries, so `front_leg_right`, `legL` and `Hind Leg 2` all work. A name that matches no role,
 * or matches two different roles (`tail_fin`), has no role: the repair then leaves the part alone
 * and reports it, because a wrong guess moves geometry. A caller that knows better passes a hint.
 *
 * @module
 */

import type { AnatomyRole, IFace } from "./types";

/** What a role implies for placement. */
export interface IRoleSpec {
  role: AnatomyRole;
  /** Words that name the role. */
  words: readonly string[];
  /** The host faces the part may attach to, most natural first. Empty for the root. */
  faces: readonly IFace[];
  /** Overrides how deep the part may sink into its host before it counts as buried. */
  buriedShare?: number;
  /** Roles a host may have, nearest ancestor first; the first one found is the fallback host. */
  fallbackHost?: readonly AnatomyRole[];
}

const UP: IFace = { axis: 1, sign: 1 };
const DOWN: IFace = { axis: 1, sign: -1 };
const FRONT: IFace = { axis: 2, sign: -1 };
const REAR: IFace = { axis: 2, sign: 1 };
const LEFT: IFace = { axis: 0, sign: -1 };
const RIGHT: IFace = { axis: 0, sign: 1 };

/** The role table. Order does not matter: a name's words must all agree on one role. */
export const ROLE_SPECS: readonly IRoleSpec[] = [
  { role: "torso", words: ["body", "torso", "trunk", "chest", "abdomen", "pelvis", "belly"], faces: [] },
  { role: "head", words: ["head", "skull"], faces: [UP, FRONT], fallbackHost: ["torso"] },
  { role: "neck", words: ["neck"], faces: [UP, FRONT], fallbackHost: ["torso"] },
  { role: "leg", words: ["leg", "thigh", "shin", "foot", "paw", "hoof"], faces: [DOWN], fallbackHost: ["torso"] },
  { role: "limb", words: ["arm", "hand", "wing", "flipper", "fin"], faces: [RIGHT, LEFT], fallbackHost: ["torso"] },
  { role: "tail", words: ["tail"], faces: [REAR], fallbackHost: ["torso"] },
  { role: "top_attachment", words: ["ear", "horn", "antler", "crest", "spike", "mane", "comb"], faces: [UP, RIGHT, LEFT], fallbackHost: ["head", "torso"] },
  { role: "face_attachment", words: ["beak", "bill", "snout", "muzzle", "jaw", "nose", "mouth", "eye", "tongue"], faces: [FRONT], fallbackHost: ["head", "torso"] },
];

/** Words that carry a side. */
const SIDE_WORDS: Readonly<Record<string, "left" | "right">> = { l: "left", left: "left", r: "right", right: "right" };

/** Splits a name into lowercase words. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 0);
}

const WORD_ROLES: ReadonlyMap<string, IRoleSpec> = new Map(ROLE_SPECS.flatMap((spec) => spec.words.map((word) => [word, spec] as const)));

/** Singular form for matching: `legs` to `leg`, `wings` to `wing`; words of three letters or fewer stay. */
const singular = (word: string): string => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);

/** The outcome of reading a name. */
export type RoleReading =
  | { kind: "role"; spec: IRoleSpec }
  | { kind: "none" }
  | { kind: "ambiguous"; roles: AnatomyRole[] };

/** Reads the role a name suggests. */
export function readRole(name: string): RoleReading {
  const specs = new Map<AnatomyRole, IRoleSpec>();
  for (const word of nameWords(name)) {
    const spec = WORD_ROLES.get(word) ?? WORD_ROLES.get(singular(word));
    if (spec) specs.set(spec.role, spec);
  }
  const found = [...specs.values()];
  const [only] = found;
  if (found.length === 1 && only) return { kind: "role", spec: only };
  if (found.length === 0) return { kind: "none" };
  return { kind: "ambiguous", roles: found.map((spec) => spec.role) };
}

/** The spec of a role. */
export function specOf(role: AnatomyRole): IRoleSpec {
  const spec = ROLE_SPECS.find((candidate) => candidate.role === role);
  if (!spec) throw new Error(`Unknown anatomy role "${role}".`);
  return spec;
}

/** Which side a name is on, or undefined for a centre part. */
export function sideOfName(name: string): "left" | "right" | undefined {
  for (const word of nameWords(name)) {
    const side = SIDE_WORDS[word];
    if (side) return side;
  }
  return undefined;
}
