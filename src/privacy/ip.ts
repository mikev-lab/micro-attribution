/**
 * IP address classification and subnet truncation utilities.
 * Conforms to GDPR and ePrivacy guidance by zeroing out the host identifier
 * (/24 for IPv4, /48 for IPv6) to prevent longitudinal cross-site tracking.
 */

/**
 * Truncates an IPv4 address to its /24 network prefix by zeroing the last octet.
 *
 * Example:
 *   "198.51.100.42" -> "198.51.100.0"
 *
 * @param ip - Raw IPv4 address string (with optional port).
 * @returns Truncated /24 IPv4 address or fallback if invalid.
 */
export function truncateIpv4(ip: string): string {
  const clean = ip.trim().split(":")[0]!; // Strip optional port
  const parts = clean.split(".");

  if (parts.length !== 4) {
    return clean;
  }

  for (let i = 0; i < 4; i++) {
    const num = Number(parts[i]);
    if (!Number.isInteger(num) || num < 0 || num > 255) {
      return clean;
    }
  }

  return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}

/**
 * Expands an IPv6 address string into its full 8-group representation.
 *
 * @param ip - Clean IPv6 address string.
 * @returns Array of 8 hex group strings.
 */
function expandIpv6(ip: string): string[] | null {
  // Handle IPv4-mapped IPv6 e.g. ::ffff:192.0.2.1
  if (ip.includes(".")) {
    return null;
  }

  let doubleColonIndex = ip.indexOf("::");
  if (doubleColonIndex !== -1) {
    // There can only be at most one "::"
    if (ip.indexOf("::", doubleColonIndex + 2) !== -1) {
      return null;
    }

    const leftPart = ip.slice(0, doubleColonIndex);
    const rightPart = ip.slice(doubleColonIndex + 2);

    const leftGroups = leftPart ? leftPart.split(":") : [];
    const rightGroups = rightPart ? rightPart.split(":") : [];

    const missingGroupsCount = 8 - (leftGroups.length + rightGroups.length);
    if (missingGroupsCount < 0) {
      return null;
    }

    const midGroups = new Array<string>(missingGroupsCount).fill("0");
    const fullGroups = [...leftGroups, ...midGroups, ...rightGroups];

    if (fullGroups.length !== 8) {
      return null;
    }
    return fullGroups.map((g) => g.toLowerCase());
  }

  const groups = ip.split(":");
  if (groups.length !== 8) {
    return null;
  }

  return groups.map((g) => g.toLowerCase());
}

/**
 * Truncates an IPv6 address to its /48 network prefix (first 3 groups of 16 bits).
 *
 * Example:
 *   "2001:0db8:85a3:0000:0000:8a2e:0370:7334" -> "2001:db8:85a3::"
 *
 * @param ip - Raw IPv6 address string (with optional port or brackets).
 * @returns Truncated /48 IPv6 address string.
 */
export function truncateIpv6(ip: string): string {
  let clean = ip.trim().toLowerCase();

  // Strip brackets if present: [2001:db8::1]:8080 -> 2001:db8::1
  if (clean.startsWith("[")) {
    const endBracket = clean.indexOf("]");
    if (endBracket !== -1) {
      clean = clean.slice(1, endBracket);
    }
  }

  // Handle IPv4-mapped IPv6 e.g. ::ffff:192.0.2.128
  if (clean.includes(".")) {
    const lastColon = clean.lastIndexOf(":");
    if (lastColon !== -1) {
      const ipv4Part = clean.slice(lastColon + 1);
      const prefix = clean.slice(0, lastColon + 1);
      return `${prefix}${truncateIpv4(ipv4Part)}`;
    }
  }

  const expanded = expandIpv6(clean);
  if (!expanded) {
    return clean;
  }

  // Format first 3 groups (48 bits) with leading zeros trimmed
  const g1 = parseInt(expanded[0]!, 16).toString(16);
  const g2 = parseInt(expanded[1]!, 16).toString(16);
  const g3 = parseInt(expanded[2]!, 16).toString(16);

  if (g1 === "0" && g2 === "0" && g3 === "0") {
    return "::";
  }

  return `${g1}:${g2}:${g3}::`;
}

/**
 * Automatically classifies and truncates an IPv4 or IPv6 address to its privacy-preserving subnet.
 *
 * @param ip - Inbound IP address string.
 * @returns Truncated IP subnet string.
 */
export function truncateIp(ip: string): string {
  if (!ip || typeof ip !== "string") {
    return "";
  }

  const trimmed = ip.trim();
  if (trimmed.includes(":")) {
    return truncateIpv6(trimmed);
  }

  if (trimmed.includes(".")) {
    return truncateIpv4(trimmed);
  }

  return trimmed;
}
