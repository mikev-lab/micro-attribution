import { describe, expect, it } from "vitest";
import {
  classifyReferrerChannel,
  extractCampaignMetadata,
} from "../../src/client/campaign.js";

describe("Campaign Parameter & Referrer Classification Engine", () => {
  describe("classifyReferrerChannel", () => {
    it("classifies major search engines as organic_search", () => {
      expect(classifyReferrerChannel("https://www.google.com/")).toBe("organic_search");
      expect(classifyReferrerChannel("https://google.co.uk/search?q=test")).toBe("organic_search");
      expect(classifyReferrerChannel("https://search.yahoo.com/")).toBe("organic_search");
      expect(classifyReferrerChannel("https://www.bing.com/")).toBe("organic_search");
      expect(classifyReferrerChannel("https://duckduckgo.com/?q=privacy")).toBe("organic_search");
      expect(classifyReferrerChannel("https://www.baidu.com/")).toBe("organic_search");
      expect(classifyReferrerChannel("https://yandex.ru/")).toBe("organic_search");
      expect(classifyReferrerChannel("https://www.ecosia.org/")).toBe("organic_search");
    });

    it("classifies major social media platforms as social", () => {
      expect(classifyReferrerChannel("https://www.facebook.com/")).toBe("social");
      expect(classifyReferrerChannel("https://m.facebook.com/")).toBe("social");
      expect(classifyReferrerChannel("https://instagram.com/p/12345")).toBe("social");
      expect(classifyReferrerChannel("https://twitter.com/")).toBe("social");
      expect(classifyReferrerChannel("https://t.co/xyz123")).toBe("social");
      expect(classifyReferrerChannel("https://x.com/")).toBe("social");
      expect(classifyReferrerChannel("https://www.linkedin.com/feed/")).toBe("social");
      expect(classifyReferrerChannel("https://lnkd.in/abc")).toBe("social");
      expect(classifyReferrerChannel("https://www.tiktok.com/@user")).toBe("social");
      expect(classifyReferrerChannel("https://www.reddit.com/r/technology")).toBe("social");
      expect(classifyReferrerChannel("https://www.youtube.com/watch?v=123")).toBe("social");
      expect(classifyReferrerChannel("https://youtu.be/123")).toBe("social");
      expect(classifyReferrerChannel("https://threads.net/@user")).toBe("social");
    });

    it("identifies direct navigation on empty or same-origin referrer", () => {
      expect(classifyReferrerChannel("")).toBe("direct");
      expect(classifyReferrerChannel("   ")).toBe("direct");
      expect(classifyReferrerChannel(undefined)).toBe("direct");
      expect(
        classifyReferrerChannel(
          "https://example.com/checkout",
          "https://example.com"
        )
      ).toBe("direct");
    });

    it("classifies unknown external hostnames as referral", () => {
      expect(classifyReferrerChannel("https://partner-blog.org/reviews")).toBe("referral");
      expect(classifyReferrerChannel("https://techcrunch.com/article")).toBe("referral");
      expect(classifyReferrerChannel("not-a-valid-url")).toBe("referral");
    });
  });

  describe("extractCampaignMetadata", () => {
    it("extracts standard UTM parameters accurately", () => {
      const url =
        "https://example.com/landing?utm_source=newsletter&utm_medium=email&utm_campaign=summer_sale&utm_term=shoes&utm_content=v1_cta";

      const info = extractCampaignMetadata(url);

      expect(info.channel).toBe("email");
      expect(info.source).toBe("newsletter");
      expect(info.medium).toBe("email");
      expect(info.campaign).toBe("summer_sale");
      expect(info.term).toBe("shoes");
      expect(info.content).toBe("v1_cta");
      expect(info.clickId).toBeUndefined();
    });

    it("detects Google Ads gclid and assigns paid_search channel", () => {
      const url = "https://example.com/landing?gclid=test_gclid_12345&utm_source=google";
      const info = extractCampaignMetadata(url);

      expect(info.clickId).toBe("test_gclid_12345");
      expect(info.clickIdType).toBe("gclid");
      expect(info.channel).toBe("paid_search");
    });

    it("detects Meta Ads fbclid and assigns paid_social channel", () => {
      const url = "https://example.com/product?fbclid=test_fbclid_67890";
      const info = extractCampaignMetadata(url);

      expect(info.clickId).toBe("test_fbclid_67890");
      expect(info.clickIdType).toBe("fbclid");
      expect(info.channel).toBe("paid_social");
    });

    it("detects Google Privacy Sandbox wbraid and gbraid click identifiers", () => {
      const url1 = "https://example.com/landing?wbraid=test_wbraid_123";
      expect(extractCampaignMetadata(url1).channel).toBe("paid_search");

      const url2 = "https://example.com/landing?gbraid=test_gbraid_456";
      expect(extractCampaignMetadata(url2).channel).toBe("paid_search");
    });

    it("classifies utm_medium variations into standard channels", () => {
      expect(extractCampaignMetadata("https://example.com/?utm_medium=cpc").channel).toBe("paid_search");
      expect(extractCampaignMetadata("https://example.com/?utm_medium=ppc").channel).toBe("paid_search");
      expect(extractCampaignMetadata("https://example.com/?utm_medium=paidsocial").channel).toBe("paid_social");
      expect(extractCampaignMetadata("https://example.com/?utm_medium=social").channel).toBe("social");
      expect(extractCampaignMetadata("https://example.com/?utm_medium=display").channel).toBe("display");
      expect(extractCampaignMetadata("https://example.com/?utm_medium=affiliate").channel).toBe("affiliates");
      expect(extractCampaignMetadata("https://example.com/?utm_medium=organic").channel).toBe("organic_search");
    });

    it("falls back to referrer classification when UTM parameters and click IDs are absent", () => {
      const url = "https://example.com/product/123";
      const referrer = "https://www.google.com/search?q=micro-attribution";

      const info = extractCampaignMetadata(url, referrer);

      expect(info.channel).toBe("organic_search");
      expect(info.referrer).toBe(referrer);
      expect(info.source).toBeUndefined();
    });

    it("defaults to direct when neither campaign parameters nor referrer exist", () => {
      const url = "https://example.com/home";
      const info = extractCampaignMetadata(url, "");

      expect(info.channel).toBe("direct");
      expect(info.clickId).toBeUndefined();
    });

    it("handles malformed or empty URLs gracefully without throwing", () => {
      expect(extractCampaignMetadata("").channel).toBe("direct");
      expect(extractCampaignMetadata("not a valid url").channel).toBe("direct");
    });
  });
});
