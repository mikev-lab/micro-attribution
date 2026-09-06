/**
 * Low-Level Network Transmitter with Transport Auto-Negotiation.
 *
 * Implements a resilient transmission hierarchy across:
 * 1. navigator.sendBeacon: High-reliability non-blocking browser daemon flush.
 * 2. fetch with { keepalive: true }: Guaranteed unload survival when beacon buffer saturates.
 * 3. Standard fetch: Universal fallback for standard batches, Web Workers, and Edge runtimes.
 *
 * Zero runtime dependencies. Dual browser/edge runtime agnostic.
 */

import type { DispatchResult, QueuedEvent, TransmitOptions } from "../types.js";

/**
 * Transmits a batch of telemetry events to an ingestion endpoint with
 * automatic graceful degradation across transport protocols.
 *
 * @param endpoint - Target HTTP ingestion URL.
 * @param events - Array of queued events to serialize and transmit.
 * @param options - Transmission preferences and custom HTTP headers.
 * @returns DispatchResult indicating success, transport utilized, and HTTP status.
 */
export async function transmitBatch(
  endpoint: string,
  events: QueuedEvent[],
  options?: TransmitOptions
): Promise<DispatchResult> {
  if (!events || events.length === 0) {
    return {
      success: true,
      transport: options?.preferredTransport ?? "fetch",
      sentCount: 0,
      status: 200,
    };
  }

  const jsonString = JSON.stringify(events);
  const preferred = options?.preferredTransport;

  // Step 1: Attempt navigator.sendBeacon if preferred or auto-negotiating
  const shouldTryBeacon =
    (preferred === "beacon" || preferred === undefined) &&
    typeof navigator !== "undefined" &&
    typeof navigator.sendBeacon === "function";

  if (shouldTryBeacon) {
    try {
      let body: Blob | string = jsonString;
      if (typeof Blob !== "undefined") {
        try {
          body = new Blob([jsonString], { type: "application/json" });
        } catch {
          // If Blob instantiation fails in unusual environments, fall back to string
          body = jsonString;
        }
      }

      const beaconAccepted = navigator.sendBeacon(endpoint, body);
      if (beaconAccepted) {
        return {
          success: true,
          transport: "beacon",
          sentCount: events.length,
          status: 200,
        };
      }
      // If sendBeacon returned false, browser queue is full (64KB buffer saturated).
      // Fall through to keepalive fetch.
    } catch {
      // In case sendBeacon threw a SecurityError or URL parsing exception, fall through.
    }
  }

  // Step 2: Attempt fetch with keepalive: true if preferred or auto-negotiating
  const hasFetch = typeof fetch === "function";
  if (!hasFetch) {
    return {
      success: false,
      transport: "fetch",
      sentCount: 0,
      error: new Error("No network transport available (fetch is undefined)"),
    };
  }

  const shouldTryKeepalive = preferred !== "fetch";
  if (shouldTryKeepalive) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      };

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: jsonString,
        keepalive: true,
      });

      return {
        success: response.ok,
        transport: "keepalive",
        sentCount: response.ok ? events.length : 0,
        status: response.status,
      };
    } catch {
      // Keepalive can reject if payload exceeds user-agent keepalive budget (often 64KB)
      // or if keepalive flag is unsupported in runtime. Fall through to standard fetch.
    }
  }

  // Step 3: Standard fetch fallback
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: jsonString,
    });

    return {
      success: response.ok,
      transport: "fetch",
      sentCount: response.ok ? events.length : 0,
      status: response.status,
    };
  } catch (err) {
    return {
      success: false,
      transport: "fetch",
      sentCount: 0,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
