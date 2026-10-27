import path from "node:path";
import { envFileKeys, removeLocalEnvValue, writeLocalEnvValue } from "./env.js";
import { familyFromName } from "./family-catalog.js";
import { guardedFetch } from "./hf-access.js";

/**
 * Civitai: finding LoRAs for the model in use and downloading them.
 * (civitai.js is something else: the A1111 text written into PNGs.)
 *
 * - Two sites since April 2026: civitai.com holds SFW models only, civitai.red
 *   the mature ones, and mature downloads through civitai.com are refused. The
 *   "Show mature content" switch picks the site everything goes to.
 * - An API key (CIVITAI_TOKEN, or saved in Settings › Models) is sent to those
 *   two sites only, never to the storage a download redirects to.
 * - Downloads are .safetensors only, with Civitai's SHA-256, through the same
 *   queue as every other model download (model-downloads.js).
 */

const tokenKey = "CIVITAI_TOKEN";
const nsfwKey = "HEISS_CIVITAI_NSFW";
export const civitaiHosts = new Set(["civitai.com", "civitai.red"]);
const savedHere = new Set();

/** Civitai's base models (BaseModel names on civitai.com) for each HEISS family that has some. */
export const civitaiBaseModels = {
  sd15: ["SD 1.5", "SD 1.4", "SD 1.5 LCM", "SD 1.5 Hyper"],
  sd2: ["SD 2.0", "SD 2.1"],
  sdxl: ["SDXL 1.0", "SDXL Lightning", "SDXL Hyper", "Pony", "Illustrious", "NoobAI"],
  auraflow: ["Pony V7", "AuraFlow"],
  sd3: ["SD 3.5", "SD 3.5 Large", "SD 3.5 Medium"],
  flux1: ["Flux.1 D", "Flux.1 S", "Flux.1 Krea"],
  flux2_dev: ["Flux.2 D"],
  flux2_klein_4b: ["Flux.2 Klein 4B", "Flux.2 Klein 4B-base"],
  flux2_klein_9b: ["Flux.2 Klein 9B", "Flux.2 Klein 9B-base"],
  flux3: ["Flux.3 Klein", "Flux.3 Klein-base"],
  chroma: ["Chroma"],
  hidream: ["HiDream"],
  qwen_image: ["Qwen"],
  qwen_image_21: ["Qwen 2.1"],
  zimage: ["ZImageTurbo", "ZImageBase"],
  krea2: ["Krea 2", "Krea 2 Turbo"],
  anima: ["Anima"],
  lumina2: ["Lumina"],
  ideogram4: ["Ideogram 4.0"],
  mage_flow: ["MageFlow"],
  ernie: ["Ernie"],
  moss_image: ["MOSS Image"],
  wan21: ["Wan Video 14B t2v", "Wan Video 1.3B t2v"],
  wan22_5b: ["Wan Video 2.2 TI2V-5B"],
  wan22_14b: ["Wan Video 2.2 T2V-A14B"],
  wan22_14b_i2v: ["Wan Video 2.2 I2V-A14B"],
  minimax_h3: ["MiniMax H3"]
};

/* ------------------------------------------------------------ Settings */

export function civitaiToken(env = process.env) {
  const value = String(env[tokenKey] || "").trim();
  return { token: value, source: value ? (envFileKeys.has(tokenKey) || savedHere.has(tokenKey) ? "settings" : "environment") : "" };
}

export function civitaiMature(env = process.env) {
  return env[nsfwKey] === "1";
}

/** civitai.red with mature content on, civitai.com otherwise. */
export function civitaiOrigin(env = process.env) {
  return civitaiMature(env) ? "https://civitai.red" : "https://civitai.com";
}

/** What Settings may show: never the key itself. */
export function civitaiStatus(env = process.env) {
  const { token, source } = civitaiToken(env);
  return {
    set: Boolean(token), source, editable: source !== "environment", key: tokenKey,
    ...(token ? { hint: `…${token.slice(-4)}` } : {}),
    mature: civitaiMature(env), site: new URL(civitaiOrigin(env)).hostname
  };
}

