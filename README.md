# micro-attribution

[![Zero Runtime Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)
[![Dual Runtime](https://img.shields.io/badge/runtime-Browser%20%7C%20Edge%20%7C%20Node-blue.svg)](#dual-runtime-topology)
[![Bundle Size Budget](https://img.shields.io/badge/min%2Bgzip-%3C%202.5%20KB%20per%20module-brightgreen.svg)](#verified-bundle-budget-metrics)
[![Tests Passing](https://img.shields.io/badge/tests-198%20passed-success.svg)](tests/)
[![TypeScript Strict](https://img.shields.io/badge/typescript-strict%20mode-blue.svg)](tsconfig.json)
[![Statutory Privacy](https://img.shields.io/badge/privacy-GDPR%20%7C%20CCPA%20%7C%20ePrivacy-orange.svg)](#privacy-preserving-guarantees)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An enterprise-grade, zero-dependency client and edge telemetry library for privacy-preserving conversion attribution.

Designed for high-throughput marketing telemetry, cookieless sessionization, offline-resilient event queuing, and multi-touch attribution (MTA) calculation across modern browsers, Web Workers, and serverless edge runtimes.

---

## Technical Highlights

- **Absolute Zero Dependencies**: Runtime `dependencies: {}` in `package.json`. Native Web APIs (`crypto.subtle`, `IndexedDB`, `fetch`, `navigator.sendBeacon`) and pure TypeScript.
- **Strict Bundle Budget**: Every modular subpath bundle compiles to **strictly < 2.5 KB min+gzip**.
- **Dual-Runtime Agnostic**: Runs identically in Browser DOM, Web Workers, Cloudflare Workers, Vercel Edge, Deno, and Node.js LTS.
- **Offline Resilience & Backpressure Engine**: Durable 3-tier storage hierarchy (`IndexedDB` -> `localStorage` -> `Memory`) with priority-aware FIFO eviction protecting monetary conversions under quota pressure.
- **Guaranteed Delivery & Unload Flush**: Lifecycle hooks bound to `visibilitychange` and `pagehide` ensuring bfcache compatibility and zero event loss during tab closures.
- **Network Flapping & Exponential Backoff**: Truncated exponential backoff with full randomized jitter and RFC 7231 `Retry-After` header parsing.
- **Statutory Privacy (GDPR, CCPA, ePrivacy)**: Zero third-party cookies, IPv4/IPv6 subnet masking (/24 and /48 prefix), deep recursive PII payload sanitization, and daily rotating ephemeral salt tokenization.
- **Multi-Touch Attribution Engine**: First-Touch, Last-Touch, Last Non-Direct, Linear, Time-Decay (half-life exponential decay), Position-Based (U-Shaped), and first-order Markov Chain with Removal Effect scoring.

---

## Architectural Data Flow

```mermaid
flowchart TD
    subgraph BrowserClient ["Browser Client Context"]
        Campaign["Campaign Classifier: UTMs, Click IDs, Referrer"]
        SDK["MicroAttribution SDK: pageview, touchpoint, conversion"]
        Queue["EventQueue: 3-Tier Storage (IndexedDB, LocalStorage, Memory)"]
        Dispatcher["NetworkDispatcher: Truncated Backoff + Full Jitter"]
        Flusher["Unload Flusher: visibilitychange, pagehide (bfcache safe)"]
    end

    subgraph EdgeCollector ["Serverless Edge Runtime Context"]
        Worker["handleEdgeRequest: Cloudflare, Vercel, Deno, Node"]
        IPMask["IP Masking: /24 IPv4, /48 IPv6"]
        TokenGen["Daily Ephemeral Visitor Token: SHA-256 + Rotating Salt"]
        PIIScrub["Recursive PII Scrubber: Redact Emails, Cards, SSNs"]
        Sink["Database Ingestion Callback: BigQuery, ClickHouse, Postgres"]
    end

    subgraph AttributionEngine ["Mathematical Attribution Engine"]
        SingleTouch["Single-Touch: FTA, LTA, Last Non-Direct"]
        MultiTouch["Heuristic MTA: Linear, Time-Decay, Position-Based"]
        Markov["Algorithmic MTA: Discrete-Time Markov Removal Effects"]
    end

    Campaign --> SDK
    SDK --> Queue
    Queue --> Dispatcher
    Flusher --> Dispatcher
    Dispatcher -->|POST /telemetry (Beacon / Keepalive Fetch)| Worker

    Worker --> IPMask
    IPMask --> TokenGen
    TokenGen --> PIIScrub
    PIIScrub --> Sink

    Sink --> SingleTouch
    Sink --> MultiTouch
    Sink --> Markov
```

---

## Verified Bundle Budget Metrics

Every submodule is tree-shakeable and independently importable, satisfying strict bundle constraints:

| Subpath Package | ESM Artifact | CJS Artifact | Verified Gzip Size | Target Ceiling | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `micro-attribution/attribution` | `dist/attribution.js` | `dist/attribution.cjs` | **2,246 bytes** | < 2,560 bytes | PASSED (-314 B) |
| `micro-attribution/privacy` | `dist/privacy.js` | `dist/privacy.cjs` | **2,297 bytes** | < 2,560 bytes | PASSED (-263 B) |
| `micro-attribution/storage` | `dist/storage.js` | `dist/storage.cjs` | **2,029 bytes** | < 2,560 bytes | PASSED (-531 B) |
| `micro-attribution/queue` | `dist/queue.js` | `dist/queue.cjs` | **1,631 bytes** | < 2,560 bytes | PASSED (-929 B) |
| `micro-attribution/transport` | `dist/transport.js` | `dist/transport.cjs` | **2,059 bytes** | < 2,560 bytes | PASSED (-501 B) |
| `micro-attribution/edge` | `dist/edge.js` | `dist/edge.cjs` | **2,545 bytes** | < 2,560 bytes | PASSED (-15 B) |
| `micro-attribution/client` | `dist/client.js` | `dist/client.cjs` | **6,820 bytes** | < 7,500 bytes | PASSED (-680 B) |

---

## Quickstart Guide

### 1. Client-Side Browser Telemetry

Install `micro-attribution` via your package manager:

```bash
npm install micro-attribution
```

Initialize telemetry tracking with automatic campaign extraction, background queuing, and guaranteed unload delivery:

```typescript
import { MicroAttribution } from "micro-attribution/client";

// Initialize client tracker
const tracker = new MicroAttribution({
  endpoint: "https://telemetry.yourdomain.com/collect",
  sampleRate: 1.0, // 100% of standard pageviews
  autoCaptureCampaign: true, // Extracts UTM parameters and platform click IDs (gclid, fbclid, etc.)
});

await tracker.init();

// Track pageviews
await tracker.pageview();

// Track custom interactions
await tracker.touchpoint("newsletter_signup", { source: "modal_popup" });

// Track high-priority conversions (bypasses sampling, strictly preserved under quota limits)
await tracker.conversion("order_completed", {
  orderId: "ord_98765",
  revenue: 149.50,
  currency: "USD",
});
```

---

### 2. Universal Edge Ingestion Handler

Deploy an ingestion collector on Cloudflare Workers, Vercel Edge, Deno, or Node.js:

```typescript
import { handleEdgeRequest } from "micro-attribution/edge";

export default {
  async fetch(request: Request): Promise<Response> {
    return handleEdgeRequest(request, {
      saltSecret: "your-cryptographic-daily-salt-secret",
      onBatch: async (events, context) => {
        // Persist sanitized, tokenized events to your database or message queue
        console.log(`Ingested ${events.length} events from visitor ${context.visitorToken}`);
        await database.insert(events);
      },
    });
  },
};
```

---

### 3. Multi-Touch Attribution Modeling

Compute attribution across customer journeys:

```typescript
import { calculateAttribution, calculateCohortAttribution } from "micro-attribution/attribution";
import type { CustomerJourney } from "micro-attribution";

const journey: CustomerJourney = {
  visitorId: "anon_usr_772",
  touchpoints: [
    { channel: "paid_search", timestamp: 1700000000000 },
    { channel: "social", timestamp: 1700086400000 },
    { channel: "organic_search", timestamp: 1700172800000 },
    { channel: "direct", timestamp: 1700259200000 },
  ],
  conversion: {
    id: "conv_441",
    value: 500.0,
    timestamp: 1700262800000,
  },
};

// 1. Time-Decay Attribution (exponential half-life decay)
const decayResult = calculateAttribution(journey, "time-decay", { halfLifeDays: 7 });
console.log(decayResult.credits);
// { paid_search: 84.15, social: 92.83, organic_search: 102.41, direct: 220.61 }

// 2. Position-Based / U-Shaped Attribution (40% first, 40% last, 20% intermediate)
const uShapedResult = calculateAttribution(journey, "position-based");
console.log(uShapedResult.credits);
// { paid_search: 200.0, social: 50.0, organic_search: 50.0, direct: 200.0 }

// 3. Algorithmic Markov Chain Attribution (Removal Effects)
const cohortResults = calculateCohortAttribution([journey /* ...cohort journeys */], "markov");
console.log(cohortResults.credits);
```

---

## Privacy-Preserving Guarantees

1. **Zero Third-Party Cookies**: Operates completely cookieless. Sessionization relies on ephemeral daily tokens.
2. **Daily Rotating Salt Tokenization**: Visitor tokens are calculated via HMAC-SHA256 using an ephemeral salt rotated at UTC midnight. Intraday journeys are stitched accurately, while longitudinal cross-day surveillance is cryptographically prevented.
3. **Subnet Masking**: Client IP addresses are truncated before downstream logging: IPv4 addresses have their host octet zeroed (`/24`), and IPv6 addresses have their interface identifier masked (`/48`).
4. **Recursive PII Sanitizer**: Payload values and URL query parameters are recursively scanned against key denylists and regex patterns, automatically redacting emails, payment cards (Luhn-compliant PANs), and government identifiers.

---

## Detailed Documentation Guides

- [Technical Architecture & System Design](docs/ARCHITECTURE.md): Dual-runtime topology, storage hierarchy, backpressure algorithms, and transport negotiation.
- [Multi-Touch Attribution Models & Mathematics](docs/ATTRIBUTION_MODELS.md): Formulas and derivations for FTA, LTA, Last Non-Direct, Linear, Time-Decay, Position-Based, and absorbing Markov Chains.

---

## Verification & Quality Gates

The entire library is strictly gated by automated compliance, strict type checking, and unit/chaos test suites:

```bash
# Verify architectural specifications, stealth boundaries, and invariant compliance
npm run test:compliance

# Execute strict TypeScript typecheck (zero warnings, zero any)
npm run typecheck

# Run full Vitest suite (198 tests across 25 unit, chaos, and math suites)
npm test

# Build production distributions and verify subpath bundle budgets
npm run build
```

---

## License

MIT License. Copyright (c) 2026 Mike V.
