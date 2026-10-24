/** Ein einheitlicher Strichsatz: 1.6px, runde Enden, 16er-Raster. */

interface IconProps {
  size?: number
  className?: string
}

function svg(path: React.ReactNode, size = 16, className?: string) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {path}
    </svg>
  )
}

export const IconInbox = ({ size, className }: IconProps) =>
  svg(
    <>
      <path d="M1.8 9.5h3l1 1.8h4.4l1-1.8h3" />
      <path d="M3.2 2.8h9.6l1.4 6.7v2.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V9.5z" />
    </>,
    size,
    className
  )

export const IconSent = ({ size, className }: IconProps) =>
  svg(<path d="M14.2 1.8 7 9M14.2 1.8 9.7 14.2 7 9 1.8 6.3z" />, size, className)

export const IconDraft = ({ size, className }: IconProps) =>
  svg(
    <>
      <path d="M9 1.8H4a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.8z" />
      <path d="M9 1.8v4h4" />
    </>,
    size,
    className
  )

export const IconTrash = ({ size, className }: IconProps) =>
  svg(
    <>
      <path d="M2.6 4h10.8M6.3 4V2.6h3.4V4M4 4l.6 9.4h6.8L12 4" />
      <path d="M6.6 6.8v4M9.4 6.8v4" />
    </>,
    size,
    className
  )

export const IconJunk = ({ size, className }: IconProps) =>
  svg(
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 5v3.6M8 10.8h.01" />
    </>,
    size,
    className
  )

export const IconArchive = ({ size, className }: IconProps) =>
  svg(
    <>
      <path d="M1.8 2.6h12.4v2.8H1.8z" />
      <path d="M2.9 5.4v7a1 1 0 0 0 1 1h8.2a1 1 0 0 0 1-1v-7" />
      <path d="M6.4 8.2h3.2" />
    </>,
    size,
    className
  )

export const IconFolder = ({ size, className }: IconProps) =>
  svg(
    <path d="M1.8 12.6V3.4a.8.8 0 0 1 .8-.8h3.1l1.5 1.8h6a.8.8 0 0 1 .8.8v7.4a.8.8 0 0 1-.8.8H2.6a.8.8 0 0 1-.8-.8z" />,
    size,
    className
  )

export const IconStar = ({ size, className }: IconProps) =>
  svg(<path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />, size, className)

export const IconStarFilled = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
    <path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
  </svg>
)

export const IconPaperclip = ({ size, className }: IconProps) =>
  svg(
    <path d="M12.9 7.4 7.6 12.7a3.1 3.1 0 0 1-4.4-4.4l5.6-5.6a2.1 2.1 0 0 1 2.9 2.9l-5.5 5.6a1 1 0 0 1-1.5-1.5l5.1-5.1" />,
    size,
    className
  )

export const IconSearch = ({ size, className }: IconProps) =>
  svg(
    <>
      <circle cx="7.2" cy="7.2" r="4.6" />
      <path d="m10.6 10.6 3 3" />
    </>,
    size,
    className
  )

export const IconReply = ({ size, className }: IconProps) =>
  svg(
    <>
      <path d="M6 3.4 1.8 7.2 6 11" />
      <path d="M1.8 7.2h6.4a5 5 0 0 1 5 5v1" />
    </>,
    size,
    className
  )

export const IconReplyAll = ({ size, className }: IconProps) =>
  svg(
    <>
      <path d="M5 3.4 1.4 7.2 5 11" />
      <path d="M8.6 3.4 5 7.2 8.6 11" />
      <path d="M5 7.2h4.4a4.6 4.6 0 0 1 4.6 4.6v1" />
    </>,
    size,
    className
  )

export const IconForward = ({ size, className }: IconProps) =>
  svg(
    <>
      <path d="M10 3.4 14.2 7.2 10 11" />
      <path d="M14.2 7.2H7.8a5 5 0 0 0-5 5v1" />
    </>,
    size,
    className
  )

export const IconCompose = ({ size = 18, className }: IconProps) =>
  svg(
    <>
      <path d="M11.4 2.4a1.6 1.6 0 0 1 2.2 2.2L5.9 12.3l-3 .8.8-3z" />
      <path d="M10.2 3.6 12.4 5.8" />
    </>,
    size,
    className
  )

export const IconRefresh = ({ size, className }: IconProps) =>
  svg(
    <>
      <path d="M13.6 8a5.6 5.6 0 1 1-1.7-4" />
      <path d="M13.4 1.6v3h-3" />
    </>,
    size,
    className
  )

export const IconSettings = ({ size, className }: IconProps) =>
  svg(
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v1.6M8 12.8v1.6M14.4 8h-1.6M3.2 8H1.6M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6 3.5 3.5" />
    </>,
    size,
    className
  )

export const IconClock = ({ size, className }: IconProps) =>
  svg(
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.3 1.5" />
    </>,
    size,
    className
  )

export const IconClose = ({ size, className }: IconProps) =>
  svg(<path d="M3.6 3.6 12.4 12.4M12.4 3.6 3.6 12.4" />, size, className)

export const IconLayers = ({ size, className }: IconProps) =>
  svg(
    <>
      <path d="M8 1.8 1.8 5 8 8.2 14.2 5z" />
      <path d="m1.8 8 6.2 3.2L14.2 8" />
      <path d="m1.8 11 6.2 3.2L14.2 11" />
    </>,
    size,
    className
  )

export const IconPlus = ({ size, className }: IconProps) =>
  svg(<path d="M8 2.8v10.4M2.8 8h10.4" />, size, className)

export const IconEnvelopeOpen = ({ size, className }: IconProps) =>
  svg(
    <>
      <path d="M1.8 6.6 8 2.2l6.2 4.4v6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
      <path d="m1.8 6.6 6.2 4.2 6.2-4.2" />
    </>,
    size,
    className
  )

export const IconDownload = ({ size, className }: IconProps) =>
  svg(
    <>
      <path d="M8 2.2v7.6" />
      <path d="m4.8 6.9 3.2 3.2 3.2-3.2" />
      <path d="M2.6 11.4v1.4a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-1.4" />
    </>,
    size,
    className
  )

export const IconFile = ({ size, className }: IconProps) =>
  svg(
    <>
      <path d="M9 1.8H4.2a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V5.4z" />
      <path d="M9 1.8v3.6h3.8" />
    </>,
    size,
    className
  )

export const IconAttach = IconPaperclip
