/**
 * Zero-Dependency Google Analytics 4 (GA4) Measurement Protocol Bridge.
 *
 * Dispatches conversion events and pageviews directly to GA4 Measurement Protocol:
 * https://www.google-analytics.com/mp/collect
 *
 * Features:
 * 1. Automatic mapping of conversion events to standard GA4 'purchase' events.
 * 2. Attribution preservation: forwards campaign, source, medium, and custom properties.
 * 3. Dual-target transmission: uses keepalive fetch or navigator.sendBeacon.
 * 4. Validation support: debug endpoint toggle (/debug/mp/collect).
 * 5. Strict zero-dependency invariant: 100% native Web APIs.
 */

import type { DispatchResult, GA4ForwardingOptions, QueuedEvent } from "../types.js";

/**
 * Standard GA4 event parameter dictionary.
 */
export interface GA4EventParams {
  [key: string]: string | number | boolean | undefined;
}

/**
 * Standard GA4 Measurement Protocol Event payload.
 */
export interface GA4Event {
  name: string;
  params?: GA4EventParams;
}

/**
 * Root GA4 Measurement Protocol request body.
 */
export interface GA4Payload {
  client_id: string;
  user_id?: string;
  timestamp_micros?: number;
  events: GA4Event[];
}

/**
 * Normalizes event names according to Google Analytics 4 naming rules:
 * 1 to 40 characters, alphanumeric and underscores, must begin with an alphabetic character.
 *
 * @param name - Raw event name string.
 * @returns Sanitized GA4 event identifier.
 */
export function sanitizeGA4EventName(name: string): string {
  if (!name) {
    return "custom_event";
  }

  // Replace any non-alphanumeric character with underscore
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);

  // Must begin with an alphabetical character
  if (!/^[a-zA-Z]/.test(sanitized)) {
    sanitized = `e_${sanitized}`.slice(0, 40);
  }

  return sanitized;
}

/**
 * Formats a telemetry event into standard Google Analytics 4 event structure.
 *
 * @param event - Telemetry queued event.
 * @param options - Forwarding configuration options.
 * @returns Formatted GA4 event object or null if event should be omitted.
 */
export function formatGA4Event(
  event: QueuedEvent,
  options?: GA4ForwardingOptions
): GA4Event | null {
  const data = (event.payload && typeof event.payload === "object" ? event.payload : event) as Record<string, unknown>;
  const eventType = (data.type as string) || "custom_event";

  if (eventType === "pageview") {
    if (!options?.forwardPageviews) {
      return null;
    }

    const params: GA4EventParams = {};
    if (data.url && typeof data.url === "string") {
      params.page_location = data.url;
    } else if (data.path && typeof data.path === "string") {
      params.page_location = data.path;
    }
    if (data.title && typeof data.title === "string") {
      params.page_title = data.title;
    }
    if (data.referrer && typeof data.referrer === "string") {
      params.page_referrer = data.referrer;
    }

    const campaign = data.campaign as Record<string, unknown> | undefined;
    if (campaign?.campaign) params.campaign = String(campaign.campaign);
    if (campaign?.source) params.source = String(campaign.source);
    if (campaign?.medium) params.medium = String(campaign.medium);
    if (campaign?.term) params.term = String(campaign.term);
    if (campaign?.content) params.content = String(campaign.content);

    return {
      name: "page_view",
      params,
    };
  }

  if (eventType === "conversion") {
    const conversion = (data.conversion || {}) as Record<string, unknown>;
    const isPurchase =
      conversion.revenue !== undefined ||
      conversion.transactionId !== undefined ||
      data.value !== undefined ||
      data.event_name === "purchase";

    const name = isPurchase
      ? "purchase"
      : sanitizeGA4EventName((conversion.conversionId as string) || (data.name as string) || "conversion");
    const params: GA4EventParams = {};

    const revenue = conversion.revenue !== undefined ? conversion.revenue : data.value;
    if (typeof revenue === "number") {
      params.value = revenue;
      params.currency = (conversion.currency as string) || (data.currency as string) || "USD";
    }

    const transactionId =
      (conversion.transactionId as string) ||
      (conversion.conversionId as string) ||
      (data.transactionId as string) ||
      (data.name as string);

    if (transactionId) {
      params.transaction_id = transactionId;
    }

    // Attach campaign attribution if available
    const campaign = data.campaign as Record<string, unknown> | undefined;
    if (campaign?.campaign) params.campaign = String(campaign.campaign);
    if (campaign?.source) params.source = String(campaign.source);
    if (campaign?.medium) params.medium = String(campaign.medium);
    if (campaign?.term) params.term = String(campaign.term);
    if (campaign?.content) params.content = String(campaign.content);

    // Attach scalar conversion properties
    const properties = (conversion.properties || {}) as Record<string, unknown>;
    for (const [key, val] of Object.entries(properties)) {
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        params[sanitizeGA4EventName(key)] = val;
      }
    }

    return {
      name,
      params,
    };
  }

  // Generic custom event
  const params: GA4EventParams = {};
  for (const [key, val] of Object.entries(data)) {
    if (
      key !== "type" &&
      key !== "conversion" &&
      (typeof val === "string" || typeof val === "number" || typeof val === "boolean")
    ) {
      params[sanitizeGA4EventName(key)] = val;
    }
  }

  return {
    name: sanitizeGA4EventName(eventType),
    params,
  };
}

