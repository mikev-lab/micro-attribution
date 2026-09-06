# Framework Integration Guides

This guide demonstrates how to integrate `micro-attribution` into modern web application frameworks and serverless edge platforms.

---

## 1. React & Next.js

### React Hook & Context Provider
Create an attribution provider that initializes once per session and exposes a convenient hook:

```typescript
// src/attribution/AttributionContext.tsx
import React, { createContext, useContext, useEffect, useRef } from "react";
import { MicroAttribution } from "micro-attribution/client";

const AttributionContext = createContext<MicroAttribution | null>(null);

export function AttributionProvider({
  endpoint,
  children,
}: {
  endpoint: string;
  children: React.ReactNode;
}) {
  const trackerRef = useRef<MicroAttribution | null>(null);

  if (!trackerRef.current) {
    trackerRef.current = new MicroAttribution({
      endpoint,
      autoCaptureCampaign: true,
      autoCaptureReferrer: true,
    });
  }

  useEffect(() => {
    trackerRef.current?.init();
    trackerRef.current?.pageview();

    return () => {
      trackerRef.current?.stop();
    };
  }, []);

  return (
    <AttributionContext.Provider value={trackerRef.current}>
      {children}
    </AttributionContext.Provider>
  );
}

export function useAttribution(): MicroAttribution {
  const context = useContext(AttributionContext);
  if (!context) {
    throw new Error("useAttribution must be used within an AttributionProvider");
  }
  return context;
}
```

### Tracking Conversions in a Checkout Component
```tsx
// src/components/CheckoutButton.tsx
import React from "react";
import { useAttribution } from "../attribution/AttributionContext";

export function CheckoutButton({ orderId, total }: { orderId: string; total: number }) {
  const attribution = useAttribution();

  const handlePurchase = async () => {
    // Process payment...
    await attribution.conversion("purchase", {
      orderId,
      revenue: total,
      currency: "USD",
    });
  };

  return <button onClick={handlePurchase}>Complete Purchase</button>;
}
```

---

### Next.js App Router
Track client route transitions in Next.js 13+ with the `usePathname` hook:

```tsx
// app/AttributionTracker.tsx
"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { MicroAttribution } from "micro-attribution/client";

export function AttributionTracker({ endpoint }: { endpoint: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const trackerRef = useRef<MicroAttribution | null>(null);

  useEffect(() => {
    const tracker = new MicroAttribution({
      endpoint,
      autoCaptureCampaign: true,
      autoCaptureReferrer: true,
    });
    tracker.init();
    trackerRef.current = tracker;

    return () => {
      tracker.stop();
    };
  }, [endpoint]);

  useEffect(() => {
    if (trackerRef.current) {
      const fullPath = searchParams?.toString()
        ? `${pathname}?${searchParams.toString()}`
        : pathname;
      trackerRef.current.pageview(fullPath);
    }
  }, [pathname, searchParams]);

  return null;
}
```

Include it in `app/layout.tsx`:
```tsx
// app/layout.tsx
import { AttributionTracker } from "./AttributionTracker";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AttributionTracker endpoint="https://telemetry.yourdomain.com/collect" />
        {children}
      </body>
    </html>
  );
}
```

---

## 2. Vue 3 & Nuxt

### Vue 3 Plugin
```typescript
// src/plugins/attribution.ts
import type { App } from "vue";
import type { Router } from "vue-router";
import { MicroAttribution } from "micro-attribution/client";

export default {
  install(app: App, options: { endpoint: string; router?: Router }) {
    const tracker = new MicroAttribution({
      endpoint: options.endpoint,
      autoCaptureCampaign: true,
      autoCaptureReferrer: true,
    });

    tracker.init();
    tracker.pageview();

    if (options.router) {
      options.router.afterEach((to) => {
        tracker.pageview(to.fullPath);
      });
    }

    app.provide("attribution", tracker);
    app.config.globalProperties.$attribution = tracker;
  },
};
```

---

## 3. Serverless Edge Collectors

### Cloudflare Workers
Deploy an edge collection endpoint on Cloudflare Workers with durable KV or D1 database persistence:

```typescript
// workers/telemetry.ts
import { handleEdgeRequest } from "micro-attribution/edge";

export default {
  async fetch(request: Request, env: { DB: D1Database; SALT_SECRET: string }): Promise<Response> {
    return handleEdgeRequest(request, {
      saltSecret: env.SALT_SECRET,
      onBatch: async (events, context) => {
        const statements = events.map((event) =>
          env.DB.prepare(
            "INSERT INTO telemetry_events (event_id, visitor_token, client_ip, timestamp, payload) VALUES (?, ?, ?, ?, ?)"
          ).bind(
            event.id,
            context.visitorToken,
            context.clientIp,
            event.timestamp,
            JSON.stringify(event.payload)
          )
        );
        await env.DB.batch(statements);
      },
    });
  },
};
```

---

### Vercel Edge Functions
Deploy an edge function in Vercel with zero cold starts:

```typescript
// api/telemetry.ts
import { handleEdgeRequest } from "micro-attribution/edge";

export const config = {
  runtime: "edge",
};

export default async function handler(request: Request) {
  return handleEdgeRequest(request, {
    saltSecret: process.env.SALT_SECRET,
    onBatch: async (events, context) => {
      // Stream directly into an analytics warehouse or message broker
      await fetch(process.env.WAREHOUSE_INGEST_URL!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events, context }),
      });
    },
  });
}
```

---

### Node.js & Express / Fastify
Integrate with standard Node.js server environments:

```typescript
// server.ts
import express from "express";
import { handleEdgeRequest } from "micro-attribution/edge";

const app = express();
app.use(express.raw({ type: "*/*" }));

app.all("/api/telemetry", async (req, res) => {
  // Convert Node incoming message to Fetch Request
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const fullUrl = `${protocol}://${req.headers.host}${req.url}`;

  const fetchRequest = new Request(fullUrl, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
  });

  const response = await handleEdgeRequest(fetchRequest, {
    saltSecret: process.env.SALT_SECRET || "development-salt",
    onBatch: async (events, context) => {
      console.log(`Received batch of ${events.length} events from ${context.clientIp}`);
    },
  });

  res.status(response.status);
  response.headers.forEach((val, key) => res.setHeader(key, val));
  const text = await response.text();
  res.send(text);
});

app.listen(3000, () => {
  console.log("Telemetry collector listening on port 3000");
});
```
