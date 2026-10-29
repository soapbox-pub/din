import { strToU8 } from 'fflate';
import { fmtNum } from './geom';
import { IDML_MIME, IDPKG_NS, parseXml, type Pkg } from './idml';
import { unitToIdml, type Unit } from './units';

/**
 * A new document, written as the IDML InDesign itself would start with:
 * the designmap, a master spread, the pages, default swatches and styles,
 * and preferences for the page size, margins, columns and bleed.
 */

export interface NewDocSettings {
  width: number;
  height: number;
  pages: number;
  facing: boolean;
  startPage: number;
  columns: number;
  gutter: number;
  margins: { top: number; bottom: number; inside: number; outside: number };
  bleed: { top: number; bottom: number; inside: number; outside: number };
  unit: Unit;
  primaryTextFrame: boolean;
}

export const PRESETS: { name: string; w: number; h: number; unit: Unit }[] = [
  { name: 'Letter', w: 612, h: 792, unit: 'in' },
  { name: 'Legal', w: 612, h: 1008, unit: 'in' },
  { name: 'Tabloid', w: 792, h: 1224, unit: 'in' },
  { name: 'A4', w: 595.276, h: 841.89, unit: 'mm' },
  { name: 'A5', w: 419.528, h: 595.276, unit: 'mm' },
  { name: 'A3', w: 841.89, h: 1190.551, unit: 'mm' },
];

