/**
 * Campaign Parameter & Inbound Referrer Classification Engine.
 *
 * Automatically parses marketing campaign tags (UTM), ad platform click IDs,
 * and classifies inbound referrers into standard acquisition channels:
 * - 'organic_search'
 * - 'paid_search'
 * - 'paid_social'
 * - 'social'
 * - 'email'
 * - 'display'
 * - 'affiliates'
 * - 'referral'
 * - 'direct'
 *
 * Zero runtime dependencies.
 */

import type { CampaignInfo } from "../types.js";

const SEARCH_ENGINE_PATTERNS: readonly RegExp[] = [
  /(^|\.)google\./i,
  /(^|\.)bing\.com$/i,
  /(^|\.)yahoo\.(com|co\.[a-z]{2})$/i,
  /(^|\.)duckduckgo\.com$/i,
  /(^|\.)baidu\.com$/i,
  /(^|\.)yandex\.(ru|com)$/i,
  /(^|\.)ecosia\.org$/i,
  /(^|\.)ask\.com$/i,
];

const SOCIAL_NETWORK_PATTERNS: readonly RegExp[] = [
  /(^|\.)facebook\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)t\.co$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)lnkd\.in$/i,
  /(^|\.)pinterest\.com$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)reddit\.com$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtu\.be$/i,
  /(^|\.)threads\.net$/i,
  /(^|\.)whatsapp\.com$/i,
  /(^|\.)t\.me$/i,
];

const CLICK_IDENTIFIERS: readonly { readonly param: string; readonly channel: string }[] = [
  { param: "gclid", channel: "paid_search" },
  { param: "wbraid", channel: "paid_search" },
  { param: "gbraid", channel: "paid_search" },
  { param: "msclkid", channel: "paid_search" },
  { param: "fbclid", channel: "paid_social" },
  { param: "ttclid", channel: "paid_social" },
  { param: "li_fat_id", channel: "paid_social" },
  { param: "twclid", channel: "paid_social" },
];

/**
 * Classifies an inbound referrer URL into a marketing acquisition channel.
 *
 * @param referrer - Inbound document.referrer string.
 * @param origin - First-party site origin to detect internal navigation.
 * @returns Inferred acquisition channel identifier.
 */
export function classifyReferrerChannel(referrer?: string, origin?: string): string {
  if (!referrer || typeof referrer !== "string" || referrer.trim().length === 0) {
    return "direct";
  }

  let refHost: string;
  try {
    const parsedRef = new URL(referrer);
    refHost = parsedRef.hostname.toLowerCase();
  } catch {
    return "referral";
  }

  if (origin && typeof origin === "string") {
    try {
      const parsedOrigin = new URL(origin);
      if (refHost === parsedOrigin.hostname.toLowerCase()) {
        return "direct";
      }
    } catch {
      // Origin is not a valid URL; continue classification
    }
  }

  // Check known search engines
  for (const pattern of SEARCH_ENGINE_PATTERNS) {
    if (pattern.test(refHost)) {
      return "organic_search";
    }
  }

  // Check known social platforms
  for (const pattern of SOCIAL_NETWORK_PATTERNS) {
    if (pattern.test(refHost)) {
      return "social";
    }
  }

  return "referral";
}

/**
 * Extracts and normalizes campaign attribution metadata and platform click IDs
 * from the active or supplied URL and referrer.
 *
 * @param urlString - Target URL to parse (defaults to window.location.href in browser).
 * @param referrerString - Inbound referrer URL (defaults to document.referrer in browser).
 * @returns Structured CampaignInfo object.
 */
export function extractCampaignMetadata(
  urlString?: string,
  referrerString?: string
): CampaignInfo {
  const currentUrl =
    urlString ??
    (typeof window !== "undefined" && window.location ? window.location.href : "");

  const currentReferrer =
    referrerString ??
    (typeof document !== "undefined" ? document.referrer : "");

  const currentOrigin =
    typeof window !== "undefined" && window.location ? window.location.origin : undefined;

  let searchParams: URLSearchParams | null = null;
  if (currentUrl) {
    try {
      const parsed = new URL(currentUrl);
      searchParams = parsed.searchParams;
    } catch {
      searchParams = null;
    }
  }

  const utmSource = searchParams?.get("utm_source")?.trim() || undefined;
  const utmMedium = searchParams?.get("utm_medium")?.trim() || undefined;
  const utmCampaign = searchParams?.get("utm_campaign")?.trim() || undefined;
  const utmTerm = searchParams?.get("utm_term")?.trim() || undefined;
  const utmContent = searchParams?.get("utm_content")?.trim() || undefined;

  // Extract ad platform click IDs
  let clickId: string | undefined;
  let clickIdType: string | undefined;
  let clickChannel: string | undefined;

  if (searchParams) {
    for (const { param, channel } of CLICK_IDENTIFIERS) {
      const val = searchParams.get(param)?.trim();
      if (val) {
        clickId = val;
        clickIdType = param;
        clickChannel = channel;
        break;
      }
    }
  }

  // Determine channel precedence:
  // 1. Explicit click identifier (e.g. gclid -> paid_search, fbclid -> paid_social)
  // 2. utm_medium matching standard rules
  // 3. Referrer domain classification
  // 4. Fallback to 'direct'
  let channel = "direct";

  if (clickChannel) {
    channel = clickChannel;
  } else if (utmMedium) {
    const med = utmMedium.toLowerCase();
    if (/^(cpc|ppc|paidsearch|sem|search_paid)$/.test(med)) {
      channel = "paid_search";
    } else if (/^(paidsocial|social_paid|cpm)$/.test(med)) {
      channel = "paid_social";
    } else if (/^(email|newsletter)$/.test(med)) {
      channel = "email";
    } else if (/^(social|social_network|sm)$/.test(med)) {
      channel = "social";
    } else if (/^(display|cpm|banner)$/.test(med)) {
      channel = "display";
    } else if (/^(affiliate|affiliates)$/.test(med)) {
      channel = "affiliates";
    } else if (/^organic$/.test(med)) {
      channel = "organic_search";
    } else if (/^referral$/.test(med)) {
      channel = "referral";
    } else {
      channel = med;
    }
  } else if (currentReferrer) {
    channel = classifyReferrerChannel(currentReferrer, currentOrigin);
  }

  return {
    channel,
    source: utmSource,
    medium: utmMedium,
    campaign: utmCampaign,
    term: utmTerm,
    content: utmContent,
    clickId,
    clickIdType,
    referrer: currentReferrer || undefined,
  };
}
