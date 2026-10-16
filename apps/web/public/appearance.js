import {THEMES,FONT_OPTIONS,validateCustomColors,contrastRatio} from './preferences.js';

const systemQuery='(prefers-color-scheme: dark)';
function mediaQuery(matchMedia=globalThis.matchMedia){
  try{return typeof matchMedia==='function'?matchMedia.call(globalThis,systemQuery):null;}catch{return null;}
}
/** Resolve the display only. The saved manual palette and colors remain unchanged. */
export function resolveAppearancePreferences(value,{dark=mediaQuery()?.matches===true}={}){
  return value?.followSystem===true?{...value,themeId:dark?'midnight':'light',customColors:{}}:value;
}
/** Update presentation tokens only; never rebuild editors, dialogs or their inputs. */
export function applyPreferenceAppearance(value,{document=globalThis.document,dark}={}){
  const effective=resolveAppearancePreferences(value,dark===undefined?{}:{dark});
  const theme=THEMES.find(theme=>theme.id===effective.themeId)??THEMES[1];
  const colors=validateCustomColors(effective.themeId,effective.customColors).colors??theme.colors;
  const kind=effective.customColors.canvas?(contrastRatio('#FFFFFF',colors.canvas)>contrastRatio('#102030',colors.canvas)?'dark':'light'):theme.kind;
  const root=document?.documentElement;
  if(root){
    const aliases={on:'on-accent',soft:'accent-soft',disabledBg:'disabled-bg',disabledFg:'disabled-fg'};
    for(const[role,color]of Object.entries(colors)){root.style.setProperty('--'+role,color);if(aliases[role])root.style.setProperty('--'+aliases[role],color);}
    root.style.setProperty('--accent-hover',colors.accent);root.style.setProperty('--focus',colors.accent);root.style.setProperty('--control-border',colors.muted);
    const family=FONT_OPTIONS.find(font=>font.id===effective.fontId)?.family??FONT_OPTIONS[0].family;
    root.style.setProperty('--font-family',family);root.style.fontFamily=family;root.style.colorScheme=kind;
    root.dataset.appearance=kind;root.dataset.theme=effective.themeId;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',colors.nav);
  }
  return{kind,colors,preferences:effective};
}
/** Each event reads the current account store; an old account cannot replace its presentation. */
export function watchSystemAppearance(getSnapshot,{document=globalThis.document,matchMedia=globalThis.matchMedia,onAppearance}={}){
  if(typeof getSnapshot!=='function')throw new TypeError('INVALID_APPEARANCE_OBSERVER');
  const media=mediaQuery(matchMedia);if(!media)return()=>{};
  const changed=()=>{
    const snapshot=getSnapshot();if(snapshot?.followSystem!==true)return;
    const appearance=applyPreferenceAppearance(snapshot,{document,dark:media.matches===true});onAppearance?.(appearance);
  };
  if(typeof media.addEventListener==='function')media.addEventListener('change',changed);
  else if(typeof media.addListener==='function')media.addListener(changed);
  return()=>{if(typeof media.removeEventListener==='function')media.removeEventListener('change',changed);else media.removeListener?.(changed);};
}
