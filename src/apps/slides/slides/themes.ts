import { OFFICE_THEME, type ThemeColorName } from '@/shared/office/theme';

/** Design > Variants > Colors: Office's built-in color sets. */
export const COLOR_SETS: { name: string; colors: Record<ThemeColorName, string> }[] = [
  { name: 'Office', colors: OFFICE_THEME.colors },
  ...(
    [
      ['Office 2007 - 2010', '1F497D', 'EEECE1', ['4F81BD', 'C0504D', '9BBB59', '8064A2', '4BACC6', 'F79646'], '0000FF', '800080'],
      ['Grayscale', '000000', 'F8F8F8', ['DDDDDD', 'B2B2B2', '969696', '808080', '5F5F5F', '4D4D4D'], '5F5F5F', '919191'],
      ['Blue', '17406D', 'DBEFF9', ['0F6FC6', '009DD9', '0BD0D9', '10CF9B', '7CCA62', 'A5C249'], 'F49100', '85DFD0'],
      ['Green', '455F51', 'E3DED1', ['549E39', '8AB833', 'C0CF3A', '029676', '4AB5C4', '0989B1'], '6B9F25', 'BA6906'],
      ['Yellow', '39302A', 'E5DEDB', ['FFCA08', 'F8931D', 'CE8D3E', 'EC7016', 'E64823', '9C6A6A'], '2998E3', '7F723D'],
      ['Orange', '637052', 'CCDDEA', ['E48312', 'BD582C', '865640', '9B8357', 'C2BC80', '94A088'], '2998E3', '8C8C8C'],
      ['Red', '323232', 'E5C243', ['A5300F', 'D55816', 'E19825', 'B19C7D', '7F5F52', 'B27D49'], '6B9F25', 'B26B02'],
      ['Violet', '373545', 'DCD8DC', ['AD84C6', '8784C7', '5D739A', '6997AF', '84ACB6', '6F8183'], '69A020', '8C8C8C'],
      ['Paper', '444D26', 'FEFAC9', ['A5B592', 'F3A447', 'E7BC29', 'D092A7', '9C85C0', '809EC2'], '8E58B6', '7F6F6F'],
      ['Marquee', '5E5E5E', 'DDDDDD', ['418AB3', 'A6B727', 'F69200', '838383', 'FEC306', 'DF5327'], 'F59E00', 'B2B2B2'],
    ] as [string, string, string, string[], string, string][]
  ).map(([name, dk2, lt2, a, hlink, folHlink]) => ({
    name,
    colors: { dk1: '000000', lt1: 'FFFFFF', dk2, lt2, accent1: a[0], accent2: a[1], accent3: a[2], accent4: a[3], accent5: a[4], accent6: a[5], hlink, folHlink },
  })),
];

/** Design > Variants > Fonts: [name, headings, body]. */
export const FONT_SETS: [string, string, string][] = [
  ['Office', 'Calibri Light', 'Calibri'],
  ['Office 2007 - 2010', 'Cambria', 'Calibri'],
  ['Calibri', 'Calibri', 'Calibri'],
  ['Arial', 'Arial', 'Arial'],
  ['Cambria', 'Cambria', 'Cambria'],
  ['Georgia', 'Georgia', 'Georgia'],
  ['Times New Roman', 'Times New Roman', 'Times New Roman'],
  ['Trebuchet MS', 'Trebuchet MS', 'Trebuchet MS'],
  ['Verdana', 'Verdana', 'Verdana'],
  ['Segoe UI', 'Segoe UI', 'Segoe UI'],
  ['Garamond', 'Garamond', 'Garamond'],
];
