import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-enhance-models-"));
process.env.HEISS_COMFY_ROOT = path.join(scratch, "ComfyUI");
const encoders = path.join(scratch, "ComfyUI", "models", "text_encoders");
fs.mkdirSync(encoders, { recursive: true });

const { canSee, enhancerKind, localEnhancers, noteFor } = await import("./enhance-models.js");

/** A header shaped like a real file's: tensor names with shapes and dtypes. Only the names and a few shapes matter. */
const tensor = (shape = [1], dtype = "BF16") => ({ dtype, shape, data_offsets: [0, 0] });
function header(keys, shapes = {}, dtype = "BF16") {
  return Object.fromEntries(keys.map((key) => [key, tensor(shapes[key] || [1], dtype)]));
}
const layers = (count, suffix) => Array.from({ length: count }, (_, i) => `model.layers.${i}.${suffix}`);

const qwen3vl4b = header(["model.visual.deepstack_merger_list.0.norm.weight", "model.visual.merger.linear_fc2.weight", "model.layers.0.self_attn.q_proj.weight"], { "model.visual.merger.linear_fc2.weight": [2560, 4096] });
const qwen35 = (width, vision) => header([
  "model.language_model.layers.0.linear_attn.A_log", "model.language_model.layers.0.input_layernorm.weight",
  ...(vision ? ["model.visual.blocks.0.attn.qkv.weight"] : [])
], { "model.language_model.layers.0.input_layernorm.weight": [width] });
const gemma4e4b = (vision) => header([
  "model.layers.0.post_feedforward_layernorm.weight", ...layers(42, "self_attn.q_norm.weight"),
  ...(vision ? ["model.vision_tower.encoder.layers.0.mlp.fc1.weight"] : [])
]);

/** Writes a safetensors file holding just a header (all the reader looks at). */
function writeFile(name, value) {
  const json = Buffer.from(JSON.stringify(value));
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(json.length));
  fs.writeFileSync(path.join(encoders, name), Buffer.concat([size, json]));
}

test("the three families the node runs are recognised by their weights, with size and sight", () => {
  assert.deepEqual(enhancerKind(qwen3vl4b), { family: "qwen3vl", size: "4B", vision: true, label: "Qwen3-VL 4B", fp8: false });
  assert.deepEqual(enhancerKind(qwen35(2560, true)), { family: "qwen35", size: "4B", vision: true, label: "Qwen3.5 4B", fp8: false });
  assert.equal(enhancerKind(qwen35(2048, false)).label, "Qwen3.5 2B");
  assert.equal(enhancerKind(qwen35(2048, false)).vision, false, "no vision tower, words only");
  assert.deepEqual(enhancerKind(gemma4e4b(true)), { family: "gemma4", size: "E4B", vision: true, label: "Gemma 4 E4B", fp8: false });
  assert.equal(enhancerKind(header(["model.visual.deepstack_merger_list.0.norm.weight", "model.visual.merger.linear_fc2.weight"], {}, "F8_E4M3")).fp8, true);
});

test("look-alikes the node can't write with are never offered", () => {
  // T5-XXL, CLIP-L, Gemma 3 (same layer norm, other layer counts), LTX-2's cut-down Gemma 4 12B, a Qwen3.5 of an unknown width.
  assert.equal(enhancerKind(header(["encoder.block.23.layer.1.DenseReluDense.wi_1.weight"])), null);
  assert.equal(enhancerKind(header(["text_model.encoder.layers.0.mlp.fc1.weight"])), null);
  assert.equal(enhancerKind(header(["model.layers.0.post_feedforward_layernorm.weight", ...layers(26, "self_attn.q_norm.weight")])), null);
  assert.equal(enhancerKind(header(["model.layers.0.post_feedforward_layernorm.weight", ...layers(48, "self_attn.q_norm.weight"), "text_embedding_projection.video_aggregate_embed.weight"])), null);
  assert.equal(enhancerKind(qwen35(3000, true)), null);
  assert.equal(enhancerKind(null), null);
});

test("the person's own files ComfyUI lists become choices; the catalog's and other encoders don't", () => {
  writeFile("my-qwen35-2b.safetensors", qwen35(2048, false));
  writeFile("gemma4-e4b.safetensors", gemma4e4b(true));
  writeFile("t5xxl.safetensors", header(["encoder.block.23.layer.1.DenseReluDense.wi_1.weight"]));
  writeFile("catalog.safetensors", qwen3vl4b);
  const listed = ["my-qwen35-2b.safetensors", "gemma4-e4b.safetensors", "t5xxl.safetensors", "catalog.safetensors", "not-on-disk.safetensors", "model.gguf"];
  const choices = localEnhancers(listed, { catalogFiles: ["catalog.safetensors"] });
  assert.deepEqual(choices.map((choice) => [choice.id, choice.label, choice.vision]), [
    ["local:my-qwen35-2b.safetensors", "Qwen3.5 2B", false],
    ["local:gemma4-e4b.safetensors", "Gemma 4 E4B", true]
  ]);
  assert.match(choices[0].note, /words only/);
  assert.equal(choices[0].listed && choices[0].onDisk && choices[0].local, true);
  assert.equal(canSee("gemma4-e4b.safetensors"), true);
  assert.equal(canSee("my-qwen35-2b.safetensors"), false);
  assert.equal(canSee("catalog.safetensors", ["catalog.safetensors"]), true, "the catalog's are all vision models");
});

test("the note warns when a model won't fit the card, or is fp8", () => {
  const big = { vision: true, fp8: true, bytes: 9 * 1024 ** 3 };
  assert.match(noteFor(big, { vramTotal: 8 * 1024 ** 3 }), /Bigger than this card’s memory/);
  assert.match(noteFor(big, { vramTotal: 24 * 1024 ** 3 }), /fp8/);
  assert.doesNotMatch(noteFor({ ...big, fp8: false }, { vramTotal: 24 * 1024 ** 3 }), /fp8|Bigger/);
});
