import fs from "node:fs";
import path from "node:path";

/**
 * Opening the studio on other devices (LAN mode). On by default: the server
 * listens on 0.0.0.0, and other devices still sign in with the studio
 * password (access.js). Three ways to decide otherwise, strongest first:
 * - `--lan` on the command line (npm start -- --lan, npm run dev -- --lan): on for that run.
 * - HOST from the shell: whatever it says.
 * - The Settings switch, saved as HEISS_LAN in .env (HEISS_LAN=0 keeps it on
 *   this computer), or a HOST line in .env (HOST=127.0.0.1 counts as off).
 *
 * No side effects, so the dev launcher can ask before anything else has read .env.
 */
export function resolveLan({ argv = [], env = {}, fileKeys = new Set() } = {}) {
  const wildcard = (value) => value === "0.0.0.0" || value === "::";
  const flag = argv.includes("--lan");
  const shellHost = env.HOST && !fileKeys.has("HOST") ? env.HOST : "";
  const fileHost = fileKeys.has("HOST") ? env.HOST || "" : "";
  const saved = env.HEISS_LAN === "1" || (env.HEISS_LAN !== "0" && (!fileHost || wildcard(fileHost)));
  if (flag) return { host: "0.0.0.0", source: "flag", saved };
  if (shellHost) return { host: shellHost, source: "shell", saved };
  if (saved) return { host: "0.0.0.0", source: "setting", saved };
  return { host: fileHost && !wildcard(fileHost) ? fileHost : "127.0.0.1", source: "setting", saved };
}

/** Whether a server on this host answers other devices, not only this computer. */
export function listensBeyondThisComputer(host = "") {
  return !["127.0.0.1", "localhost", "::1", ""].includes(host);
}

/** .env as it is on disk right now: values, and which keys it sets. */
export function readEnvFile(root) {
  const values = {};
  try {
    for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !(match[1] in values)) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch {
    // .env is optional.
  }
  return { values, keys: new Set(Object.keys(values)) };
}
