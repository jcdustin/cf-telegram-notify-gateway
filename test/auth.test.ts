import { describe, expect, it } from "vitest";
import { isAuthorized } from "../src/auth";

describe("Bearer authentication", () => {
  it("accepts the correct token", async () => {
    await expect(isAuthorized("Bearer test-secret", "test-secret")).resolves.toBe(true);
  });

  it("rejects a missing header", async () => {
    await expect(isAuthorized(null, "test-secret")).resolves.toBe(false);
  });

  it.each(["test-secret", "Bearer", "Bearer  test-secret", "Basic test-secret", "Bearer test secret"])(
    "rejects malformed header %s",
    async (header) => {
      await expect(isAuthorized(header, "test-secret")).resolves.toBe(false);
    },
  );

  it("rejects an incorrect token", async () => {
    await expect(isAuthorized("Bearer wrong-secret", "test-secret")).resolves.toBe(false);
  });
});
