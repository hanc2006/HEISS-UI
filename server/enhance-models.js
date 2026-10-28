import fs from "node:fs";
import path from "node:path";
import { modelFolders } from "./comfy.js";
import { readSafetensorsHeader } from "./model-families.js";

/**
 * Prompt enhance's other models: the person's own files in ComfyUI's
 * text_encoders folder that HEISS Prompt Enhance can run. The node writes
 * with ComfyUI's own text generation, which (HEISS UI Nodes, heiss_enhance.py)
 * covers three families: Qwen3-VL, Qwen3.5 and Gemma 4. A file is recognised
 * by its weight names, the same signatures ComfyUI's detect_te_model uses
 * (comfy/sd.py), so a T5, a CLIP or a Gemma 3 never shows up as a choice.
 *
 * What a file can do comes from its weights too: a vision tower means it can
 * turn a picture into a prompt; without one it rewrites words only. Before a
 * file becomes the enhancer, a short test run checks it really writes
 * (index.js, /api/enhance/test).
 */

const shapeOf = (header, key) => (Array.isArray(header?.[key]?.shape) ? header[key].shape : null);
const has = (header, key) => Boolean(header && Object.hasOwn(header, key));
const keysOf = (header) => Object.keys(header || {}).filter((key) => key !== "__metadata__");

const families = { qwen3vl: "Qwen3-VL", qwen35: "Qwen3.5", gemma4: "Gemma 4" };

/** { family, label, size, vision, fp8 } for a file the node can run; null for anything else. */
export function enhancerKind(header) {
  if (!header || typeof header !== "object") return null;
  const keys = keysOf(header);
  const fp8 = keys.some((key) => /^F8/i.test(String(header[key]?.dtype || "")));
  let kind = null;
  // Gemma 4 (comfy/sd.py checks it before the Qwens). Gemma 3 and 2 share the layer norms but not these counts.
  if (has(header, "model.layers.0.post_feedforward_layernorm.weight")) {
    const qNorm = (layer) => has(header, `model.layers.${layer}.self_attn.q_norm.weight`);
    // LTX-2's Gemma 4 12B conditioning encoder is cut for that job, not for writing.
    const ltx = has(header, "text_embedding_projection.video_aggregate_embed.weight");
    const size = qNorm(59) ? "31B"
      : qNorm(47) && !has(header, "model.layers.5.self_attn.v_proj.weight") && !ltx ? "12B"
      : qNorm(41) && !qNorm(47) ? "E4B"
      : qNorm(34) && !qNorm(41) ? "E2B"
      : "";
    if (size) kind = { family: "gemma4", size, vision: keys.some((key) => /(^|\.)vision_(model|tower)\./.test(key)) };
  } else if (has(header, "model.language_model.layers.0.linear_attn.A_log")) {
    const width = shapeOf(header, "model.language_model.layers.0.input_layernorm.weight")?.[0];
    const size = { 1024: "0.8B", 2048: "2B", 2560: "4B", 4096: "9B", 5120: "27B" }[width] || "";
    if (size) kind = { family: "qwen35", size, vision: keys.some((key) => key.startsWith("model.visual.")) };
  } else if (has(header, "model.visual.deepstack_merger_list.0.norm.weight")) {
    // DeepStack is unique to Qwen3-VL. (MiniMax H3's truncated 32B has its keys without "model." and is no writer.)
    const size = shapeOf(header, "model.visual.merger.linear_fc2.weight")?.[0] === 2560 ? "4B" : "8B";
    kind = { family: "qwen3vl", size, vision: true };
  }
  return kind ? { ...kind, label: `${families[kind.family]} ${kind.size}`, fp8 } : null;
}

const cache = new Map();

/** The file behind a name ComfyUI lists for the CLIP loader, when it is on this computer. */
function localFile(name) {
  if (!/\.safetensors$/i.test(name)) return "";
  const parts = String(name).split(/[\\/]/).filter(Boolean);
  if (!parts.length || parts.some((part) => part === "..")) return "";
  for (const dir of modelFolders("text_encoders", ["text_encoders", "clip"])) {
    const file = path.join(dir, ...parts);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* the next folder */ }
  }
  return "";
}

/** What a listed file is, read once per file version (size and modified time). null when unknown or not a writer. */
export function describeLocal(name) {
  const file = localFile(name);
  if (!file) return null;
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (!cache.has(key)) {
    let kind = null;
    try { kind = enhancerKind(readSafetensorsHeader(file)); } catch { kind = null; }
    cache.set(key, kind ? { ...kind, bytes: stat.size } : null);
  }
  return cache.get(key);
}

/** One line about a file: what it reads, and what to know before picking it. */
export function noteFor(kind, { vramTotal = 0 } = {}) {
  const notes = [kind.vision ? "Reads words and pictures." : "Reads words only: it can’t turn a picture into a prompt."];
  // fp8 is upcast to 16-bit on cards before RTX 40 (docs/prompt-enhance.md), about twice the size.
  if (kind.fp8) notes.push("fp8: on cards before RTX 40 it takes about twice its size.");
  // It has to fit whole: a model that spills over streams its weights for every word and slows to a crawl.
  if (vramTotal && kind.bytes * 1.1 > vramTotal) notes.push("Bigger than this card’s memory, so it will write slowly.");
  return notes.join(" ");
}

/**
 * The person's own writers among the files ComfyUI lists: everything the node
 * can run, minus the catalog's own builds (they are listed already).
 */
export function localEnhancers(listed = [], { catalogFiles = [], vramTotal = 0 } = {}) {
  const skip = new Set(catalogFiles);
  const out = [];
  for (const name of listed) {
    if (skip.has(name)) continue;
    const kind = describeLocal(name);
    if (!kind) continue;
    out.push({
      id: `local:${name}`, file: name, label: kind.label, note: noteFor(kind, { vramTotal }), bytes: kind.bytes,
      listed: true, onDisk: true, local: true, vision: kind.vision, family: kind.family, fileName: path.basename(name)
    });
  }
  return out;
}

/** Whether the model in use can read a picture: the catalog's are all vision models; an own file says so in its weights. */
export function canSee(model, catalogFiles = []) {
  if (catalogFiles.includes(model)) return true;
  return Boolean(describeLocal(model)?.vision);
}
