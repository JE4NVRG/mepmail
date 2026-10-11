/**
 * Waits for the tasks to settle, but never longer than `ms`: whatever is still
 * running then is left behind (its result simply is not waited for). Rejections
 * never surface. The Correio page uses it so a slow read never holds the HTML.
 */
export async function settleWithin(tasks: readonly Promise<unknown>[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}
