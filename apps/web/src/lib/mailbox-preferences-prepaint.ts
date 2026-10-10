/**
 * The part of the Correio preferences a server component may import: the
 * local-storage keys and the script inlined before the first paint. This
 * module has no "use client" directive on purpose, so `src/app/(mail)/layout.tsx`
 * receives the string itself and not a client reference.
 */

export const CORREIO_PREFS_KEY = "mepmail.correio.prefs";

/** Per device: whether the person collapsed or expanded the side rail. */
export const CORREIO_RAIL_KEY = "mepmail.correio.rail";

/** Per device: the column widths the person dragged (lib/mailbox-columns). */
export const CORREIO_COLUMNS_KEY = "mepmail.correio.columns";

/**
 * Inlined before the first paint of a Correio page: reads the local mirror and
 * applies the layout attributes, plus the device theme when "system" is set
 * the rail the person collapsed or expanded and the column widths dragged on
 * this device, so the page never flashes the defaults. The width limits match
 * COLUMN_LIMITS in lib/mailbox-columns.
 */
export const CORREIO_PREFS_PREPAINT_SCRIPT = `try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(CORREIO_PREFS_KEY)})||"{}"),r=document.documentElement;r.dataset.density=p.density==="compact"?"compact":"comfortable";r.dataset.readingPane=p.readingPane==="bottom"||p.readingPane==="off"?p.readingPane:"right";r.dataset.previewLines=p.previewLines===0||p.previewLines===2?String(p.previewLines):"1";if(p.showAvatars===false)r.dataset.avatars="off";else delete r.dataset.avatars;if(p.theme==="system"){if(matchMedia("(prefers-color-scheme: light)").matches)r.setAttribute("data-theme","light");else r.removeAttribute("data-theme")}var q=JSON.parse(localStorage.getItem(${JSON.stringify(CORREIO_RAIL_KEY)})||"{}");if(q.collapsed===true)r.dataset.rail="collapsed";else if(q.collapsed===false)r.dataset.rail="expanded";else delete r.dataset.rail;var c=JSON.parse(localStorage.getItem(${JSON.stringify(CORREIO_COLUMNS_KEY)})||"{}")||{},w=function(n,v,f,a,b){if(typeof c[n]==="number"&&c[n]>=a&&c[n]<=b){r.style.setProperty(v,Math.round(c[n])+"px");r.dataset[f]="1"}};w("rail","--correio-rail-w","colRail",180,400);w("list","--correio-list-w","colList",260,720)}catch(e){}`;
