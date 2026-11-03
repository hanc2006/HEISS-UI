import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { civitaiImage, civitaiMature, loraDetails, versionByHash } from "./civitai-api.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import { localLoraFile } from "./lora-info.js";
import { downloadFolder } from "./model-downloads.js";

/**
 * What sits beside a LoRA file, named like it:
 *
 * - its picture, the way ComfyUI-Manager, LoRA Manager and A1111 save them
 *   ("name.preview.png", or "name.png"). HEISS saves Civitai's first picture
 *   this way when it downloads a LoRA.
 * - "name.civitai.json": which Civitai LoRA it is (ids, name, base model) and
 *   what Civitai says about it (trigger words, usage tips, pictures with how
 *   they were made), so the LoRA browser shows a LoRA on this computer the way
 *   it shows one on Civitai, without asking Civitai each time. Written on
 *   download, or once a file from elsewhere is found on Civitai by its SHA-256
 *   (one at a time, or all at once with the scan below).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.HEISS_DATA_DIR || process.env.JAI_DATA_DIR ? path.resolve(process.env.HEISS_DATA_DIR || process.env.JAI_DATA_DIR) : path.join(root, "data");
// Files Civitai didn't know, by path, size and date: not hashed or asked again until they change.
const unknownFile = path.join(dataDir, "lora-civitai-unknown.json");

const endings = [".preview.png", ".preview.jpeg", ".preview.jpg", ".preview.webp", ".png", ".jpeg", ".jpg", ".webp"];
const stemOf = (file) => file.replace(/\.safetensors$/i, "");
const sidecarOf = (file) => `${stemOf(file)}.civitai.json`;
const text = (item, max) => (typeof item === "string" ? item.slice(0, max) : "");

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

/** The details kept in a sidecar, checked field by field (it is a file anyone can edit). */
function cleanDetails(value) {
  if (!value || typeof value !== "object") return null;
  const number = (item) => (Number.isFinite(Number(item)) && item !== null && item !== "" ? Number(item) : null);
  const images = (Array.isArray(value.images) ? value.images : []).filter((image) => /^https:\/\//.test(String(image?.url || ""))).slice(0, 12).map((image) => ({
    url: String(image.url), width: number(image.width), height: number(image.height),
    ...(/^https:\/\//.test(String(image.video || "")) ? { video: String(image.video) } : {}),
    made: image.made && typeof image.made === "object" ? {
      prompt: text(image.made.prompt, 4000), negativePrompt: text(image.made.negativePrompt, 4000), seed: number(image.made.seed),
      steps: number(image.made.steps), cfgScale: number(image.made.cfgScale), sampler: text(image.made.sampler, 80), clipSkip: number(image.made.clipSkip)
    } : null
  }));
  const strength = value.strength && typeof value.strength === "object" && number(value.strength.value) !== null
    ? { value: number(value.strength.value), min: number(value.strength.min), max: number(value.strength.max) } : null;
  return {
    trainedWords: (Array.isArray(value.trainedWords) ? value.trainedWords : []).map((word) => text(word, 200)).filter(Boolean).slice(0, 20),
    strength, images, bytes: number(value.bytes) || 0, page: /^https:\/\//.test(String(value.page || "")) ? String(value.page) : ""
  };
}

/** What a sidecar says: { ref, details, mature }, or null when there is none (or it isn't one of ours). */
function readSidecar(file) {
  try {
    const value = JSON.parse(fs.readFileSync(sidecarOf(file), "utf8"));
    const versionId = Number(value?.versionId);
    if (!Number.isSafeInteger(versionId) || versionId <= 0) return null;
    return {
      ref: { versionId, modelId: Number(value.modelId) || 0, name: text(value.name, 200), version: text(value.version, 200), baseModel: text(value.baseModel, 80) },
      // Details saved before videos were kept (no detailsVersion) are read again from Civitai.
      details: Number(value.detailsVersion) >= detailsVersion ? cleanDetails(value.details) : null,
      mature: Boolean(value.mature)
    };
  } catch {
    return null;
  }
}

// 2: pictures include videos (as a first-frame still plus the clip).
const detailsVersion = 2;

function writeSidecar(file, ref, details = null, mature = false) {
  const target = sidecarOf(file);
  const value = { ...ref, ...(details ? { details: cleanDetails(details), detailsVersion, mature, savedAt: new Date().toISOString() } : {}) };
  fs.writeFileSync(`${target}.part`, `${JSON.stringify(value, null, 2)}\n`);
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
  const saved = readSidecar(file);
  return {
    bytes, preview: previewBeside(file)?.version || 0,
    ...(saved ? { title: saved.ref.name, civitai: saved.ref.versionId, civitaiBase: saved.ref.baseModel } : {})
  };
}

/* ------------------------------------------------------------ Finding */

const hashes = new Map();
let unknownKeys = null;

function unknown() {
  if (!unknownKeys) {
    let saved = null;
    try { saved = readJsonFile(unknownFile); } catch { saved = null; }
    unknownKeys = new Set(Array.isArray(saved?.keys) ? saved.keys.map(String) : []);
  }
  return unknownKeys;
}

function rememberUnknown(key) {
  unknown().add(key);
  try { writeJsonFile(unknownFile, { keys: [...unknownKeys].slice(-5000) }); } catch { /* asked again next run */ }
}

function fileKey(file) {
  const stat = fs.statSync(file);
  return `${file}:${stat.size}:${Math.round(stat.mtimeMs)}`;
}

