/// <reference types="three" />
/// <reference types="blockbench-types" />
import type * as ThreeNamespace from "three";
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";

const Three = globalThis.THREE as typeof ThreeNamespace;

const HAND_SLOTS = [
  "thirdperson_righthand",
  "thirdperson_lefthand",
  "firstperson_righthand",
  "firstperson_lefthand",
] as const;
const HANDLE_GRIP_VERTICAL_BIAS_RATIO = 0.25;

type HandSlot = (typeof HAND_SLOTS)[number];
type NamedMatch = Group | OutlinerElement;
type Vec3Tuple = [number, number, number];

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
      "Automatically corrects java_block hand display settings by centering a named part, such as 'handle', at the player hand anchor.",
    annotations: {
      title: "Auto Correct Display Settings",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: autoCorrectDisplaySettingsParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

function normalizeName(name: string | undefined | null): string {
  return (name ?? "").trim().toLowerCase();
}

function roundNumber(value: number, decimals: number = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundVec3(vector: ThreeNamespace.Vector3 | Vec3Tuple): Vec3Tuple {
  if (!Array.isArray(vector)) {
    return [
      roundNumber(vector.x),
      roundNumber(vector.y),
      roundNumber(vector.z),
    ];
  }

  return [
    roundNumber(vector[0]),
    roundNumber(vector[1]),
    roundNumber(vector[2]),
  ];
}

function isLeftHandSlot(slot: HandSlot): boolean {
  return slot.includes("lefthand");
}

function describeMatch(match: NamedMatch): string {
  const kind = match instanceof Group ? "group" : match.type || "element";
  return `${kind} "${match.name}" (${match.uuid})`;
}

function listExactNameMatches(partName: string): NamedMatch[] {
  const normalized = normalizeName(partName);
  const groups = (Group.all ?? []).filter(
    (group) => normalizeName(group.name) === normalized
  );
  const elements = (Outliner.elements ?? []).filter(
    (element) => normalizeName(element.name) === normalized
  );
  return [...groups, ...elements];
}

function findUniqueNamedMatchOrThrow(partName: string): NamedMatch {
  const matches = listExactNameMatches(partName);

  if (matches.length === 0) {
    throw new Error(
      `No group or element named "${partName}" was found. Create exactly one matching part, then try again.`
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `Found multiple exact matches for "${partName}": ${matches
        .map(describeMatch)
        .join(", ")}. Rename the extras so only one remains.`
    );
  }

  return matches[0];
}

function expandModelBoundsFromSceneObject(
  bounds: ThreeNamespace.Box3,
  sceneObject: ThreeNamespace.Object3D | undefined,
  projectModel: ThreeNamespace.Object3D
): boolean {
  if (!sceneObject || sceneObject.visible === false) {
    return false;
  }

  sceneObject.updateWorldMatrix(true, true);

  const geometry = (
    sceneObject as ThreeNamespace.Object3D & {
      geometry?: ThreeNamespace.BufferGeometry;
    }
  ).geometry;
  if (!geometry) {
    return false;
  }

  if (!geometry.boundingBox) {
    geometry.computeBoundingBox();
  }

  const geometryBounds = geometry.boundingBox;
  if (!geometryBounds || geometryBounds.isEmpty()) {
    return false;
  }

  const corners = [
    new Three.Vector3(
      geometryBounds.min.x,
      geometryBounds.min.y,
      geometryBounds.min.z
    ),
    new Three.Vector3(
      geometryBounds.min.x,
      geometryBounds.min.y,
      geometryBounds.max.z
    ),
    new Three.Vector3(
      geometryBounds.min.x,
      geometryBounds.max.y,
      geometryBounds.min.z
    ),
    new Three.Vector3(
      geometryBounds.min.x,
      geometryBounds.max.y,
      geometryBounds.max.z
    ),
    new Three.Vector3(
      geometryBounds.max.x,
      geometryBounds.min.y,
      geometryBounds.min.z
    ),
    new Three.Vector3(
      geometryBounds.max.x,
      geometryBounds.min.y,
      geometryBounds.max.z
    ),
    new Three.Vector3(
      geometryBounds.max.x,
      geometryBounds.max.y,
      geometryBounds.min.z
    ),
    new Three.Vector3(
      geometryBounds.max.x,
      geometryBounds.max.y,
      geometryBounds.max.z
    ),
  ];

  for (const corner of corners) {
    corner.applyMatrix4(sceneObject.matrixWorld);
    bounds.expandByPoint(projectModel.worldToLocal(corner));
  }

  return true;
}

function collectModelSpaceBoundsForGroup(
  group: Group,
  projectModel: ThreeNamespace.Object3D
): ThreeNamespace.Box3 {
  const bounds = new Three.Box3();
  let hasGeometry = false;

  const visit = (node: OutlinerNode) => {
    if (node instanceof Group) {
      node.children.forEach(visit);
      return;
    }

    if (!(node instanceof OutlinerElement)) {
      return;
    }

    if (expandModelBoundsFromSceneObject(bounds, node.scene_object, projectModel)) {
      hasGeometry = true;
    }
  };

  visit(group);

  if (!hasGeometry) {
    throw new Error(
      `Group "${group.name}" does not contain any usable rendered geometry.`
    );
  }

  return bounds;
}

function getModelSpaceBoundsForMatch(match: NamedMatch): ThreeNamespace.Box3 {
  const project = Project;
  if (!project?.model_3d) {
    throw new Error("No project 3D model is available.");
  }

  project.model_3d.updateMatrixWorld(true);

  if (match instanceof Group) {
    return collectModelSpaceBoundsForGroup(match, project.model_3d);
  }

  const bounds = new Three.Box3();
  if (!expandModelBoundsFromSceneObject(bounds, match.scene_object, project.model_3d)) {
    throw new Error(
      `${describeMatch(match)} does not contain any usable rendered geometry.`
    );
  }

  return bounds;
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
  const project = Project;
  if (!project) {
    throw new Error("No project is open in Blockbench.");
  }

  // Blockbench display mode re-parents the model under display_base and shifts it
  // before applying display slot transforms. Mirror that offset here so the
  // translation correction matches what the display preview actually renders.
  if (typeof Modes !== "undefined" && Modes.display) {
    return project.model_3d.position.clone();
  }

  const xzOffset = project.format?.centered_grid ? 0 : -8;
  return new Three.Vector3(xzOffset, -8, xzOffset);
}

function getOrCreateHandSlot(slotName: HandSlot): {
  slot: DisplaySlot;
  createdFromPreset: boolean;
} {
  const project = Project;
  if (!project) {
    throw new Error("No project is open in Blockbench.");
  }

  let slot = project.display_settings[slotName] as DisplaySlot | undefined;
  let createdFromPreset = false;

  if (!slot) {
    slot = new DisplaySlot(slotName, {});
    slot.extend(HANDHELD_PRESET_DEFAULTS[slotName]);
    project.display_settings[slotName] = slot;
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
        if (!Project) {
          throw new Error("No project is open in Blockbench.");
        }

        if (Project.format?.id !== "java_block") {
          throw new Error(
            `This tool only works with java_block projects. Current project format is "${Project.format?.id ?? "unknown"}".`
          );
        }

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