const DOM = '18.0';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const n = fmtNum;
const head = (kind: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<idPkg:${kind} xmlns:idPkg="${IDPKG_NS}" DOMVersion="${DOM}">`;

function pageXml(self: string, name: string, s: NewDocSettings, x: number, master: string, left: boolean): string {
  const ml = left ? s.margins.outside : s.margins.inside;
  const mr = left ? s.margins.inside : s.margins.outside;
  const inner = s.width - ml - mr;
  const cw = (inner - s.gutter * (s.columns - 1)) / s.columns;
  const positions: number[] = [];
  for (let i = 0; i < s.columns; i++) positions.push(i * (cw + s.gutter), i * (cw + s.gutter) + cw);
  return `
		<Page Self="${self}" GeometricBounds="0 0 ${n(s.height)} ${n(s.width)}" ItemTransform="1 0 0 1 ${n(x)} ${n(-s.height / 2)}" Name="${esc(name)}" AppliedTrapPreset="TrapPreset/$ID/kDefaultTrapStyleName" OverrideList="" AppliedMaster="${master}" MasterPageTransform="1 0 0 1 0 0" TabOrder="" GridStartingPoint="TopOutside" UseMasterGrid="true">
			<Properties>
				<PageColor type="enumeration">UseMasterColor</PageColor>
			</Properties>
			<MarginPreference ColumnCount="${s.columns}" ColumnGutter="${n(s.gutter)}" Top="${n(s.margins.top)}" Bottom="${n(s.margins.bottom)}" Left="${n(s.margins.inside)}" Right="${n(s.margins.outside)}" ColumnDirection="Horizontal" ColumnsPositions="${positions.map(n).join(' ')}"/>
		</Page>`;
}

function textFrameXml(self: string, story: string, s: NewDocSettings, pageX: number, left: boolean, layer: string, prev: string, next: string): string {
  const ml = left ? s.margins.outside : s.margins.inside;
  const mr = left ? s.margins.inside : s.margins.outside;
  const x0 = pageX + ml;
  const x1 = pageX + s.width - mr;
  const y0 = -s.height / 2 + s.margins.top;
  const y1 = s.height / 2 - s.margins.bottom;
  const pt = (x: number, y: number) => `<PathPointType Anchor="${n(x)} ${n(y)}" LeftDirection="${n(x)} ${n(y)}" RightDirection="${n(x)} ${n(y)}"/>`;
  return `
		<TextFrame Self="${self}" ParentStory="${story}" PreviousTextFrame="${prev}" NextTextFrame="${next}" ContentType="TextType" ItemLayer="${layer}" Locked="false" AppliedObjectStyle="ObjectStyle/$ID/[Normal Text Frame]" Visible="true" Name="$ID/" ItemTransform="1 0 0 1 0 0">
			<Properties>
				<PathGeometry>
					<GeometryPathType PathOpen="false">
						<PathPointArray>
							${pt(x0, y0)}
							${pt(x0, y1)}
							${pt(x1, y1)}
							${pt(x1, y0)}
						</PathPointArray>
					</GeometryPathType>
				</PathGeometry>
			</Properties>
			<TextFramePreference TextColumnCount="${s.columns}" TextColumnGutter="${n(s.gutter)}" TextColumnFixedWidth="${n((x1 - x0 - s.gutter * (s.columns - 1)) / s.columns)}"/>
		</TextFrame>`;
}

const COLORS: [string, string, string][] = [
  ['C=100 M=0 Y=0 K=0', 'CMYK', '100 0 0 0'],
  ['C=0 M=100 Y=0 K=0', 'CMYK', '0 100 0 0'],
  ['C=0 M=0 Y=100 K=0', 'CMYK', '0 0 100 0'],
  ['C=15 M=100 Y=100 K=0', 'CMYK', '15 100 100 0'],
  ['C=75 M=5 Y=100 K=0', 'CMYK', '75 5 100 0'],
  ['C=100 M=90 Y=10 K=0', 'CMYK', '100 90 10 0'],
];

export function newDocument(s: NewDocSettings): Pkg {
  let id = 0x100;
  const nid = () => `u${(id++).toString(16)}`;
  const layer = nid();
  const masterSelf = nid();
  const masterPages = s.facing ? [nid(), nid()] : [nid()];
  const sectionSelf = nid();

  // Pages into spreads: a first right-hand page, then pairs, when pages face.
  const pageIds = Array.from({ length: s.pages }, () => nid());
  const groups: string[][] = [];
  if (s.facing) {
    const firstLeft = s.startPage % 2 === 0;
    let i = 0;
    if (!firstLeft) groups.push([pageIds[i++]]);
    for (; i < pageIds.length; i += 2) groups.push(pageIds.slice(i, i + 2));
  } else for (const p of pageIds) groups.push([p]);

  const stories: { self: string; frames: string[] }[] = [];
  const spreads: { self: string; xml: string }[] = [];
  let pageNo = s.startPage;
  const allFrames: { frame: string; story: string }[] = [];
  const primaryStory = s.primaryTextFrame ? nid() : null;
  if (primaryStory) stories.push({ self: primaryStory, frames: [] });
  for (const g of groups) {
    const self = nid();
    const left = s.facing && (g.length === 2 || pageNo % 2 === 0);
    let x = s.facing ? (left ? -s.width : 0) : 0;
    let pagesXml = '';
    let framesXml = '';
    const frameIds: string[] = [];
    for (let k = 0; k < g.length; k++) {
      const isLeft = s.facing && x < 0;
      pagesXml += pageXml(g[k], String(pageNo), s, x, masterSelf, isLeft);
      if (primaryStory) {
        const f = nid();
        frameIds.push(f);
        allFrames.push({ frame: f, story: primaryStory });
        framesXml += `@@FRAME:${f}:${x}:${isLeft ? 1 : 0}@@`;
      }
      x += s.width;
      pageNo++;
    }
    spreads.push({
      self,
      xml: `${head('Spread')}
	<Spread Self="${self}" FlattenerOverride="Default" AllowPageShuffle="true" ItemTransform="1 0 0 1 0 0" ShowMasterItems="true" PageCount="${g.length}" BindingLocation="${s.facing && g.length === 2 ? 1 : s.facing && left ? 1 : 0}" PageTransitionType="None" PageTransitionDirection="NotApplicable" PageTransitionDuration="Medium">
		<FlattenerPreference LineArtAndTextResolution="300" GradientAndMeshResolution="150" ClipComplexRegions="false" ConvertAllStrokesToOutlines="false" ConvertAllTextToOutlines="false">
			<Properties>
				<RasterVectorBalance type="double">50</RasterVectorBalance>
			</Properties>
		</FlattenerPreference>${pagesXml}${framesXml}
	</Spread>
</idPkg:Spread>`,
    });
  }
  // Text frames, threaded page to page.
  if (primaryStory) {
    for (const sp of spreads) {
      sp.xml = sp.xml.replace(/@@FRAME:(u[0-9a-f]+):(-?[\d.]+):(\d)@@/g, (_m, f: string, x: string, l: string) => {
        const i = allFrames.findIndex((a) => a.frame === f);
        return textFrameXml(f, primaryStory, s, parseFloat(x), l === '1', layer, allFrames[i - 1]?.frame ?? 'n', allFrames[i + 1]?.frame ?? 'n');
      });
    }
  }

  const master = `${head('MasterSpread')}
	<MasterSpread Self="${masterSelf}" ItemTransform="1 0 0 1 0 0" OverriddenPageItemProps="" Name="A-Master" NamePrefix="A" BaseName="Master" ShowMasterItems="true" PageCount="${masterPages.length}">
		<Properties>
			<PageColor type="enumeration">UseMasterColor</PageColor>
		</Properties>${masterPages.map((p, i) => pageXml(p, 'A', s, s.facing ? (i === 0 ? -s.width : 0) : 0, 'n', s.facing && i === 0)).join('')}
	</MasterSpread>
</idPkg:MasterSpread>`;

  const graphic = `${head('Graphic')}
	<Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" ColorOverride="Specialblack" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Black" ColorEditable="false" ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/>
	<Color Self="Color/Cyan" Model="Process" Space="CMYK" ColorValue="100 0 0 0" ColorOverride="Hiddenreserved" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Cyan" ColorEditable="false" ColorRemovable="false" Visible="false" SwatchCreatorID="7937"/>
	<Color Self="Color/Magenta" Model="Process" Space="CMYK" ColorValue="0 100 0 0" ColorOverride="Hiddenreserved" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Magenta" ColorEditable="false" ColorRemovable="false" Visible="false" SwatchCreatorID="7937"/>
	<Color Self="Color/Paper" Model="Process" Space="CMYK" ColorValue="0 0 0 0" ColorOverride="Specialpaper" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Paper" ColorEditable="true" ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/>
	<Color Self="Color/Registration" Model="Registration" Space="CMYK" ColorValue="100 100 100 100" ColorOverride="Specialregistration" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Registration" ColorEditable="false" ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/>
	<Color Self="Color/Yellow" Model="Process" Space="CMYK" ColorValue="0 0 100 0" ColorOverride="Hiddenreserved" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Yellow" ColorEditable="false" ColorRemovable="false" Visible="false" SwatchCreatorID="7937"/>
${COLORS.map(([name, space, v]) => `	<Color Self="Color/${name}" Model="Process" Space="${space}" ColorValue="${v}" ColorOverride="Normal" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="${name}" ColorEditable="true" ColorRemovable="true" Visible="true" SwatchCreatorID="7937"/>`).join('\n')}
	<Ink Self="Ink/$ID/Process Cyan" Name="$ID/Process Cyan" Angle="75" ConvertToProcess="false" Frequency="70" NeutralDensity="0.61" PrintInk="true" TrapOrder="1" InkType="Normal"/>
	<Ink Self="Ink/$ID/Process Magenta" Name="$ID/Process Magenta" Angle="15" ConvertToProcess="false" Frequency="70" NeutralDensity="0.76" PrintInk="true" TrapOrder="2" InkType="Normal"/>
	<Ink Self="Ink/$ID/Process Yellow" Name="$ID/Process Yellow" Angle="0" ConvertToProcess="false" Frequency="70" NeutralDensity="0.16" PrintInk="true" TrapOrder="3" InkType="Normal"/>
	<Ink Self="Ink/$ID/Process Black" Name="$ID/Process Black" Angle="45" ConvertToProcess="false" Frequency="70" NeutralDensity="1.7" PrintInk="true" TrapOrder="4" InkType="Normal"/>
	<Gradient Self="Gradient/u${(id++).toString(16)}" Type="Linear" Name="$ID/" ColorEditable="true" ColorRemovable="true" Visible="false" SwatchCreatorID="7937">
		<GradientStop Self="GradientStop/a0" StopColor="Color/Paper" Location="0"/>
		<GradientStop Self="GradientStop/a1" StopColor="Color/Black" Location="100" Midpoint="50"/>
	</Gradient>
	<StrokeStyle Self="StrokeStyle/$ID/Solid" Name="$ID/Solid"/>
	<StrokeStyle Self="StrokeStyle/$ID/Dashed" Name="$ID/Dashed"/>
	<StrokeStyle Self="StrokeStyle/$ID/Canned Dotted" Name="$ID/Canned Dotted"/>
	<Swatch Self="Swatch/None" Name="None" ColorEditable="false" ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/>
</idPkg:Graphic>`;

  const styles = `${head('Styles')}
	<RootCharacterStyleGroup Self="u79">
		<CharacterStyle Self="CharacterStyle/$ID/[No character style]" Imported="false" Name="$ID/[No character style]"/>
	</RootCharacterStyleGroup>
	<RootParagraphStyleGroup Self="u78">
		<ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]" Imported="false" FillColor="Color/Black" FontStyle="Regular" PointSize="12" HorizontalScale="100" KerningMethod="$ID/Metrics" Ligatures="true" StrokeWeight="1" Tracking="0" DropCapCharacters="0" DropCapLines="0" BaselineShift="0" Capitalization="Normal" StrokeColor="Swatch/None" VerticalScale="100" LeftIndent="0" RightIndent="0" FirstLineIndent="0" AutoLeading="120" AppliedLanguage="$ID/English: USA" Hyphenation="true" SpaceBefore="0" SpaceAfter="0" Underline="false" Position="Normal" StrikeThru="false" Justification="LeftAlign" Skew="0" FillTint="-1" StrokeTint="-1" StartParagraph="Anywhere" BulletsAndNumberingListType="NoList">
			<Properties>
				<Leading type="enumeration">Auto</Leading>
				<TabList type="list"></TabList>
				<AppliedFont type="string">Minion Pro</AppliedFont>
			</Properties>
		</ParagraphStyle>
		<ParagraphStyle Self="ParagraphStyle/$ID/NormalParagraphStyle" Name="$ID/NormalParagraphStyle" Imported="false" NextStyle="ParagraphStyle/$ID/NormalParagraphStyle" KeyboardShortcut="0 0">
			<Properties>
				<BasedOn type="string">$ID/[No paragraph style]</BasedOn>
				<PreviewColor type="enumeration">Nothing</PreviewColor>
			</Properties>
		</ParagraphStyle>
	</RootParagraphStyleGroup>
	<TOCStyle Self="TOCStyle/$ID/DefaultTOCStyleName" TitleStyle="ParagraphStyle/$ID/[No paragraph style]" Title="Contents" Name="$ID/DefaultTOCStyleName" RunIn="false" IncludeHidden="false" IncludeBookDocuments="false" CreateBookmarks="true" SetStoryDirection="Horizontal" NumberedParagraphs="IncludeFullParagraph" RemoveForcedLineBreak="false" MakeAnchor="false"/>
	<RootCellStyleGroup Self="u7e">
		<CellStyle Self="CellStyle/$ID/[None]" AppliedParagraphStyle="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[None]"/>
	</RootCellStyleGroup>
	<RootTableStyleGroup Self="u80">
		<TableStyle Self="TableStyle/$ID/[No table style]" Name="$ID/[No table style]"/>
		<TableStyle Self="TableStyle/$ID/[Basic Table]" Name="$ID/[Basic Table]">
			<Properties>
				<BasedOn type="string">$ID/[No table style]</BasedOn>
			</Properties>
		</TableStyle>
	</RootTableStyleGroup>
	<RootObjectStyleGroup Self="u8a">
		<ObjectStyle Self="ObjectStyle/$ID/[None]" Name="$ID/[None]" AppliedParagraphStyle="ParagraphStyle/$ID/[No paragraph style]" FillColor="Swatch/None" FillTint="-1" StrokeWeight="0" StrokeType="StrokeStyle/$ID/Solid" StrokeColor="Swatch/None" StrokeTint="-1" StrokeAlignment="CenterAlignment" CornerRadius="12" CornerOption="None">
			<TextFramePreference TextColumnCount="1" TextColumnGutter="12" FirstBaselineOffset="AscentOffset" VerticalJustification="TopAlign"/>
		</ObjectStyle>
		<ObjectStyle Self="ObjectStyle/$ID/[Normal Graphics Frame]" Name="$ID/[Normal Graphics Frame]" FillColor="Swatch/None" StrokeWeight="1" StrokeColor="Color/Black" StrokeType="StrokeStyle/$ID/Solid">
			<Properties>
				<BasedOn type="string">$ID/[None]</BasedOn>
			</Properties>
		</ObjectStyle>
		<ObjectStyle Self="ObjectStyle/$ID/[Normal Text Frame]" Name="$ID/[Normal Text Frame]" AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle" FillColor="Swatch/None" StrokeWeight="1" StrokeColor="Swatch/None">
			<Properties>
				<BasedOn type="string">$ID/[None]</BasedOn>
			</Properties>
		</ObjectStyle>
		<ObjectStyle Self="ObjectStyle/$ID/[Normal Grid]" Name="$ID/[Normal Grid]">
			<Properties>
				<BasedOn type="string">$ID/[None]</BasedOn>
			</Properties>
		</ObjectStyle>
	</RootObjectStyleGroup>
