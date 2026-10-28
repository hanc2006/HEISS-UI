import fs from "node:fs";
import path from "node:path";
import { civitaiImage } from "./civitai-api.js";
import { localLoraFile } from "./lora-info.js";
import { downloadFolder } from "./model-downloads.js";

/**
 * A LoRA's picture: a file beside it named like it, the way ComfyUI-Manager,
 * LoRA Manager and A1111 save them ("name.preview.png", or "name.png").
 * HEISS saves Civitai's first picture this way when it downloads a LoRA, so
 * the LoRA browser can show it once the LoRA is on this computer.
 */

const endings = [".preview.png", ".preview.jpeg", ".preview.jpg", ".preview.webp", ".png", ".jpeg", ".jpg", ".webp"];
const stemOf = (file) => file.replace(/\.safetensors$/i, "");

function previewBeside(file) {
  const stem = stemOf(file);
  for (const ending of endings) {
    const candidate = `${stem}${ending}`;
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size > 0) return { file: candidate, version: Math.round(stat.mtimeMs) };
    } catch { /* the next ending */ }
  }
  return null;
}

/** { file, version } for a listed LoRA's picture on this computer, else null. */
export function loraPreview(name) {
  const file = localLoraFile(name);
  return file ? previewBeside(file) : null;
}

/** The LoRA file's size and its picture's version (0 without one), for the browser's cards. */
export function loraFileFacts(name) {
  const file = localLoraFile(name);
  if (!file) return null;
  let bytes = 0;
  try { bytes = fs.statSync(file).size; } catch { return null; }
  return { bytes, preview: previewBeside(file)?.version || 0 };
}

/**
 * Saves a Civitai download's picture beside the LoRA, unless it has one.
 * Best effort: a LoRA without a picture works the same. Resolves true when saved.
 */
export async function saveLoraPreview(spec, { transport = null } = {}) {
  if (!spec?.preview || spec.folder !== "loras" || !/\.safetensors$/i.test(spec.file || "")) return false;
  const dir = downloadFolder(spec);
  const lora = path.join(dir, spec.file);
  if (previewBeside(lora)) return false;
  const image = await civitaiImage(spec.preview, { transport });
  if (!image) return false;
  const target = `${stemOf(lora)}.preview.${image.ext}`;
  const partial = `${target}.part`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(partial, image.bytes);
  fs.renameSync(partial, target);
  return true;
}
