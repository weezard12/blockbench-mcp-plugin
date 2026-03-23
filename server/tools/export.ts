/// <reference types="three" />
/// <reference types="blockbench-types" />
import { z } from "zod";
import { createTool, type ToolSpec } from "@/lib/factories";
import { STATUS_STABLE } from "@/lib/constants";

// ============================================================================
// Export Tool Parameter Schemas
// ============================================================================

export const exportJavaBlockParameters = z.object({
  export_folder: z
    .string()
    .describe(
      "Absolute path to the folder where the files will be written. " +
      "Both '<model_name>.json' and '<model_name>.png' are placed directly in this folder."
    ),
  model_name: z
    .string()
    .describe(
      "Name used for the output files and the texture reference inside the JSON " +
      "(e.g. 'my_block' produces 'my_block.json' and 'my_block.png')."
    ),
});

// ============================================================================
// Export Tool Docs
// ============================================================================

export const exportToolDocs: ToolSpec[] = [
  {
    name: "export_java_block_model",
    description:
      "Exports the active java_block project as a Minecraft resource pack model. " +
      "Writes '<model_name>.json' and '<model_name>.png' directly into the provided export folder. " +
      "Only textures referenced by the model are packed into a square power-of-2 PNG atlas " +
      "arranged in an efficient grid layout, with UV coordinates remapped accordingly. " +
      "Only works when the active project format is 'java_block'.",
    annotations: {
      title: "Export Java Block Model",
      openWorldHint: true,
    },
    parameters: exportJavaBlockParameters,
    status: STATUS_STABLE,
  },
];

// ============================================================================
// Helpers
// ============================================================================

/** Smallest power of 2 >= n. */
function nextPowerOf2(n: number): number {
  if (n <= 1) return 1;
  return Math.pow(2, Math.ceil(Math.log2(n)));
}

/**
 * Computes a square atlas layout.
 *
 * Finds the smallest square power-of-2 side length such that a grid arrangement
 * of `texCount` tiles (each `texW × texH`) fits entirely within the square canvas.
 *
 * Returns: atlasSize (side length in pixels), and cols/rows of the grid.
 */
