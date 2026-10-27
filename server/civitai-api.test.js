import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The requests below go to a stand-in, never through a proxy someone has set.
for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete process.env[key];
delete process.env.CIVITAI_TOKEN;
delete process.env.HEISS_CIVITAI_NSFW;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-civitai-"));
process.env.HEISS_COMFY_ROOT = path.join(scratch, "ComfyUI");
fs.mkdirSync(path.join(scratch, "ComfyUI", "models", "loras"), { recursive: true });

const civitai = await import("./civitai-api.js");
const { downloadState, startDownload } = await import("./model-downloads.js");

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

/*
 * Answers shaped like Civitai's /api/v1/models and /api/v1/model-versions, after the
 * field list in its API reference (developer.civitai.com). Not recorded: Civitai
 * can't be reached from where these were written, so the first real run checks them.
 */
const file = (id, name, extra = {}) => ({
  id, name, sizeKB: 1, type: "Model", primary: true, metadata: { format: "SafeTensor" },
  hashes: { SHA256: sha(name).toUpperCase() }, downloadUrl: `https://civitai.com/api/download/models/${id}`, ...extra
});
const model = (id, name, versions, extra = {}) => ({ id, name, type: "LORA", nsfw: false, creator: { username: `maker${id}` }, stats: { downloadCount: id * 10 }, modelVersions: versions, ...extra });
const version = (id, baseModel, files, extra = {}) => ({
  id, name: `v${id}`, baseModel, trainedWords: ["glowing"], files,
  images: [{ url: `https://image.civitai.com/key/uuid-${id}/width=1024/${id}.jpeg`, nsfwLevel: 1, type: "image" }], ...extra
});

function fakeCivitai(pages) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url: new URL(url), authorization: new Headers(options.headers).get("authorization") || "" });
    const answer = pages[calls.length - 1] ?? pages.at(-1);
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, transport };
}

test("each HEISS family asks for its own base models; a workflow is placed by its model file", () => {
  assert.deepEqual(civitai.basesFor("flux2_klein_9b"), ["Flux.2 Klein 9B", "Flux.2 Klein 9B-base"]);
  assert.ok(civitai.basesFor("sdxl").includes("Pony"));
  // Real Dream's workflow family ("flux2-edit") is HEISS's own name; its model file says Klein 9B.
  assert.deepEqual(civitai.basesFor("flux2-edit", "real-dream-klein9b-1-fp8.safetensors"), civitai.basesFor("flux2_klein_9b"));
  assert.deepEqual(civitai.basesFor("sana"), [], "no Civitai category: nothing rather than the wrong LoRAs");
});

test("file names: no folders, no odd characters, .safetensors only", () => {
  assert.equal(civitai.safeFileName("../../evil.safetensors"), "evil.safetensors");
  assert.equal(civitai.safeFileName("Détail <xl>.safetensors"), "D_tail _xl_.safetensors");
  assert.equal(civitai.safeFileName("pickle.pt"), "");
  assert.equal(civitai.safeFileName(".safetensors"), "");
});

test("search: LoRA types for the family's bases, SFW on civitai.com, one row per usable model", async () => {
  const { calls, transport } = fakeCivitai([{
    items: [
      model(1, "Glow", [version(11, "SDXL 1.0", [file(111, "glow.safetensors")])]),
      // The newest version is for another base; the one that fits is taken.
      model(2, "Ink", [version(21, "Flux.1 D", [file(211, "ink-flux.safetensors")]), version(22, "Illustrious", [file(221, "ink.safetensors")])]),
      // Nothing usable: a pickle, and a file Civitai gives no SHA-256 for.
      model(3, "Old", [version(31, "SDXL 1.0", [file(311, "old.pt"), file(312, "nohash.safetensors", { hashes: {} })])])
    ],
    metadata: { nextCursor: "next-page" }
  }]);
  const result = await civitai.searchLoras({ family: "sdxl" }, { transport, env: {} });
  const url = calls[0].url;
  assert.equal(url.origin, "https://civitai.com");
  assert.equal(url.pathname, "/api/v1/models");
  assert.deepEqual(url.searchParams.getAll("types"), ["LORA", "LoCon", "DoRA"]);
  assert.ok(url.searchParams.getAll("baseModels").includes("SDXL 1.0"));
  assert.equal(url.searchParams.get("nsfw"), "false");
  assert.equal(url.searchParams.get("sort"), "Most Downloaded");
  assert.equal(calls[0].authorization, "", "no key set, none sent");

  assert.deepEqual(result.rows.map((row) => [row.name, row.baseModel, row.file, row.id]), [
    ["Glow", "SDXL 1.0", "glow.safetensors", "civitai:11:111"],
    ["Ink", "Illustrious", "ink.safetensors", "civitai:22:221"]
  ]);
  assert.equal(result.rows[0].preview, "https://image.civitai.com/key/uuid-11/width=160/11.jpeg");
  assert.equal(result.rows[0].creator, "maker1");
  assert.equal(result.nextCursor, "next-page");
});

