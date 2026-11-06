import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A native <select> in the look of the Select trigger: a borderless capsule
 * field with the same caret. `className` sizes and places it (it goes on
 * the wrapper the caret is drawn in); the rest go to the <select>.
 */
function NativeSelect({
  className,
  size = "default",
  ref,
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  return (
    <div data-slot="native-select-wrapper" className={cn("relative inline-flex w-fit min-w-0", className)}>
      <select
        ref={ref}
        data-slot="native-select"
        data-size={size}
        className="w-full min-w-0 appearance-none rounded-full bg-foreground/[0.06] py-0 pr-8 pl-3.5 text-sm text-foreground transition-colors outline-none hover:bg-foreground/[0.09] focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-2 aria-invalid:ring-destructive/40 data-[size=default]:h-9 data-[size=sm]:h-8"
        {...props}
      />
      <ChevronDownIcon
        aria-hidden
        strokeWidth={1.75}
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  )
}

export { NativeSelect }
