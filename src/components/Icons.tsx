interface IconProps {
  size?: number;
  className?: string;
}

/**
 * 产品图标：立体麻将「红中」。
 * 和打包用的 icons/*.png 是同一套几何（48 单位的画布），
 * 说明里说的「立体的麻将红中、字要正、简洁但一看就懂」就指这个。
 */
export const IconLogoTile = ({ size = 18, className }: IconProps) => (
  <svg
    className={"icon" + (className ? " " + className : "")}
    width={size}
    height={size}
    viewBox="0 0 48 48"
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="zeeai-tile-face" x1="0" y1="0" x2="0.7" y2="1">
        <stop offset="0" stopColor="#fffdf7" />
        <stop offset="1" stopColor="#e9e2d1" />
      </linearGradient>
    </defs>
    {/* 厚度（右下偏移 = 立体） */}
    <rect x="5.6" y="6.6" width="37" height="38" rx="6.6" fill="#a69d84" />
    {/* 正面 */}
    <rect
      x="4"
      y="4"
      width="37"
      height="38"
      rx="6.6"
      fill="url(#zeeai-tile-face)"
      stroke="rgba(120,110,92,0.30)"
      strokeWidth="1.1"
    />
    <rect
      x="6.9"
      y="6.9"
      width="31.2"
      height="32.2"
      rx="4.6"
      fill="none"
      stroke="rgba(120,110,90,0.14)"
      strokeWidth="1"
    />
    {/* 红中：先白后红，做出刻出来的立体感 */}
    <text
      x="22.6"
      y="24.2"
      textAnchor="middle"
      dominantBaseline="central"
      fontFamily="'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif"
      fontSize="26.6"
      fontWeight="700"
      fill="#c81a20"
      stroke="rgba(255,255,255,0.92)"
      strokeWidth="1.6"
      paintOrder="stroke"
    >
      中
    </text>
  </svg>
);

function base(paths: React.ReactNode, size: number, className?: string) {
  return (
    <svg
      className={"icon" + (className ? " " + className : "")}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
}

/** 远程服务器：机架（两段带指示灯的机架） */
export const IconServer = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <rect x="2.5" y="3" width="19" height="7.5" rx="1.5" />
      <rect x="2.5" y="13.5" width="19" height="7.5" rx="1.5" />
      <circle cx="6.5" cy="6.75" r="1" />
      <circle cx="6.5" cy="17.25" r="1" />
      <line x1="10.5" y1="6.75" x2="18" y2="6.75" />
      <line x1="10.5" y1="17.25" x2="18" y2="17.25" />
    </>,
    size,
    className,
  );

/**
 * PowerShell：学它原生的样子——深蓝底 + 白色 `>_`。
 * 这里用固定品牌色（不跟随主题），这样和 CMD 一眼就能区分开。
 */