test("search: words go to Civitai as the query; a page with nothing usable reads on", async () => {
  const { calls, transport } = fakeCivitai([
    { items: [model(4, "Pickle", [version(41, "SDXL 1.0", [file(411, "p.pt")])])], metadata: { nextCursor: "c2" } },
    { items: [model(5, "Neon", [version(51, "SDXL 1.0", [file(511, "neon.safetensors")])])], metadata: {} }
  ]);
  const result = await civitai.searchLoras({ family: "sdxl", query: "  neon  " }, { transport, env: {} });
  assert.equal(calls[0].url.searchParams.get("query"), "neon");
  assert.equal(calls[0].url.searchParams.get("sort"), null, "Civitai ranks a search itself");
  assert.equal(calls[1].url.searchParams.get("cursor"), "c2");
  assert.deepEqual(result.rows.map((row) => row.name), ["Neon"]);
  assert.equal(result.nextCursor, "");
});

test("mature content on: civitai.red, nsfw=true, and mature previews shown; off: they're left out", async () => {
  const items = [model(6, "Spicy", [version(61, "Pony", [file(611, "spicy.safetensors")], { images: [{ url: "https://image.civitai.com/k/u/width=450/x.jpeg", nsfwLevel: 8, type: "image" }] })], { nsfw: true })];
  const on = fakeCivitai([{ items, metadata: {} }]);
  const shown = await civitai.searchLoras({ family: "sdxl" }, { transport: on.transport, env: { HEISS_CIVITAI_NSFW: "1" } });
  assert.equal(on.calls[0].url.origin, "https://civitai.red");
  assert.equal(on.calls[0].url.searchParams.get("nsfw"), "true");
  assert.match(shown.rows[0].preview, /width=160/);

  const off = fakeCivitai([{ items, metadata: {} }]);
  const hidden = await civitai.searchLoras({ family: "sdxl" }, { transport: off.transport, env: {} });
  assert.equal(hidden.rows[0].preview, "", "a mature preview isn't shown with the switch off");
});

test("a family Civitai has no category for doesn't ask Civitai at all", async () => {
  const { calls, transport } = fakeCivitai([{ items: [], metadata: {} }]);
  const result = await civitai.searchLoras({ family: "sana" }, { transport, env: {} });
  assert.equal(result.unsupported, true);
  assert.equal(calls.length, 0);
});

test("Civitai's hosts: both sites, with or without www, never a look-alike; previews from either site's images", async () => {
  for (const host of ["civitai.com", "www.civitai.com", "civitai.red", "WWW.CIVITAI.RED."]) assert.equal(civitai.isCivitaiHost(host), true, host);
  for (const host of ["civitai.com.evil.net", "evilcivitai.com", "civitai.work", "image.civitai.com"]) assert.equal(civitai.isCivitaiHost(host), false, host);
  const { transport } = fakeCivitai([{ items: [model(7, "Red", [version(71, "Pony", [file(711, "red.safetensors")], { images: [{ url: "https://image.civitai.red/k/u/width=450/r.jpeg", nsfwLevel: 1, type: "image" }] })])], metadata: {} }]);
  const result = await civitai.searchLoras({ family: "sdxl" }, { transport, env: {} });
  assert.equal(result.rows[0].preview, "https://image.civitai.red/k/u/width=160/r.jpeg");
});

test("the key goes to Civitai only, never to the storage a download redirects to", async () => {
  const seen = [];
  const transport = async (url, options) => {
    seen.push([url.hostname, new Headers(options.headers).get("authorization") || ""]);
    if (url.hostname === "civitai.com") return new Response(null, { status: 307, headers: { location: "https://storage.example.net/file?sig=1" } });
    return new Response("weights", { status: 200 });
  };
  const response = await civitai.civitaiFetch("https://civitai.com/api/download/models/1", {}, { transport, env: { CIVITAI_TOKEN: "abcdefghijklmnop1234" } });
  assert.equal(await response.text(), "weights");
  assert.deepEqual(seen, [["civitai.com", "Bearer abcdefghijklmnop1234"], ["storage.example.net", ""]]);
});

