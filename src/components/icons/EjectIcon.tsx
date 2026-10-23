/**
 * Eject icon — the ⏏ symbol, a triangle over a bar.
 *
 * Lucide has no eject glyph. Stroked and sized by `className` (`size-4`) like
 * a Lucide icon, so it drops in wherever one of those would.
 */
export function EjectIcon({
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
      <path d="M12 4 4.5 13.5h15z" />
      <path d="M4.5 19h15" />
    </svg>
  );
}
