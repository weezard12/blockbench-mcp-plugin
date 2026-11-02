/**
 * Repair tool: fixes the defects the geometry gates only report, on creature models.
 *
 * `bbmodel_validate` says a leg floats or sits inside the body; this tool slides it where it
 * belongs. It is the headless twin of the plugin's `auto_correct_anatomy` and shares its core
 * (`lib/anatomy`), so both return the same report.
 *
 * @module
 */

import { ANATOMY_REPAIR_DESCRIPTION, anatomyRepairShape, toPlanRequest } from "@/lib/anatomy/request";
import { stampAiUsage } from "../edit/operations";
import { repairDocument } from "../repair/repair-document";
import { defineTool, fileParam, revisionParam } from "../tool";

const repairTool = defineTool({
  name: "bbmodel_auto_correct_anatomy",
  title: "Auto-correct Anatomy",
  description: `${ANATOMY_REPAIR_DESCRIPTION} Moves are kept only if the floating, interpenetration and mirror gates find no more problems afterwards.`,
  parameters: { file: fileParam, expected_revision: revisionParam, ...anatomyRepairShape },
  readOnly: false,
  destructive: true,
  async execute(args, context) {
    const request = toPlanRequest(args);
    if (args.dry_run) {
      const { doc, revision } = await context.store.read(args.file);
      return { revision, ...repairDocument(doc, request, true).report };
    }
    const written = await context.store.update(args.file, args.expected_revision, ({ doc }) => {
      const { doc: repaired, report } = repairDocument(doc, request, false);
      const stamped = report.committed && context.aiDisclosure ? stampAiUsage(repaired, context.clientName()) : repaired;
      return { doc: stamped, result: report };
    });
    return { revision: written.revision, ...written.result };
  },
});

/** Repair tools. */
export const repairTools = [repairTool];
