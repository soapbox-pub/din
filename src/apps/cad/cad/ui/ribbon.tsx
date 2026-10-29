import { Lightbulb, LightbulbOff, Lock, LockOpen, Snowflake, Sun } from 'lucide-react';
import { ACI, colorName, hex } from '../aci';
import { BYBLOCK, BYLAYER, LINEWEIGHTS, LW_BYBLOCK, LW_BYLAYER, LW_DEFAULT, TRUE_COLOR, type Drawing, type Layer } from '../model';
import { PATTERNS } from '../hatch';
import type { HatchSettings } from '../commands';
import { BigButton, Col, Dropdown, MenuItem, MenuLabel, MenuSeparator, Panel, SmallButton } from './chrome';
import { FIELD, keepFocus, lwName } from './style';
import { Icons } from './icons';
import { cn } from '@/lib/utils';

export type RibbonTabId = 'home' | 'insert' | 'annotate' | 'view' | 'hatch';

export interface RibbonProps {
  tab: RibbonTabId;
  setTab: (t: RibbonTabId) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  run: (cmd: string) => void;
  drawing: Drawing;
  /** Selection's common value, or undefined for mixed, or null with nothing selected. */
  selLayer: string | null | undefined;
  selColor: number | null | undefined;
  selLinetype: string | null | undefined;
  selLineweight: number | null | undefined;
  current: { color: number; linetype: string; lineweight: number };
  setLayerProp: (name: string, patch: Partial<Layer>) => void;
  chooseLayer: (name: string) => void;
  chooseColor: (c: number) => void;
  chooseLinetype: (n: string) => void;
  chooseLineweight: (n: number) => void;
  chooseTextStyle: (n: string) => void;
  chooseDimStyle: (n: string) => void;
  setTextHeight: (h: number) => void;
  hatchActive: boolean;
  hatch: HatchSettings;
  setHatch: (h: HatchSettings) => void;
  finishHatch: () => void;
  palettes: { properties: boolean; layers: boolean; assistant: boolean };
  togglePalette: (p: 'properties' | 'layers' | 'assistant') => void;
  dark: boolean;
  toggleDark: () => void;
}

export function Swatch({ color, layerColor }: { color: number; layerColor?: number }) {
  const c = color === BYLAYER ? (layerColor ?? 7) : color === BYBLOCK ? 7 : color;
  const rgb = c >= TRUE_COLOR ? c & 0xffffff : c === 7 ? 0xffffff : ACI[c] ?? 0xffffff;
  return <span className="inline-block size-3 shrink-0 rounded-[1px] border border-black/60" style={{ background: hex(rgb) }} />;
}

export function LwSample({ lw }: { lw: number }) {
  const px = lw <= 0 ? 1 : Math.max(1, Math.min(6, Math.round(lw / 25)));
  return <span className="inline-block w-8 shrink-0 bg-[#dfe4ec]" style={{ height: px }} />;
}


const BASIC_COLORS = [1, 2, 3, 4, 5, 6, 7];

