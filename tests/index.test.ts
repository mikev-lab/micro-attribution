import { describe, it, expect } from "vitest";
import { VERSION } from "../src/index";

describe("MicroAttribution Base SDK", () => {
  it("exports correct version string", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