function computeAtlasLayout(texCount: number, texW: number, texH: number) {
  let atlasSize = nextPowerOf2(Math.max(texW, texH));
  while (true) {
    const cols = Math.floor(atlasSize / texW);
    const rows = Math.floor(atlasSize / texH);
    if (cols * rows >= texCount) {
      return { atlasSize, cols };
    }
    atlasSize *= 2;
  }
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerExportTools() {
  createTool(
    exportToolDocs[0].name,
    {
      ...exportToolDocs[0],
      async execute({ export_folder, model_name }) {
        // ── 1. Validate ──────────────────────────────────────────────────
        if (!Project) {
          throw new Error("No project is open in Blockbench.");
        }
        if (Project.format?.id !== "java_block") {
          throw new Error(
            `This tool only works with java_block projects. ` +
            `Current project format is "${Project.format?.id ?? "unknown"}".`
          );
        }

        const codec = Codecs["java_block"];
        if (!codec) {
          throw new Error("java_block codec not found in Blockbench.");
        }

        // ── 2. Compile model JSON ─────────────────────────────────────────
        const compiledStr: string = codec.compile();
        const modelJson = JSON.parse(compiledStr) as {
          textures?: Record<string, string>;
          elements?: Array<{
            faces?: Record<string, {
              uv?: [number, number, number, number];
              texture?: string;
            }>;
          }>;
          [key: string]: unknown;
        };

        // ── 3. Identify which textures are actually referenced ────────────
        //
        // Blockbench's java_block codec assigns variable names "0", "1", "2", ...
        // in the same order as Project.textures. We parse the compiled texture
        // block to find which numeric keys exist, map them to Texture objects,
        // and filter out any unreferenced textures.
        //
        const allTextures: Texture[] = Project.textures ?? Texture.all;
        if (allTextures.length === 0) {
          throw new Error("No textures in the project. Add at least one texture before exporting.");
        }

        const texWidth: number = allTextures[0].width;
        const texHeight: number = allTextures[0].height;

        // Resolve the texture variable → Blockbench Texture mapping.
        // Direct keys (non-# values): numeric key → textures[parseInt(key)].
        // Ref keys (#X): follow the chain.
        const keyToTexIndex = new Map<string, number>();

        if (modelJson.textures) {
          // First pass: direct keys
          for (const [key, value] of Object.entries(modelJson.textures)) {
            if (!value.startsWith("#")) {
              const idx = parseInt(key, 10);
              keyToTexIndex.set(key, isNaN(idx) ? 0 : idx);
            }
          }
          // Second pass: ref keys
          for (const [key, value] of Object.entries(modelJson.textures)) {
            if (value.startsWith("#")) {
              const refKey = value.slice(1);
              keyToTexIndex.set(key, keyToTexIndex.get(refKey) ?? 0);
            }
          }
        }

        // Collect only the unique textures that are actually used, preserving order
        const usedIndices = [...new Set([...keyToTexIndex.values()])].sort((a, b) => a - b);
        const usedTextures = usedIndices
          .map((i) => allTextures[i])
          .filter(Boolean) as Texture[];

        if (usedTextures.length === 0) {
          throw new Error("No referenced textures found in the compiled model.");
        }

        // Build a mapping: original texture index → atlas slot index (0-based, compact)
        const texIndexToSlot = new Map<number, number>();
        usedIndices.forEach((origIdx, slot) => texIndexToSlot.set(origIdx, slot));

        // ── 4. Build a square grid atlas ──────────────────────────────────
        //
        // Textures are laid out left-to-right, top-to-bottom:
        //   slot i → col = i % cols, row = Math.floor(i / cols)
        //   pixel origin = (col * texW, row * texH)
        //
        // The atlas is square: atlasSize × atlasSize pixels, power-of-2.
        //
        const { atlasSize, cols } = computeAtlasLayout(usedTextures.length, texWidth, texHeight);

        const atlasCanvas = document.createElement("canvas");
        atlasCanvas.width = atlasSize;
        atlasCanvas.height = atlasSize;
        const atlasCtx = atlasCanvas.getContext("2d")!;
        atlasCtx.clearRect(0, 0, atlasSize, atlasSize);

        for (let slot = 0; slot < usedTextures.length; slot++) {
          const col = slot % cols;
          const row = Math.floor(slot / cols);
          const tex = usedTextures[slot];
          const texCanvas = tex.getActiveCanvas().canvas as HTMLCanvasElement;
          atlasCtx.drawImage(texCanvas, col * texWidth, row * texHeight, texWidth, texHeight);
        }

        const atlasPngDataUrl = atlasCanvas.toDataURL("image/png");
        const base64Match = atlasPngDataUrl.match(/^data:image\/png;base64,(.+)$/);
        if (!base64Match) {
          throw new Error("Failed to encode the baked texture atlas as PNG.");
        }

        // ── 5. Rewrite texture refs + remap UVs in the model JSON ─────────
        //
        // UV remapping for a face whose texture occupies slot S (grid col, row):
        //
        //   uScale = texW / atlasSize    (fraction of atlas width one tile occupies)
        //   vScale = texH / atlasSize
        //   u_atlas = (col * uScale + u_tex / 16 * uScale) * 16
        //   v_atlas = (row * vScale + v_tex / 16 * vScale) * 16
        //
        const uScale = texWidth / atlasSize;
        const vScale = texHeight / atlasSize;

        // Build key → atlas slot map for UV remapping
        const keyToSlot = new Map<string, number>();
        for (const [key, origIdx] of keyToTexIndex.entries()) {
          keyToSlot.set(key, texIndexToSlot.get(origIdx) ?? 0);
        }

        // Replace all texture values with model_name
        if (modelJson.textures) {
          for (const key of Object.keys(modelJson.textures)) {
            modelJson.textures[key] = model_name;
          }
        }

        // Remap element face UVs
        if (Array.isArray(modelJson.elements) && usedTextures.length > 1) {
          for (const element of modelJson.elements) {
            if (!element.faces) continue;
            for (const face of Object.values(element.faces)) {
              if (!face.uv || !face.texture) continue;

              const texKey = face.texture.startsWith("#")
                ? face.texture.slice(1)
                : face.texture;
              const slot = keyToSlot.get(texKey) ?? 0;
              const col = slot % cols;
              const row = Math.floor(slot / cols);

              face.uv[0] = (col * uScale + (face.uv[0] / 16) * uScale) * 16;
              face.uv[1] = (row * vScale + (face.uv[1] / 16) * vScale) * 16;
              face.uv[2] = (col * uScale + (face.uv[2] / 16) * uScale) * 16;
              face.uv[3] = (row * vScale + (face.uv[3] / 16) * vScale) * 16;
            }
          }
        }

        // ── 6. Write files ────────────────────────────────────────────────
        // @ts-ignore
        const fs = requireNativeModule("fs") as typeof import("fs");
        // @ts-ignore
        const path = requireNativeModule("path") as typeof import("path");

        fs.mkdirSync(export_folder, { recursive: true });

        const jsonPath = path.join(export_folder, `${model_name}.json`);
        const pngPath = path.join(export_folder, `${model_name}.png`);

        fs.writeFileSync(jsonPath, JSON.stringify(modelJson, null, 2), "utf8");
        fs.writeFileSync(pngPath, Buffer.from(base64Match[1], "base64"));

        const gridCols = cols;
        const gridRows = Math.ceil(usedTextures.length / cols);

        return (
          `Exported java_block model "${model_name}":\n` +
          `  JSON: ${jsonPath}\n` +
          `  PNG:  ${pngPath}\n` +
          `  Atlas: ${atlasSize}×${atlasSize}px (square), ` +
          `${usedTextures.length}/${allTextures.length} texture(s) used, ` +
          `grid: ${gridCols}×${gridRows}\n` +
          `  Texture reference in JSON: "${model_name}"`
        );
      },
    },
    exportToolDocs[0].status
  );
}