/** Saves the key in .env, or clears it with "". One set in the shell can't be changed here. */
export function saveCivitaiToken(value) {
  const token = String(value || "").trim();
  if (civitaiToken().source === "environment") throw new Error(`The key is set by ${tokenKey} in the environment. Change it there.`);
  if (token && !/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error("That doesn’t look like a Civitai API key. Create one on Civitai under Account settings › API Keys.");
  if (token) {
    writeLocalEnvValue(tokenKey, token);
    savedHere.add(tokenKey);
  } else {
    removeLocalEnvValue(tokenKey);
    if (savedHere.delete(tokenKey)) delete process.env[tokenKey];
  }
  return civitaiStatus();
}

export function saveCivitaiMature(enabled) {
  writeLocalEnvValue(nsfwKey, enabled ? "1" : "0");
  return civitaiStatus();
}

/* ------------------------------------------------------------ Fetch */

/** civitai.com or civitai.red, with or without www. Never a look-alike (civitai.com.evil.net). */
export function isCivitaiHost(hostname = "") {
  return civitaiHosts.has(String(hostname).toLowerCase().replace(/\.$/, "").replace(/^www\./, ""));
}

export function isCivitaiUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && isCivitaiHost(url.hostname);
  } catch {
    return false;
  }
}

/** Civitai's own image servers (image.civitai.com, and civitai.red's for mature previews). */
function isCivitaiImage(value) {
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && [...civitaiHosts].some((site) => host === site || host.endsWith(`.${site}`));
  } catch {
    return false;
  }
}

/** fetch with the key on civitai.com / civitai.red only. `transport` replaces the network in tests. */
export function civitaiFetch(input, init = {}, { env = process.env, transport = null } = {}) {
  const { token } = civitaiToken(env);
  return guardedFetch(input, init, { env, transport, service: "Civitai", tokenFor: (url) => (token && isCivitaiHost(url.hostname) ? token : "") });
}

async function civitaiJson(pathAndQuery, { env, transport } = {}) {
  const url = new URL(pathAndQuery, civitaiOrigin(env));
  let response;
  try {
    response = await civitaiFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) }, { env, transport });
  } catch (error) {
    // Node's own wording ("fetch failed") says nothing; the cause usually does (ENOTFOUND, ECONNREFUSED, a timeout).
    const cause = error?.name === "TimeoutError" ? "it took too long to answer" : error?.cause?.code || error?.code || error?.message || "no answer";
    throw new Error(`Civitai couldn’t be reached at ${url.hostname} (${cause}). Check this computer’s internet connection.`);
  }
  if (response.status === 401 || response.status === 403) throw Object.assign(new Error("Civitai asks for an API key for this. Add one in Settings › Models."), { status: response.status });
  if (!response.ok) throw Object.assign(new Error(`Civitai answered HTTP ${response.status}.`), { status: response.status });
  return response.json();
}

/* ------------------------------------------------------------ Search */

/** The base models to ask Civitai for: the profile's family, else the family its model file names. */
export function basesFor(family = "", model = "") {
  return civitaiBaseModels[family] || civitaiBaseModels[familyFromName(String(model || ""))] || [];
}

/** A file name ComfyUI and model-downloads.js take: no folders, no odd characters, .safetensors. */
export function safeFileName(name = "") {
  const base = path.basename(String(name)).replace(/[^\w.()+ -]/g, "_").replace(/^[.\s]+/, "");
  return /\.safetensors$/i.test(base) ? base : "";
}

/** The version's primary .safetensors file that carries a SHA-256, or null. */
function loraFile(version) {
  const files = Array.isArray(version?.files) ? version.files : [];
  const usable = files.filter((file) => safeFileName(file?.name) && /^[0-9a-f]{64}$/i.test(String(file?.hashes?.SHA256 || "")) && isCivitaiUrl(file?.downloadUrl));
  return usable.find((file) => file.primary) || usable[0] || null;
}

