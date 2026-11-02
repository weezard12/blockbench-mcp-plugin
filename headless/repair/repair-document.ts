/**
 * Repairs the anatomy of a creature `.bbmodel`: plans with the core, applies the moves to a copy,
 * and keeps the copy only if the geometry gates find no more problems than before.
 *
 * @module
 */

import { roundBox } from "@/lib/anatomy/boxes";
import { planAnatomy, type IPlanRequest } from "@/lib/anatomy/plan";
import type { IGateCounts, IRepairReport } from "@/lib/anatomy/report";
import type { IAppliedFix, IBox, IUnfixedPart } from "@/lib/anatomy/types";
import type { IBBModel } from "../document/schema";
import { descendantsOf } from "../document/tree";
import { type GeometryGateId, runGeometryGates } from "../gates/geometry";
import { applyMoves, modelBounds, readParts } from "./model-adapter";

export type { IGateCounts, IRepairReport };

/** The gates a repair is judged by: its fixes must not add findings to any of them. */
export const REPAIR_GATES: readonly GeometryGateId[] = ["floating", "interpenetration", "mirror"];

function countGates(doc: IBBModel, freeElements: readonly string[]): IGateCounts {
  const results = runGeometryGates(doc, { freeElements }, REPAIR_GATES);
  const byGate = Object.fromEntries(results.map((result) => [result.id, result.violations.length]));
  return { total: Object.values(byGate).reduce((sum, count) => sum + count, 0), byGate };
}

/**
 * Plans and applies a repair.
 *
 * @returns The document to keep (the input when nothing was committed) and the report.
 */
export function repairDocument(doc: IBBModel, request: Partial<IPlanRequest>, dryRun: boolean): { doc: IBBModel; report: IRepairReport } {
  const { parts, looseBoxes, index } = readParts(doc);
  const plan = planAnatomy(parts, { ...request, looseBoxes });
  const strategies = request.strategies ?? ["connect", "ground"];

  // Parts the caller keeps may float on purpose: the floating gate is told so.
  const kept = new Set((request.hints ?? []).filter((hint) => hint.keep).map((hint) => hint.name));
  const keptElements = [...index.groups.values()]
    .filter((group) => kept.has(group.name))
    .flatMap((group) => descendantsOf(index, group.uuid))
    .flatMap((id) => index.elements.get(id)?.name ?? []);

  const before = countGates(doc, keptElements);
  const repaired = plan.moves.length > 0 ? applyMoves(doc, plan.moves) : doc;
  const after = plan.moves.length > 0 ? countGates(repaired, keptElements) : before;
  const worse = after.total > before.total;
  const committed = plan.moves.length > 0 && !worse && !dryRun;
  const bounds = modelBounds(worse ? doc : repaired);

  const report: IRepairReport = {
    changed: plan.moves.length > 0 && !worse,
    dry_run: dryRun,
    committed,
    strategies,
    applied: worse ? [] : plan.applied,
    skipped: plan.skipped,
    unfixed: worse
      ? [...plan.unfixed, ...plan.applied.map((fix): IUnfixedPart => ({ part: fix.part, finding: fix.reason, numbers: { suggestedDelta: fix.delta, partBox: fix.before } }))]
      : plan.unfixed,
    checks: { before, after: worse ? before : after },
    bounds: bounds ? roundBox(bounds) : null,
    ...(worse ? { rolled_back: `The moves raised the gate findings from ${before.total} to ${after.total} (${JSON.stringify(after.byGate)}), so none was kept.` } : {}),
  };
  return { doc: committed ? repaired : doc, report };
}
