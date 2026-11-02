/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type IToolSpec } from "@/lib/factories";
import { STATUS_EXPERIMENTAL } from "@/lib/constants";
import { roundBox, unionBox } from "@/lib/anatomy/boxes";
import { planAnatomy, WHOLE_MODEL, type IPlanRequest } from "@/lib/anatomy/plan";
import { ANATOMY_REPAIR_DESCRIPTION, anatomyRepairShape, toPlanRequest } from "@/lib/anatomy/request";
import type { IRepairReport } from "@/lib/anatomy/report";
import type { IAnatomyPart, IAnatomyPlan, IBox } from "@/lib/anatomy/types";
import { Three, expandModelBoundsFromSceneObject, shiftNodeByOffset } from "./alignment-shared";

export const autoCorrectAnatomyParameters = z.object(anatomyRepairShape);

export const autoCorrectAnatomyToolDocs: IToolSpec[] = [
  {
    name: "auto_correct_anatomy",
    description: `${ANATOMY_REPAIR_DESCRIPTION} The whole repair is one undo step.`,
    annotations: {
      title: "Auto Correct Anatomy",
      destructiveHint: true,
      openWorldHint: true,
    },
    parameters: autoCorrectAnatomyParameters,
    status: STATUS_EXPERIMENTAL,
  },
];

const isTilted = (rotation: readonly number[] | undefined): boolean => (rotation ?? []).some((value) => Math.abs(value) > 1e-6);

/** World box of one element as Blockbench draws it, or null when it draws nothing. */
function elementBox(element: OutlinerElement, model: THREE.Object3D): IBox | null {
  if (element.export === false) return null;
  const bounds = new Three.Box3();
  if (!expandModelBoundsFromSceneObject(bounds, element.scene_object, model)) return null;
  return { min: [bounds.min.x, bounds.min.y, bounds.min.z], max: [bounds.max.x, bounds.max.y, bounds.max.z] };
}

interface ILiveModel {
  parts: IAnatomyPart[];
  looseBoxes: IBox[];
  groups: Map<string, Group>;
}

/** Reads the open project as parts: one per group, with the box of every element directly in it. */
function readLiveModel(): ILiveModel {
  const model = Project?.model_3d;
  if (!model) throw new Error("No project 3D model is available.");
  model.updateMatrixWorld(true);

  const groups = new Map<string, Group>((Group.all ?? []).map((group) => [group.uuid, group]));
  const boxesOf = (nodes: readonly OutlinerNode[]): IBox[] =>
    nodes.flatMap((node) => (node instanceof OutlinerElement ? (elementBox(node, model) ?? []) : []));

  const parts = [...groups.values()].map((group): IAnatomyPart => {
    let tiltedAncestor = false;
    for (let ancestor = group.parent; ancestor instanceof Group; ancestor = ancestor.parent) {
      if (isTilted(ancestor.rotation)) tiltedAncestor = true;
    }
    return {
      id: group.uuid,
      name: group.name,
      parent: group.parent instanceof Group ? group.parent.uuid : null,
      ownElements: boxesOf(group.children),
      tiltedAncestor,
    };
  });
  return { parts, looseBoxes: boxesOf(Outliner.root), groups };
}

const modelBounds = (live: ILiveModel): IBox | null => unionBox([...live.parts.flatMap((part) => part.ownElements), ...live.looseBoxes]);

/** How many parts the planner still finds wrong: the in-app tool's check. */
const findingCount = (plan: IAnatomyPlan): number => plan.applied.filter((fix) => fix.strategy === "connect").length + plan.unfixed.filter((item) => item.part !== WHOLE_MODEL).length;

function shiftAll(live: ILiveModel, plan: IAnatomyPlan): void {
  for (const move of plan.moves) {
    const delta = new Three.Vector3(move.delta[0], move.delta[1], move.delta[2]);
    if (move.part === WHOLE_MODEL) {
      for (const node of Outliner.root) shiftNodeByOffset(node, delta);
      continue;
    }
    const group = live.groups.get(move.part);
    if (group) shiftNodeByOffset(group, delta);
  }
}

