// Icons from the design files (24×24, stroked with currentColor unless a colour is given).

import type { CSSProperties, ReactNode } from "react";

interface IconProps {
  size?: number;
  color?: string;
  width?: number;
  style?: CSSProperties;
}

function icon(children: ReactNode, defaults: { width?: number; join?: boolean } = {}) {
  return function Icon({ size = 20, color = "currentColor", width, style }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        style={{
          stroke: color,
          strokeWidth: width ?? defaults.width ?? 1.75,
          strokeLinecap: "round",
          strokeLinejoin: defaults.join === false ? undefined : "round",
          flex: "none",
          ...style,
        }}
      >
        {children}
      </svg>
    );
  };
}

export const HistoryIcon = icon(<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v3.5h3.5M12 8v4l3 2" />);
export const SettingsIcon = icon(
  <>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </>,
  { join: false },
);
export const CloseIcon = icon(<path d="M6 6l12 12M18 6L6 18" />, { join: false });
export const BackIcon = icon(<path d="M15 6l-6 6 6 6" />);
export const ChevronIcon = icon(<path d="M9 6l6 6-6 6" />);
export const PencilIcon = icon(<path d="M4 20h4L19 9l-4-4L4 16v4z" />, { width: 2 });
export const CheckIcon = icon(<path d="M5 12l5 5L20 7" />, { width: 2 });
export const CheckCircleIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l2.5 2.5L16 9.5" />
  </>,
);
export const FlameIcon = icon(
  <path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.2 1-3.8 2.2-5 .2 1.6 1 2.6 2 3 0-3 .3-5.5.8-8z" />,
);
export const StopIcon = icon(<rect x="6" y="6" width="12" height="12" rx="2" />);
export const MinusIcon = icon(<path d="M5 12h14" />, { join: false });
export const PlusIcon = icon(<path d="M5 12h14M12 5v14" />, { join: false });
export const SearchIcon = icon(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4 4" />
  </>,
  { join: false },
);
export const WarnIcon = icon(<path d="M12 4l9 16H3L12 4zM12 10v4M12 17.5v.01" />);
export const OfflineIcon = icon(
  <path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M3 3l18 18" />,
);
export const ArrowUpIcon = icon(<path d="M12 19V5M6 11l6-6 6 6" />, { width: 2 });
export const ArrowDownIcon = icon(<path d="M12 5v14M6 13l6 6 6-6" />, { width: 2 });
export const InfoIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8v.01" />
  </>,
);