</idPkg:Styles>`;

  const unit = unitToIdml(s.unit);
  const prefs = `${head('Preferences')}
	<DocumentPreference PageHeight="${n(s.height)}" PageWidth="${n(s.width)}" PagesPerDocument="${s.pages}" FacingPages="${s.facing}" DocumentBleedTopOffset="${n(s.bleed.top)}" DocumentBleedBottomOffset="${n(s.bleed.bottom)}" DocumentBleedInsideOrLeftOffset="${n(s.bleed.inside)}" DocumentBleedOutsideOrRightOffset="${n(s.bleed.outside)}" DocumentBleedUniformSize="${s.bleed.top === s.bleed.bottom && s.bleed.top === s.bleed.inside && s.bleed.top === s.bleed.outside}" SlugTopOffset="0" SlugBottomOffset="0" SlugInsideOrLeftOffset="0" SlugRightOrOutsideOffset="0" DocumentSlugUniformSize="false" PreserveLayoutWhenShuffling="true" AllowPageShuffle="true" OverprintBlack="true" PageBinding="LeftToRight" ColumnDirection="Horizontal" ColumnGuideLocked="true" MasterTextFrame="${s.primaryTextFrame}" SnippetImportUsesOriginalLocation="false" Intent="PrintIntent" CreatePrimaryTextFrame="${s.primaryTextFrame}" StartPageNumber="${s.startPage}"/>
	<MarginPreference ColumnCount="${s.columns}" ColumnGutter="${n(s.gutter)}" Top="${n(s.margins.top)}" Bottom="${n(s.margins.bottom)}" Left="${n(s.margins.inside)}" Right="${n(s.margins.outside)}" ColumnDirection="Horizontal" ColumnsPositions="0 ${n(s.width - s.margins.inside - s.margins.outside)}"/>
	<ViewPreference PointsPerInch="72" HorizontalCustomPoints="12" VerticalCustomPoints="12" HorizontalMeasurementUnits="${unit}" VerticalMeasurementUnits="${unit}" RulerOrigin="SpreadOrigin" ShowRulers="true" ShowFrameEdges="true" CursorKeyIncrement="1" GuideSnaptoZone="4" LineMeasurementUnits="Points" TypographicMeasurementUnits="Points" TextSizeMeasurementUnits="Points" PrintDialogMeasurementUnits="Points" StrokeMeasurementUnits="Points"/>
	<GuidePreference GuidesInBack="false" GuidesShown="true" GuidesLocked="false" GuidesSnapto="true" RulerGuidesViewThreshold="5">
		<Properties>
			<RulerGuidesColor type="enumeration">Cyan</RulerGuidesColor>
		</Properties>
	</GuidePreference>
	<TextPreference TypographersQuotes="true" SuperscriptSize="58.3" SuperscriptPosition="33.3" SubscriptSize="58.3" SubscriptPosition="33.3" SmallCap="70"/>
	<TextDefault AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle" AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"/>
	<PasteboardPreference PasteboardMargins="-1 72" MinimumSpaceAboveAndBelow="72"/>
