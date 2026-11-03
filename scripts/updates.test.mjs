import test from "node:test";
import assert from "node:assert/strict";
import { selectUpdateAssets, hasUpdateDigest } from "../src/lib/updates.ts";

const asset = (name) => ({ name, browser_download_url: `https://example.invalid/${name}` });
const assets = [
  "ZeeAI_Term.exe", "ZeeAI_Term_1.0.0_arm64-setup.exe", "ZeeAI_Term_1.0.0_x64-setup.exe",
  "ZeeAI_Term_1.0.0_x64_en-US.msi", "ZeeAI_Term-1.0.0-portable.zip",
  "ZeeAI_Term_1.0.0_x64.dmg", "ZeeAI_Term_1.0.0_aarch64.dmg", "sources.zip",
].map(asset);

test("one Release offers different installers to Windows and Apple Silicon", () => {
  const win = selectUpdateAssets(assets, { os: "windows", arch: "x86_64" });
  const mac = selectUpdateAssets(assets, { os: "macos", arch: "aarch64" });
  assert.equal(win.installer.name, "ZeeAI_Term_1.0.0_x64-setup.exe");
  assert.equal(win.msi.name, "ZeeAI_Term_1.0.0_x64_en-US.msi");
  assert.equal(win.portable.name, "ZeeAI_Term-1.0.0-portable.zip");
  assert.equal(mac.installer.name, "ZeeAI_Term_1.0.0_aarch64.dmg");
  assert.equal(mac.msi, undefined);
  assert.equal(mac.portable, undefined);
});

test("Mac prefers Universal, otherwise Intel receives the Intel package", () => {
  const intel = { os: "macos", arch: "x86_64" };
  assert.equal(selectUpdateAssets(assets, intel).installer.name, "ZeeAI_Term_1.0.0_x64.dmg");
  const universal = asset("ZeeAI_Term_1.0.0_universal.dmg");
  assert.equal(selectUpdateAssets([...assets, universal], intel).installer, universal);
  assert.equal(selectUpdateAssets([...assets, universal], { os: "macos", arch: "aarch64" }).installer, universal);
});

test("never falls back to another OS, another CPU, standalone exe or source zip", () => {
  const arm = selectUpdateAssets(assets, { os: "windows", arch: "aarch64" });
  assert.equal(arm.installer.name, "ZeeAI_Term_1.0.0_arm64-setup.exe");
  assert.equal(arm.portable, undefined);
  const missingMac = selectUpdateAssets(assets.filter((a) => !a.name.endsWith(".dmg")), { os: "macos", arch: "aarch64" });
  assert.equal(missingMac.installer, undefined);
  const missingWin = selectUpdateAssets([asset("ZeeAI_Term.exe"), asset("sources.zip")], { os: "windows", arch: "x86_64" });
  assert.equal(missingWin.installer, undefined);
  assert.equal(missingWin.portable, undefined);
});

test("one-click install requires a complete SHA-256 digest", () => {
  assert.equal(hasUpdateDigest("sha256:" + "a".repeat(64)), true);
  for (const missing of [undefined, "", "sha256:abcd", "g".repeat(64)]) assert.equal(hasUpdateDigest(missing), false);
});
