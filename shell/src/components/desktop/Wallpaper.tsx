/** Fullscreen wallpaper backdrop shared by the login screen and desktop. */
export function Wallpaper({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#0b0f14]">
      <img
        src="/wallpaper.jpg"
        alt=""
        aria-hidden
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
      />
      {children}
    </div>
  );
}