function previewOf(version, mature) {
  const images = (Array.isArray(version?.images) ? version.images : []).filter((image) => image?.url && image.type !== "video" && (mature || !(Number(image.nsfwLevel) > 1)));
  const url = String(images[0]?.url || "");
  // Civitai serves any width from the same address; a small one is enough for a row.
  return isCivitaiImage(url) ? url.replace(/\/(?:width=\d+|original=true)\//, "/width=160/") : "";
}

/** One row per model: its newest version made for one of `bases`, with a usable file. */
export function loraRows(items = [], bases = [], { mature = false } = {}) {
  const rows = [];
  for (const item of Array.isArray(items) ? items : []) {
    const version = (item?.modelVersions || []).find((candidate) => bases.includes(candidate?.baseModel) && loraFile(candidate));
    if (!version) continue;
    const file = loraFile(version);
    rows.push({
      modelId: Number(item.id), versionId: Number(version.id), fileId: Number(file.id),
      name: String(item.name || ""), version: String(version.name || ""), creator: String(item.creator?.username || ""),
      baseModel: String(version.baseModel || ""), nsfw: Boolean(item.nsfw),
      file: safeFileName(file.name), bytes: Math.round(Number(file.sizeKB || 0) * 1024),
      trainedWords: (version.trainedWords || []).map(String).filter(Boolean).slice(0, 8),
      downloads: Number(item.stats?.downloadCount || 0), preview: previewOf(version, mature),
      page: `${civitaiOrigin()}/models/${Number(item.id)}?modelVersionId=${Number(version.id)}`,
      id: `civitai:${Number(version.id)}:${Number(file.id)}`
    });
  }
  return rows;
}

/** LoRAs on Civitai for this family, newest version per model; `cursor` continues a page. */
export async function searchLoras({ query = "", family = "", model = "", cursor = "" } = {}, options = {}) {
  const env = options.env || process.env;
  const bases = basesFor(family, model);
  if (!bases.length) return { bases, rows: [], nextCursor: "", unsupported: true };
  const mature = civitaiMature(env);
  const params = new URLSearchParams({ limit: "20", nsfw: String(mature), primaryFileOnly: "true" });
  // LoCon and DoRA are their own types on Civitai, but ComfyUI's LoRA loader takes them all.
  for (const type of ["LORA", "LoCon", "DoRA"]) params.append("types", type);
  for (const base of bases) params.append("baseModels", base);
  const text = String(query || "").trim().slice(0, 100);
  if (text) params.set("query", text);
  else params.set("sort", "Most Downloaded");
  // A page can hold only models with no usable file; read on (a few pages at most) rather than show nothing.
  let next = String(cursor || "");
  for (let page = 0; page < 3; page += 1) {
    if (next) params.set("cursor", next);
    const data = await civitaiJson(`/api/v1/models?${params}`, { env, transport: options.transport });
    const rows = loraRows(data?.items, bases, { mature });
    next = String(data?.metadata?.nextCursor || "");
    if (rows.length || !next) return { bases, rows, nextCursor: next, site: new URL(civitaiOrigin(env)).hostname };
  }
  return { bases, rows: [], nextCursor: next, site: new URL(civitaiOrigin(env)).hostname };
}

/* ------------------------------------------------------------ Download */

/**
 * "civitai:<versionId>:<fileId>" as model-downloads.js takes it. Read again
 * from Civitai, never from the browser: the address, name and SHA-256 come
 * from Civitai's own answer, and the address is on the active site.
 */
export async function civitaiDownload(id = "", options = {}) {
  const match = /^civitai:(\d{1,12}):(\d{1,12})$/.exec(String(id));
  if (!match) return null;
  const env = options.env || process.env;
  const version = await civitaiJson(`/api/v1/model-versions/${match[1]}`, { env, transport: options.transport });
  const file = (version?.files || []).find((item) => String(item?.id) === match[2]);
  const name = safeFileName(file?.name);
  const sha256 = String(file?.hashes?.SHA256 || "").toLowerCase();
  if (!file || !name || !/^[0-9a-f]{64}$/.test(sha256) || !isCivitaiUrl(file.downloadUrl)) return null;
  const url = new URL(file.downloadUrl);
  url.hostname = new URL(civitaiOrigin(env)).hostname;
  return {
    id: `civitai:${match[1]}:${match[2]}`, file: name, folder: "loras",
    label: String(version?.model?.name || name), url: url.href,
    bytes: Math.round(Number(file.sizeKB || 0) * 1024), sha256, source: "Civitai"
  };
}