export function ColorMenu({ onPick, layerColor }: { onPick: (c: number) => void; layerColor?: number }) {
  return (
    <>
      <MenuItem icon={<Swatch color={BYLAYER} layerColor={layerColor} />} onSelect={() => onPick(BYLAYER)}>
        ByLayer
      </MenuItem>
      <MenuItem icon={<Swatch color={BYBLOCK} />} onSelect={() => onPick(BYBLOCK)}>
        ByBlock
      </MenuItem>
      <MenuSeparator />
      {BASIC_COLORS.map((c) => (
        <MenuItem key={c} icon={<Swatch color={c} />} onSelect={() => onPick(c)}>
          {colorName(c)}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>Index colors</MenuLabel>
      <div className="grid grid-cols-[repeat(24,12px)] gap-px px-2 pb-2">
        {Array.from({ length: 240 }, (_, i) => i + 10).map((c) => (
          <button
            key={c}
            type="button"
            title={`Color ${c}`}
            aria-label={`Color ${c}`}
            onClick={() => onPick(c)}
            className="size-3 border border-black/40 hover:outline hover:outline-1 hover:outline-white"
            style={{ background: hex(ACI[c]) }}
          />
        ))}
      </div>
      <div className="flex gap-px px-2 pb-1.5">
        {[8, 9, 250, 251, 252, 253, 254, 255].map((c) => (
          <button key={c} type="button" title={`Color ${c}`} aria-label={`Color ${c}`} onClick={() => onPick(c)} className="size-4 border border-black/40 hover:outline hover:outline-1 hover:outline-white" style={{ background: hex(ACI[c]) }} />
        ))}
      </div>
    </>
  );
}

function LayerRow({ l, current, onPick, setLayerProp }: { l: Layer; current: boolean; onPick: () => void; setLayerProp: (patch: Partial<Layer>) => void }) {
  const icon = (on: boolean, a: React.ReactNode, b: React.ReactNode, label: string, toggle: () => void) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }}
      className="grid size-5 place-items-center rounded-[2px] hover:bg-white/10"
    >
      {on ? a : b}
    </button>
  );
  return (
    <MenuItem onSelect={onPick} className={cn(current && 'font-semibold')}>
      <span className="flex items-center gap-1">
        {icon(l.on, <Lightbulb className="size-3.5 text-[#f5c542]" />, <LightbulbOff className="size-3.5 text-[#6c7480]" />, l.on ? 'Turn off' : 'Turn on', () => setLayerProp({ on: !l.on }))}
        {icon(!l.frozen, <Sun className="size-3.5 text-[#f5c542]" />, <Snowflake className="size-3.5 text-[#7cc4ff]" />, l.frozen ? 'Thaw' : 'Freeze', () => setLayerProp({ frozen: !l.frozen }))}
        {icon(!l.locked, <LockOpen className="size-3.5 text-[#c4ccd7]" />, <Lock className="size-3.5 text-[#f5c542]" />, l.locked ? 'Unlock' : 'Lock', () => setLayerProp({ locked: !l.locked }))}
        <Swatch color={l.color} />
        <span className="ml-1.5">{l.name}</span>
      </span>
    </MenuItem>
  );
}

