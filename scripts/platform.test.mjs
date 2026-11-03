import test from "node:test";
import assert from "node:assert/strict";

async function platform(name) {
  Object.defineProperty(globalThis, "navigator", { value: { platform: name }, configurable: true });
  return import(`../src/lib/platform.ts?platform=${name}`);
}

test("macOS recovers imported Windows preferences to a usable shell", async () => {
  const mac = await platform("MacIntel");
  assert.equal(mac.supportedShell("powershell"), "zsh");
  assert.equal(mac.supportedShell("wsl"), "zsh");
  assert.equal(mac.supportedShell("bash"), "bash");
  assert.deepEqual(mac.LOCAL_SHELLS.map((s) => s.key), ["zsh", "bash"]);
  assert.equal(mac.primaryModifier({ ctrlKey: false, metaKey: true }), true);
  assert.equal(mac.primaryModifier({ ctrlKey: true, metaKey: false }), false);
});

test("Windows preserves all existing shells including PowerShell 7", async () => {
  const win = await platform("Win32");
  assert.equal(win.supportedShell("pwsh"), "pwsh");
  assert.equal(win.supportedShell("cmd"), "cmd");
  assert.equal(win.supportedShell("zsh"), "powershell");
  assert.equal(win.primaryModifier({ ctrlKey: true, metaKey: false }), true);
});
