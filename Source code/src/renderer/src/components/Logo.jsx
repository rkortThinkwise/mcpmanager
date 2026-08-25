import { brand } from '../theme'

// Generic app mark: a rounded tile with an abstract hub-and-nodes glyph,
// standing in for "a manager of connections" without any company branding.
// Appears small in the top bar; same glyph as the empty-state tile, just
// self-contained so it can be used at any size.
export default function Logo({ width = 32, style }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={width}
      height={width}
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', ...style }}
      role="img"
      aria-label="MCP Manager"
    >
      <defs>
        <linearGradient id="mcpLogoGradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={brand.blue} />
          <stop offset="1" stopColor={brand.navy} />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#mcpLogoGradient)" />
      <g stroke="#fff" strokeWidth="2.5" strokeLinecap="round">
        <line x1="32" y1="32" x2="18" y2="20" />
        <line x1="32" y1="32" x2="46" y2="20" />
        <line x1="32" y1="32" x2="18" y2="44" />
        <line x1="32" y1="32" x2="46" y2="44" />
      </g>
      <circle cx="32" cy="32" r="6.5" fill="#fff" />
      <circle cx="18" cy="20" r="4" fill="#fff" />
      <circle cx="46" cy="20" r="4" fill="#fff" />
      <circle cx="18" cy="44" r="4" fill="#fff" />
      <circle cx="46" cy="44" r="4" fill="#fff" />
    </svg>
  )
}
