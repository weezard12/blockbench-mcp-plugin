/**
 * The report both repair tools return.
 *
 * @module
 */

import type { AnatomyStrategy } from "./plan";
import type { IAppliedFix, IBox, ISkippedPart, IUnfixedPart } from "./types";

/** Findings per check, and their total. */
export interface IGateCounts {
  total: number;
  byGate: Record<string, number>;
}

/**
 * What a repair run reports. A type alias, not an interface, so it can be returned as MCP structured content.
 * `checks` counts the geometry gate findings in the headless tool and the parts the planner would still move in the in-app tool.
 */
export type IRepairReport = {
  /** True when the document was changed (or would be, in a dry run). */
  changed: boolean;
  dry_run: boolean;
  /** False when the planned moves were not kept because the checks found more problems afterwards. */
  committed: boolean;
  strategies: readonly AnatomyStrategy[];
  applied: IAppliedFix[];
  skipped: ISkippedPart[];
  unfixed: IUnfixedPart[];
  /** Findings before and after. */
  checks: { before: IGateCounts; after: IGateCounts };
  /** Box around all geometry after the repair. */
  bounds: IBox | null;
  /** Why planned moves were dropped, when they were. */
  rolled_back?: string;
};
