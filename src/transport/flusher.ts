/**
 * Lifecycle Event Listener for Safe Page Unload Flushing.
 *
 * Binds flush callbacks to modern browser lifecycle events:
 * 1. document.visibilityState === 'hidden' (mobile tab switching, app backgrounding, minimization).
 * 2. window 'pagehide' (desktop tab closing, navigation away, cross-origin traversal).
 *
 * Avoids deprecated 'unload' and 'beforeunload' events which break the
 * browser Back/Forward Cache (bfcache).
 *
 * Gracefully degrades to a no-op in Web Worker, Node.js, and serverless edge runtimes.
 */

/**
 * Binds an asynchronous flush operation to modern browser unload lifecycle events.
 *
 * @param flushFn - Asynchronous callback to execute when the document is being hidden or unloaded.
 * @returns Cleanup function that unbinds all registered DOM listeners.
 */
export function bindUnloadFlush(flushFn: () => Promise<void> | void): () => void {
  const hasDocument = typeof document !== "undefined" && typeof document.addEventListener === "function";
  const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function";

  if (!hasDocument && !hasWindow) {
    // Non-browser execution environment (Web Worker, Cloudflare Workers, Node.js)
    return () => {};
  }

  let isExecuting = false;

  const runFlush = (): void => {
    if (isExecuting) {
      return;
    }
    isExecuting = true;
    try {
      const result = flushFn();
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch(() => {
          // Swallow asynchronous exceptions during unload to avoid unhandled rejections
        }).finally(() => {
          isExecuting = false;
        });
      } else {
        isExecuting = false;
      }
    } catch {
      isExecuting = false;
    }
  };

  const handleVisibilityChange = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      runFlush();
    }
  };

  const handlePageHide = (): void => {
    runFlush();
  };

  if (hasDocument) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  if (hasWindow) {
    window.addEventListener("pagehide", handlePageHide);
  }

  return () => {
    if (hasDocument) {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
    if (hasWindow) {
      window.removeEventListener("pagehide", handlePageHide);
    }
  };
}
