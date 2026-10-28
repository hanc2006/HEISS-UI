import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-lora-previews-"));
process.env.HEISS_COMFY_ROOT = path.join(scratch, "ComfyUI");
process.env.HEISS_DATA_DIR = path.join(scratch, "data");
const loraDir = path.join(scratch, "ComfyUI", "models", "loras");
fs.mkdirSync(loraDir, { recursive: true });
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { civitaiImage } = await import("./civitai-api.js");
const { loraFileFacts, loraOnCivitai, loraPreview, saveLoraPreview } = await import("./lora-previews.js");

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const answering = (body, type = "image/jpeg", status = 200) => {
  const calls = [];
  return { calls, transport: async (url, options) => { calls.push({ url, auth: new Headers(options.headers).get("authorization") }); return new Response(body, { status, headers: { "content-type": type } }); } };
};
const spec = (file, preview = "https://image.civitai.com/k/u/width=450/p.jpeg") => ({ id: "civitai:1:2", file, folder: "loras", url: "https://civitai.com/api/download/models/2", preview });

test("pictures come only from Civitai's image servers, as JPEG, PNG or WebP, without the key", async () => {
  const ok = answering(jpeg);
  process.env.CIVITAI_TOKEN = "secret";
  assert.deepEqual(await civitaiImage("https://image.civitai.com/k/u/width=450/p.jpeg", { transport: ok.transport }), { bytes: jpeg, ext: "jpeg" });
  assert.equal(ok.calls[0].auth, null, "the API key stays off picture requests");
  delete process.env.CIVITAI_TOKEN;
  const never = answering(jpeg);
  assert.equal(await civitaiImage("https://example.com/p.jpeg", { transport: never.transport }), null);
  assert.equal(await civitaiImage("https://civitai.com.evil.net/p.jpeg", { transport: never.transport }), null);
  assert.equal(never.calls.length, 0, "other hosts are never asked");
  assert.equal(await civitaiImage("https://image.civitai.com/p.svg", answering("<svg/>", "image/svg+xml")), null);
  assert.equal(await civitaiImage("https://image.civitai.com/p.jpeg", answering("gone", "image/jpeg", 404)), null);
});

test("a downloaded LoRA gets its picture beside it once; the browser reads its size and picture version", async () => {
  fs.writeFileSync(path.join(loraDir, "ink.safetensors"), Buffer.alloc(64));
  assert.equal(await saveLoraPreview(spec("ink.safetensors"), answering(jpeg)), true);
  assert.deepEqual(fs.readFileSync(path.join(loraDir, "ink.preview.jpeg")), jpeg);
  const again = answering(jpeg);
  assert.equal(await saveLoraPreview(spec("ink.safetensors"), again), false, "one picture is enough");
  assert.equal(again.calls.length, 0);
  assert.equal(loraPreview("ink.safetensors").file, path.join(loraDir, "ink.preview.jpeg"));
  const facts = loraFileFacts("ink.safetensors");
  assert.equal(facts.bytes, 64);
  assert.ok(facts.preview > 0);
});

test("pictures saved by other tools count; no picture, no preview; odd names are refused", async () => {
  fs.writeFileSync(path.join(loraDir, "hand.safetensors"), Buffer.alloc(8));
  fs.writeFileSync(path.join(loraDir, "hand.png"), jpeg);
  assert.equal(loraPreview("hand.safetensors").file, path.join(loraDir, "hand.png"));
  fs.writeFileSync(path.join(loraDir, "bare.safetensors"), Buffer.alloc(8));
  assert.equal(loraPreview("bare.safetensors"), null);
  assert.equal(loraFileFacts("bare.safetensors").preview, 0);
  assert.equal(loraPreview("../ink.safetensors"), null);
  assert.equal(await saveLoraPreview({ ...spec("bare.safetensors"), preview: undefined }), false);
  assert.equal(await saveLoraPreview({ ...spec("model.safetensors"), folder: "checkpoints" }), false);
});

test("a download remembers which Civitai LoRA it is; the browser's facts carry its name", async () => {
  fs.writeFileSync(path.join(loraDir, "neon.safetensors"), Buffer.alloc(16));
  const ref = { versionId: 22, modelId: 2, name: "Neon Nights", version: "v1", baseModel: "Flux.2 D" };
  await saveLoraPreview({ ...spec("neon.safetensors"), preview: undefined, civitai: ref });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(loraDir, "neon.civitai.json"), "utf8")), ref);
  const facts = loraFileFacts("neon.safetensors");
  assert.deepEqual([facts.title, facts.civitai, facts.civitaiBase], ["Neon Nights", 22, "Flux.2 D"]);
  assert.deepEqual(await loraOnCivitai("neon.safetensors", { transport: async () => { throw new Error("not asked"); } }), ref);
});

test("a LoRA from elsewhere is found by its SHA-256 once, then remembered; an unknown one is asked once", async () => {
  const bytes = Buffer.from("some weights");
  fs.writeFileSync(path.join(loraDir, "found.safetensors"), bytes);
  const sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const asked = [];
  const transport = async (url) => {
    asked.push(url.pathname);
    return url.pathname.endsWith(sha)
      ? new Response(JSON.stringify({ id: 9, modelId: 4, name: "v3", baseModel: "SDXL 1.0", model: { name: "Found It" } }), { status: 200 })
      : new Response("{}", { status: 404 });
  };
  assert.equal((await loraOnCivitai("found.safetensors", { transport })).name, "Found It");
  assert.ok(fs.existsSync(path.join(loraDir, "found.civitai.json")));
  await loraOnCivitai("found.safetensors", { transport });
  assert.equal(asked.length, 1, "the sidecar answers the second time");
  fs.writeFileSync(path.join(loraDir, "mine.safetensors"), Buffer.from("trained at home"));
  assert.equal(await loraOnCivitai("mine.safetensors", { transport }), null);
  assert.equal(await loraOnCivitai("mine.safetensors", { transport }), null);
  assert.equal(asked.length, 2, "an unknown file is asked about once");
  assert.equal(await loraOnCivitai("../mine.safetensors", { transport }), null);
});