function buildSummary(report: IRepairReport): string {
  const lines = [
    report.dry_run ? "Anatomy repair plan (dry run, nothing changed)." : report.committed ? "Auto-corrected anatomy." : report.rolled_back ? "Anatomy repair undone." : "Anatomy needs no repair.",
    ...report.applied.map((fix) => `- ${fix.reason} delta [${fix.delta.join(", ")}]`),
    ...report.unfixed.map((item) => `! ${item.part}: ${item.finding}`),
    ...report.skipped.map((item) => `? ${item.part}: ${item.reason}`),
  ];
  if (report.rolled_back) lines.push(report.rolled_back);
  lines.push(`Findings: ${report.checks.before.total} -> ${report.checks.after.total}.`);
  return lines.join("\n");
}

export function registerAutoCorrectAnatomyTools() {
  createTool(
    autoCorrectAnatomyToolDocs[0].name,
    {
      ...autoCorrectAnatomyToolDocs[0],
      async execute(args) {
        if (!Project) throw new Error("No project is open in Blockbench.");
        const request: Partial<IPlanRequest> = toPlanRequest(args);
        const before = readLiveModel();
        const plan = planAnatomy(before.parts, { ...request, looseBoxes: before.looseBoxes });
        const findingsBefore = findingCount(plan);
        const strategies = request.strategies ?? ["connect", "ground"];

        const report: IRepairReport = {
          changed: plan.moves.length > 0,
          dry_run: args.dry_run,
          committed: false,
          strategies,
          applied: plan.applied,
          skipped: plan.skipped,
          unfixed: plan.unfixed,
          checks: { before: { total: findingsBefore, byGate: { anatomy: findingsBefore } }, after: { total: findingsBefore, byGate: { anatomy: findingsBefore } } },
          bounds: (() => {
            const box = modelBounds(before);
            return box ? roundBox(box) : null;
          })(),
        };

        if (args.dry_run || plan.moves.length === 0) {
          return { content: [{ type: "text", text: buildSummary(report) }], structuredContent: { ...report } };
        }

        Undo.initEdit({ elements: [...Outliner.elements], outliner: true, collections: [] });
        try {
          shiftAll(before, plan);
        } catch (error) {
          Undo.cancelEdit();
          throw error;
        }

        // The planner judges its own result: a second plan over the moved model must find nothing left to move.
        const after = readLiveModel();
        const second = planAnatomy(after.parts, { ...request, looseBoxes: after.looseBoxes });
        const findingsAfter = findingCount(second);
        if (second.moves.length > 0 && findingsAfter > findingsBefore) {
          Undo.cancelEdit();
          const undone: IRepairReport = {
            ...report,
            changed: false,
            applied: [],
            unfixed: [...plan.unfixed, ...plan.applied.map((fix) => ({ part: fix.part, finding: fix.reason, numbers: { suggestedDelta: fix.delta, partBox: fix.before } }))],
            rolled_back: `The moves left ${findingsAfter} findings where there were ${findingsBefore}, so none was kept.`,
          };
          return { content: [{ type: "text", text: buildSummary(undone) }], structuredContent: { ...undone } };
        }

        Undo.finishEdit("Auto-correct anatomy");
        Canvas.updateAllPositions();
        Canvas.updateAll();
        if (typeof updateSelection === "function") updateSelection();

        const afterBounds = modelBounds(after);
        const done: IRepairReport = {
          ...report,
          committed: true,
          checks: { before: report.checks.before, after: { total: findingsAfter, byGate: { anatomy: findingsAfter } } },
          bounds: afterBounds ? roundBox(afterBounds) : null,
        };
        return { content: [{ type: "text", text: buildSummary(done) }], structuredContent: { ...done } };
      },
    },
    autoCorrectAnatomyToolDocs[0].status
  );
}
