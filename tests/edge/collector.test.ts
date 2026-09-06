import { describe, expect, it, vi } from "vitest";
import { handleEdgeRequest } from "../../src/edge/collector.js";
import type { EdgeContext, QueuedEvent } from "../../src/types.js";

function createMockRequest(
  method: string,
  body?: unknown,
  headers?: Record<string, string>
): Request {
  const reqHeaders = new Headers(headers);
  const init: RequestInit = {
    method,
    headers: reqHeaders,
  };

  if (body !== undefined && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  return new Request("https://edge.example.com/collect", init);
}

describe("Edge Telemetry Collector (handleEdgeRequest)", () => {
  it("handles CORS preflight OPTIONS requests with 204 No Content", async () => {
    const request = createMockRequest("OPTIONS", undefined, {
      origin: "https://customer.app",
    });

    const response = await handleEdgeRequest(request);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("supports dynamic custom CORS origin validation function", async () => {
    const allowedRequest = createMockRequest("OPTIONS", undefined, {
      origin: "https://trusted-domain.com",
    });

    const options = {
      corsOrigin: (origin: string) => origin.endsWith("trusted-domain.com"),
    };

    const allowedResponse = await handleEdgeRequest(allowedRequest, options);
    expect(allowedResponse.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://trusted-domain.com"
    );

    const blockedRequest = createMockRequest("OPTIONS", undefined, {
      origin: "https://evil.com",
    });
    const blockedResponse = await handleEdgeRequest(blockedRequest, options);
    expect(blockedResponse.headers.get("Access-Control-Allow-Origin")).toBe("");
  });

  it("rejects non-POST non-OPTIONS requests with 405 Method Not Allowed", async () => {
    const getRequest = createMockRequest("GET");
    const response = await handleEdgeRequest(getRequest);

    expect(response.status).toBe(405);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toContain("Method Not Allowed");
  });

  it("rejects malformed JSON payloads with 400 Bad Request", async () => {
    const badJsonRequest = createMockRequest(
      "POST",
      "{ malformed_json: true, ...",
      { "Content-Type": "application/json" }
    );

    const response = await handleEdgeRequest(badJsonRequest);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toBe("Invalid JSON");
  });

  it("extracts CF-Connecting-IP and truncates to /24 IPv4 subnet", async () => {
    let capturedContext: EdgeContext | undefined;
    const onBatch = vi.fn().mockImplementation((_events, context) => {
      capturedContext = context;
    });

    const request = createMockRequest(
      "POST",
      [{ id: "evt_1", payload: { path: "/home" } }],
      {
        "cf-connecting-ip": "198.51.100.42",
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)",
      }
    );

    const response = await handleEdgeRequest(request, { onBatch });

    expect(response.status).toBe(200);
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(capturedContext).toBeDefined();
    // Subnet truncation: 198.51.100.42 -> 198.51.100.0
    expect(capturedContext?.clientIp).toBe("198.51.100.0");
    expect(capturedContext?.userAgent).toContain("iPhone");
    expect(capturedContext?.visitorToken.length).toBe(64); // 256-bit hex hash
  });

  it("extracts first client IP from multi-hop X-Forwarded-For header", async () => {
    let capturedContext: EdgeContext | undefined;
    const onBatch = vi.fn().mockImplementation((_events, context) => {
      capturedContext = context;
    });

    const request = createMockRequest(
      "POST",
      [{ id: "evt_1", payload: {} }],
      {
        "x-forwarded-for": "203.0.113.195, 70.41.3.18, 150.172.238.178",
      }
    );

    const response = await handleEdgeRequest(request, { onBatch });

    expect(response.status).toBe(200);
    expect(capturedContext?.clientIp).toBe("203.0.113.0");
  });

  it("scrubs PII fields and sensitive patterns from incoming event payloads", async () => {
    let capturedEvents: QueuedEvent[] = [];
    const onBatch = vi.fn().mockImplementation((events) => {
      capturedEvents = events;
    });

    const rawBatch = [
      {
        id: "evt_raw_1",
        payload: {
          utm_source: "newsletter",
          email: "customer@domain.com", // PII key
          note: "Contact customer at secret@company.org regarding card 4111 2222 3333 4444", // PII values
        },
      },
    ];

    const request = createMockRequest("POST", rawBatch);
    const response = await handleEdgeRequest(request, { onBatch });

    expect(response.status).toBe(200);
    expect(capturedEvents.length).toBe(1);

    const sanitizedPayload = capturedEvents[0]?.payload;
    // Sensitive key is dropped
    expect(sanitizedPayload?.email).toBeUndefined();
    // Marketing parameters preserved
    expect(sanitizedPayload?.utm_source).toBe("newsletter");
    // Sensitive pattern in text is redacted
    expect(sanitizedPayload?.note).toContain("[REDACTED]");
    expect(sanitizedPayload?.note).not.toContain("customer@domain.com");
  });

  it("handles persistence failures gracefully with 500 Internal Server Error", async () => {
    const failingHook = vi.fn().mockRejectedValue(new Error("Database connection timeout"));

    const request = createMockRequest("POST", [{ id: "evt_1", payload: {} }]);
    const response = await handleEdgeRequest(request, { onBatch: failingHook });

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.message).toBe("Database connection timeout");
  });
});
