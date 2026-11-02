/**
 * The arguments of the anatomy repair tools and how they become a plan request.
 *
 * The headless tool (`bbmodel_auto_correct_anatomy`) and the in-app tool (`auto_correct_anatomy`)
 * take the same arguments, so the shape lives here once. Only the file arguments of the headless
 * tool are its own.
 *
 * @module
 */

import { z } from "zod";
import type { IPlanRequest } from "./plan";
import { DEFAULT_CONNECT_OPTIONS } from "./types";

/** Roles a caller can give a part. `none` takes it out of every repair. */
export const ANATOMY_ROLE_NAMES = ["torso", "head", "neck", "leg", "limb", "tail", "top_attachment", "face_attachment", "none"] as const;

/** What a caller knows about one part. */
export const partHintSchema = z.object({
  name: z.string().min(1).describe("Group name."),
  role: z.enum(ANATOMY_ROLE_NAMES).optional().describe("Overrides the role the name suggests. none takes the part out of every repair."),
  host: z.string().min(1).optional().describe("Name of the part this one attaches to. Defaults to the nearest ancestor group that holds geometry."),
  keep: z.boolean().optional().describe("Leave the part exactly where it is (a deliberately detached or overlapping part)."),
});

/** Arguments both tools share, as a Zod shape. */
export const anatomyRepairShape = {
  strategies: z.array(z.enum(["connect", "ground"])).min(1).default(["connect", "ground"]),
  dry_run: z.boolean().default(false).describe("Plan and report only; nothing is written."),
  parts: z.array(partHintSchema).default([]),
  ground_y: z.number().default(0).describe("Height the lowest point of the model is moved to by ground."),
  seat: z.number().min(0).default(DEFAULT_CONNECT_OPTIONS.seat).describe("Units a connected part sinks into its host."),
  buried_share: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_CONNECT_OPTIONS.buriedShare)
    .describe("A part with more of its volume than this inside its host counts as buried."),
  max_move_ratio: z
    .number()
    .min(0)
    .default(DEFAULT_CONNECT_OPTIONS.maxMoveRatio)
    .describe("A part moves by at most this many times its own size along an axis (plus the seat)."),
  max_changed_share: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_CONNECT_OPTIONS.maxChangedShare)
    .describe("When more than this share of the parts would move, nothing moves."),
};

/** Parsed arguments of the repair tools. */
export type AnatomyRepairArgs = z.infer<z.ZodObject<typeof anatomyRepairShape>>;

/** What the tools say about themselves. */
export const ANATOMY_REPAIR_DESCRIPTION = [
  "Fixes a creature model whose parts do not meet: slides legs, head, neck, wings, tail and face parts onto the part they belong to, and puts the whole model on the ground.",
  "A part's role comes from its group name (leg, head, wing, tail, beak, ear and so on; left/right words are understood); pass parts to override a role or name its host.",
  "Strategies: connect (floating or buried parts are slid flush against the right face of their host with a small seat; whole subtrees move together) and ground (the lowest point goes to ground_y).",
  "The tool abstains instead of guessing: parts without a clear role, host or geometry, rotated groups above a part, and moves longer than the part itself are reported, not made.",
  "The report lists every move with before and after boxes, and everything it left alone with the numbers needed to fix it by hand.",
  "dry_run reports without writing.",
].join(" ");

/** The plan request the arguments stand for. */
export function toPlanRequest(args: AnatomyRepairArgs): Partial<IPlanRequest> {
  return {
    strategies: args.strategies,
    hints: args.parts,
    groundY: args.ground_y,
    options: { seat: args.seat, buriedShare: args.buried_share, maxMoveRatio: args.max_move_ratio, maxChangedShare: args.max_changed_share },
  };
}
