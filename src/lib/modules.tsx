// 左侧活动栏的模块列表（图标 + 名字）。
//
// 为什么是 .tsx：`node` 是真正的 JSX 图标；放这里是为了让 App 的模块枚举
// 和图标实现待在一起，新增一个模块只改这一处。

import { IconAndroid, IconCmd, IconGit, IconPowerShell, IconSerial, IconServer, IconTerminal, IconWsl } from "../components/Icons";
import type { ModuleKey } from "./ui-model";

export const MODULES: { key: ModuleKey; label: string; node: JSX.Element }[] = [
  { key: "remote", label: "远程", node: <IconServer size={22} /> },
  { key: "powershell", label: "PowerShell", node: <IconPowerShell size={22} /> },
  { key: "cmd", label: "CMD", node: <IconCmd size={22} /> },
  { key: "wsl", label: "WSL", node: <IconWsl size={22} /> },
  { key: "git", label: "Git", node: <IconGit size={22} /> },
  { key: "serial", label: "串口", node: <IconSerial size={22} /> },
  { key: "adb", label: "ADB", node: <IconAndroid size={22} /> },
];

export const MODULE_LABEL: Record<ModuleKey, string> = {
  remote: "远程",
  powershell: "PowerShell",
  cmd: "CMD",
  wsl: "WSL",
  git: "Git",
  serial: "串口",
  adb: "ADB",
};

export function moduleIcon(kind: ModuleKey, size = 14): JSX.Element {
  switch (kind) {
    case "remote":
      return <IconServer size={size} />;
    case "cmd":
      return <IconCmd size={size} />;
    case "wsl":
      return <IconWsl size={size} />;
    case "git":
      return <IconGit size={size} />;
    case "serial":
      return <IconSerial size={size} />;
    case "adb":
      return <IconAndroid size={size} />;
    default:
      return <IconTerminal size={size} />;
  }
}




