/**
 * Edge Telemetry Collector & Request Handler.
 *
 * Universal, zero-dependency HTTP ingestion handler designed for:
 * - Cloudflare Workers
 * - Vercel Edge Functions
 * - Deno
 * - Node.js 18+ (using standard Request/Response)
 *
 * Operational features:
 * 1. Automatic CORS preflight (OPTIONS) negotiation.
 * 2. Client socket IP extraction from edge headers (CF-Connecting-IP, X-Forwarded-For).
 * 3. Subnet IP truncation (/24 IPv4 and /48 IPv6) for statutory compliance.
 * 4. Deep recursive PII scrubbing of incoming payloads.
 * 5. Daily rotating ephemeral visitor pseudonym tokenization.
 * 6. Pluggable batch persistence and forwarding hook (onBatch).
 *
 * Zero runtime dependencies.
 */

import { generateVisitorToken } from "../privacy/hasher.js";
import { truncateIp } from "../privacy/ip.js";
import { sanitizePayload } from "../privacy/sanitizer.js";
import type {
  EdgeCollectorOptions,
  EdgeContext,
  IngestResult,
  QueuedEvent,
} from "../types.js";

/**
 * Resolves the CORS allowed origin header value based on request and options.
 */
function resolveCorsOrigin(
  requestOrigin: string,
  corsConfig?: string | ((origin: string) => boolean)
): string {
  if (typeof corsConfig === "function") {
    return corsConfig(requestOrigin) ? requestOrigin : "";
  }
  return typeof corsConfig === "string" ? corsConfig : "*";
}

/**
 * Extracts the raw client socket IP address from standard reverse-proxy headers.
 */
function extractClientIp(headers: Headers): string {
  const cfIp = headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();

  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "127.0.0.1";

  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  return "127.0.0.1";
}

function jsonResponse(
  body: IngestResult,
  status: number,
  corsHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

/**
 * Handles an incoming edge HTTP request, performing CORS preflight negotiation,
 * IP masking, PII scrubbing, and batch persistence forwarding.
 *
 * @param request - Standard Web API Request object.
 * @param options - Edge collector configuration options and forwarding hooks.
 * @returns Standard Web API Response object.
 */
export async function handleEdgeRequest(
  request: Request,
  options?: EdgeCollectorOptions
): Promise<Response> {
  const requestOrigin = request.headers.get("origin") || "*";
  const allowedOrigin = resolveCorsOrigin(requestOrigin, options?.corsOrigin);

  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization",
    "Access-Control-Max-Age": "86400",
  };

  // Step 1: Handle CORS preflight OPTIONS request
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // Step 2: Enforce POST method
  if (request.method !== "POST") {
    return jsonResponse(
      { success: false, count: 0, message: "Method Not Allowed" },
      405,
      corsHeaders
    );
  }

  // Step 3: Parse and validate JSON batch body
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse(
      { success: false, count: 0, message: "Invalid JSON" },
      400,
      corsHeaders
    );
  }

  let events: QueuedEvent[];
  if (Array.isArray(rawBody)) {
    events = rawBody as QueuedEvent[];
  } else if (
    rawBody &&
    typeof rawBody === "object" &&
    Array.isArray((rawBody as { events?: unknown }).events)
  ) {
    events = (rawBody as { events: QueuedEvent[] }).events;
  } else if (rawBody && typeof rawBody === "object") {
    events = [rawBody as QueuedEvent];
  } else {
    return jsonResponse(
      { success: false, count: 0, message: "Malformed batch" },
      400,
      corsHeaders
    );
  }

  // Step 4: Extract and sanitize client IP
  const rawIp = extractClientIp(request.headers);
  const clientIp = options?.anonymizeIp !== false ? truncateIp(rawIp) : rawIp;
  const userAgent = request.headers.get("user-agent") || "";
  const origin = request.headers.get("origin") || request.headers.get("host") || "";

  // Step 5: Derive ephemeral daily rotating visitor pseudonym
  let visitorToken = "";
  try {
    visitorToken = await generateVisitorToken({
      ip: clientIp,
      userAgent,
      origin,
      pepper: options?.pepper,
    });
  } catch {
    visitorToken = "";
  }

  const context: EdgeContext = {
    clientIp,
    userAgent,
    origin,
    visitorToken,
    timestamp: Date.now(),
  };

  // Step 6: Deep PII scrubbing across event payloads
  const sanitizedEvents: QueuedEvent[] = events.map((event) => {
    if (!options || options.sanitizePayloads !== false) {
      const sanitizedPayload = sanitizePayload(event.payload ?? {});
      return {
        ...event,
        payload: sanitizedPayload as Record<string, unknown>,
      };
    }
    return event;
  });

  // Step 7: Invoke custom persistence or pipeline forwarding hook
  if (options?.onBatch && typeof options.onBatch === "function") {
    try {
      await options.onBatch(sanitizedEvents, context);
    } catch (err) {
      return jsonResponse(
        { success: false, count: 0, message: err instanceof Error ? err.message : "Ingestion hook failure" },
        500,
        corsHeaders
      );
    }
  }

  // Step 8: Return successful ingestion acknowledgment
  return jsonResponse({ success: true, count: sanitizedEvents.length }, 200, corsHeaders);
}

