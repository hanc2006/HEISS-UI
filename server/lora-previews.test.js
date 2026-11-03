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
const { loraCivitaiInfo, loraFileFacts, loraOnCivitai, loraPreview, loraScanState, saveLoraPreview, startLoraScan } = await import("./lora-previews.js");

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const answering = (body, type = "image/jpeg", status = 200) => {
  const calls = [];
  return { calls, transport: async (url, options) => { calls.push({ url, auth: new Headers(options.headers).get("authorization") }); return new Response(body, { status, headers: { "content-type": type } }); } };
};
/** Civitai answering: a version found by `sha` (or none), its details and pictures. */
function civitaiAnswers(sha = "", asked = []) {
  return async (url) => {
    asked.push(url.pathname);
    if (url.hostname === "image.civitai.com") return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
    if (url.pathname.includes("/by-hash/")) {
      return url.pathname.endsWith(sha) ? new Response(JSON.stringify({ id: 9, modelId: 4, name: "v3", baseModel: "SDXL 1.0", model: { name: "Found It" } }), { status: 200 }) : new Response("{}", { status: 404 });
    }
    if (url.pathname === "/api/v1/images") return new Response(JSON.stringify({ items: [{ url: "https://image.civitai.com/k/a/original=true/a.jpeg", type: "image", nsfwLevel: 1, meta: { prompt: "a neon street", steps: 20 } }] }), { status: 200 });
    return new Response(JSON.stringify({ id: 22, modelId: 2, name: "v1", baseModel: "Flux.2 D", model: { name: "Neon Nights" }, trainedWords: ["N30N"], settings: { strength: 0.8 } }), { status: 200 });
  };
}

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
  await saveLoraPreview({ ...spec("neon.safetensors"), preview: undefined, civitai: ref }, { env: {}, transport: civitaiAnswers() });
  const saved = JSON.parse(fs.readFileSync(path.join(loraDir, "neon.civitai.json"), "utf8"));
  assert.deepEqual({ versionId: saved.versionId, modelId: saved.modelId, name: saved.name, version: saved.version, baseModel: saved.baseModel }, ref);
  assert.deepEqual(saved.details.trainedWords, ["N30N"], "what Civitai says is kept beside it");
  assert.equal(saved.details.images[0].made.prompt, "a neon street");
  const facts = loraFileFacts("neon.safetensors");
  assert.deepEqual([facts.title, facts.civitai, facts.civitaiBase], ["Neon Nights", 22, "Flux.2 D"]);
  const info = await loraCivitaiInfo("neon.safetensors", { env: {}, transport: async () => { throw new Error("not asked"); } });
  assert.deepEqual(info.ref, ref);
  assert.deepEqual(info.details.strength, { value: 0.8, min: null, max: null }, "read from the file, Civitai not asked");
});

test("a LoRA from elsewhere is found by its SHA-256 once, then remembered; an unknown one is asked once", async () => {
  const bytes = Buffer.from("some weights");
  fs.writeFileSync(path.join(loraDir, "found.safetensors"), bytes);
  const sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const asked = [];
  const transport = civitaiAnswers(sha, asked);
  assert.equal((await loraOnCivitai("found.safetensors", { env: {}, transport })).name, "Found It");
  assert.ok(fs.existsSync(path.join(loraDir, "found.civitai.json")));
  const hashAsks = () => asked.filter((item) => item.includes("by-hash")).length;
  await loraOnCivitai("found.safetensors", { env: {}, transport });
  assert.equal(hashAsks(), 1, "the sidecar answers the second time");
  fs.writeFileSync(path.join(loraDir, "mine.safetensors"), Buffer.from("trained at home"));
  assert.equal(await loraOnCivitai("mine.safetensors", { env: {}, transport }), null);
  assert.equal(await loraOnCivitai("mine.safetensors", { env: {}, transport }), null);
  assert.equal(hashAsks(), 2, "an unknown file is asked about once");
  assert.ok(fs.readFileSync(path.join(process.env.HEISS_DATA_DIR, "lora-civitai-unknown.json"), "utf8").includes("mine.safetensors"), "and remembered across restarts");
  assert.equal(await loraOnCivitai("../mine.safetensors", { env: {}, transport }), null);
});

test("the scan matches every LoRA without a sidecar, one at a time, and says how far it got", async () => {
  for (const name of ["s1", "s2", "s3"]) fs.writeFileSync(path.join(loraDir, `${name}.safetensors`), Buffer.from(`weights ${name}`));
  const sha = (await import("node:crypto")).createHash("sha256").update(Buffer.from("weights s2")).digest("hex");
  await startLoraScan(["s1.safetensors", "s2.safetensors", "s3.safetensors", "neon.safetensors", "nowhere.safetensors"], { env: {}, transport: civitaiAnswers(sha) });
  const state = loraScanState();
  assert.deepEqual([state.running, state.total, state.done, state.matched], [false, 3, 3, 1], "neon has its sidecar already; nowhere isn't on this computer");
  assert.ok(fs.existsSync(path.join(loraDir, "s2.civitai.json")));
  assert.ok(!fs.existsSync(path.join(loraDir, "s1.civitai.json")));
  assert.equal(state.promise, undefined);
});

test("a LoRA matched with Civitai gets Civitai's first picture beside it, so its card shows it", async () => {
  const bytes = Buffer.from("pictured weights");
  fs.writeFileSync(path.join(loraDir, "pictured.safetensors"), bytes);
  const sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  await loraOnCivitai("pictured.safetensors", { env: {}, transport: civitaiAnswers(sha) });
  assert.deepEqual(fs.readFileSync(path.join(loraDir, "pictured.preview.jpeg")), jpeg);
  assert.ok(loraFileFacts("pictured.safetensors").preview > 0);
  // A .civitai.json written by the version before (no picture saved): the next scan brings the picture, without asking Civitai again.
  fs.writeFileSync(path.join(loraDir, "older.safetensors"), Buffer.from("older weights"));
  const sidecar = JSON.parse(fs.readFileSync(path.join(loraDir, "pictured.civitai.json"), "utf8"));
  fs.writeFileSync(path.join(loraDir, "older.civitai.json"), JSON.stringify(sidecar));
  const asked = [];
  await startLoraScan(["older.safetensors", "pictured.safetensors"], { env: {}, transport: civitaiAnswers(sha, asked) });
  assert.equal(loraScanState().total, 1, "pictured has its picture already");
  assert.ok(fs.existsSync(path.join(loraDir, "older.preview.jpeg")));
  assert.deepEqual(asked.filter((item) => item.startsWith("/api/")), [], "only the picture was fetched");
});

test("a .civitai.json saved before videos were kept is read again from Civitai, keeping its name", async () => {
  fs.writeFileSync(path.join(loraDir, "wanclip.safetensors"), Buffer.from("wan weights"));
  fs.writeFileSync(path.join(loraDir, "wanclip.civitai.json"), JSON.stringify({ versionId: 22, modelId: 2, name: "Neon Nights", version: "v1", baseModel: "Flux.2 D", details: { trainedWords: [], images: [] }, mature: false }));
  const asked = [];
  const info = await loraCivitaiInfo("wanclip.safetensors", { env: {}, transport: civitaiAnswers("", asked) });
  assert.ok(asked.includes("/api/v1/model-versions/22"), "its details were asked for again");
  assert.ok(!asked.some((item) => item.includes("by-hash")), "but not which LoRA it is");
  assert.equal(info.details.images.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(loraDir, "wanclip.civitai.json"), "utf8")).detailsVersion, 2);
});
