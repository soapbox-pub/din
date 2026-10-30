import { cva } from "class-variance-authority"

export const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center text-muted-foreground select-none group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col group-data-[orientation=vertical]/tabs:items-stretch",
  {
    variants: {
      variant: {
        default:
          "gap-0.5 rounded-lg bg-foreground/[0.06] p-0.5 shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.05)] group-data-[orientation=horizontal]/tabs:h-8 dark:bg-white/[0.08] dark:shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.06)]",
        line: "gap-4 border-border group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=horizontal]/tabs:border-b group-data-[orientation=vertical]/tabs:gap-1 group-data-[orientation=vertical]/tabs:border-r",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)
