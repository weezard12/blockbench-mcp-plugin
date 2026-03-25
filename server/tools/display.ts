/// <reference types="three" />
/// <reference types="blockbench-types" />
import type * as ThreeNamespace from "three";
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";
import {
  Three,
  assertJavaBlockProject,
  describeMatch,
  findUniqueNamedMatchOrThrow,
  getModelSpaceBoundsForMatch,
  roundNumber,
  roundVec3,
  type NamedMatch,
  type Vec3Tuple,
} from "./alignment-shared";

const HAND_SLOTS = [
  "thirdperson_righthand",
  "thirdperson_lefthand",
  "firstperson_righthand",
  "firstperson_lefthand",
] as const;
const HANDLE_GRIP_VERTICAL_BIAS_RATIO = 0.25;

type HandSlot = (typeof HAND_SLOTS)[number];

interface SlotCorrectionResult {
  beforeTranslation: Vec3Tuple;
  afterTranslation: Vec3Tuple;
  delta: Vec3Tuple;
  createdFromPreset: boolean;
}

const HANDHELD_PRESET_DEFAULTS: Record<HandSlot, DisplaySlotOptions> = {
  thirdperson_righthand: {
    rotation: [0, -90, 55],
    translation: [0, 4, 0.5],
    scale: [0.85, 0.85, 0.85],
  },
  thirdperson_lefthand: {
    rotation: [0, 90, -55],
    translation: [0, 4, 0.5],
    scale: [0.85, 0.85, 0.85],
  },
  firstperson_righthand: {
    rotation: [0, -90, 25],
    translation: [1.13, 3.2, 1.13],
    scale: [0.68, 0.68, 0.68],
  },
  firstperson_lefthand: {
    rotation: [0, 90, -25],
    translation: [1.13, 3.2, 1.13],
    scale: [0.68, 0.68, 0.68],
  },
};

export const autoCorrectDisplaySettingsParameters = z.object({
  strategy: z
    .string()
    .optional()
    .default("handle")
    .describe("Auto-correction strategy. Currently only 'handle' is supported."),
  part_name: z
    .string()
    .optional()
    .default("handle")
    .describe("Exact part name to match, case-insensitively. Defaults to 'handle'."),
});

