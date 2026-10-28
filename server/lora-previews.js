import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { civitaiImage, versionByHash } from "./civitai-api.js";
import { localLoraFile } from "./lora-info.js";
import { downloadFolder } from "./model-downloads.js";

/**
 * What sits beside a LoRA file, named like it:
 *
 * - its picture, the way ComfyUI-Manager, LoRA Manager and A1111 save them
 *   ("name.preview.png", or "name.png"). HEISS saves Civitai's first picture
 *   this way when it downloads a LoRA.
 * - "name.civitai.json": which Civitai LoRA it is (ids, name, base model), so
 *   the LoRA browser can show Civitai's details for a LoRA on this computer.
 *   Written on download, or once a file from elsewhere is found on Civitai by
 *   its SHA-256.
 */

const endings = [".preview.png", ".preview.jpeg", ".preview.jpg", ".preview.webp", ".png", ".jpeg", ".jpg", ".webp"];
const stemOf = (file) => file.replace(/\.safetensors$/i, "");
const sidecarOf = (file) => `${stemOf(file)}.civitai.json`;

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

/** The Civitai facts kept beside a file, checked; null when there are none. */
function readSidecar(file) {
  try {
    const value = JSON.parse(fs.readFileSync(sidecarOf(file), "utf8"));
    const versionId = Number(value?.versionId);
    if (!Number.isSafeInteger(versionId) || versionId <= 0) return null;
    const text = (item, max) => (typeof item === "string" ? item.slice(0, max) : "");
    return { versionId, modelId: Number(value.modelId) || 0, name: text(value.name, 200), version: text(value.version, 200), baseModel: text(value.baseModel, 80) };
  } catch {
    return null;
  }
}

function writeSidecar(file, ref) {
  const target = sidecarOf(file);
  fs.writeFileSync(`${target}.part`, `${JSON.stringify(ref, null, 2)}\n`);
  fs.renameSync(`${target}.part`, target);
}

/** { file, version } for a listed LoRA's picture on this computer, else null. */
export function loraPreview(name) {
  const file = localLoraFile(name);
  return file ? previewBeside(file) : null;
}

/**
 * For the browser's cards: the file's size, its picture's version (0 without
 * one), and, when known, its Civitai name, base model and version id.
 */
export function loraFileFacts(name) {
  const file = localLoraFile(name);
  if (!file) return null;
  let bytes = 0;
  try { bytes = fs.statSync(file).size; } catch { return null; }
  const ref = readSidecar(file);
  return {
    bytes, preview: previewBeside(file)?.version || 0,
    ...(ref ? { title: ref.name, civitai: ref.versionId, civitaiBase: ref.baseModel } : {})
  };
}

const hashes = new Map();
const unknown = new Set();

async function sha256Of(file) {
  const stat = fs.statSync(file);
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (!hashes.has(key)) {
    const hash = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(file), hash);
    hashes.set(key, hash.digest("hex"));
  }
  return { key, sha256: hashes.get(key) };
}

/**
 * Which Civitai LoRA a listed file is: from its sidecar, else asked of Civitai
 * by the file's SHA-256 (and kept as a sidecar). null for a file Civitai
 * doesn't know, or one that isn't on this computer.
 */
export async function loraOnCivitai(name, { transport = null } = {}) {
  const file = localLoraFile(name);
  if (!file) return null;
  const saved = readSidecar(file);
  if (saved) return saved;
  const { key, sha256 } = await sha256Of(file);
  if (unknown.has(key)) return null;
  const ref = await versionByHash(sha256, { transport });
  if (!ref) { unknown.add(key); return null; }
  try { writeSidecar(file, ref); } catch { /* read-only folder: asked again next time */ }
  return ref;
}

/**
 * Saves what a Civitai download brings along beside the LoRA: which Civitai
 * LoRA it is, and its first picture (unless it has one). Best effort: a LoRA
 * without them works the same. Resolves true when the picture was saved.
 */
export async function saveLoraPreview(spec, { transport = null } = {}) {
  if (spec?.folder !== "loras" || !/\.safetensors$/i.test(spec?.file || "")) return false;
  const dir = downloadFolder(spec);
  const lora = path.join(dir, spec.file);
  fs.mkdirSync(dir, { recursive: true });
  if (spec.civitai?.versionId && !readSidecar(lora)) writeSidecar(lora, spec.civitai);
  if (!spec.preview || previewBeside(lora)) return false;
  const image = await civitaiImage(spec.preview, { transport });
  if (!image) return false;
  const target = `${stemOf(lora)}.preview.${image.ext}`;
  fs.writeFileSync(`${target}.part`, image.bytes);
  fs.renameSync(`${target}.part`, target);
  return true;
}
