import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindUnloadFlush } from "../../src/transport/flusher.js";

describe("Unload Flush Lifecycle Binding", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
  });

  it("safely degrades to no-op in headless non-browser environments", () => {
    Object.defineProperty(globalThis, "document", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const flushFn = vi.fn();
    const unbind = bindUnloadFlush(flushFn);

    expect(typeof unbind).toBe("function");
    unbind();
    expect(flushFn).not.toHaveBeenCalled();
  });

  it("executes flush callback when document becomes hidden", () => {
    const listeners: Record<string, () => void> = {};

    const mockDoc = {
      visibilityState: "hidden",
      addEventListener: vi.fn((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(globalThis, "document", {
      value: mockDoc,
      configurable: true,
      writable: true,
    });

    const flushFn = vi.fn();
    bindUnloadFlush(flushFn);

    expect(mockDoc.addEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function)
    );

    // Trigger visibilitychange with hidden state
    listeners.visibilitychange?.();
    expect(flushFn).toHaveBeenCalledTimes(1);
  });

  it("does not execute flush when document visibility state is visible", () => {
    const listeners: Record<string, () => void> = {};

    const mockDoc = {
      visibilityState: "visible",
      addEventListener: vi.fn((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(globalThis, "document", {
      value: mockDoc,
      configurable: true,
      writable: true,
    });

    const flushFn = vi.fn();
    bindUnloadFlush(flushFn);

    listeners.visibilitychange?.();
    expect(flushFn).not.toHaveBeenCalled();
  });

  it("executes flush callback when window fires pagehide", () => {
    const listeners: Record<string, () => void> = {};

    const mockWindow = {
      addEventListener: vi.fn((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(globalThis, "window", {
      value: mockWindow,
      configurable: true,
      writable: true,
    });

    const flushFn = vi.fn();
    bindUnloadFlush(flushFn);

    expect(mockWindow.addEventListener).toHaveBeenCalledWith(
      "pagehide",
      expect.any(Function)
    );

    listeners.pagehide?.();
    expect(flushFn).toHaveBeenCalledTimes(1);
  });

  it("unbinds listeners completely upon executing cleanup callback", () => {
    const docListeners: Record<string, () => void> = {};
    const winListeners: Record<string, () => void> = {};

    const mockDoc = {
      visibilityState: "hidden",
      addEventListener: vi.fn((event: string, handler: () => void) => {
        docListeners[event] = handler;
      }),
      removeEventListener: vi.fn(),
    };

    const mockWindow = {
      addEventListener: vi.fn((event: string, handler: () => void) => {
        winListeners[event] = handler;
      }),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(globalThis, "document", {
      value: mockDoc,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: mockWindow,
      configurable: true,
      writable: true,
    });

    const flushFn = vi.fn();
    const unbind = bindUnloadFlush(flushFn);

    unbind();

    expect(mockDoc.removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function)
    );
    expect(mockWindow.removeEventListener).toHaveBeenCalledWith(
      "pagehide",
      expect.any(Function)
    );
  });
});
