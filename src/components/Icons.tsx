interface IconProps {
  size?: number;
  className?: string;
}

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

/** PowerShell：方框 + `>_` 提示符 */
export const IconPowerShell = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <rect x="2.5" y="3.5" width="19" height="17" rx="2.5" />
      <polyline points="6.5 9 10.5 12 6.5 15" />
      <line x1="12.5" y1="15" x2="17" y2="15" />
    </>,
    size,
    className,
  );

/** CMD：控制台窗口 + 提示符 */
export const IconCmd = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <line x1="2.5" y1="8.5" x2="21.5" y2="8.5" />
      <polyline points="6 12 8.5 14 6 16" />
      <line x1="10" y1="16" x2="13.5" y2="16" />
    </>,
    size,
    className,
  );

/** WSL：企鹅 */
export const IconWsl = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <ellipse cx="12" cy="9" rx="5" ry="6" />
      <path d="M7.5 13.5c-1.8 1-1.8 3.5 0 4.5" />
      <path d="M16.5 13.5c1.8 1 1.8 3.5 0 4.5" />
      <circle cx="10.2" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="13.8" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <path d="M11.2 10.6 12 12.2l0.8-1.6z" />
      <path d="M8.5 20.5h7" />
    </>,
    size,
    className,
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

/** 设置：齿轮 */
export const IconGear = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v2.6M12 18.9v2.6M4.6 4.6l1.9 1.9M17.5 17.5l1.9 1.9M2.5 12h2.6M18.9 12h2.6M4.6 19.4l1.9-1.9M17.5 6.5l1.9-1.9" />
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