export function Ribbon(p: RibbonProps) {
  const d = p.drawing;
  const r = (cmd: string) => () => p.run(cmd);
  const layerName = p.selLayer === undefined ? '' : (p.selLayer ?? d.header.clayer);
  const layer = d.layers.find((l) => l.name.toUpperCase() === layerName.toUpperCase());
  const colorShown = p.selColor === undefined ? null : (p.selColor ?? p.current.color);
  const ltShown = p.selLinetype === undefined ? '' : (p.selLinetype ?? p.current.linetype);
  const lwShown = p.selLineweight === undefined ? null : (p.selLineweight ?? p.current.lineweight);
  const tabs: [RibbonTabId, string][] = [
    ['home', 'Home'],
    ['insert', 'Insert'],
    ['annotate', 'Annotate'],
    ['view', 'View'],
  ];
  if (p.hatchActive) tabs.push(['hatch', 'Hatch Creation']);

  const layerDropdown = (
    <Dropdown
      label="Layer"
      width="w-[196px]"
      value={
        layer ? (
          <>
            {layer.on ? <Lightbulb className="size-3.5 shrink-0 text-[#f5c542]" /> : <LightbulbOff className="size-3.5 shrink-0 text-[#6c7480]" />}
            {layer.frozen ? <Snowflake className="size-3.5 shrink-0 text-[#7cc4ff]" /> : <Sun className="size-3.5 shrink-0 text-[#f5c542]" />}
            {layer.locked ? <Lock className="size-3.5 shrink-0 text-[#f5c542]" /> : <LockOpen className="size-3.5 shrink-0 text-[#c4ccd7]" />}
            <Swatch color={layer.color} />
            <span className="truncate">{layer.name}</span>
          </>
        ) : (
          <span className="text-[#a9b2bf]">{p.selLayer === undefined ? 'Varies' : layerName}</span>
        )
      }
    >
      {d.layers.map((l) => (
        <LayerRow key={l.name} l={l} current={l.name === d.header.clayer} onPick={() => p.chooseLayer(l.name)} setLayerProp={(patch) => p.setLayerProp(l.name, patch)} />
      ))}
    </Dropdown>
  );

  const colorDropdown = (
    <Dropdown label="Object Color" width="w-[124px]" value={colorShown === null ? <span className="text-[#a9b2bf]">Varies</span> : <><Swatch color={colorShown} layerColor={layer?.color} /> {colorName(colorShown)}</>}>
      <ColorMenu onPick={p.chooseColor} layerColor={layer?.color} />
    </Dropdown>
  );
  const ltDropdown = (
    <Dropdown label="Linetype" width="w-[124px]" value={<span className="truncate">{ltShown || 'Varies'}</span>}>
      {d.linetypes.map((l) => (
        <MenuItem key={l.name} onSelect={() => p.chooseLinetype(l.name)}>
          <span className="inline-flex w-full items-center gap-3">
            <svg width={44} height={6} className="shrink-0" aria-hidden>
              <line x1={0} y1={3} x2={44} y2={3} stroke="#dfe4ec" strokeWidth={1.5} strokeDasharray={l.pattern.length ? l.pattern.map((x) => Math.max(1.5, Math.abs(x) * 12)).join(' ') : undefined} />
            </svg>
            {l.name}
          </span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onSelect={r('LAYER')}>Load more in Layer Properties…</MenuItem>
    </Dropdown>
  );
  const lwDropdown = (
    <Dropdown label="Lineweight" width="w-[124px]" value={lwShown === null ? <span className="text-[#a9b2bf]">Varies</span> : <><LwSample lw={lwShown} /> <span className="truncate">{lwName(lwShown)}</span></>}>
      {[LW_BYLAYER, LW_BYBLOCK, LW_DEFAULT, ...LINEWEIGHTS].map((lw) => (
        <MenuItem key={lw} onSelect={() => p.chooseLineweight(lw)}>
          <span className="inline-flex items-center gap-3">
            <LwSample lw={lw} />
            {lwName(lw)}
          </span>
        </MenuItem>
      ))}
    </Dropdown>
  );

  const textStyleDd = (
    <Dropdown label="Text Style" width="w-[150px]" value={<span className="truncate">{d.header.textstyle}</span>}>
      {d.textStyles.map((s) => (
        <MenuItem key={s.name} onSelect={() => p.chooseTextStyle(s.name)} checked={s.name === d.header.textstyle}>
          {s.name}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onSelect={r('STYLE')}>Manage Text Styles…</MenuItem>
    </Dropdown>
  );
  const dimStyleDd = (
    <Dropdown label="Dimension Style" width="w-[150px]" value={<span className="truncate">{d.header.dimstyle}</span>}>
      {d.dimStyles.map((s) => (
        <MenuItem key={s.name} onSelect={() => p.chooseDimStyle(s.name)} checked={s.name === d.header.dimstyle}>
          {s.name}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onSelect={r('DIMSTYLE')}>Manage Dimension Styles…</MenuItem>
    </Dropdown>
  );

  const dimMenu = (
    <>
      <MenuItem icon={<Icons.dimlinear />} onSelect={r('DIMLINEAR')}>Linear</MenuItem>
      <MenuItem icon={<Icons.dimaligned />} onSelect={r('DIMALIGNED')}>Aligned</MenuItem>
      <MenuItem icon={<Icons.dimangular />} onSelect={r('DIMANGULAR')}>Angular</MenuItem>
      <MenuItem icon={<Icons.dimradius />} onSelect={r('DIMRADIUS')}>Radius</MenuItem>
      <MenuItem icon={<Icons.dimdiameter />} onSelect={r('DIMDIAMETER')}>Diameter</MenuItem>
      <MenuItem icon={<Icons.dimordinate />} onSelect={r('DIMORDINATE')}>Ordinate</MenuItem>
    </>
  );

  const home = (
    <>
      <Panel title="Draw">
        <BigButton icon={<Icons.line />} label="Line" title="Line (L)" onClick={r('LINE')} />
        <BigButton icon={<Icons.pline />} label="Polyline" title="Polyline (PL)" onClick={r('PLINE')} />
        <BigButton
          icon={<Icons.circle />}
          label="Circle"
          title="Circle (C)"
          menu={
            <>
              <MenuItem icon={<Icons.circle />} onSelect={r('CIRCLE')}>Center, Radius</MenuItem>
              <MenuItem icon={<Icons.circle />} onSelect={() => p.run('CIRCLE')}>Center, Diameter</MenuItem>
              <MenuItem icon={<Icons.circle />} onSelect={r('CIRCLE 2P')}>2-Point</MenuItem>
              <MenuItem icon={<Icons.circle />} onSelect={r('CIRCLE 3P')}>3-Point</MenuItem>
              <MenuItem icon={<Icons.circle />} onSelect={r('CIRCLE T')}>Tan, Tan, Radius</MenuItem>
            </>
          }
        />
        <BigButton
          icon={<Icons.arc />}
          label="Arc"
          title="Arc (A)"
          menu={
            <>
              <MenuItem icon={<Icons.arc />} onSelect={r('ARC')}>3-Point</MenuItem>
              <MenuItem icon={<Icons.arc />} onSelect={r('ARC C')}>Center, Start, End</MenuItem>
            </>
          }
        />
        <Col>
          <SmallButton icon={<Icons.rect />} label="Rectangle" iconOnly title="Rectangle (REC)" onClick={r('RECTANG')} />
          <SmallButton icon={<Icons.ellipse />} label="Ellipse" iconOnly title="Ellipse (EL)" onClick={r('ELLIPSE')} />
          <SmallButton icon={<Icons.polygon />} label="Polygon" iconOnly title="Polygon (POL)" onClick={r('POLYGON')} />
        </Col>
        <Col>
          <SmallButton icon={<Icons.hatch />} label="Hatch" iconOnly title="Hatch (H)" onClick={r('HATCH')} />
          <SmallButton icon={<Icons.spline />} label="Spline" iconOnly title="Spline (SPL)" onClick={r('SPLINE')} />
          <SmallButton icon={<Icons.point />} label="Multiple Points" iconOnly title="Multiple Points (PO)" onClick={r('MULTIPLEPOINT')} />
        </Col>
        <Col>
          <SmallButton icon={<Icons.xline />} label="Construction Line" iconOnly title="Construction Line (XL)" onClick={r('XLINE')} />
          <SmallButton icon={<Icons.ray />} label="Ray" iconOnly title="Ray" onClick={r('RAY')} />
          <SmallButton icon={<Icons.donut />} label="Donut" iconOnly title="Donut (DO)" onClick={r('DONUT')} />
        </Col>
      </Panel>
      <Panel title="Modify">
        <Col>
          <SmallButton icon={<Icons.move />} label="Move" title="Move (M)" onClick={r('MOVE')} />
          <SmallButton icon={<Icons.copy />} label="Copy" title="Copy (CO)" onClick={r('COPY')} />
          <SmallButton icon={<Icons.stretch />} label="Stretch" title="Stretch (S)" onClick={r('STRETCH')} />
        </Col>
        <Col>
          <SmallButton icon={<Icons.rotate />} label="Rotate" title="Rotate (RO)" onClick={r('ROTATE')} />
          <SmallButton icon={<Icons.mirror />} label="Mirror" title="Mirror (MI)" onClick={r('MIRROR')} />
          <SmallButton icon={<Icons.scale />} label="Scale" title="Scale (SC)" onClick={r('SCALE')} />
        </Col>
        <Col>
          <SmallButton
            icon={<Icons.trim />}
            label="Trim"
            title="Trim (TR)"
            menu={
              <>
                <MenuItem icon={<Icons.trim />} onSelect={r('TRIM')}>Trim</MenuItem>
                <MenuItem icon={<Icons.extend />} onSelect={r('EXTEND')}>Extend</MenuItem>
              </>
            }
          />
          <SmallButton
            icon={<Icons.fillet />}
            label="Fillet"
            title="Fillet (F)"
            menu={
              <>
                <MenuItem icon={<Icons.fillet />} onSelect={r('FILLET')}>Fillet</MenuItem>
                <MenuItem icon={<Icons.chamfer />} onSelect={r('CHAMFER')}>Chamfer</MenuItem>
              </>
            }
          />
          <SmallButton
            icon={<Icons.array />}
            label="Array"
            title="Array (AR)"
            menu={
              <>
                <MenuItem icon={<Icons.array />} onSelect={r('ARRAYRECT')}>Rectangular Array</MenuItem>
                <MenuItem icon={<Icons.rotate />} onSelect={r('ARRAYPOLAR')}>Polar Array</MenuItem>
              </>
            }
          />
        </Col>
        <Col>
          <SmallButton icon={<Icons.erase />} label="Erase" iconOnly title="Erase (E)" onClick={r('ERASE')} />
          <SmallButton icon={<Icons.explode />} label="Explode" iconOnly title="Explode (X)" onClick={r('EXPLODE')} />
          <SmallButton icon={<Icons.offset />} label="Offset" iconOnly title="Offset (O)" onClick={r('OFFSET')} />
        </Col>
        <Col>
          <SmallButton icon={<Icons.break />} label="Break" iconOnly title="Break (BR)" onClick={r('BREAK')} />
          <SmallButton icon={<Icons.join />} label="Join" iconOnly title="Join (J)" onClick={r('JOIN')} />
          <SmallButton icon={<Icons.break />} label="Break at Point" iconOnly title="Break at Point" onClick={r('BREAKATPOINT')} />
        </Col>
      </Panel>
      <Panel title="Annotation">
        <BigButton
          icon={<Icons.mtext />}
          label="Text"
          title="Multiline Text (T)"
          menu={
            <>
              <MenuItem icon={<Icons.mtext />} onSelect={r('MTEXT')}>Multiline Text</MenuItem>
              <MenuItem icon={<Icons.text />} onSelect={r('TEXT')}>Single Line</MenuItem>
            </>
          }
        />
        <BigButton icon={<Icons.dimlinear />} label="Dimension" title="Dimension" menu={dimMenu} />
        <Col>
          <SmallButton icon={<Icons.leader />} label="Leader" title="Leader (LE)" onClick={r('LEADER')} />
          <SmallButton icon={<Icons.dimlinear />} label="Linear" title="Linear (DLI)" onClick={r('DIMLINEAR')} />
          <SmallButton icon={<Icons.dimradius />} label="Radius" title="Radius (DRA)" onClick={r('DIMRADIUS')} />
        </Col>
      </Panel>
      <Panel title="Layers" onExpand={() => p.togglePalette('layers')}>
        <BigButton icon={<Icons.layers />} label="Layer" title="Layer Properties (LA)" onClick={() => p.togglePalette('layers')} active={p.palettes.layers} />
        <div className="flex flex-col gap-1 pt-0.5">
          {layerDropdown}
          <div className="flex gap-px">
            <SmallButton icon={<Icons.layerCurrent />} label="Make Current" iconOnly title="Make Object's Layer Current (LAYMCUR)" onClick={r('LAYMCUR')} />
            <SmallButton icon={<Icons.layerIso />} label="Isolate" iconOnly title="Isolate (LAYISO)" onClick={r('LAYISO')} />
            <SmallButton icon={<Icons.layerOff />} label="Off" iconOnly title="Off (LAYOFF)" onClick={r('LAYOFF')} />
            <SmallButton icon={<Icons.layerFreeze />} label="Freeze" iconOnly title="Freeze (LAYFRZ)" onClick={r('LAYFRZ')} />
            <SmallButton icon={<Icons.layerLock />} label="Lock" iconOnly title="Lock (LAYLCK)" onClick={r('LAYLCK')} />
            <SmallButton icon={<Lightbulb className="size-4 text-[#f5c542]" />} label="Turn All Layers On" iconOnly title="Turn All Layers On (LAYON)" onClick={r('LAYON')} />
            <SmallButton icon={<Sun className="size-4 text-[#f5c542]" />} label="Thaw All Layers" iconOnly title="Thaw All Layers (LAYTHW)" onClick={r('LAYTHW')} />
          </div>
        </div>
      </Panel>
      <Panel title="Block">
        <BigButton icon={<Icons.insert />} label="Insert" title="Insert (I)" onClick={r('INSERT')} />
        <Col>
          <SmallButton icon={<Icons.block />} label="Create" title="Create Block (B)" onClick={r('BLOCK')} />
        </Col>
      </Panel>
      <Panel title="Properties" onExpand={() => p.togglePalette('properties')}>
        <BigButton icon={<Icons.matchprop />} label="Match" title="Match Properties (MA)" onClick={r('MATCHPROP')} />
        <div className="flex flex-col gap-0.5 pt-0.5">
          {colorDropdown}
          {lwDropdown}
          {ltDropdown}
        </div>
      </Panel>
      <Panel title="Utilities">
        <BigButton
          icon={<Icons.measure />}
          label="Measure"
          title="Measure Distance (DI)"
          menu={
            <>
              <MenuItem icon={<Icons.measure />} onSelect={r('DIST')}>Distance</MenuItem>
              <MenuItem icon={<Icons.area />} onSelect={r('AREA')}>Area</MenuItem>
              <MenuItem icon={<Icons.id />} onSelect={r('ID')}>ID Point</MenuItem>
              <MenuItem icon={<Icons.list />} onSelect={r('LIST')}>List</MenuItem>
            </>
          }
        />
      </Panel>
      <Panel title="Assistant">
        <BigButton icon={<Icons.assistant />} label="Ask AI" title="Assistant (Ctrl+Shift+A)" onClick={() => p.togglePalette('assistant')} active={p.palettes.assistant} />
      </Panel>
    </>
  );

  const insert = (
    <>
      <Panel title="Block">
        <BigButton icon={<Icons.insert />} label="Insert" title="Insert (I)" onClick={r('INSERT')} />
        <BigButton icon={<Icons.block />} label="Create Block" title="Create Block (B)" onClick={r('BLOCK')} />
      </Panel>
      <Panel title="Clipboard">
        <BigButton icon={<Icons.paste />} label="Paste" title="Paste (Ctrl+V)" onClick={r('PASTECLIP')} />
        <Col>
          <SmallButton icon={<Icons.copyclip />} label="Copy Clip" title="Copy Clip (Ctrl+C)" onClick={r('COPYCLIP')} />
          <SmallButton icon={<Icons.copyclip />} label="Copy with Base Point" title="Copy with Base Point" onClick={r('COPYBASE')} />
          <SmallButton icon={<Icons.cut />} label="Cut" title="Cut (Ctrl+X)" onClick={r('CUTCLIP')} />
        </Col>
      </Panel>
    </>
  );

  const annotate = (
    <>
      <Panel title="Text">
        <BigButton
          icon={<Icons.mtext />}
          label="Multiline Text"
          title="Multiline Text (T)"
          onClick={r('MTEXT')}
        />
        <BigButton icon={<Icons.text />} label="Single Line" title="Single Line Text (DT)" onClick={r('TEXT')} />
        <div className="flex flex-col gap-1 pt-0.5">
          {textStyleDd}
          <label className="flex items-center gap-1.5 text-[11.5px] text-[#c4ccd7]">
            Height
            <input
              key={d.header.textsize}
              defaultValue={String(d.header.textsize)}
              aria-label="Text height"
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  const v = parseFloat((e.target as HTMLInputElement).value);
                  if (v > 0) p.setTextHeight(v);
                }
              }}
              onBlur={(e) => {
                const v = parseFloat(e.target.value);
                if (v > 0 && v !== d.header.textsize) p.setTextHeight(v);
              }}
              className={cn(FIELD, 'w-[104px]')}
            />
          </label>
        </div>
      </Panel>
      <Panel title="Dimensions">
        <BigButton icon={<Icons.dimlinear />} label="Dimension" title="Linear Dimension (DLI)" onClick={r('DIMLINEAR')} menu={dimMenu} />
        <Col>
          <SmallButton icon={<Icons.dimaligned />} label="Aligned" title="Aligned (DAL)" onClick={r('DIMALIGNED')} />
          <SmallButton icon={<Icons.dimangular />} label="Angular" title="Angular (DAN)" onClick={r('DIMANGULAR')} />
          <SmallButton icon={<Icons.dimdiameter />} label="Diameter" title="Diameter (DDI)" onClick={r('DIMDIAMETER')} />
        </Col>
        <div className="flex flex-col gap-1 pt-0.5">{dimStyleDd}</div>
      </Panel>
      <Panel title="Leaders">
        <BigButton icon={<Icons.leader />} label="Leader" title="Leader (LE)" onClick={r('LEADER')} />
      </Panel>
    </>
  );

  const view = (
    <>
      <Panel title="Navigate">
        <BigButton icon={<Icons.zoomExtents />} label="Extents" title="Zoom Extents (Z E)" onClick={r('ZOOM E')} />
        <Col>
          <SmallButton icon={<Icons.zoomWindow />} label="Window" title="Zoom Window" onClick={r('ZOOM W')} />
          <SmallButton icon={<Icons.zoomPrevious />} label="Previous" title="Zoom Previous" onClick={r('ZOOM P')} />
          <SmallButton icon={<Icons.pan />} label="Pan" title="Pan (P)" onClick={r('PAN')} />
        </Col>
      </Panel>
      <Panel title="Palettes">
        <BigButton icon={<Icons.properties />} label="Properties" title="Properties (Ctrl+1)" onClick={() => p.togglePalette('properties')} active={p.palettes.properties} />
        <BigButton icon={<Icons.layers />} label="Layer Properties" title="Layer Properties (LA)" onClick={() => p.togglePalette('layers')} active={p.palettes.layers} />
        <BigButton icon={<Icons.assistant />} label="Assistant" title="Assistant (Ctrl+Shift+A)" onClick={() => p.togglePalette('assistant')} active={p.palettes.assistant} />
      </Panel>
      <Panel title="Interface">
        <BigButton icon={<span className={cn('size-6 rounded-[3px] border-2', p.dark ? 'border-[#c4ccd7] bg-[#212830]' : 'border-[#555] bg-white')} />} label={p.dark ? 'Dark' : 'Light'} title="Model space background" onClick={p.toggleDark} />
        <Col>
          <SmallButton icon={<Icons.units />} label="Units" title="Units (UN)" onClick={r('UNITS')} />
          <SmallButton icon={<Icons.gear />} label="Drafting Settings" title="Drafting Settings (DS)" onClick={r('DSETTINGS')} />
          <SmallButton icon={<Icons.list />} label="Text Window" title="Text Window (F2)" onClick={r('TEXTSCR')} />
        </Col>
      </Panel>
    </>
  );

  const hatchTab = (
    <>
      <Panel title="Boundaries">
        <BigButton icon={<Icons.hatch />} label="Pick Points" title="Click inside an area" onClick={() => {}} active />
      </Panel>
      <Panel title="Pattern">
        <div className="grid max-h-[68px] grid-cols-[repeat(6,40px)] gap-1 overflow-y-auto pr-1">
          {['SOLID', ...Object.keys(PATTERNS)].map((name) => (
            <button
              key={name}
              type="button"
              title={name === 'SOLID' ? 'Solid fill' : `${name} — ${PATTERNS[name].description}`}
              aria-label={name}
              aria-pressed={p.hatch.pattern === name}
              onMouseDown={keepFocus}
              onClick={() => p.setHatch({ ...p.hatch, pattern: name })}
              className={cn('grid h-8 w-10 place-items-center rounded-[2px] border bg-[#262c34] text-[9px]', p.hatch.pattern === name ? 'border-[#3fa9f5]' : 'border-[#4f5865] hover:border-[#6f7b8b]')}
            >
              <PatternSwatch name={name} />
            </button>
          ))}
        </div>
      </Panel>
      <Panel title="Properties">
        <div className="flex flex-col gap-1 pt-0.5 text-[11.5px] text-[#c4ccd7]">
          <label className="flex items-center justify-between gap-2">
            Angle
            <input key={`a${p.hatch.angle}`} defaultValue={p.hatch.angle} aria-label="Hatch angle" onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => p.setHatch({ ...p.hatch, angle: parseFloat(e.target.value) || 0 })} className={cn(FIELD, 'w-20')} />
          </label>
          <label className="flex items-center justify-between gap-2">
            Scale
            <input key={`s${p.hatch.scale}`} defaultValue={p.hatch.scale} aria-label="Hatch scale" onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => p.setHatch({ ...p.hatch, scale: parseFloat(e.target.value) > 0 ? parseFloat(e.target.value) : p.hatch.scale })} className={cn(FIELD, 'w-20')} />
          </label>
        </div>
      </Panel>
      <Panel title="Close">
        <BigButton icon={<Icons.close className="text-[#ff6b6b]" />} label="Close Hatch Creation" onClick={p.finishHatch} />
      </Panel>
    </>
  );

  const body = { home, insert, annotate, view, hatch: hatchTab }[p.tab];
  return (
    <div className="shrink-0 select-none" onMouseDown={keepFocus}>
      <div role="tablist" aria-label="Ribbon tabs" className="flex h-[26px] items-end gap-0.5 bg-[#2a3039] px-2">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={p.tab === id}
            onClick={() => (p.collapsed ? (p.setTab(id), p.setCollapsed(false)) : p.setTab(id))}
            onDoubleClick={() => p.setCollapsed(!p.collapsed)}
            className={cn(
              'h-[23px] rounded-t-[3px] px-3 text-[12px]',
              p.tab === id && !p.collapsed ? 'bg-[#38404c] text-white' : 'text-[#c4ccd7] hover:bg-[#343b46] hover:text-white',
              id === 'hatch' && 'text-[#7fd4ff]',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#3fa9f5]',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {!p.collapsed && <div className="flex h-[90px] overflow-x-auto overflow-y-hidden bg-[#38404c] [scrollbar-width:none]">{body}</div>}
    </div>
  );
}

export function PatternSwatch({ name }: { name: string }) {
  if (name === 'SOLID') return <span className="block h-6 w-8 bg-[#c4ccd7]" />;
  const def = PATTERNS[name];
  if (!def) return <span>{name}</span>;
  const lines: React.ReactNode[] = [];
  let k = 0;
  for (const [deg, x0, y0, dx, dy, ...dashes] of def.lines) {
    const a = (deg * Math.PI) / 180;
    const u = { x: Math.cos(a), y: Math.sin(a) };
    const n = { x: -u.y, y: u.x };
    const s = 24;
    const off = { x: (dx * u.x - dy * u.y) * s, y: (dx * u.y + dy * u.x) * s };
    const spacing = Math.abs(off.x * n.x + off.y * n.y);
    if (spacing < 0.5) continue;
    for (let i = -12; i <= 12; i++) {
      const ox = x0 * s + off.x * i;
      const oy = y0 * s + off.y * i;
      lines.push(<line key={k++} x1={ox - u.x * 40} y1={oy - u.y * 40} x2={ox + u.x * 40} y2={oy + u.y * 40} strokeDasharray={dashes.length ? dashes.map((x) => Math.max(0.6, Math.abs(x) * s)).join(' ') : undefined} />);
    }
  }
  return (
    <svg viewBox="0 0 32 24" className="h-6 w-8" stroke="#c4ccd7" strokeWidth={0.8} aria-hidden>
      <g transform="translate(0 24) scale(1 -1)">{lines}</g>
    </svg>
  );
}
