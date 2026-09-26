/**
 * 终端配色方案（xterm 的 ITheme 调色板）。
 *
 * 为什么要单独一个文件：配色就是一堆纯数据，跟界面逻辑混在一起没法维护。
 * 这里提供若干套现成风格（含 MobaXterm / xterm 那种传统 16 色风格），
 * 另外支持用户自定义（设置里改颜色，或者粘贴 Windows Terminal 的配色 JSON）。
 */

export interface TermPalette {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TermScheme {
  key: string;
  name: string;
  /** 深色还是浅色底 —— 只用于列表里的小标签展示 */
  kind: "dark" | "light";
  palette: TermPalette;
}

export const CUSTOM_SCHEME_KEY = "custom";

/** 传统 xterm / MobaXterm 默认的 16 色 */
const XTERM_16 = {
  black: "#000000",
  red: "#cd0000",
  green: "#00cd00",
  yellow: "#cdcd00",
  blue: "#0000ee",
  magenta: "#cd00cd",
  cyan: "#00cdcd",
  white: "#e5e5e5",
  brightBlack: "#7f7f7f",
  brightRed: "#ff0000",
  brightGreen: "#00ff00",
  brightYellow: "#ffff00",
  brightBlue: "#5c5cff",
  brightMagenta: "#ff00ff",
  brightCyan: "#00ffff",
  brightWhite: "#ffffff",
};

/** Windows 控制台（conhost / cmd / PowerShell）的传统 16 色 */
const WIN_16 = {
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
};

/** 经典 Linux 控制台（黑底灰字，颜色最朴素） */
const LINUX_16 = {
  black: "#000000",
  red: "#aa0000",
  green: "#00aa00",
  yellow: "#aa5500",
  blue: "#0000aa",
  magenta: "#aa00aa",
  cyan: "#00aaaa",
  white: "#aaaaaa",
  brightBlack: "#555555",
  brightRed: "#ff5555",
  brightGreen: "#55ff55",
  brightYellow: "#ffff55",
  brightBlue: "#5555ff",
  brightMagenta: "#ff55ff",
  brightCyan: "#55ffff",
  brightWhite: "#ffffff",
};

/** Solarized 的 16 色（深浅两套底共用） */
const SOLARIZED_16 = {
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const UBUNTU_16 = {
  black: "#2e3436",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf",
  brightBlack: "#555753",
  brightRed: "#ef2929",
  brightGreen: "#8ae234",
  brightYellow: "#fce94f",
  brightBlue: "#729fcf",
  brightMagenta: "#ad7fa8",
  brightCyan: "#34e2e2",
  brightWhite: "#eeeeec",
};

export const DEFAULT_PALETTE: TermPalette = {
  background: "#181818",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

export const TERM_SCHEMES: TermScheme[] = [
  {
    key: "vscode-dark",
    name: "VS Code 深色（默认）",
    kind: "dark",
    palette: DEFAULT_PALETTE,
  },
  {
    key: "vscode-light",
    name: "VS Code 浅色",
    kind: "light",
    palette: {
      background: "#ffffff",
      foreground: "#1f1f1f",
      cursor: "#1f1f1f",
      selectionBackground: "#add6ff",
      black: "#000000",
      red: "#cd3131",
      green: "#00bc00",
      yellow: "#949800",
      blue: "#0451a5",
      magenta: "#bc05bc",
      cyan: "#0598bc",
      white: "#555555",
      brightBlack: "#666666",
      brightRed: "#cd3131",
      brightGreen: "#14ce14",
      brightYellow: "#b5ba00",
      brightBlue: "#0451a5",
      brightMagenta: "#bc05bc",
      brightCyan: "#0598bc",
      brightWhite: "#a5a5a5",
    },
  },
  {
    key: "moba-dark",
    name: "MobaXterm 经典（黑底 16 色）",
    kind: "dark",
    palette: {
      ...XTERM_16,
      background: "#000000",
      foreground: "#e5e5e5",
      cursor: "#e5e5e5",
      selectionBackground: "#2b4a6f",
    },
  },
  {
    key: "moba-light",
    name: "MobaXterm 浅色（白底 16 色）",
    kind: "light",
    palette: {
      ...XTERM_16,
      background: "#ffffff",
      foreground: "#000000",
      cursor: "#000000",
      selectionBackground: "#add6ff",
    },
  },
  {
    key: "cmd",
    name: "CMD 经典（黑底银字）",
    kind: "dark",
    palette: {
      ...WIN_16,
      background: "#0c0c0c",
      foreground: "#cccccc",
      cursor: "#cccccc",
      selectionBackground: "#264f78",
    },
  },
  {
    key: "powershell",
    name: "PowerShell 蓝（经典蓝底）",
    kind: "dark",
    palette: {
      ...WIN_16,
      background: "#012456",
      foreground: "#eeedf0",
      cursor: "#ffffff",
      selectionBackground: "#264f78",
      blue: "#3a96dd",
      brightBlue: "#59a8ff",
    },
  },
  {
    key: "linux",
    name: "Linux 控制台（黑底灰字）",
    kind: "dark",
    palette: {
      ...LINUX_16,
      background: "#000000",
      foreground: "#aaaaaa",
      cursor: "#aaaaaa",
      selectionBackground: "#3a3a3a",
    },
  },
  {
    key: "ubuntu",
    name: "Ubuntu 紫",
    kind: "dark",
    palette: {
      ...UBUNTU_16,
      background: "#300a24",
      foreground: "#ffffff",
      cursor: "#ffffff",
      selectionBackground: "#4d2b3f",
    },
  },
  {
    key: "solarized-dark",
    name: "Solarized 深色",
    kind: "dark",
    palette: {
      ...SOLARIZED_16,
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      selectionBackground: "#073642",
    },
  },
  {
    key: "solarized-light",
    name: "Solarized 浅色",
    kind: "light",
    palette: {
      ...SOLARIZED_16,
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#586e75",
      selectionBackground: "#eee8d5",
      white: "#93a1a1",
      brightWhite: "#586e75",
    },
  },
  {
    key: "monokai",
    name: "Monokai",
    kind: "dark",
    palette: {
      background: "#272822",
      foreground: "#f8f8f2",
      cursor: "#f8f8f0",
      selectionBackground: "#49483e",
      black: "#272822",
      red: "#f92672",
      green: "#a6e22e",
      yellow: "#f4bf75",
      blue: "#66d9ef",
      magenta: "#ae81ff",
      cyan: "#a1efe4",
      white: "#f8f8f2",
      brightBlack: "#75715e",
      brightRed: "#f92672",
      brightGreen: "#a6e22e",
      brightYellow: "#f4bf75",
      brightBlue: "#66d9ef",
      brightMagenta: "#ae81ff",
      brightCyan: "#a1efe4",
      brightWhite: "#f9f8f5",
    },
  },
  {
    key: "dracula",
    name: "Dracula",
    kind: "dark",
    palette: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    key: "one-dark",
    name: "One Dark",
    kind: "dark",
    palette: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      selectionBackground: "#3e4451",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  {
    key: "gruvbox-dark",
    name: "Gruvbox 深色",
    kind: "dark",
    palette: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      selectionBackground: "#504945",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
  {
    key: "tango-light",
    name: "Tango 浅色（Linux 默认配色）",
    kind: "light",
    palette: {
      ...UBUNTU_16,
      black: "#000000",
      white: "#555753",
      brightBlack: "#555753",
      brightWhite: "#000000",
      background: "#ffffff",
      foreground: "#000000",
      cursor: "#000000",
      selectionBackground: "#add6ff",
    },
  },
];

/** 把颜色值规整成 #rrggbb；非法值退回 fallback */
export function normalizeColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return ("#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase();
  }
  return fallback;
}

const KEYS: (keyof TermPalette)[] = [
  "background",
  "foreground",
  "cursor",
  "selectionBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

/** 以 base 为底，用 patch 覆盖出一套完整调色板（缺的字段保留 base 的值） */
export function mergePalette(base: TermPalette, patch: unknown): TermPalette {
  const out: TermPalette = { ...base };
  if (!patch || typeof patch !== "object") return out;
  const src = patch as Record<string, unknown>;
  // 兼容 Windows Terminal 的字段名
  const alias: Record<string, string> = {
    cursorColor: "cursor",
    selectionBackground: "selectionBackground",
    cursor: "cursor",
  };
  for (const key of KEYS) {
    const raw =
      src[key] !== undefined
        ? src[key]
        : alias[key] && src[alias[key]] !== undefined
          ? src[alias[key]]
          : undefined;
    if (raw !== undefined) out[key] = normalizeColor(raw, out[key]);
  }
  // Windows Terminal 里写 cursorColor 的情况
  if (src.cursorColor !== undefined) out.cursor = normalizeColor(src.cursorColor, out.cursor);
  return out;
}

export function parsePaletteJson(base: TermPalette, json: string): TermPalette {
  const data = JSON.parse(json) as Record<string, unknown>;
  return mergePalette(base, data);
}

/**
 * 根据设置里的方案名算出真正要用的调色板。
 * 自定义方案解析失败（用户 JSON 写坏了）时退回默认，不让终端变成全黑/全白。
 */
export function resolveTermPalette(schemeKey: string, customJson?: string): TermPalette {
  if (schemeKey === CUSTOM_SCHEME_KEY) {
    const base = DEFAULT_PALETTE;
    if (!customJson || !customJson.trim()) return base;
    try {
      return parsePaletteJson(base, customJson);
    } catch {
      return base;
    }
  }
  const found = TERM_SCHEMES.find((s) => s.key === schemeKey);
  return found ? found.palette : DEFAULT_PALETTE;
}

/** 这套配色是浅底还是深底（状态栏上给个小提示用） */
export function isLightPalette(p: TermPalette): boolean {
  const hex = normalizeColor(p.background, "#000000").slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 140;
}
