import { describe, it, expect } from "vitest";
import { truncateIpv4, truncateIpv6, truncateIp } from "../../src/privacy/ip";

describe("IP Subnet Truncation Utilities", () => {
  describe("IPv4 /24 Subnet Masking", () => {
    it("truncates standard public IPv4 address to /24", () => {
      expect(truncateIpv4("198.51.100.42")).toBe("198.51.100.0");
      expect(truncateIpv4("203.0.113.195")).toBe("203.0.113.0");
    });

    it("truncates private and loopback IPv4 addresses", () => {
      expect(truncateIpv4("192.168.1.254")).toBe("192.168.1.0");
      expect(truncateIpv4("10.0.50.88")).toBe("10.0.50.0");
      expect(truncateIpv4("127.0.0.1")).toBe("127.0.0.0");
    });

    it("strips optional port before truncation", () => {
      expect(truncateIpv4("192.168.1.10:8080")).toBe("192.168.1.0");
      expect(truncateIpv4("10.1.2.3:443")).toBe("10.1.2.0");
    });

    it("returns raw string if IPv4 octet structure is invalid", () => {
      expect(truncateIpv4("999.1.1.1")).toBe("999.1.1.1");
      expect(truncateIpv4("1.2.3")).toBe("1.2.3");
      expect(truncateIpv4("not.an.ip.address")).toBe("not.an.ip.address");
    });
  });

  describe("IPv6 /48 Subnet Masking", () => {
    it("truncates standard uncompressed IPv6 address to /48 prefix", () => {
      const fullIpv6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
      expect(truncateIpv6(fullIpv6)).toBe("2001:db8:85a3::");
    });

    it("truncates compressed IPv6 address with :: syntax", () => {
      expect(truncateIpv6("2001:db8:cafe::1")).toBe("2001:db8:cafe::");
      expect(truncateIpv6("2001:db8:abcd:ef01::1234")).toBe("2001:db8:abcd::");
    });

    it("truncates IPv6 with bracket notation and optional port", () => {
      expect(truncateIpv6("[2001:db8:85a3::8a2e:370:7334]:8080")).toBe("2001:db8:85a3::");
    });

    it("truncates IPv4-mapped IPv6 addresses correctly", () => {
      expect(truncateIpv6("::ffff:192.0.2.128")).toBe("::ffff:192.0.2.0");
    });

    it("handles loopback IPv6 address", () => {
      expect(truncateIpv6("::1")).toBe("::");
    });
  });

  describe("truncateIp Classifier", () => {
    it("automatically classifies and masks IPv4", () => {
      expect(truncateIp("198.51.100.77")).toBe("198.51.100.0");
    });

    it("automatically classifies and masks IPv6", () => {
      expect(truncateIp("2001:db8:1234::5678")).toBe("2001:db8:1234::");
    });

    it("handles empty or non-string inputs safely", () => {
      expect(truncateIp("")).toBe("");
      expect(truncateIp("   ")).toBe("");
    });
  });
});
