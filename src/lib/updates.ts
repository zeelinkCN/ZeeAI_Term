import type { Asset } from "./ui-model";

export interface RuntimeInfo { os: string; arch: string }

function architecture(name: string, arch: string): boolean {
  const aliases = arch === "x86_64" ? ["x64", "x86_64", "amd64"]
    : arch === "aarch64" ? ["aarch64", "arm64"] : arch === "x86" ? ["i686", "ia32"] : [];
  return aliases.some((alias) => new RegExp(`(?:^|[-_.])${alias}(?:[-_.]|$)`).test(name));
}

/** The Release API is shared; installers must match the running OS and CPU.
 * A standalone exe is never an installer, and an arbitrary zip is never portable.
 */
export function selectUpdateAssets(assets: Asset[], runtime: RuntimeInfo) {
  const find = (predicate: (name: string) => boolean) =>
    assets.find((asset) => predicate((asset.name ?? "").toLowerCase()));
  if (runtime.os === "macos") {
    const installer = find((name) => name.endsWith(".dmg") && /(?:^|[-_.])universal(?:[-_.]|$)/.test(name))
      ?? find((name) => name.endsWith(".dmg") && architecture(name, runtime.arch));
    return { installer, msi: undefined, portable: undefined };
  }
  if (runtime.os === "windows") {
    const installer = find((name) => name.endsWith("setup.exe") && architecture(name, runtime.arch));
    const msi = find((name) => name.endsWith(".msi") && architecture(name, runtime.arch));
    const portable = find((name) => name.endsWith("portable.zip") && architecture(name, runtime.arch))
      // Releases through 0.1.14 shipped only x64 portable zips without an arch suffix.
      ?? (runtime.arch === "x86_64" ? find((name) => /^zeeai_term-[\d.]+-portable\.zip$/.test(name)) : undefined);
    return { installer, msi, portable };
  }
  return { installer: undefined, msi: undefined, portable: undefined };
}

export function hasUpdateDigest(digest: string | undefined): boolean {
  return /^(?:sha256:)?[a-f0-9]{64}$/i.test((digest ?? "").trim());
}
