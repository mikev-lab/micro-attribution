# Customization & Extensibility Guide

`micro-attribution` is engineered as a modular, extensible telemetry platform. Every subsystem: event capture, campaign classification, storage adapters, network dispatching, edge collection, and attribution algorithms can be customized to fit your data architecture.

This guide provides practical patterns and working code examples for extending the library.

---

## 1. Custom Event Taxonomy & Ecommerce Funnels

While `micro-attribution` provides convenient shortcuts (`pageview`, `touchpoint`, `conversion`), the underlying engine accepts arbitrary structured payloads.

### Building a Strongly Typed Event Taxonomy
Define your organization's business event contracts in TypeScript:

```typescript
import { MicroAttribution } from "micro-attribution/client";

// Define your custom interaction schemas
export interface ProductViewedEvent {
  action: "product_viewed";
  productId: string;
  sku: string;
  category: string;
  price: number;
}

export interface CartUpdatedEvent {
  action: "cart_updated";
  cartId: string;
  itemCount: number;
  cartTotal: number;
  currency: string;
}

export interface CheckoutStartedEvent {
  action: "checkout_started";
  step: number;
  stepName: "shipping" | "billing" | "review";
  cartValue: number;
}

// Wrapper client with domain-specific tracking methods
export class EcommerceAnalytics {
  private tracker: MicroAttribution;

  constructor(endpoint: string) {
    this.tracker = new MicroAttribution({
      endpoint,
      autoCaptureCampaign: true,
      autoCaptureReferrer: true,
    });
  }

  async init(): Promise<void> {
    await this.tracker.init();
  }

  async trackProductView(data: Omit<ProductViewedEvent, "action">): Promise<void> {
    await this.tracker.touchpoint("product_viewed", data);
  }

  async trackCartUpdate(data: Omit<CartUpdatedEvent, "action">): Promise<void> {
    await this.tracker.touchpoint("cart_updated", data);
  }

  async trackCheckoutStep(data: Omit<CheckoutStartedEvent, "action">): Promise<void> {
    await this.tracker.touchpoint("checkout_started", data);
  }

  async trackPurchase(orderId: string, revenue: number, currency = "USD"): Promise<void> {
    // Conversions automatically receive 'high' priority to protect them from quota eviction
    await this.tracker.conversion("order_completed", {
      orderId,
      revenue,
      currency,
    });
  }
}
```

---

## 2. Strict ePrivacy Compliance & Zero-Storage Mode

Under European Data Protection regulations (Directive 2002/58/EC Article 5(3)), any read or write access to the user's terminal equipment generally requires prior user consent.

For organizations requiring 100% consent-banner exemption, `micro-attribution` supports a **Zero-Storage Mode** that avoids writing to `localStorage` or `IndexedDB` entirely:

```typescript
import { MicroAttribution } from "micro-attribution/client";

// Strict Zero-Storage Configuration:
// Uses MemoryAdapter exclusively. Zero data is written to the user's hard drive or browser storage.
const tracker = new MicroAttribution({
  endpoint: "https://telemetry.yourdomain.com/collect",
  storageTier: "memory",
  autoCaptureCampaign: true,
  autoCaptureReferrer: true,
});

await tracker.init();
```

