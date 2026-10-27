import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-startup-password-"));
process.env.HEISS_DATA_DIR = path.join(temporary, "data");
process.env.COMFY_URL = "http://127.0.0.1:9";
delete process.env.HEISS_STUDIO_PASSWORD;
delete process.env.HEISS_ADMIN_FROM_DEVICES;

const access = await import("./access.js");
const accessFile = path.join(temporary, "data", "access.json");

function fresh() {
  fs.rmSync(path.join(temporary, "data"), { recursive: true, force: true });
  access.reloadAccess();
}

test("a desktop start leaves the password to Settings", async () => {
  fresh();
  assert.deepEqual(await access.ensureStudioPassword({ env: {}, asServer: false }), { source: "" });
  assert.equal(access.studioPasswordSet(), false);
});

test("a server with no way in makes up a password, and keeps only its hash", async () => {
  fresh();
  const result = await access.ensureStudioPassword({ env: {}, asServer: true });
  assert.equal(result.source, "generated");
  assert.ok(result.password.length >= 16);
  assert.equal(await access.checkStudioPassword(result.password), true);
  assert.ok(!fs.readFileSync(accessFile, "utf8").includes(result.password), "never the password itself");
  // The next start finds it set and leaves it alone.
  access.reloadAccess();
  assert.deepEqual(await access.ensureStudioPassword({ env: {}, asServer: true }), { source: "" });
  assert.equal(await access.checkStudioPassword(result.password), true);
});

test("a server that can already sign devices in (a Hidden password standing in) gets nothing new", async () => {
  fresh();
  assert.deepEqual(await access.ensureStudioPassword({ env: {}, asServer: true, canSignIn: true }), { source: "" });
  assert.equal(access.studioPasswordSet(), false);
});

test("HEISS_STUDIO_PASSWORD is the password, on any start, and replaces a different one", async () => {
  fresh();
  await access.setStudioPassword("saved in settings");
  const env = { HEISS_STUDIO_PASSWORD: "from the environment" };
  assert.deepEqual(await access.ensureStudioPassword({ env, asServer: false }), { source: "env" });
  assert.equal(await access.checkStudioPassword("from the environment"), true);
  assert.equal(await access.checkStudioPassword("saved in settings"), false);

  // The same one again changes nothing, so signed-in devices stay signed in.
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, getHeader(name) { return this.headers[name]; } };
  access.startDeviceSession({ socket: { remoteAddress: "192.168.1.40" }, headers: {} }, res);
  assert.equal(access.listDeviceSessions(null).length, 1);
  await access.ensureStudioPassword({ env, asServer: true });
  assert.equal(access.listDeviceSessions(null).length, 1);
});

test("a HEISS_STUDIO_PASSWORD too short to use is reported and not used", async () => {
  fresh();
  const result = await access.ensureStudioPassword({ env: { HEISS_STUDIO_PASSWORD: "short" }, asServer: true });
  assert.equal(result.source, "");
  assert.match(result.error, /8 characters/);
  assert.equal(access.studioPasswordSet(), false);
});

test("HEISS_ADMIN_FROM_DEVICES=1 lets signed-in devices administer, whatever the switch says", () => {
  fresh();
  assert.equal(access.adminFromDevicesForced({}), false);
  assert.equal(access.adminFromDevicesForced({ HEISS_ADMIN_FROM_DEVICES: "1" }), true);
  assert.equal(access.adminFromDevicesForced({ HEISS_ADMIN_FROM_DEVICES: "0" }), false);
  assert.equal(access.devicesMayAdmin(), false);
  process.env.HEISS_ADMIN_FROM_DEVICES = "1";
  try {
    assert.equal(access.devicesMayAdmin(), true);
    assert.equal(access.setDevicesMayAdmin(false), true, "the switch can't turn it off while the variable is set");
  } finally {
    delete process.env.HEISS_ADMIN_FROM_DEVICES;
  }
  assert.equal(access.devicesMayAdmin(), false);
});