export const displayToolDocs: ToolSpec[] = [
  {
    name: "auto_correct_display_settings",
    description:
      "Automatically corrects java_block hand display settings by centering a named part, such as 'handle', at the player hand anchor. Run auto_correct_center first if the model geometry itself is offset.",
    annotations: {
      title: "Auto Correct Display Settings",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: autoCorrectDisplaySettingsParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

function isLeftHandSlot(slot: HandSlot): boolean {
  return slot.includes("lefthand");
}

function getHandleAlignmentPoint(
  bounds: ThreeNamespace.Box3
): ThreeNamespace.Vector3 {
  const center = bounds.getCenter(new Three.Vector3());
  const size = bounds.getSize(new Three.Vector3());
  center.y += size.y * HANDLE_GRIP_VERTICAL_BIAS_RATIO;
  return center;
}

function getDisplayModeModelOffset(): ThreeNamespace.Vector3 {
  if (!Project) {
    throw new Error("No project is open in Blockbench.");
  }

  if (typeof Modes !== "undefined" && Modes.display) {
    return Project.model_3d.position.clone();
  }

  const xzOffset = Project.format?.centered_grid ? 0 : -8;
  return new Three.Vector3(xzOffset, -8, xzOffset);
}

function getOrCreateHandSlot(slotName: HandSlot): {
  slot: DisplaySlot;
  createdFromPreset: boolean;
} {
  if (!Project) {
    throw new Error("No project is open in Blockbench.");
  }

  let slot = Project.display_settings[slotName] as DisplaySlot | undefined;
  let createdFromPreset = false;

  if (!slot) {
    slot = new DisplaySlot(slotName, {});
    slot.extend(HANDHELD_PRESET_DEFAULTS[slotName]);
    Project.display_settings[slotName] = slot;
    createdFromPreset = true;
  }

  return { slot, createdFromPreset };
}

function computeDisplayPointForSlot(
  point: ThreeNamespace.Vector3,
  slot: DisplaySlot,
  slotName: HandSlot
): ThreeNamespace.Vector3 {
  const displayModeOffset = getDisplayModeModelOffset();
  const handSign = isLeftHandSlot(slotName) ? -1 : 1;
  const rotation = new Three.Euler(
    Three.MathUtils.degToRad(slot.rotation[0]),
    Three.MathUtils.degToRad(slot.rotation[1] * handSign),
    Three.MathUtils.degToRad(slot.rotation[2] * handSign)
  );
  const position = new Three.Vector3(
    slot.translation[0] * handSign,
    slot.translation[1],
    slot.translation[2]
  );
  const effectiveScale = new Three.Vector3(
    (slot.scale[0] || 0.001) * (slot.mirror[0] ? -1 : 1),
    (slot.scale[1] || 0.001) * (slot.mirror[1] ? -1 : 1),
    (slot.scale[2] || 0.001) * (slot.mirror[2] ? -1 : 1)
  );

  if (!slot.rotation_pivot.allEqual(0)) {
    const pivotOffset = new Three.Vector3()
      .fromArray(slot.rotation_pivot)
      .multiplyScalar(16);
    const original = pivotOffset.clone();
    pivotOffset.applyEuler(rotation);
    pivotOffset.sub(original);
    position.sub(pivotOffset);
  }

  if (!slot.scale_pivot.allEqual(0)) {
    const pivotOffset = new Three.Vector3()
      .fromArray(slot.scale_pivot)
      .multiplyScalar(16);
    pivotOffset.applyEuler(rotation);
    pivotOffset.x *= 1 - slot.scale[0];
    pivotOffset.y *= 1 - slot.scale[1];
    pivotOffset.z *= 1 - slot.scale[2];
    position.add(pivotOffset);
  }

  return point
    .clone()
    .add(displayModeOffset)
    .multiply(effectiveScale)
    .applyEuler(rotation)
    .add(position);
}

function buildSummaryText(
  partName: string,
  match: NamedMatch,
  modelLocalCenter: Vec3Tuple,
  alignmentPoint: Vec3Tuple,
  createdSlots: HandSlot[],
  results: Record<HandSlot, SlotCorrectionResult>
): string {
  const lines = [
    `Auto-corrected display settings using strategy "handle" for "${partName}".`,
    `Matched ${describeMatch(match)}.`,
    `Model-space bounds center: [${modelLocalCenter.join(", ")}].`,
    `Handle alignment point: [${alignmentPoint.join(", ")}].`,
    createdSlots.length
      ? `Initialized handheld defaults for: ${createdSlots.join(", ")}.`
      : "No display slots needed initialization.",
    "Updated hand slots:",
  ];

  for (const slotName of HAND_SLOTS) {
    const result = results[slotName];
    lines.push(
      `- ${slotName}: [${result.beforeTranslation.join(", ")}] -> ` +
        `[${result.afterTranslation.join(", ")}], ` +
        `delta [${result.delta.join(", ")}]`
    );
  }

  return lines.join("\n");
}

export function registerDisplayTools() {
  createTool(
    displayToolDocs[0].name,
    {
      ...displayToolDocs[0],
      async execute({ strategy, part_name }) {
        assertJavaBlockProject();

        if (strategy !== "handle") {
          throw new Error(
            `Unsupported auto-correction strategy "${strategy}". Currently only "handle" is supported.`
          );
        }

        const match = findUniqueNamedMatchOrThrow(part_name);
        const modelBounds = getModelSpaceBoundsForMatch(match);
        const modelLocalCenter = modelBounds.getCenter(new Three.Vector3());
        const alignmentPoint = getHandleAlignmentPoint(modelBounds);
        const roundedCenter = roundVec3(modelLocalCenter);
        const roundedAlignmentPoint = roundVec3(alignmentPoint);
        const createdSlots: HandSlot[] = [];
        const slotResults = {} as Record<HandSlot, SlotCorrectionResult>;

        Undo.initEdit({ display_slots: [...HAND_SLOTS] });

        try {
          for (const slotName of HAND_SLOTS) {
            const { slot, createdFromPreset } = getOrCreateHandSlot(slotName);
            if (createdFromPreset) {
              createdSlots.push(slotName);
            }

            const beforeTranslation = roundVec3([
              slot.translation[0],
              slot.translation[1],
              slot.translation[2],
            ]);
            const transformedCenter = computeDisplayPointForSlot(
              alignmentPoint,
              slot,
              slotName
            );
            const handSign = isLeftHandSlot(slotName) ? -1 : 1;
            const delta: Vec3Tuple = roundVec3([
              -handSign * transformedCenter.x,
              -transformedCenter.y,
              -transformedCenter.z,
            ]);

            slot.translation[0] = roundNumber(slot.translation[0] + delta[0]);
            slot.translation[1] = roundNumber(slot.translation[1] + delta[1]);
            slot.translation[2] = roundNumber(slot.translation[2] + delta[2]);
            slot.update();

            slotResults[slotName] = {
              beforeTranslation,
              afterTranslation: roundVec3([
                slot.translation[0],
                slot.translation[1],
                slot.translation[2],
              ]),
              delta,
              createdFromPreset,
            };
          }
        } catch (error) {
          Undo.cancelEdit();
          throw error;
        }

        Undo.finishEdit("Auto-correct display settings");
        Canvas.updateAll();

        const summaryText = buildSummaryText(
          part_name,
          match,
          roundedCenter,
          roundedAlignmentPoint,
          createdSlots,
          slotResults
        );

        return {
          content: [{ type: "text", text: summaryText }],
          structuredContent: {
            strategy,
            partName: part_name,
            matchedPart: {
              name: match.name,
              uuid: match.uuid,
              type: match instanceof Group ? "group" : match.type || "element",
            },
            createdSlotsFromPreset: createdSlots,
            modelLocalCenter: roundedCenter,
            alignmentPoint: roundedAlignmentPoint,
            slots: slotResults,
          },
        };
      },
    },
    displayToolDocs[0].status
  );
}
