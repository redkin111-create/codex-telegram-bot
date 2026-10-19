import type { MobileCapabilities } from "./types.js";

export function isCapabilitySectionResponse(
  capabilities: Pick<MobileCapabilities, "capabilitySection">,
  expected: NonNullable<MobileCapabilities["capabilitySection"]>,
): boolean {
  return capabilities.capabilitySection === expected;
}
