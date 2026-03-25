/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";
import {
  Three,
  assertJavaBlockProject,
  getJavaModelCenterTarget,
  getProjectModelSpaceBounds,
  roundVec3,
  shiftNodeByOffset,
  type Vec3Tuple,
} from "./alignment-shared";

interface CenterCorrectionResult {
  beforeCenter: Vec3Tuple;
  afterCenter: Vec3Tuple;
  delta: Vec3Tuple;
  targetCenter: Vec3Tuple;
}

export const autoCorrectCenterParameters = z.object({});

export const centerToolDocs: ToolSpec[] = [
  {
    name: "auto_correct_center",
    description:
      "Automatically recenters java_block model geometry on the format center by shifting the actual model coordinates on X/Z.",
    annotations: {
      title: "Auto Correct Center",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: autoCorrectCenterParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

function buildCenterSummary(result: CenterCorrectionResult, changed: boolean): string {
  if (!changed) {
    return [
      "The model is already centered for java_block export.",
      `Center: [${result.beforeCenter.join(", ")}].`,
      `Target center: [${result.targetCenter.join(", ")}].`,
      'Run "auto_correct_display_settings" after any future geometry changes.',
    ].join("\n");
  }

  return [
    "Auto-corrected java_block model center.",
    `Center: [${result.beforeCenter.join(", ")}] -> [${result.afterCenter.join(", ")}].`,
    `Applied offset: [${result.delta.join(", ")}].`,
    `Target center: [${result.targetCenter.join(", ")}].`,
    'Run "auto_correct_display_settings" after this so the hand slots track the moved geometry.',
  ].join("\n");
}

export function registerCenterTools() {
  createTool(
    centerToolDocs[0].name,
    {
      ...centerToolDocs[0],
      async execute() {
        assertJavaBlockProject();

        const beforeBounds = getProjectModelSpaceBounds();
        const beforeCenter = beforeBounds.getCenter(new Three.Vector3());
        const targetCenter = getJavaModelCenterTarget();
        targetCenter.y = beforeCenter.y;

        const delta = new Three.Vector3(
          targetCenter.x - beforeCenter.x,
          0,
          targetCenter.z - beforeCenter.z
        );

        const result: CenterCorrectionResult = {
          beforeCenter: roundVec3(beforeCenter),
          afterCenter: roundVec3(beforeCenter.clone().add(delta)),
          delta: roundVec3(delta),
          targetCenter: roundVec3(targetCenter),
        };

        const changed = Math.abs(delta.x) >= 1e-6 || Math.abs(delta.z) >= 1e-6;
        if (!changed) {
          const summary = buildCenterSummary(result, false);
          return {
            content: [{ type: "text", text: summary }],
            structuredContent: result,
          };
        }

        Undo.initEdit({
          elements: [...Outliner.elements],
          outliner: true,
          collections: [],
        });

        try {
          for (const node of Outliner.root) {
            shiftNodeByOffset(node, delta);
          }
        } catch (error) {
          Undo.cancelEdit();
          throw error;
        }

        Undo.finishEdit("Auto-correct model center");
        Canvas.updateAllPositions();
        Canvas.updateAll();
        if (typeof updateSelection === "function") {
          updateSelection();
        }

        const summary = buildCenterSummary(result, true);
        return {
          content: [{ type: "text", text: summary }],
          structuredContent: result,
        };
      },
    },
    centerToolDocs[0].status
  );
}
