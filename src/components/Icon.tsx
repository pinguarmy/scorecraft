import type { ReactNode } from 'react';

const paths: Record<string, ReactNode> = {
  play: <path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <path d="M8 5v14M16 5v14" strokeWidth="4" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />,
  upload: (
    <>
      <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6Z M14 3v5h4M9 12h6M9 16h6" />
    </>
  ),
  back: <path d="m14 6-6 6 6 6M5 5v14" />,
  forward: <path d="m10 6 6 6-6 6M19 5v14" />,
  loop: (
    <>
      <path d="M5 7h12l3 3m0-3v3h-3M19 17H7l-3-3m0 3v-3h3M4 11V9a2 2 0 0 1 2-2m14 6v2a2 2 0 0 1-2 2" />
    </>
  ),
  sound: (
    <>
      <path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
    </>
  ),
  pen: (
    <>
      <path d="m4 16 11-11 4 4L8 20H4ZM13 7l4 4" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  print: (
    <>
      <path d="M7 8V3h10v5M7 17H3V8h18v9h-4M7 14h10v7H7Z" />
    </>
  ),
  note: (
    <>
      <path d="M10 17V5l9-2v12M10 9l9-2" />
      <ellipse cx="7" cy="18" rx="3" ry="2" />
      <ellipse cx="16" cy="16" rx="3" ry="2" />
    </>
  ),
  undo: (
    <>
      <path d="M8 7H3V2m0 5a9 9 0 1 1-1 9" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
    </>
  ),
};

/** 线条图标集；未知名称显示音符图标。 */
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.note}
    </svg>
  );
}
