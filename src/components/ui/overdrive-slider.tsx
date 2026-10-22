import * as React from "react"

import { cn } from "@/lib/utils"
import {
  REACH,
  defaultVariant,
  joltAnimation,
  knockAnimation,
  position,
  stepWithDetent,
  type OverdriveRange,
  type OverdriveVariant,
} from "@/lib/overdrive"

/**
 * A slider whose range can be pushed past its ends. It looks like an ordinary
 * min-max slider until you keep going: drag past the end and it holds for a
 * moment, then gives way and the track grows out of its end to follow the
 * pointer. Arrow keys stop at the edge, knock once, and go through on the
 * next press. Volume uses this to amplify past 100%, brightness to dim below
 * the backlight's floor.
 */

/** How far past the end the pointer has to pull before the slider gives way. */
const CATCH_PX = 16
/** The broken look's tilt, in degrees. */
const TILT = 4
const TILT_TAN = Math.tan((TILT * Math.PI) / 180)
/** Gap between the broken track and the piece that broke off. */
const BREAK_GAP_PX = 3

const SPRING = "ease-[cubic-bezier(0.34,1.56,0.64,1)]"

// Jagged edges for the broken look: the track's end and the piece that broke off.
const JAG_RIGHT = "polygon(0 0, calc(100% - 4px) 0, 100% 30%, calc(100% - 3px) 55%, calc(100% - 1px) 80%, calc(100% - 4px) 100%, 0 100%)"
const JAG_LEFT = "polygon(4px 0, 100% 0, 100% 100%, 4px 100%, 1px 80%, 3px 55%, 0 30%)"
const PIECE_LEFT_EDGE = "polygon(0 30%, 3px 55%, 1px 80%, 4px 100%, 100% 100%, 100% 0, 4px 0)"
const PIECE_RIGHT_EDGE = "polygon(0 0, calc(100% - 4px) 0, 100% 30%, calc(100% - 3px) 55%, calc(100% - 1px) 80%, calc(100% - 4px) 100%, 0 100%)"

interface RailsProps {
  value: number
  range: OverdriveRange
  variant: OverdriveVariant
  muted?: boolean
  /** Spring the fill and extensions to new values (off while dragging). */
  animate: boolean
  className?: string
}

/**
 * The track, its fill, and the extensions past either end. Shared by the
 * slider and the read-only meter in the OSDs.
 */
function Rails({ value, range, variant, muted, animate, className }: RailsProps) {
  const pos = position(value, range)
  const over = Math.max(0, pos - 1)
  const under = Math.max(0, -pos)
  const broken = variant === "broken"
  const motion = animate && cn("motion-safe:duration-300", SPRING)

  const piece = (side: "over" | "under", length: number) => (
    <div
      aria-hidden
      data-slot="overdrive-extension"
      className={cn(
        "absolute inset-y-0",
        side === "over" ? "rounded-r-full" : "rounded-l-full",
        muted ? "bg-muted-foreground" : side === "over" ? "bg-orange-500" : "bg-indigo-500",
        motion && "motion-safe:transition-[width]",
      )}
      style={{
        width: `${length * 100}%`,
        [side === "over" ? "left" : "right"]: broken ? `calc(100% + ${BREAK_GAP_PX}px)` : "100%",
        ...(broken && {
          clipPath: side === "over" ? PIECE_LEFT_EDGE : PIECE_RIGHT_EDGE,
          transform: `rotate(${side === "over" ? -TILT : TILT}deg)`,
          transformOrigin: side === "over" ? "left center" : "right center",
        }),
      }}
    />
  )

  const shards = (side: "over" | "under") => (
    <>
      <span
        aria-hidden
        className={cn(
          "absolute -top-2 size-1 rotate-45 rounded-[1px]",
          side === "over" ? "left-full ml-1 bg-orange-500/70" : "right-full mr-1 bg-indigo-500/70",
        )}
      />
      <span
        aria-hidden
        className={cn(
          "absolute -bottom-2 size-0.5 rotate-12",
          side === "over" ? "left-full ml-2 bg-orange-500/50" : "right-full mr-2 bg-indigo-500/50",
        )}
      />
    </>
  )

  return (
    <div data-slot="overdrive-rails" className={cn("relative h-1.5 w-full", className)}>
      <div
        data-slot="overdrive-track"
        className={cn(
          "relative h-full w-full overflow-hidden rounded-full bg-muted",
          over > 0 && "rounded-r-none",
          under > 0 && "rounded-l-none",
        )}
        style={
          broken && (over > 0 || under > 0)
            ? { clipPath: over > 0 ? JAG_RIGHT : JAG_LEFT }
            : undefined
        }
      >
        <div
          data-slot="overdrive-fill"
          className={cn(
            "absolute inset-y-0 left-0",
            muted ? "bg-muted-foreground" : "bg-primary",
            motion && "motion-safe:transition-[width]",
          )}
          style={{ width: `${Math.min(1, Math.max(0, pos)) * 100}%` }}
        />
      </div>
      {range.overMax !== undefined && piece("over", over)}
      {range.underMin !== undefined && piece("under", under)}
      {broken && over > 0 && shards("over")}
      {broken && under > 0 && shards("under")}
    </div>
  )
}

