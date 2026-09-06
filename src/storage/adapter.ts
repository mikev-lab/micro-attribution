/**
 * Shared storage constants and utility functions for storage adapters.
 */

export const DEFAULT_DB_NAME = "__micro_attr_db";
export const DEFAULT_STORE_NAME = "event_queue";
export const DEFAULT_LS_KEY = "__micro_attr_queue__";

/**
 * Estimates the byte size of an arbitrary JavaScript value when serialized as JSON.
 *
 * Uses TextEncoder when available for accurate UTF-8 byte measurement,
 * falling back to UTF-16 character length approximation in legacy runtimes.
 *
 * @param value The value whose byte size is to be estimated.
 * @returns Approximate byte length of the JSON string representation.
 */
export function estimateByteSize(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }

  try {
    const jsonString = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(jsonString).length;
    }
    return jsonString.length * 2;
  } catch {
    return 64;
  }
}
