/**
 * PowerPoint's built-in table styles aren't written into files that use
 * them (tableStyles.xml often only names the default), so the ones a new
 * table gets — Medium Style 2 in each accent — are defined here, in the
 * same XML Office writes when it does spell them out.
 */

export const MEDIUM_STYLE_2: Record<string, string> = {
  dk1: '{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}',
  accent1: '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}',
  accent2: '{21E4AEA4-8DFA-4A89-87EB-49C32662AFE8}',
  accent3: '{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}',
  accent4: '{00A15C55-8517-42AA-B614-E9B94910E393}',
  accent5: '{7DF18680-E054-41AD-8BC1-D1AEF772440D}',
  accent6: '{93296810-A885-4BE3-A3E7-6D5BEEA58F35}',
};

export const DEFAULT_TABLE_STYLE = MEDIUM_STYLE_2.accent1;

export function tableStyleXml(accent: string): string {
  const id = MEDIUM_STYLE_2[accent];
  const name = accent === 'dk1' ? 'Medium Style 2' : `Medium Style 2 - Accent ${accent.slice(-1)}`;
  const ln = (w: number) => `<a:ln w="${w}" cmpd="sng"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln>`;
  const sides = ['left', 'right', 'top', 'bottom', 'insideH', 'insideV'].map((s) => `<a:${s}>${ln(12700)}</a:${s}>`).join('');
  const fill = (mods: string) => `<a:fill><a:solidFill><a:schemeClr val="${accent}">${mods}</a:schemeClr></a:solidFill></a:fill>`;
  const boldTx = '<a:tcTxStyle b="on"><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="lt1"/></a:tcTxStyle>';
  return (
    `<a:tblStyle styleId="${id}" styleName="${name}">` +
    `<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr>${sides}</a:tcBdr>${fill('<a:tint val="20000"/>')}</a:tcStyle></a:wholeTbl>` +
    `<a:band1H><a:tcStyle><a:tcBdr/>${fill('<a:tint val="40000"/>')}</a:tcStyle></a:band1H><a:band2H><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2H>` +
    `<a:band1V><a:tcStyle><a:tcBdr/>${fill('<a:tint val="40000"/>')}</a:tcStyle></a:band1V><a:band2V><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2V>` +
    `<a:lastCol>${boldTx}<a:tcStyle><a:tcBdr/>${fill('')}</a:tcStyle></a:lastCol>` +
    `<a:firstCol>${boldTx}<a:tcStyle><a:tcBdr/>${fill('')}</a:tcStyle></a:firstCol>` +
    `<a:lastRow>${boldTx}<a:tcStyle><a:tcBdr><a:top>${ln(38100)}</a:top></a:tcBdr>${fill('')}</a:tcStyle></a:lastRow>` +
    `<a:firstRow>${boldTx}<a:tcStyle><a:tcBdr><a:bottom>${ln(38100)}</a:bottom></a:tcBdr>${fill('')}</a:tcStyle></a:firstRow>` +
    '</a:tblStyle>'
  );
}

export function tableStyleListXml(body = ''): string {
  return `<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="${DEFAULT_TABLE_STYLE}">${body}</a:tblStyleLst>`;
}