</idPkg:Preferences>`;

  const fonts = `${head('Fonts')}
</idPkg:Fonts>`;

  const storyXml = (self: string) => `${head('Story')}
	<Story Self="${self}" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/" AppliedNamedGrid="n">
		<StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12" FrameType="TextFrameType" StoryOrientation="Horizontal" StoryDirection="LeftToRightDirection"/>
		<InCopyExportOption IncludeGraphicProxies="true" IncludeAllResources="false"/>
		<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle">
			<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"/>
		</ParagraphStyleRange>
	</Story>
</idPkg:Story>`;

  const designmap = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<?aid style="50" type="document" readerVersion="6.0" featureSet="257" product="${DOM}(0)" ?>
<Document xmlns:idPkg="${IDPKG_NS}" DOMVersion="${DOM}" Self="d" StoryList="${stories.map((x) => x.self).join(' ')}" ZeroPoint="0 0" ActiveLayer="${layer}" CMYKProfile="U.S. Web Coated (SWOP) v2" RGBProfile="sRGB IEC61966-2.1" SolidColorIntent="UseColorSettings" AfterBlendingIntent="UseColorSettings" DefaultImageIntent="UseColorSettings" RGBPolicy="PreserveEmbeddedProfiles" CMYKPolicy="CombinationOfPreserveAndSafeCmyk" AccurateLABSpots="false">
	<Language Self="Language/$ID/English%3a USA" Name="$ID/English: USA" SingleQuotes="‘’" DoubleQuotes="“”" PrimaryLanguageName="$ID/English" SublanguageName="$ID/USA" Id="269" HyphenationVendor="Hunspell" SpellingVendor="Hunspell"/>
	<idPkg:Graphic src="Resources/Graphic.xml"/>
	<idPkg:Fonts src="Resources/Fonts.xml"/>
	<idPkg:Styles src="Resources/Styles.xml"/>
	<NumberingList Self="NumberingList/$ID/[Default]" Name="$ID/[Default]" ContinueNumbersAcrossStories="false" ContinueNumbersAcrossDocuments="false"/>
	<idPkg:Preferences src="Resources/Preferences.xml"/>
	<idPkg:Tags src="XML/Tags.xml"/>
	<Layer Self="${layer}" Name="Layer 1" Visible="true" Locked="false" IgnoreWrap="false" ShowGuides="true" LockGuides="false" UI="true" Expendable="true" Printable="true">
		<Properties>
			<LayerColor type="enumeration">LightBlue</LayerColor>
		</Properties>
	</Layer>
	<idPkg:MasterSpread src="MasterSpreads/MasterSpread_${masterSelf}.xml"/>
${spreads.map((sp) => `	<idPkg:Spread src="Spreads/Spread_${sp.self}.xml"/>`).join('\n')}
	<Section Self="${sectionSelf}" Length="${s.pages}" Name="" ContinueNumbering="false" IncludeSectionPrefix="false" PageNumberStart="${s.startPage}" Marker="" PageStart="${pageIds[0]}" SectionPrefix="">
		<Properties>
			<PageNumberStyle type="enumeration">Arabic</PageNumberStyle>
		</Properties>
	</Section>
	<idPkg:BackingStory src="XML/BackingStory.xml"/>
${stories.map((st) => `	<idPkg:Story src="Stories/Story_${st.self}.xml"/>`).join('\n')}
</Document>`;

  const tags = `${head('Tags')}
	<XMLTag Self="XMLTag/Root" Name="Root">
		<Properties>
			<TagColor type="enumeration">LightBlue</TagColor>
		</Properties>
	</XMLTag>
</idPkg:Tags>`;
  const backing = `${head('BackingStory')}
	<XmlStory Self="${nid()}" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/" AppliedNamedGrid="n">
		<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle">
			<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"/>
		</ParagraphStyleRange>
	</XmlStory>
</idPkg:BackingStory>`;
  const container = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
	<rootfiles>
		<rootfile full-path="designmap.xml" media-type="text/xml">
		</rootfile>
	</rootfiles>
</container>`;

  const xml = new Map<string, XMLDocument>();
  const order: string[] = ['mimetype'];
  const add = (name: string, text: string) => {
    xml.set(name, parseXml(text, name));
    order.push(name);
  };
  add('designmap.xml', designmap);
  add('META-INF/container.xml', container);
  add('Resources/Graphic.xml', graphic);
  add('Resources/Fonts.xml', fonts);
  add('Resources/Styles.xml', styles);
  add('Resources/Preferences.xml', prefs);
  add('XML/Tags.xml', tags);
  add(`MasterSpreads/MasterSpread_${masterSelf}.xml`, master);
  for (const sp of spreads) add(`Spreads/Spread_${sp.self}.xml`, sp.xml);
  add('XML/BackingStory.xml', backing);
  for (const st of stories) add(`Stories/Story_${st.self}.xml`, storyXml(st.self));
  return { xml, bin: new Map([['mimetype', strToU8(IDML_MIME)]]), order, ids: { next: id + 16 } };
}