export const IconPowerShell = ({ size = 16, className }: IconProps) => (
  <svg
    className={"icon" + (className ? " " + className : "")}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="zeeai-ps-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#3d7dd8" />
        <stop offset="1" stopColor="#1b3a75" />
      </linearGradient>
    </defs>
    <rect x="1.5" y="2.5" width="21" height="19" rx="3" fill="url(#zeeai-ps-grad)" />
    <path
      d="M6.4 8.2 10.5 12l-4.1 3.8"
      fill="none"
      stroke="#ffffff"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12.4 15.6h5"
      fill="none"
      stroke="#ffffff"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

/**
 * CMD：学它原生的样子——黑色命令提示符窗口 + 白色 `C:\` 提示符 + 光标块。
 * 提示符全部用「描边 + 圆点」画（不依赖字体），保证任何缩放下都居中、不歪。
 * 和 PowerShell 的「蓝底 >_」放在一起一眼就能区分。
 */
export const IconCmd = ({ size = 16, className }: IconProps) => (
  <svg
    className={"icon" + (className ? " " + className : "")}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <rect x="1.5" y="2.5" width="21" height="19" rx="2.8" fill="#0d0d0d" />
    {/* 标题栏 */}
    <path
      d="M1.5 5.3a2.8 2.8 0 0 1 2.8-2.8h15.4a2.8 2.8 0 0 1 2.8 2.8v1.5H1.5z"
      fill="#3a3a3a"
    />
    <rect
      x="1.5"
      y="2.5"
      width="21"
      height="19"
      rx="2.8"
      fill="none"
      stroke="#8c8c8c"
      strokeWidth="1"
    />
    <g stroke="#f2f2f2" strokeWidth="1.65" strokeLinecap="round" fill="none">
      {/* C */}
      <path d="M9.31 12.79A2.5 2.5 0 1 0 9.31 16.01" />
      {/* \ */}
      <path d="M13.6 12.6 15.4 16.4" />
    </g>
    {/* : */}
    <circle cx="11.5" cy="13.1" r="0.68" fill="#f2f2f2" />
    <circle cx="11.5" cy="15.7" r="0.68" fill="#f2f2f2" />
    {/* 光标 */}
    <rect x="16.6" y="14.9" width="3.4" height="1.6" rx="0.3" fill="#f2f2f2" />
  </svg>
);

/**
 * WSL：原来的企鹅只有几根线条，看不清是什么；这里改成色块画的 Tux，
 * 黑白对比 + 橙色嘴和脚，缩到 22px 也能认出来。
 */
export const IconWsl = ({ size = 16, className }: IconProps) => (
  <svg
    className={"icon" + (className ? " " + className : "")}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    {/* 身体 */}
    <ellipse cx="12" cy="13.6" rx="6" ry="7.8" fill="#141414" />
    {/* 肚子 */}
    <ellipse cx="12" cy="14.9" rx="3.9" ry="5.7" fill="#f4f4f4" />
    {/* 头 */}
    <ellipse cx="12" cy="7.3" rx="5" ry="4.5" fill="#141414" />
    {/* 眼睛 */}
    <circle cx="10.1" cy="7" r="1.6" fill="#ffffff" />
    <circle cx="13.9" cy="7" r="1.6" fill="#ffffff" />
    <circle cx="10.3" cy="7.2" r="0.8" fill="#141414" />
    <circle cx="13.7" cy="7.2" r="0.8" fill="#141414" />
    {/* 嘴 */}
    <path d="M10.9 9h2.2l-1.1 2.2z" fill="#f5a623" />
    {/* 翅膀 */}
    <path d="M5.7 11.4c-.8 2.3-.6 4.8.7 6.6-1.9-1.5-2.6-4.3-1.5-6.9z" fill="#141414" />
    <path d="M18.3 11.4c.8 2.3.6 4.8-.7 6.6 1.9-1.5 2.6-4.3 1.5-6.9z" fill="#141414" />
    {/* 脚 */}
    <path d="M8.3 20.7h3.2l-.5 1.2H7.8z" fill="#f5a623" />
    <path d="M12.5 20.7h3.2l.5 1.2h-3.2z" fill="#f5a623" />
  </svg>
);

/** 串口：插头 */
export const IconSerial = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <path d="M9 2.5v5" />
      <path d="M15 2.5v5" />
      <path d="M6 7.5h12v3.5a6 6 0 0 1-6 6 6 6 0 0 1-6-6z" />
      <path d="M12 17v4.5" />
    </>,
    size,
    className,
  );

/** ADB：安卓机器人头 */
export const IconAndroid = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <path d="M4.5 16.5a7.5 7.5 0 0 1 15 0z" />
      <path d="M3 9.5l1.8 1.2" />
      <path d="M21 9.5l-1.8 1.2" />
      <circle cx="9.3" cy="12.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="12.6" r="0.9" fill="currentColor" stroke="none" />
      <line x1="7" y1="19" x2="7" y2="21" />
      <line x1="17" y1="19" x2="17" y2="21" />
      <line x1="12" y1="19" x2="12" y2="21" />
    </>,
    size,
    className,
  );

/** Git：分支图（三个提交节点） */
export const IconGit = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <circle cx="7" cy="6" r="2.6" />
      <circle cx="7" cy="18" r="2.6" />
      <circle cx="17" cy="12" r="2.6" />
      <path d="M7 8.6v6.8" />
      <path d="M9.6 12h4.8" />
    </>,
    size,
    className,
  );

/**
 * 设置：真正的一圈轮齿（原来是「圆 + 八根放射线」，看着像太阳/亮度图标）。
 * 用和 VS Code 同一种「齿轮 + 内圈」的形状。
 */
export const IconGear = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <path d="M19.14 12.94a7.6 7.6 0 0 0 .06-.94 7.6 7.6 0 0 0-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.62l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.86a.5.5 0 0 0 .12.62l2.03 1.58c-.05.31-.08.62-.08.94s.03.63.08.94l-2.03 1.58a.5.5 0 0 0-.12.62l1.92 3.32c.12.22.38.31.6.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.09.48 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.62z" />
      <circle cx="12" cy="12" r="3.1" />
    </>,
    size,
    className,
  );

/** 终端（通用） */
export const IconTerminal = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <polyline points="4 17 10 12 4 7" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>,
    size,
    className,
  );

export const IconPlus = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>,
    size,
    className,
  );

export const IconClose = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>,
    size,
    className,
  );

export const IconActivity = ({ size = 16, className }: IconProps) =>
  base(<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />, size, className);

export const IconFile = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2.5 14 8 19.5 8" />
    </>,
    size,
    className,
  );

export const IconFolder = ({ size = 16, className }: IconProps) =>
  base(
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
    size,
    className,
  );

export const IconChevronRight = ({ size = 16, className }: IconProps) =>
  base(<polyline points="9 6 15 12 9 18" />, size, className);

export const IconChevronDown = ({ size = 16, className }: IconProps) =>
  base(<polyline points="6 9 12 15 18 9" />, size, className);
