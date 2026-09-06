/**
 * Client Telemetry SDK Entry Point.
 *
 * Provides embeddable browser client telemetry, automated campaign parameter capture,
 * referrer channel classification, and cookieless sessionization.
 *
 * Zero runtime dependencies. Target bundle budget < 2.5 KB min+gzip.
 */

export { MicroAttribution } from "./sdk.js";
export {
  extractCampaignMetadata,
  classifyReferrerChannel,
} from "./campaign.js";
