import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { describeZone, getDateTimeBridge, zoneOffset, type ZonePlace } from '@/lib/datetime';
import { WORLD_LAND_PATH } from '@/lib/worldMap';

/**
 * Settings → Date & Time's map of the world: click where you are, and the
 * time zone there is picked (the lookup is the system's, `zoneAt`, the same
 * one the automatic time zone uses). Hovering says which zone a spot is in.
 * The list beside it is the keyboard's way to the same choice.
 *
 * The land is equirectangular, in tenths of a degree (src/lib/worldMap.ts);
 * the map shows from 84°N to 56°S, where people set clocks.
 */

const TOP = 60; // 84°N
const BOTTOM = 1460; // 56°S
const VIEW_BOX = `0 ${TOP} 3600 ${BOTTOM - TOP}`;

const toX = (longitude: number) => (longitude + 180) * 10;
const toY = (latitude: number) => (90 - latitude) * 10;

interface Point {
  latitude: number;
  longitude: number;
}

interface Hover extends Point {
  zone: string | null;
  /** Where to put the label, as fractions of the map's size. */
  fx: number;
  fy: number;
}

export function TimeZoneMap({
  current,
  places,
  disabled,
  onPick,
}: {
  current: string;
  places: ZonePlace[];
  /** While the time zone is set automatically. */
  disabled: boolean;
  onPick: (zone: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  /** Where the user clicked, and the zone it gave: the pin goes there, not on the zone's city. */
  const [picked, setPicked] = useState<(Point & { zone: string }) | null>(null);
  const hoverRequest = useRef(0);
  const hoverTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const offset = zoneOffset(current);
  const sameOffset = useMemo(() => {
    const at = new Date();
    return new Set(places.filter((p) => zoneOffset(p.zone, at) === offset).map((p) => p.zone));
  }, [places, offset]);

  const home = places.find((p) => p.zone === current);
  const pin: Point | null = picked && picked.zone === current ? picked : home ?? null;

  /** The map point under a mouse event. */
  function pointAt(event: React.MouseEvent<SVGSVGElement>): (Point & { fx: number; fy: number }) | null {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const rect = svg.getBoundingClientRect();
    const longitude = p.x / 10 - 180;
    const latitude = 90 - p.y / 10;
    if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return null;
    return {
      latitude,
      longitude,
      fx: (event.clientX - rect.left) / rect.width,
      fy: (event.clientY - rect.top) / rect.height,
    };
  }

  function lookUp(point: Point): Promise<string | null> {
    const bridge = getDateTimeBridge();
    return bridge ? bridge.zoneAt(point.latitude, point.longitude).catch(() => null) : Promise.resolve(null);
  }

  function onMove(event: React.MouseEvent<SVGSVGElement>) {
    if (disabled) return;
    const point = pointAt(event);
    if (!point) return;
    setHover((h) => ({ ...point, zone: h?.zone ?? null }));
    window.clearTimeout(hoverTimer.current);
    const request = ++hoverRequest.current;
    hoverTimer.current = window.setTimeout(() => {
      void lookUp(point).then((zone) => {
        if (request === hoverRequest.current) setHover((h) => (h ? { ...h, zone } : h));
      });
    }, 60);
  }

  async function onClick(event: React.MouseEvent<SVGSVGElement>) {
    if (disabled) return;
    const point = pointAt(event);
    if (!point) return;
    const zone = await lookUp(point);
    if (!zone) return;
    setPicked({ latitude: point.latitude, longitude: point.longitude, zone });
    if (zone !== current) onPick(zone);
  }

  const hoverZone = hover?.zone ?? null;

  return (
    <div className={cn('relative overflow-hidden rounded-md border bg-muted/20', disabled && 'opacity-80')}>
      <svg
        ref={svgRef}
        viewBox={VIEW_BOX}
        className={cn('block h-auto w-full select-none', !disabled && 'cursor-crosshair')}
        role="img"
        aria-label={`World map. The time zone is ${describeZone(current).city}${disabled ? ', set from where you are' : '; click a place to choose its time zone'}.`}
        onMouseMove={onMove}
        onMouseLeave={() => {
          window.clearTimeout(hoverTimer.current);
          hoverRequest.current++;
          setHover(null);
        }}
        onClick={(event) => void onClick(event)}
      >
        <path d={WORLD_LAND_PATH} className="fill-foreground/15" />
        {places.map((place) => (
          <circle
            key={place.zone}
            cx={toX(place.longitude)}
            cy={toY(place.latitude)}
            r={sameOffset.has(place.zone) ? 9 : 6}
            className={sameOffset.has(place.zone) ? 'fill-primary/60' : 'fill-foreground/30'}
          />
        ))}
        {pin && (
          <g transform={`translate(${toX(pin.longitude)} ${toY(pin.latitude)})`}>
            <circle r={56} className="fill-primary/25 motion-safe:animate-pulse" />
            <circle r={22} className="fill-primary stroke-background" strokeWidth={8} />
          </g>
        )}
      </svg>
      {hover && hoverZone && (
        <div
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm"
          style={{
            left: `${hover.fx * 100}%`,
            top: `${hover.fy * 100}%`,
            transform: `translate(${hover.fx > 0.7 ? 'calc(-100% - 12px)' : '12px'}, ${hover.fy > 0.7 ? 'calc(-100% - 8px)' : '8px'})`,
          }}
        >
          {describeZone(hoverZone).city} <span className="text-muted-foreground">· {zoneOffset(hoverZone)}</span>
        </div>
      )}
    </div>
  );
}
