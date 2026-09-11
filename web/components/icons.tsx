/**
 * 内联 SVG 图标集（lucide 风格，stroke 线性图标）。
 */
import type { ReactElement, ReactNode, SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Ico({ size = 18, children, ...rest }: IconProps & { children: ReactNode }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconAnalyze = (p: IconProps) => (
  <Ico {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /><path d="M11 8v3l2 2" /></Ico>
);
export const IconUpload = (p: IconProps) => (
  <Ico {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></Ico>
);
export const IconImage = (p: IconProps) => (
  <Ico {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.6-3.6a2 2 0 0 0-2.8 0L6 20" /></Ico>
);
export const IconBook = (p: IconProps) => (
  <Ico {...p}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></Ico>
);
export const IconDatabase = (p: IconProps) => (
  <Ico {...p}><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></Ico>
);
export const IconHistory = (p: IconProps) => (
  <Ico {...p}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></Ico>
);
export const IconShield = (p: IconProps) => (
  <Ico {...p}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /></Ico>
);
export const IconSettings = (p: IconProps) => (
  <Ico {...p}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></Ico>
);
export const IconAlert = (p: IconProps) => (
  <Ico {...p}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></Ico>
);
export const IconInfo = (p: IconProps) => (
  <Ico {...p}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></Ico>
);
export const IconCheck = (p: IconProps) => (
  <Ico {...p}><path d="M20 6 9 17l-5-5" /></Ico>
);
export const IconCheckCircle = (p: IconProps) => (
  <Ico {...p}><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></Ico>
);
export const IconX = (p: IconProps) => (
  <Ico {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Ico>
);
export const IconXCircle = (p: IconProps) => (
  <Ico {...p}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></Ico>
);
export const IconDownload = (p: IconProps) => (
  <Ico {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></Ico>
);
export const IconRefresh = (p: IconProps) => (
  <Ico {...p}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></Ico>
);
export const IconPencil = (p: IconProps) => (
  <Ico {...p}><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></Ico>
);
export const IconTrash = (p: IconProps) => (
  <Ico {...p}><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></Ico>
);
export const IconSearch = (p: IconProps) => (
  <Ico {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></Ico>
);
export const IconFileText = (p: IconProps) => (
  <Ico {...p}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></Ico>
);
export const IconSave = (p: IconProps) => (
  <Ico {...p}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></Ico>
);
export const IconPrinter = (p: IconProps) => (
  <Ico {...p}><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 9V3h12v6" /><rect x="6" y="14" width="12" height="8" rx="1" /></Ico>
);
export const IconLayers = (p: IconProps) => (
  <Ico {...p}><path d="m12 2 8.5 4.71a1 1 0 0 1 0 1.75l-8.5 4.75a1 1 0 0 1-1 0L2.5 8.46a1 1 0 0 1 0-1.75Z" /><path d="m22 12-9.5 5.29a1 1 0 0 1-1 0L2 12" /></Ico>
);
export const IconZap = (p: IconProps) => (
  <Ico {...p}><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" /></Ico>
);
export const IconEye = (p: IconProps) => (
  <Ico {...p}><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></Ico>
);
export const IconEyeOff = (p: IconProps) => (
  <Ico {...p}><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><path d="m2 2 20 20" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4" /></Ico>
);
export const IconChevronRight = (p: IconProps) => (
  <Ico {...p}><path d="m9 18 6-6-6-6" /></Ico>
);
export const IconChevronDown = (p: IconProps) => (
  <Ico {...p}><path d="m6 9 6 6 6-6" /></Ico>
);
export const IconPlus = (p: IconProps) => (
  <Ico {...p}><path d="M5 12h14" /><path d="M12 5v14" /></Ico>
);
export const IconMinus = (p: IconProps) => (
  <Ico {...p}><path d="M5 12h14" /></Ico>
);
export const IconExternal = (p: IconProps) => (
  <Ico {...p}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Ico>
);
export const IconServer = (p: IconProps) => (
  <Ico {...p}><rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><path d="M6 6h.01" /><path d="M6 18h.01" /></Ico>
);
export const IconHardHat = (p: IconProps) => (
  <Ico {...p}><path d="M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1z" /><path d="M10 10V7a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v3" /><path d="M7 15v-3a5 5 0 0 1 5-5" /><path d="M17 15v-3a5 5 0 0 0-1.4-3.5" /></Ico>
);
export const IconMove = (p: IconProps) => (
  <Ico {...p}><path d="m5 9-3 3 3 3" /><path d="m9 5 3 3 3-3" /><path d="m15 19-3-3-3 3" /><path d="m19 15-3-3 3-3" /><path d="M2 12h20" /><path d="M12 2v20" /></Ico>
);
export const IconLock = (p: IconProps) => (
  <Ico {...p}><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Ico>
);
export const IconPalette = (p: IconProps) => (
  <Ico {...p}><circle cx="13.5" cy="6.5" r=".5" fill="currentColor" /><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" /><circle cx="8.5" cy="7.5" r=".5" fill="currentColor" /><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" /></Ico>
);
export const IconCamera = (p: IconProps) => (
  <Ico {...p}><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3" /></Ico>
);
export const IconRobot = (p: IconProps) => (
  <Ico {...p}><path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" /></Ico>
);
export const IconShieldCheck = (p: IconProps) => (
  <Ico {...p}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></Ico>
);
export const IconScale = (p: IconProps) => (
  <Ico {...p}><path d="M12 3v18" /><path d="M8 21h8" /><path d="M6 7h12l1.8 4.5a2.5 2.5 0 0 1-1.8 3.5" /><path d="M4.2 11.5A2.5 2.5 0 0 0 6 15a2.5 2.5 0 0 0 1.8-3.5L6 7" /><path d="M12 3a2.5 2.5 0 0 1 2.5 2.5h-5A2.5 2.5 0 0 1 12 3z" /></Ico>
);
export const IconClipboard = (p: IconProps) => (
  <Ico {...p}><rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 12h6" /><path d="M9 16h6" /></Ico>
);
export const IconRoute = (p: IconProps) => (
  <Ico {...p}><circle cx="6" cy="19" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /><circle cx="18" cy="5" r="3" /></Ico>
);
export const IconNetwork = (p: IconProps) => (
  <Ico {...p}><rect x="16" y="16" width="6" height="6" rx="1" /><rect x="2" y="16" width="6" height="6" rx="1" /><rect x="9" y="2" width="6" height="6" rx="1" /><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" /><path d="M12 8v4" /></Ico>
);
export const IconTree = (p: IconProps) => (
  <Ico {...p}><path d="M10 20v-4" /><path d="M14 20v-4" /><path d="M10 16h4" /><rect width="8" height="6" x="8" y="14" rx="1" /><path d="M12 14V8" /><path d="M8 8h8" /><rect width="12" height="6" x="6" y="2" rx="1" /></Ico>
);
export const IconChartBar = (p: IconProps) => (
  <Ico {...p}><path d="M3 3v18h18" /><path d="M7 16v-4" /><path d="M12 16V8" /><path d="M17 16V5" /></Ico>
);
export const IconPlay = (p: IconProps) => (
  <Ico {...p}><path d="M6 4.5 19.5 12 6 19.5z" /></Ico>
);
export const IconScatter = (p: IconProps) => (
  <Ico {...p}><path d="M3 3v18h18" /><circle cx="8" cy="8" r="1.5" /><circle cx="12" cy="14" r="1.5" /><circle cx="16" cy="9" r="1.5" /><circle cx="19" cy="16" r="1.5" /></Ico>
);
export const IconGithub = (p: IconProps) => (
  <Ico {...p}><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.4 4 5 5 0 0 0 19.3.5S18.2.1 15 1.8a13.4 13.4 0 0 0-7 0C4.8.1 3.7.5 3.7.5A5 5 0 0 0 3.6 4a5.4 5.4 0 0 0-1.4 3.7c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 8 18v4" /><path d="M8 19c-3 .9-3-1.5-4-2" /></Ico>
);
export const IconLogOut = (p: IconProps) => (
  <Ico {...p}><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /></Ico>
);
