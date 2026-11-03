import type { LocalShell } from "../types";

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const IS_WINDOWS = /Win/.test(navigator.platform);
export const SECRET_STORE_LABEL = IS_MAC ? "macOS 钥匙串" : IS_WINDOWS ? "Windows 凭据管理器" : "系统凭据库";
export const DEFAULT_LOCAL_SHELL: LocalShell = IS_WINDOWS ? "powershell" : IS_MAC ? "zsh" : "bash";
export const LOCAL_SHELLS: { key: LocalShell; label: string }[] = IS_WINDOWS
  ? [{ key: "powershell", label: "PowerShell" }, { key: "pwsh", label: "PowerShell 7" },
    { key: "cmd", label: "CMD" }, { key: "wsl", label: "WSL" }]
  : [{ key: "zsh", label: "zsh" }, { key: "bash", label: "bash" }];

export function supportedShell(shell: LocalShell): LocalShell {
  return LOCAL_SHELLS.some((s) => s.key === shell) ? shell : DEFAULT_LOCAL_SHELL;
}

export function isLocalKind(kind: string): kind is Exclude<LocalShell, "pwsh"> {
  return ["powershell", "cmd", "wsl", "zsh", "bash"].includes(kind);
}

export function primaryModifier(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">): boolean {
  return IS_MAC ? event.metaKey : event.ctrlKey;
}