test("a download is read again from Civitai: its own address (on the active site), name and SHA-256", async () => {
  const answer = { id: 22, model: { name: "Ink" }, files: [file(221, "ink.safetensors"), file(222, "ink-extra.pt", { primary: false })] };
  const { calls, transport } = fakeCivitai([answer]);
  const spec = await civitai.civitaiDownload("civitai:22:221", { transport, env: { HEISS_CIVITAI_NSFW: "1" } });
  assert.equal(calls[0].url.href, "https://civitai.red/api/v1/model-versions/22");
  assert.deepEqual(spec, {
    id: "civitai:22:221", file: "ink.safetensors", folder: "loras", label: "Ink",
    url: "https://civitai.red/api/download/models/221", bytes: 1024, sha256: sha("ink.safetensors"), source: "Civitai"
  });
  assert.equal(await civitai.civitaiDownload("civitai:22:222", { transport, env: {} }), null, "a .pt is never taken");
  assert.equal(await civitai.civitaiDownload("civitai:22:999", { transport, env: {} }), null, "a file the version doesn't have");
  assert.equal(await civitai.civitaiDownload("civitai:../x:1", { transport, env: {} }), null);
});

test("details: the version and its pictures with prompts, asked for together; mature ones only with the switch", async () => {
  const seen = [];
  const transport = async (url) => {
    seen.push(url);
    const body = url.pathname === "/api/v1/images"
      ? { items: [
        { url: "https://image.civitai.com/k/a/original=true/a.jpeg", type: "image", nsfwLevel: 1, width: 832, height: 1216, meta: { prompt: "a lighthouse at dusk", negativePrompt: "blurry", seed: 413271325284305, steps: 28, cfgScale: 3.5, sampler: "Euler", extra: { nested: true } } },
        { url: "https://image.civitai.com/k/b/original=true/b.jpeg", type: "image", nsfwLevel: 8, meta: { prompt: "mature" } },
        { url: "https://image.civitai.com/k/c/original=true/c.mp4", type: "video", nsfwLevel: 1 },
        { url: "https://elsewhere.example/d.jpeg", type: "image", nsfwLevel: 1 }
      ] }
      : { id: 22, modelId: 2, name: "v1.0", baseModel: "Flux.2 D", model: { name: "Ink" }, trainedWords: ["L3N0V0", " "], settings: { strength: 0.9, minStrength: 0.6, maxStrength: 1.2 } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const details = await civitai.loraDetails("22", { transport, env: {} });
  assert.deepEqual(seen.map((url) => url.pathname).sort(), ["/api/v1/images", "/api/v1/model-versions/22"]);
  const images = seen.find((url) => url.pathname === "/api/v1/images").searchParams;
  assert.deepEqual([images.get("modelVersionId"), images.get("withMeta"), images.get("nsfw")], ["22", "true", "false"]);
  assert.deepEqual(details.trainedWords, ["L3N0V0"]);
  assert.deepEqual(details.strength, { value: 0.9, min: 0.6, max: 1.2 });
  assert.equal(details.images.length, 1, "no mature picture, no video, nothing from another host");
  assert.equal(details.images[0].url, "https://image.civitai.com/k/a/width=640/a.jpeg");
  assert.deepEqual(details.images[0].made, { prompt: "a lighthouse at dusk", negativePrompt: "blurry", seed: 413271325284305, steps: 28, cfgScale: 3.5, sampler: "Euler", clipSkip: null });
  assert.equal(details.page, "https://civitai.com/models/2?modelVersionId=22");
  assert.equal(await civitai.loraDetails("not-a-number", { transport, env: {} }), null);
});

test("details: no usage tips when Civitai sends none; the version's own previews when the pictures call fails", async () => {
  const transport = async (url) => (url.pathname === "/api/v1/images"
    ? new Response("{}", { status: 500 })
    : new Response(JSON.stringify({ id: 9, modelId: 1, model: { name: "Plain" }, trainedWords: [], images: [{ url: "https://image.civitai.com/k/p/width=450/p.jpeg", type: "image", nsfwLevel: 1 }] }), { status: 200 }));
  const details = await civitai.loraDetails(9, { transport, env: {} });
  assert.equal(details.strength, null);
  assert.deepEqual(details.images, [{ url: "https://image.civitai.com/k/p/width=640/p.jpeg", width: null, height: null, made: null }]);
  assert.equal(civitai.strengthOf({ strength: 0.8 }).value, 0.8);
  assert.equal(civitai.strengthOf({ settings: { strength: "abc" } }), null);
});

test("a JSON object where words belong is no trigger word and no prompt; anything not text neither", async () => {
  const recipe = '{ "task": "head_swap", "base_image": { "source": "Image 1", "preserve": ["lighting"] } }';
  assert.equal(civitai.plainText(recipe), "");
  assert.equal(civitai.plainText('{ "task": "head_swap", "base_image": { "sou'), "", "cut short, still not words");
  assert.equal(civitai.plainText("[1, 2]"), "");
  assert.equal(civitai.plainText({ task: "x" }), "");
  assert.equal(civitai.plainText(42), "");
  assert.equal(civitai.plainText("  L3N0V0 "), "L3N0V0");
  assert.equal(civitai.plainText("[cinematic] photo, film grain"), "[cinematic] photo, film grain", "brackets in ordinary words are fine");

  const transport = async (url) => new Response(JSON.stringify(url.pathname === "/api/v1/images"
    ? { items: [{ url: "https://image.civitai.com/k/a/width=450/a.jpeg", type: "image", nsfwLevel: 1, meta: { prompt: recipe, seed: 7 } }] }
    : { id: 5, modelId: 1, model: { name: "BFS" }, trainedWords: [recipe, "k0r3an", { word: "x" }, "k0r3an"] }), { status: 200 });
  const details = await civitai.loraDetails(5, { transport, env: {} });
  assert.deepEqual(details.trainedWords, ["k0r3an"]);
  assert.equal(details.images[0].made.prompt, "", "the seed stays; the JSON prompt doesn't");
  assert.equal(details.images[0].made.seed, 7);
});

test("Civitai out of reach says so, with the cause, not Node's 'fetch failed'", async () => {
  const transport = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); };
  await assert.rejects(civitai.searchLoras({ family: "sdxl" }, { transport, env: {} }), /couldn’t be reached at civitai\.com \(ENOTFOUND\)/);
});

