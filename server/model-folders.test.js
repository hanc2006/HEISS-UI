import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A ComfyUI of our own, a home with a shared models folder in it, and ComfyUI's API answered by hand.
// .native, like HEISS: Windows temp paths can be 8.3 short names (RUNNER~1).
const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "heiss-model-folders-")));
const comfyRoot = path.join(scratch, "ComfyUI");
const home = path.join(scratch, "home");
const shared = path.join(home, "AI", "ComfyUI-Shared", "models");
const mk = (...parts) => { const dir = path.join(...parts); fs.mkdirSync(dir, { recursive: true }); return dir; };
const touch = (file) => { mk(path.dirname(file)); fs.writeFileSync(file, "x".repeat(10)); };
for (const kind of ["checkpoints", "loras", "diffusion_models", "vae", "text_encoders"]) mk(comfyRoot, "models", kind);
mk(comfyRoot, "custom_nodes");
fs.writeFileSync(path.join(comfyRoot, "main.py"), "");
touch(path.join(shared, "diffusion_models", "krea2-finetune.safetensors"));
touch(path.join(shared, "unet", "old", "flux.gguf"));
touch(path.join(shared, "loras", "style.safetensors"));
mk(shared, "vae");
// Stability Matrix names its folders its own way.
touch(path.join(home, "StabilityMatrix", "Models", "StableDiffusion", "sdxl.safetensors"));
touch(path.join(home, "StabilityMatrix", "Models", "Lora", "detail.safetensors"));
// Not a models folder: one matching name is not enough.
touch(path.join(home, "Downloads", "loras", "stray.safetensors"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let folderPaths = {};
const resetFolderPaths = () => {
  folderPaths = Object.fromEntries(["checkpoints", "loras", "diffusion_models", "vae", "text_encoders", "controlnet", "upscale_models", "embeddings"]
    .map((kind) => [kind, [[path.join(comfyRoot, "models", kind)], [".safetensors"]]]));
  folderPaths.custom_nodes = [[path.join(comfyRoot, "custom_nodes")], []];
};
resetFolderPaths();
globalThis.fetch = async (url) => {
  const pathname = new URL(url).pathname;
  const body = pathname === "/internal/folder_paths" ? folderPaths : pathname === "/system_stats" ? { system: { argv: ["main.py", "--listen", "127.0.0.1"] } } : null;
  return new Response(JSON.stringify(body), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
};

const { canPickFolder, heissSections, linkModelFolders, modelFolderReport, readLayout, sectionDirs, sectionFor, tildePath, unlinkModelFolder } = await import("./model-folders.js");
const scan = { home, drives: false };
const config = path.join(comfyRoot, "extra_model_paths.yaml");

test("a models folder is told by its shape, in ComfyUI's names or another app's", () => {
  const kinds = ["checkpoints", "loras", "diffusion_models", "vae", "text_encoders"];
  assert.equal(readLayout(shared, kinds).layout, "comfy");
  assert.deepEqual(readLayout(shared, kinds).map.find((item) => item.name === "unet"), { name: "unet", kind: "diffusion_models" });
  assert.equal(readLayout(path.join(home, "StabilityMatrix", "Models"), kinds).layout, "stability");
  assert.equal(readLayout(path.join(home, "Downloads"), kinds), null);
});

test("the report lists folders with models ComfyUI does not read, and only those", async () => {
  const report = await modelFolderReport({ scan });
  assert.equal(report.configPath, config);
  assert.deepEqual(report.folders.map((folder) => [folder.name, folder.count]).sort(), [["ComfyUI-Shared", 3], ["Stability Matrix", 2]]);
  const sharedFolder = report.folders.find((folder) => folder.name === "ComfyUI-Shared");
  assert.deepEqual(sharedFolder.kinds.map((item) => item.kind).sort(), ["diffusion_models", "diffusion_models", "loras"], "empty vae folder left out");
});

test("adding writes a marked, backed-up section ComfyUI can read, and removing takes exactly that out", async () => {
  fs.writeFileSync(config, "# mine\nother:\n    base_path: /elsewhere\n    loras: loras");
  await modelFolderReport({ scan });
  const result = await linkModelFolders([shared], { scan });
  assert.deepEqual(result.added, [shared]);
  assert.equal(fs.readFileSync(`${config}.heiss-backup`, "utf8").startsWith("# mine"), true);
  const text = fs.readFileSync(config, "utf8");
  assert.match(text, /^other:\n    base_path: \/elsewhere\n    loras: loras\n\n# >>> Added by HEISS UI: /m, "the person's own section stays as it was");
  assert.match(text, /    diffusion_models: \|\n        diffusion_models\n        unet\n/);
  assert.equal(heissSections(text).length, 1);

  // Once ComfyUI reads it, the folder is no longer reported, and shows as read.
  folderPaths.diffusion_models[0].push(path.join(shared, "diffusion_models"), path.join(shared, "unet"));
  folderPaths.loras[0].push(path.join(shared, "loras"));
  const after = await modelFolderReport({ scan });
  assert.equal(after.folders.some((folder) => folder.path === shared), false);
  assert.deepEqual(after.linked, [{ path: shared, label: shared, read: true }]);

  await unlinkModelFolder(shared);
  assert.equal(fs.readFileSync(config, "utf8").trim(), "# mine\nother:\n    base_path: /elsewhere\n    loras: loras");
  resetFolderPaths();
});

test("a section counts as read only once ComfyUI reads every folder it adds", async () => {
  // ComfyUI's own models folder: checkpoints is read from the start, the added unet folder is not.
  const models = path.join(comfyRoot, "models");
  const text = sectionFor(models, [{ kind: "diffusion_models", name: "unet" }, { kind: "loras", name: "a" }, { kind: "loras", name: "b's" }]);
  assert.deepEqual(sectionDirs(heissSections(text)[0]), ["unet", "a", "b's"].map((name) => path.resolve(models, name)));
  fs.writeFileSync(config, text);
  const before = await modelFolderReport({ scan });
  assert.equal(before.linked[0].read, false, "checkpoints being read says nothing about unet");
  folderPaths.diffusion_models[0].push(path.join(models, "unet"));
  folderPaths.loras[0].push(path.join(models, "a"), path.join(models, "b's"));
  const after = await modelFolderReport({ scan });
  assert.equal(after.linked[0].read, true);
  fs.rmSync(config, { force: true });
  resetFolderPaths();
});

test("only folders the scan found, or a picked models folder, can be added", async () => {
  await modelFolderReport({ scan });
  await assert.rejects(() => linkModelFolders(["/etc"], { scan }), /Nothing to add/);
  await assert.rejects(() => linkModelFolders([], { picked: path.join(home, "Downloads"), scan }), /doesn’t look like a models folder/);
  fs.rmSync(config, { force: true });
  const picked = await linkModelFolders([], { picked: path.join(home, "StabilityMatrix", "Models"), scan });
  assert.equal(picked.added.length, 1);
  assert.match(fs.readFileSync(config, "utf8"), /checkpoints: 'StableDiffusion'/);
  await unlinkModelFolder(picked.added[0]);
  assert.equal(fs.existsSync(config), false, "a file HEISS made and emptied goes away");
});

test("a section's quoting survives odd folder names", () => {
  const text = sectionFor("/Users/o'neil/models", [{ kind: "loras", name: "my loras" }]);
  assert.match(text, /base_path: '\/Users\/o''neil\/models'/);
  assert.match(text, /loras: 'my loras'/);
});

test("sections survive a CRLF save, and adding and removing keep CRLF", async () => {
  const crlf = sectionFor("D:\\AI\\models", [{ kind: "loras", name: "loras" }, { kind: "vae", name: "vae" }]).replace(/\n/g, "\r\n");
  assert.deepEqual(heissSections(`# mine\r\n\r\n${crlf}`).map((section) => section.path), ["D:\\AI\\models"]);

  fs.writeFileSync(config, "# mine\r\nother:\r\n    base_path: /elsewhere\r\n    loras: loras\r\n");
  await modelFolderReport({ scan });
  await linkModelFolders([shared], { scan });
  const text = fs.readFileSync(config, "utf8");
  assert.equal(heissSections(text).length, 1);
  assert.doesNotMatch(text, /[^\r]\n/, "every line ends in CRLF");
  await unlinkModelFolder(shared);
  assert.equal(fs.readFileSync(config, "utf8"), "# mine\r\nother:\r\n    base_path: /elsewhere\r\n    loras: loras\r\n");
  fs.rmSync(config, { force: true });
});

test("Windows paths are shown in full, not with ~", () => {
  assert.equal(tildePath("C:\\Users\\me\\AI", "C:\\Users\\me", "win32"), "C:\\Users\\me\\AI");
  assert.equal(tildePath("/Users/me/AI", "/Users/me", "darwin"), "~/AI");
});

test("a ComfyUI on another computer: the report says what it reads, from its own API", async () => {
  const saved = globalThis.fetch;
  // A RunPod-style ComfyUI: Linux paths that don't exist here, models listed per kind.
  const remotePaths = {
    diffusion_models: [["/workspace/models/diffusion_models", "/workspace/models/unet"], [".safetensors"]],
    loras: [["/workspace/models/loras"], [".safetensors"]],
    vae: [["/workspace/models/vae"], [".safetensors"]],
    unet_gguf: [["/workspace/models/unet"], [".gguf"]],
    controlnet: [["/workspace/models/controlnet"], [".safetensors"]],
    custom_nodes: [["/workspace/ComfyUI/custom_nodes"], []]
  };
  const remoteFiles = {
    diffusion_models: ["z_image_turbo_bf16.safetensors", "h3/minimax_h3.safetensors"],
    unet_gguf: ["h3/minimax_h3.safetensors", "flux.gguf"],
    loras: ["a.safetensors", "b.safetensors", "c.safetensors", "d.safetensors"],
    vae: ["ae.safetensors"],
    controlnet: []
  };
  globalThis.fetch = async (url) => {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const kind = pathname.startsWith("/models/") ? pathname.slice("/models/".length) : null;
    const body = pathname === "/internal/folder_paths" ? remotePaths
      : pathname === "/system_stats" ? { system: { argv: ["main.py", "--listen", "0.0.0.0"] } }
      : kind ? remoteFiles[kind] ?? null : null;
    return new Response(JSON.stringify(body), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
  };
  try {
    const report = await modelFolderReport({ local: false });
    assert.equal(report.local, false);
    assert.deepEqual(report.folders, []);
    // unet_gguf folds into diffusion_models, and a file listed under both counts once.
    assert.deepEqual(report.remote.kinds.map(({ kind, count }) => [kind, count]), [["loras", 4], ["diffusion_models", 3], ["vae", 1]]);
    assert.equal(report.remote.count, 8);
    assert.deepEqual(report.remote.kinds.find((item) => item.kind === "diffusion_models").examples, ["z_image_turbo_bf16.safetensors", "minimax_h3.safetensors", "flux.gguf"]);
    // The remote folders are shown as ComfyUI wrote them, not resolved on this computer.
    assert.deepEqual(report.remote.dirs, ["/workspace/models"]);
  } finally {
    globalThis.fetch = saved;
  }
});

test("a server's models are found where they usually live: next to ComfyUI, and in folders named in HEISS_MODEL_SEARCH_PATHS", async () => {
  // A pod: /workspace/ComfyUI, and its models in /workspace/models next to it.
  touch(path.join(scratch, "models", "loras", "pod-style.safetensors"));
  touch(path.join(scratch, "models", "checkpoints", "pod-model.safetensors"));
  // And a volume mounted somewhere else entirely.
  const volume = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "heiss-volume-")));
  touch(path.join(volume, "ai", "models", "loras", "volume-style.safetensors"));
  touch(path.join(volume, "ai", "models", "vae", "volume-vae.safetensors"));
  process.env.HEISS_MODEL_SEARCH_PATHS = volume;
  try {
    const report = await modelFolderReport({ scan });
    const paths = report.folders.map((folder) => folder.path);
    assert.ok(paths.includes(path.join(scratch, "models")), "the folder beside ComfyUI");
    assert.ok(paths.includes(path.join(volume, "ai", "models")), "the folder named in HEISS_MODEL_SEARCH_PATHS");
    assert.equal(report.searchedEverywhere, false);
    assert.equal(typeof report.canPick, "boolean");
  } finally {
    delete process.env.HEISS_MODEL_SEARCH_PATHS;
    fs.rmSync(volume, { recursive: true, force: true });
    fs.rmSync(path.join(scratch, "models"), { recursive: true, force: true });
  }
});

test("a folder picker is offered only where one can open: a desktop, not a headless server", () => {
  assert.equal(canPickFolder({}, "darwin"), true);
  assert.equal(canPickFolder({}, "win32"), true);
  assert.equal(canPickFolder({}, "linux"), false);
  assert.equal(canPickFolder({ DISPLAY: ":0" }, "linux"), true);
});

test("a folder named in HEISS_MODEL_SEARCH_PATHS can be the models folder itself", async () => {
  const volume = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "heiss-direct-")));
  touch(path.join(volume, "loras", "direct.safetensors"));
  touch(path.join(volume, "checkpoints", "direct-model.safetensors"));
  process.env.HEISS_MODEL_SEARCH_PATHS = `${volume}${path.sep}`;
  try {
    const report = await modelFolderReport({ scan });
    const found = report.folders.find((folder) => folder.path === volume);
    assert.ok(found, "the folder itself, trailing separator and all");
    assert.equal(found.count, 2);
  } finally {
    delete process.env.HEISS_MODEL_SEARCH_PATHS;
    fs.rmSync(volume, { recursive: true, force: true });
  }
});
