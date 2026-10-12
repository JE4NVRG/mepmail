/**
 * IndexNow (Bing, Yandex, Seznam…): after a release the public URLs are announced
 * so engines recrawl them in hours instead of weeks. The key is public by design: it
 * is served at /<key>.txt (apps/web/public) to prove the announcements come from this
 * host, and robots.ts lets crawlers fetch it.
 */
export const INDEXNOW_KEY = "7eee07cf64da97d882c2b5154963795a";