test("Civitai asking for a key says where to add one", async () => {
  const transport = async () => new Response("{}", { status: 401 });
  await assert.rejects(civitai.searchLoras({ family: "sdxl" }, { transport, env: {} }), /API key.*Settings › Models/);
});

test("the key: saved in .env, shown only by its end, and checked for shape", () => {
  assert.throws(() => civitai.saveCivitaiToken("has spaces in it!"), /doesn’t look like a Civitai API key/);
  const saved = civitai.saveCivitaiToken("0123456789abcdef0123456789abcdef");
  assert.deepEqual([saved.set, saved.source, saved.hint], [true, "settings", "…cdef"]);
  assert.ok(!JSON.stringify(saved).includes("0123456789abcdef0123"), "never the key itself");
  assert.equal(civitai.saveCivitaiToken("").set, false);
  assert.equal(civitai.saveCivitaiMature(true).site, "civitai.red");
  assert.equal(civitai.saveCivitaiMature(false).site, "civitai.com");
});

test("a Civitai file goes through the shared queue: checked by its SHA-256 and put in models/loras", async () => {
  const body = Buffer.from("lora weights");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (new URL(url).hostname === "civitai.com"
    ? new Response(null, { status: 302, headers: { location: "https://storage.example.net/f" } })
    : new Response(body, { status: 200, headers: { "content-length": String(body.length) } }));
  try {
    startDownload({ id: "civitai:1:2", file: "neon.safetensors", folder: "loras", label: "Neon", url: "https://civitai.com/api/download/models/2", bytes: body.length, sha256: sha(body) });
    let done;
    for (let i = 0; i < 200 && !done; i += 1) {
      done = downloadState().recent.find((item) => item.file === "neon.safetensors");
      if (!done) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(done?.status, "done", done?.error);
    assert.equal(fs.readFileSync(path.join(scratch, "ComfyUI", "models", "loras", "neon.safetensors"), "utf8"), "lora weights");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.throws(() => startDownload({ id: "x", file: "a.safetensors", folder: "loras", url: "https://civitai.evil.net/a", sha256: sha("a") }), /Only Hugging Face and Civitai downloads/);
});