async function sha256Of(file, key) {
  if (!hashes.has(key)) {
    const hash = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(file), hash);
    hashes.set(key, hash.digest("hex"));
  }
  return hashes.get(key);
}

/** Whether a file still needs Civitai: no sidecar, or one without details for this mature setting, and not known to be unknown. */
function needsCivitai(file, mature) {
  const saved = readSidecar(file);
  if (saved) return !saved.details || saved.mature !== mature || needsPicture(file, saved.details);
  try { return !unknown().has(fileKey(file)); } catch { return false; }
}

// Pictures tried this run: one that won't download isn't asked for again until a restart.
const pictureTried = new Set();
const needsPicture = (file, details) => Boolean(details?.images?.length) && !previewBeside(file) && !pictureTried.has(file);

/**
 * Civitai's first picture of a LoRA, saved beside it as its preview when it has
 * none, so its card shows it. Best effort: true when saved.
 */
async function savePictureFrom(file, details, { env, transport }) {
  if (!needsPicture(file, details)) return false;
  pictureTried.add(file);
  try {
    const image = await civitaiImage(details.images[0].url, { env, transport });
    if (!image) return false;
    const target = `${stemOf(file)}.preview.${image.ext}`;
    fs.writeFileSync(`${target}.part`, image.bytes);
    fs.renameSync(`${target}.part`, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which Civitai LoRA a listed file is and what Civitai says about it:
 * { ref, details } from its sidecar, else found by the file's SHA-256 and
 * read from Civitai, then kept as a sidecar. null for a file Civitai doesn't
 * know, or one that isn't on this computer.
 */
export async function loraCivitaiInfo(name, { env = process.env, transport = null } = {}) {
  const file = localLoraFile(name);
  if (!file) return null;
  const mature = civitaiMature(env);
  const saved = readSidecar(file);
  if (saved?.details && saved.mature === mature) {
    await savePictureFrom(file, saved.details, { env, transport });
    return { ref: saved.ref, details: saved.details };
  }
  let ref = saved?.ref || null;
  if (!ref) {
    const key = fileKey(file);
    if (unknown().has(key)) return null;
    ref = await versionByHash(await sha256Of(file, key), { env, transport });
    if (!ref) { rememberUnknown(key); return null; }
  }
  let details = saved?.details || null;
  try {
    details = cleanDetails(await loraDetails(ref.versionId, { env, transport }));
  } catch (error) {
    // Found, but its details couldn't be read: keep what is known, and try for the details next time.
    if (!saved) try { writeSidecar(file, ref); } catch { /* read-only folder */ }
    if (details) return { ref, details };
    throw error;
  }
  try { writeSidecar(file, ref, details, mature); } catch { /* read-only folder: asked again next time */ }
  await savePictureFrom(file, details, { env, transport });
  return { ref, details };
}

/** Which Civitai LoRA a listed file is (see loraCivitaiInfo), or null. */
export async function loraOnCivitai(name, options = {}) {
  return (await loraCivitaiInfo(name, options))?.ref || null;
}

/* ------------------------------------------------------------ Scan */

let scan = { running: false, total: 0, done: 0, matched: 0, failed: 0, finishedAt: 0 };

export function loraScanState() {
  const { promise: _, ...state } = scan;
  return state;
}

/**
 * Matches every listed LoRA that has no sidecar yet with Civitai, one file at
 * a time, writing a sidecar for each one Civitai knows. Runs in the
 * background; loraScanState says how far it got. Resolves when it is done.
 */
export function startLoraScan(names = [], options = {}) {
  if (scan.running) return scan.promise;
  const mature = civitaiMature(options.env || process.env);
  const todo = names.filter((name) => {
    const file = localLoraFile(name);
    return file && needsCivitai(file, mature);
  });
  scan = { running: true, total: todo.length, done: 0, matched: 0, failed: 0, finishedAt: 0 };
  const run = (async () => {
    for (const name of todo) {
      try {
        if (await loraCivitaiInfo(name, options)) scan.matched += 1;
      } catch {
        scan.failed += 1;
      }
      scan.done += 1;
    }
    scan = { ...scan, running: false, finishedAt: Date.now() };
  })();
  scan.promise = run;
  return run;
}

/* ------------------------------------------------------------ Download */

/**
 * Saves what a Civitai download brings along beside the LoRA: which Civitai
 * LoRA it is, and its first picture (unless it has one). Best effort: a LoRA
 * without them works the same. Resolves true when the picture was saved.
 */
export async function saveLoraPreview(spec, { transport = null, env = process.env } = {}) {
  if (spec?.folder !== "loras" || !/\.safetensors$/i.test(spec?.file || "")) return false;
  const dir = downloadFolder(spec);
  const lora = path.join(dir, spec.file);
  fs.mkdirSync(dir, { recursive: true });
  if (spec.civitai?.versionId && !readSidecar(lora)) {
    let details = null;
    try { details = await loraDetails(spec.civitai.versionId, { env, transport }); } catch { details = null; }
    writeSidecar(lora, spec.civitai, details, civitaiMature(env));
  }
  if (!spec.preview || previewBeside(lora)) return false;
  const image = await civitaiImage(spec.preview, { transport, env });
  if (!image) return false;
  const target = `${stemOf(lora)}.preview.${image.ext}`;
  fs.writeFileSync(`${target}.part`, image.bytes);
  fs.renameSync(`${target}.part`, target);
  return true;
}
