/// <reference types="three" />
/// <reference types="blockbench-types" />
import type * as ThreeNamespace from "three";

export const Three = globalThis.THREE as typeof ThreeNamespace;

export type NamedMatch = Group | OutlinerElement;
export type Vec3Tuple = [number, number, number];

export function assertJavaBlockProject(): void {
  if (!Project) {
    throw new Error("No project is open in Blockbench.");
  }

  if (Project.format?.id !== "java_block") {
    throw new Error(
      `This tool only works with java_block projects. Current project format is "${Project.format?.id ?? "unknown"}".`
    );
  }
}

export function normalizeName(name: string | undefined | null): string {
  return (name ?? "").trim().toLowerCase();
}

export function roundNumber(value: number, decimals: number = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function roundVec3(
  vector: ThreeNamespace.Vector3 | Vec3Tuple
): Vec3Tuple {
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

export function describeMatch(match: NamedMatch): string {
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

export function findUniqueNamedMatchOrThrow(partName: string): NamedMatch {
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

export function expandModelBoundsFromSceneObject(
  bounds: ThreeNamespace.Box3,
  sceneObject: ThreeNamespace.Object3D | undefined,
  projectModel: ThreeNamespace.Object3D
): boolean {
  if (!sceneObject) {
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

export function getModelSpaceBoundsForMatch(match: NamedMatch): ThreeNamespace.Box3 {
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

export function getProjectModelSpaceBounds(): ThreeNamespace.Box3 {
  const project = Project;
  if (!project?.model_3d) {
    throw new Error("No project 3D model is available.");
  }

  const bounds = new Three.Box3();
  let hasGeometry = false;

  project.model_3d.updateMatrixWorld(true);

  for (const element of Outliner.elements ?? []) {
    if (element.export === false) {
      continue;
    }

    if (
      expandModelBoundsFromSceneObject(bounds, element.scene_object, project.model_3d)
    ) {
      hasGeometry = true;
    }
  }

  if (!hasGeometry) {
    throw new Error("The current project does not contain any exported geometry.");
  }

  return bounds;
}

export function getJavaModelCenterTarget(): ThreeNamespace.Vector3 {
  if (!Project) {
    throw new Error("No project is open in Blockbench.");
  }

  const blockSize = Project.format?.block_size ?? 16;
  const center = Project.format?.centered_grid ? 0 : blockSize / 2;
  return new Three.Vector3(center, 0, center);
}

function shiftArrayByOffset(
  array: number[] | undefined,
  delta: ThreeNamespace.Vector3
) {
  if (!array || array.length < 3) {
    return;
  }

  array[0] = roundNumber(array[0] + delta.x);
  array[1] = roundNumber(array[1] + delta.y);
  array[2] = roundNumber(array[2] + delta.z);
}

export function shiftNodeByOffset(
  node: OutlinerNode,
  delta: ThreeNamespace.Vector3
) {
  if (node instanceof Group) {
    shiftArrayByOffset(node.origin, delta);
    node.children.forEach((child) => shiftNodeByOffset(child, delta));
    return;
  }

  if (!(node instanceof OutlinerElement)) {
    return;
  }

  const element = node as OutlinerElement & {
    from?: number[];
    to?: number[];
    origin?: number[];
    position?: number[];
  };

  if (element.from || element.to) {
    shiftArrayByOffset(element.from, delta);
    shiftArrayByOffset(element.to, delta);
    if (element.origin && element.origin !== element.from) {
      shiftArrayByOffset(element.origin, delta);
    }
    return;
  }

  if (element.position) {
    shiftArrayByOffset(element.position, delta);
    return;
  }

  if (element.origin) {
    shiftArrayByOffset(element.origin, delta);
  }
}