### When is a Cookie Consent Banner Needed?
- **Standard Mode (IndexedDB / LocalStorage)**: Data is stored on the client terminal equipment as an offline queue. While data is short-lived and non-profiling, strict interpretations by certain European DPAs (such as Germany's DSK) consider any terminal storage subject to Article 5(3).
- **Zero-Storage Mode (`storageTier: "memory"`)**: Telemetry events exist solely in volatile JavaScript memory during the page session. No cookies, no local storage, and no persistent device identifiers are created. Combined with edge IP subnet masking and daily rotating salt pseudonyms, this mode qualifies for consent exemption under guidelines such as France's CNIL audience measurement framework.

---

## 3. Custom Storage Adapters

You can implement custom persistence mechanisms (e.g. sessionStorage, Web SQL, or application state stores like Redux / Zustand) by implementing the `StorageAdapter` interface:

```typescript
import type { QueuedEvent, StorageAdapter, StorageTier } from "micro-attribution";
import { EventQueue } from "micro-attribution/queue";

export class SessionStorageAdapter implements StorageAdapter {
  public readonly tier: StorageTier = "localstorage";
  private key = "__session_event_queue__";

  async init(): Promise<void> {}

  async get(id: string): Promise<QueuedEvent | null> {
    const events = this.read();
    return events.find((e) => e.id === id) || null;
  }

  async set(event: QueuedEvent): Promise<void> {
    const events = this.read();
    const idx = events.findIndex((e) => e.id === event.id);
    if (idx >= 0) events[idx] = event;
    else events.push(event);
    this.write(events);
  }

  async delete(id: string): Promise<void> {
    const events = this.read().filter((e) => e.id !== id);
    this.write(events);
  }

  async deleteMany(ids: string[]): Promise<void> {
    const set = new Set(ids);
    const events = this.read().filter((e) => !set.has(e.id));
    this.write(events);
  }

  async peek(limit?: number): Promise<QueuedEvent[]> {
    const events = this.read();
    return limit ? events.slice(0, limit) : events;
  }

  async count(): Promise<number> {
    return this.read().length;
  }

  async clear(): Promise<void> {
    sessionStorage.removeItem(this.key);
  }

  async isAvailable(): Promise<boolean> {
    return typeof sessionStorage !== "undefined";
  }

  private read(): QueuedEvent[] {
    try {
      const raw = sessionStorage.getItem(this.key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  private write(events: QueuedEvent[]): void {
    try {
      sessionStorage.setItem(this.key, JSON.stringify(events));
    } catch {
      // Handle quota limits
    }
  }
}

// Inject custom adapter into the queue
const customQueue = new EventQueue({
  storage: new SessionStorageAdapter(),
  maxEvents: 500,
});
```

---

## 4. Custom Marketing Channels & Referrer Rules

`extractCampaignMetadata` automatically normalizes common UTM parameters and platform click identifiers (`gclid`, `fbclid`, `msclkid`, `ttclid`, etc.). You can augment this with custom channel rules:

```typescript
import { extractCampaignMetadata, classifyReferrer } from "micro-attribution/client";

export function resolveCustomMarketingChannel(url: string, referrer: string): string {
  const campaign = extractCampaignMetadata(url);

  // Custom affiliate tag detection
  const searchParams = new URL(url).searchParams;
  if (searchParams.has("aff_id") || searchParams.has("partner")) {
    return "affiliate_network";
  }

  // Custom internal campaign classification
  if (campaign.source === "newsletter" || campaign.medium === "email") {
    return "email_marketing";
  }

  if (campaign.clickIdType) {
    return `paid_${campaign.clickIdType}`;
  }

  // Fallback to organic search / social / direct classifier
  return classifyReferrer(referrer, url);
}
```

---

## 5. Custom Parametric Attribution Models

### Custom Position-Based / U-Shaped Weights
Adjust weights between discovery, nurturing, and closing interactions:

```typescript
import { calculateAttribution } from "micro-attribution/attribution";
import type { CustomerJourney } from "micro-attribution";

const journey: CustomerJourney = {
  visitorId: "user_123",
  touchpoints: [
    { channel: "paid_search", timestamp: 1700000000000 },
    { channel: "blog_post", timestamp: 1700100000000 },
    { channel: "webinar", timestamp: 1700200000000 },
    { channel: "email_sequence", timestamp: 1700300000000 },
    { channel: "sales_demo", timestamp: 1700400000000 },
  ],
  conversion: {
    id: "conv_b2b_deal",
    value: 25000.0,
    timestamp: 1700410000000,
  },
};

// Custom B2B weighting: 50% First Touch, 30% Last Touch, 20% Middle Nurture
const b2bAttribution = calculateAttribution(journey, "position-based", {
  positionWeights: {
    first: 0.50,
    middle: 0.20,
    last: 0.30,
  },
});

console.log(b2bAttribution.credits);
// Values are automatically allocated while strictly preserving total conversion revenue ($25,000)
```

### Custom Time-Decay Half-Life
For extended enterprise consideration cycles (e.g. 30 to 90 days) or short-term flash sales (e.g. 24 to 48 hours):

```typescript
// Extended 30-day half-life for B2B enterprise funnels
const b2bDecay = calculateAttribution(journey, "time-decay", {
  halfLifeDays: 30,
});

// Accelerated 2-day half-life for seasonal ecommerce promotions
const flashSaleDecay = calculateAttribution(journey, "time-decay", {
  halfLifeDays: 2,
});
```

---

## 6. Edge Collector Pipeline Extensions

`handleEdgeRequest` provides an `onBatch` hook designed for real-time edge processing and streaming into multiple analytical destinations:

```typescript
// workers/telemetry.ts (Cloudflare Workers example)
import { handleEdgeRequest } from "micro-attribution/edge";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleEdgeRequest(request, {
      saltSecret: env.SALT_SECRET,
      onBatch: async (events, context) => {
        // 1. Enrich events with edge runtime geolocation (without third-party APIs)
        const country = (request as unknown as { cf?: { country?: string } }).cf?.country || "UNKNOWN";
        const enrichedEvents = events.map((event) => ({
          ...event,
          geo: { country },
          visitorToken: context.visitorToken,
          clientIpMasked: context.clientIp,
          edgeReceivedAt: context.timestamp,
        }));

        // 2. Dual-dispatch: stream high-priority conversions to transactional queue,
        // and all events to data warehouse
        const conversions = enrichedEvents.filter((e) => e.priority === "high");

        await Promise.all([
          // Destination 1: ClickHouse or BigQuery HTTP ingestion
          fetch(env.CLICKHOUSE_INGEST_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(enrichedEvents),
          }),

          // Destination 2: Real-time Slack or CRM webhook for high-value purchases
          conversions.length > 0
            ? fetch(env.CRM_WEBHOOK_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ conversions }),
              })
            : Promise.resolve(),
        ]);
      },
    });
  },
};
```
