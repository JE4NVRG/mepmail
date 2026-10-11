/**
 * A headline's sentences, one per line on wide screens; a hyphen inside a word
 * ("e-mail") becomes a non-breaking one, so no line ends in "e-".
 */
export function titlePhrases(title: string): string[] {
  return title.replace(/(\p{L})-(\p{L})/gu, "$1\u2011$2").split(/(?<=\.)\s+/);
}