/**
 * Builds the complete GA4 Measurement Protocol payload for one or more events.
 *
 * @param events - Queued event or array of events.
 * @param options - Forwarding configuration options.
 * @returns Fully constructed GA4Payload or null if no valid events.
 */
export function buildGA4Payload(
  events: QueuedEvent | QueuedEvent[],
  options: GA4ForwardingOptions
): GA4Payload | null {
  const eventList = Array.isArray(events) ? events : [events];
  const ga4Events: GA4Event[] = [];

  let resolvedClientId = options.clientId;

  for (const ev of eventList) {
    const data = (ev.payload && typeof ev.payload === "object" ? ev.payload : ev) as Record<string, unknown>;
    if (!resolvedClientId) {
      resolvedClientId = (data.visitorToken as string) || ev.id;
    }

    const formatted = formatGA4Event(ev, options);
    if (formatted) {
      ga4Events.push(formatted);
    }
  }

  if (ga4Events.length === 0) {
    return null;
  }

  return {
    client_id: resolvedClientId || "anonymous_client",
    timestamp_micros: Math.round(Date.now() * 1000),
    events: ga4Events,
  };
}

/**
 * Dispatches events directly to the Google Analytics 4 Measurement Protocol endpoint.
 *
 * @param events - Event or array of events to forward to GA4.
 * @param options - GA4 forwarding configuration.
 * @returns DispatchResult indicating outcome and status.
 */
export async function sendToGA4(
  events: QueuedEvent | QueuedEvent[],
  options: GA4ForwardingOptions
): Promise<DispatchResult> {
  if (!options.measurementId || !options.apiSecret) {
    return {
      success: false,
      transport: "fetch",
      sentCount: 0,
      error: new Error("GA4 forwarding requires measurementId and apiSecret"),
    };
  }

  const payload = buildGA4Payload(events, options);
  if (!payload) {
    return {
      success: true,
      transport: "fetch",
      sentCount: 0,
      status: 200,
    };
  }

  const baseUrl = options.debug
    ? "https://www.google-analytics.com/debug/mp/collect"
    : "https://www.google-analytics.com/mp/collect";

  const url = `${baseUrl}?measurement_id=${encodeURIComponent(options.measurementId)}&api_secret=${encodeURIComponent(options.apiSecret)}`;
  const jsonBody = JSON.stringify(payload);

  // Attempt keepalive fetch
  if (typeof fetch === "function") {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: jsonBody,
        keepalive: true,
      });

      return {
        success: response.ok,
        transport: "keepalive",
        sentCount: response.ok ? payload.events.length : 0,
        status: response.status,
      };
    } catch {
      // If keepalive fetch fails, fall back to standard fetch
      try {
        const fallbackResponse = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: jsonBody,
        });

        return {
          success: fallbackResponse.ok,
          transport: "fetch",
          sentCount: fallbackResponse.ok ? payload.events.length : 0,
          status: fallbackResponse.status,
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
  }

  // Fallback to sendBeacon if fetch is unavailable
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      const blob = new Blob([jsonBody], { type: "application/json" });
      const accepted = navigator.sendBeacon(url, blob);
      return {
        success: accepted,
        transport: "beacon",
        sentCount: accepted ? payload.events.length : 0,
        status: accepted ? 200 : 500,
      };
    } catch (beaconErr) {
      return {
        success: false,
        transport: "beacon",
        sentCount: 0,
        error: beaconErr instanceof Error ? beaconErr : new Error(String(beaconErr)),
      };
    }
  }

  return {
    success: false,
    transport: "fetch",
    sentCount: 0,
    error: new Error("No network transport available for GA4 dispatch"),
  };
}
