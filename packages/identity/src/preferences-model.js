import {canonicalLocale,isLocaleTag} from './locale-code.js';
const presets = [
  ['paper', 'Paper', 'light', '#123B36', '#F7F6F1', '#FFFFFF', '#FCFCF8', '#276A51', '#FFFFFF', '#E7F0E9', '#25352F', '#52655B', '#DCE3D8', '#E7EBE5', '#56655D'],
  ['light', 'Light', 'light', '#283442', '#F5F7FA', '#FFFFFF', '#FAFBFD', '#385772', '#FFFFFF', '#E8EEF5', '#253340', '#536576', '#D4DDE6', '#E5EBF0', '#526270'],
  ['ocean', 'Ocean', 'light', '#11364A', '#F0F6FA', '#FFFFFF', '#F7FBFD', '#17627E', '#FFFFFF', '#DDEDF5', '#203744', '#4D6575', '#C8DDE8', '#E1EBF1', '#506574'],
  ['lavender', 'Lavender', 'light', '#392B4A', '#F6F3FA', '#FFFEFF', '#FCFAFE', '#69508C', '#FFFFFF', '#EEE5F7', '#3B2E48', '#655C71', '#DFD5E9', '#EBE5F0', '#665A72'],
  ['forest', 'Forest', 'dark', '#091B15', '#10251E', '#17332A', '#132B23', '#99D3AF', '#10251E', '#234C3B', '#E8F2EC', '#AFC5B8', '#355548', '#294238', '#ADC1B4'],
  ['midnight', 'Midnight', 'dark', '#1F2022', '#1B1C1D', '#1B1C1D', '#232426', '#A8C6DF', '#17202A', '#303236', '#E9EAEC', '#A6A8AD', '#393B40', '#303236', '#A6A8AD']
];
const roles = ['rail', 'canvas', 'surface', 'nav', 'accent', 'on', 'soft', 'text', 'muted', 'border', 'disabledBg', 'disabledFg'];
export const THEMES = Object.freeze(presets.map(([id, name, kind, ...values]) => Object.freeze({ id, name, kind, colors: Object.freeze(Object.fromEntries(roles.map((role, index) => [role, values[index]]))) })));
export const FONT_OPTIONS = Object.freeze([
  { id: 'system', label: 'System', family: 'system-ui, -apple-system, "Segoe UI", sans-serif', localOnly: false },
  { id: 'noto-sans-jp', label: 'Noto Sans JP', family: '"Noto Sans JP", system-ui, sans-serif', localOnly: true },
  { id: 'line-seed-jp', label: 'LINE Seed JP', family: '"LINE Seed JP", system-ui, sans-serif', localOnly: true },
  { id: 'noto-serif-jp', label: 'Noto Serif JP', family: '"Noto Serif JP", system-ui, serif', localOnly: true },
  { id: 'monospace', label: 'Monospace', family: 'ui-monospace, "SFMono-Regular", "Cascadia Code", Menlo, Consolas, monospace', localOnly: false }
].map(Object.freeze));

