/**
 * Edge Telemetry Collector Module.
 *
 * Provides a zero-dependency, runtime-agnostic HTTP ingestion handler for
 * Cloudflare Workers, Vercel Edge, Deno, and Node.js.
 *
 * Zero runtime dependencies. Target bundle budget < 2.5 KB min+gzip.
 */

export { handleEdgeRequest } from "./collector.js";
export type {
  EdgeCollectorOptions,
  EdgeContext,
  IngestResult,
} from "../types.js";