export interface OverdriveSliderProps extends OverdriveRange {
  value: number
  step?: number
  variant?: OverdriveVariant
  /** Grey out the fill, e.g. for a muted volume. */
  muted?: boolean
  disabled?: boolean
  className?: string
  "aria-label"?: string
  /** Text for screen readers, e.g. "120%, amplified". */
  getValueText?: (value: number) => string
  /** Every change while dragging or stepping. */
  onValueChange?: (value: number) => void
  /** When a drag ends, or after each key step. */
  onValueCommit?: (value: number) => void
}

function OverdriveSlider({
  value,
  min,
  max,
  overMax,
  underMin,
  step = 1,
  variant = defaultVariant(),
  muted,
  disabled,
  className,
  "aria-label": ariaLabel,
  getValueText,
  onValueChange,
  onValueCommit,
}: OverdriveSliderProps) {
  const range: OverdriveRange = { min, max, overMax, underMin }
  const rootRef = React.useRef<HTMLDivElement>(null)
  const visualRef = React.useRef<HTMLDivElement>(null)
  const thumbRef = React.useRef<HTMLDivElement>(null)
  const knock = React.useRef({ at: 0 })
  const drag = React.useRef<{ over: boolean; under: boolean; last: number } | null>(null)
  const [dragging, setDragging] = React.useState(false)
  // How far the pointer is pulling past an edge it hasn't broken through yet.
  const [strain, setStrain] = React.useState(0)

  const lowest = underMin ?? min
  const highest = overMax ?? max
  const snap = (v: number) =>
    Math.max(lowest, Math.min(highest, Math.round(v / step) * step))

  const breakThrough = () => {
    if (variant === "broken") joltAnimation(visualRef.current)
  }

  const moveTo = (clientX: number) => {
    const d = drag.current
    const rect = rootRef.current?.getBoundingClientRect()
    if (!d || !rect || rect.width === 0) return
    const x = clientX - rect.left
    const width = rect.width
    let next: number
    let pull = 0
    if (x > width && overMax !== undefined) {
      if (!d.over && x - width > CATCH_PX) {
        d.over = true
        breakThrough()
      }
      if (d.over) next = max + ((x - width) / (width * REACH)) * (overMax - max)
      else {
        next = max
        pull = x - width
      }
    } else if (x < 0 && underMin !== undefined) {
      if (!d.under && -x > CATCH_PX) {
        d.under = true
        breakThrough()
      }
      if (d.under) next = min - (-x / (width * REACH)) * (min - underMin)
      else {
        next = min
        pull = x
      }
    } else {
      next = min + (Math.max(0, Math.min(width, x)) / width) * (max - min)
    }
    setStrain(pull * 0.35)
    next = snap(next)
    if (next !== d.last) {
      d.last = next
      onValueChange?.(next)
    }
  }

  const endDrag = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    setDragging(false)
    setStrain(0)
    onValueCommit?.(d.last)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return
    let delta: number
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        delta = step
        break
      case "ArrowLeft":
      case "ArrowDown":
        delta = -step
        break
      case "PageUp":
        delta = step * 10
        break
      case "PageDown":
        delta = -step * 10
        break
      case "Home":
        delta = min - value
        break
      case "End":
        delta = max - value
        break
      default:
        return
    }
    event.preventDefault()
    if (delta === 0) return
    const { value: next, knocked } = stepWithDetent(value, delta, range, knock.current)
    if (knocked) knockAnimation(visualRef.current, delta > 0 ? 1 : -1)
    if (next === value) return
    if ((value <= max && next > max) || (value >= min && next < min)) breakThrough()
    onValueChange?.(next)
    onValueCommit?.(next)
  }

  const pos = position(value, range)
  const broken = variant === "broken"
  // Ride the broken piece's tilt; 100cqw is the track's width.
  const lift = broken ? Math.max(0, pos - 1, -pos) * TILT_TAN : 0
  const gap = broken ? (pos > 1 ? BREAK_GAP_PX : pos < 0 ? -BREAK_GAP_PX : 0) : 0
  const overdriven = pos > 1 || pos < 0

  return (
    <div
      ref={rootRef}
      data-slot="overdrive-slider"
      data-disabled={disabled ? "" : undefined}
      className={cn(
        "relative flex h-5 w-full touch-none items-center select-none @container data-disabled:opacity-50",
        className,
      )}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { over: value > max, under: value < min, last: value }
        setDragging(true)
        thumbRef.current?.focus()
        moveTo(event.clientX)
      }}
      onPointerMove={(event) => {
        if (drag.current) moveTo(event.clientX)
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    >
      <div ref={visualRef} className="relative flex w-full items-center">
        <Rails value={value} range={range} variant={variant} muted={muted} animate={!dragging} />
        <div
          ref={thumbRef}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={ariaLabel}
          aria-valuemin={lowest}
          aria-valuemax={highest}
          aria-valuenow={value}
          aria-valuetext={getValueText?.(value)}
          aria-orientation="horizontal"
          aria-disabled={disabled || undefined}
          data-slot="overdrive-thumb"
          className={cn(
            "absolute top-1/2 block size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border bg-white shadow-sm ring-ring/50 transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden",
            overdriven ? (pos > 1 ? "border-orange-500" : "border-indigo-500") : "border-primary",
            !dragging && cn("motion-safe:transition-[left,top,color,box-shadow] motion-safe:duration-300", SPRING),
          )}
          style={{
            left: `calc(${pos * 100}% + ${gap + strain}px)`,
            top: `calc(50% - ${lift} * 100cqw)`,
          }}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}

interface OverdriveMeterProps extends OverdriveRange {
  value: number
  /** The track's width in px. */
  width: number
  variant?: OverdriveVariant
  muted?: boolean
  /** Push the neighbors aside to make room for an extension, instead of overlapping them. */
  makeRoom?: boolean
  className?: string
  ref?: React.Ref<HTMLDivElement>
}

/** A read-only bar in the same look as OverdriveSlider, for the OSDs. */
function OverdriveMeter({
  value,
  min,
  max,
  overMax,
  underMin,
  width,
  variant = defaultVariant(),
  muted,
  makeRoom,
  className,
  ref,
}: OverdriveMeterProps) {
  const pos = position(value, { min, max, overMax, underMin })
  const room = (fraction: number) => (makeRoom ? Math.max(0, fraction) * width + (fraction > 0 && variant === "broken" ? 2 * BREAK_GAP_PX : 0) : 0)
  return (
    <div
      ref={ref}
      data-slot="overdrive-meter"
      className={cn(
        "relative flex shrink-0 items-center motion-safe:transition-[margin] motion-safe:duration-300",
        SPRING,
        className,
      )}
      style={{ width, marginRight: room(pos - 1), marginLeft: room(-pos) }}
    >
      <Rails
        value={value}
        range={{ min, max, overMax, underMin }}
        variant={variant}
        muted={muted}
        animate
        className="h-2"
      />
    </div>
  )
}

export { OverdriveSlider, OverdriveMeter }
