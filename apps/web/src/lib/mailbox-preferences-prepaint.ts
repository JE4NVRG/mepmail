/**
 * The part of the Correio preferences a server component may import: the
 * local-storage key and the script inlined before the first paint. This
 * module has no "use client" directive on purpose, so `src/app/(mail)/layout.tsx`
 * receives the string itself and not a client reference.
 */

export const CORREIO_PREFS_KEY = "mepmail.correio.prefs";

/**
 * Inlined before the first paint of a Correio page: reads the local mirror and
 * applies the layout attributes, plus the device theme when "system" is set,
 * so the page never flashes the defaults.
 */
export const CORREIO_PREFS_PREPAINT_SCRIPT = `try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(CORREIO_PREFS_KEY)})||"{}"),r=document.documentElement;r.dataset.density=p.density==="compact"?"compact":"comfortable";r.dataset.readingPane=p.readingPane==="bottom"||p.readingPane==="off"?p.readingPane:"right";r.dataset.previewLines=p.previewLines===0||p.previewLines===2?String(p.previewLines):"1";if(p.showAvatars===false)r.dataset.avatars="off";else delete r.dataset.avatars;if(p.theme==="system"){if(matchMedia("(prefers-color-scheme: light)").matches)r.setAttribute("data-theme","light");else r.removeAttribute("data-theme")}}catch(e){}`;
