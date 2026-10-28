/**
 * Nsite icon — an "N" drawn as a little network: its strokes are links and
 * each joint is a node.
 *
 * Stroked and sized by `className` (`size-4`) like a Lucide icon, so it drops
 * in wherever one of those would.
 */
export function NsiteIcon({
  className,
  ...props
}: React.ComponentProps<'svg'>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-slot="icon"
      className={className}
      {...props}
    >
      <path d="M6 19V5l12 14V5" />
      <g fill="currentColor" stroke="none">
        <circle cx="6" cy="19" r="2.75" />
        <circle cx="6" cy="5" r="2.75" />
        <circle cx="18" cy="19" r="2.75" />
        <circle cx="18" cy="5" r="2.75" />
      </g>
    </svg>
  );
}
