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
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
}

export const IconServer = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <rect x="2" y="2" width="20" height="8" rx="1" />
      <rect x="2" y="14" width="20" height="8" rx="1" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </>,
    size,
    className,
  );

export const IconTerminal = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <polyline points="4 17 10 12 4 7" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>,
    size,
    className,
  );

export const IconWindow = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
    </>,
    size,
    className,
  );

export const IconLinux = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <ellipse cx="12" cy="8.5" rx="5.5" ry="6.5" />
      <path d="M6.5 15c0 3 2.5 5 5.5 5s5.5-2 5.5-5" />
      <circle cx="9.5" cy="7.5" r="1" />
      <circle cx="14.5" cy="7.5" r="1" />
    </>,
    size,
    className,
  );

export const IconGit = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>,
    size,
    className,
  );

export const IconCable = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <path d="M5 9h14v6H5z" />
      <path d="M8 6v3" />
      <path d="M16 6v3" />
      <path d="M8 15v3" />
      <path d="M16 15v3" />
    </>,
    size,
    className,
  );

export const IconPhone = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </>,
    size,
    className,
  );

export const IconGear = ({ size = 16, className }: IconProps) =>
  base(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
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
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
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