export function normalizeColor(value) {
  if (typeof value !== 'string' || value.length > 64) throw new TypeError('INVALID_COLOR');
  const input = value.trim();
  if (/^#[\da-f]{6}$/i.test(input)) return input.toUpperCase();
  if (/^#[\da-f]{3}$/i.test(input)) return `#${input.slice(1).split('').map(char => char + char).join('').toUpperCase()}`;
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(input);
  if (!rgb || rgb.slice(1).some(channel => Number(channel) > 255)) throw new TypeError('INVALID_COLOR');
  return `#${rgb.slice(1).map(channel => Number(channel).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function channels(color) { return normalizeColor(color).slice(1).match(/../g).map(channel => Number.parseInt(channel, 16)); }
function luminance(color) { return channels(color).map(channel => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0); }
export function contrastRatio(a, b) { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + 0.05) / (values[1] + 0.05); }
function blend(front, back, weight) { const a = channels(front); return `#${channels(back).map((value, index) => Math.round(a[index] * weight + value * (1 - weight)).toString(16).padStart(2, '0')).join('').toUpperCase()}`; }

export function validateCustomColors(themeId, overrides = {}) {
  const theme = THEMES.find(item => item.id === themeId);
  if (!theme || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return { valid: false, errors: ['INVALID_THEME'], colors: null, contrast: {} };
  const colors = { ...theme.colors };
  const normalized = {};
  const errors = [];
  for (const [role, value] of Object.entries(overrides)) {
    if (!['accent', 'canvas', 'text'].includes(role)) { errors.push('INVALID_COLOR_ROLE'); continue; }
    if (value === '') continue;
    try { normalized[role] = normalizeColor(value); } catch { errors.push('INVALID_COLOR'); }
  }
  if (errors.length) return { valid: false, errors: [...new Set(errors)], colors: null, contrast: {}, normalized };
  Object.assign(colors, normalized);
  if (normalized.canvas) { colors.surface = colors.canvas; colors.nav = blend(colors.text, colors.canvas, 0.02); }
  if (normalized.text || normalized.canvas) {
    colors.muted = blend(colors.text, colors.surface, 0.88);
    colors.border = blend(colors.text, colors.surface, 0.24);
    colors.disabledBg = blend(colors.text, colors.surface, 0.08);
    colors.disabledFg = colors.text;
  }
  if (normalized.accent || normalized.canvas || normalized.text) {
    colors.on = contrastRatio('#FFFFFF', colors.accent) >= contrastRatio('#102030', colors.accent) ? '#FFFFFF' : '#102030';
    colors.soft = blend(colors.accent, colors.surface, 0.12);
    if (contrastRatio(colors.accent, colors.soft) < 4.5) colors.soft = colors.surface;
  }
  const contrast = {};
  for (const surface of ['canvas', 'surface', 'nav']) {
    contrast[`text/${surface}`] = contrastRatio(colors.text, colors[surface]);
    contrast[`muted/${surface}`] = contrastRatio(colors.muted, colors[surface]);
    contrast[`accent/${surface}`] = contrastRatio(colors.accent, colors[surface]);
  }
  contrast['on/accent'] = contrastRatio(colors.on, colors.accent);
  contrast['disabledFg/disabledBg'] = contrastRatio(colors.disabledFg, colors.disabledBg);
  if (Object.entries(contrast).some(([pair, ratio]) => ratio < (pair.startsWith('disabled') ? 3 : 4.5))) errors.push('LOW_CONTRAST');
  return { valid: errors.length === 0, errors, colors, normalized, contrast };
}


const preferenceKeys=['schemaVersion','themeId','customColors','fontId','locale'];
function plainData(value,allowed,required=allowed){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('INVALID_PREFERENCES');
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  if(keys.some(key=>typeof key!=='string'||!allowed.includes(key)||!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value'))||required.some(key=>!Object.hasOwn(descriptors,key)))throw new TypeError('INVALID_PREFERENCES');
}
export function validatePreferences(value){
  plainData(value,[...preferenceKeys,'followSystem'],preferenceKeys);
  if(Object.hasOwn(value,'followSystem')&&typeof value.followSystem!=='boolean')throw new TypeError('INVALID_PREFERENCES');
  if(value.schemaVersion!==1||!THEMES.some(theme=>theme.id===value.themeId)||!FONT_OPTIONS.some(font=>font.id===value.fontId)||!isLocaleTag(value.locale))throw new TypeError('INVALID_PREFERENCES');
  plainData(value.customColors,['accent','canvas','text'],[]);
  const checked=validateCustomColors(value.themeId,value.customColors);
  if(!checked.valid)throw new TypeError(checked.errors[0]);
  return {schemaVersion:1,themeId:value.themeId,customColors:{...checked.normalized},fontId:value.fontId,locale:canonicalLocale(value.locale),...(value.followSystem===true?{followSystem:true}:{})};
}
