import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("RFQ server", () => {
  it("exposes a health endpoint for local development", async () => {
    const response = await SELF.fetch("https://example.com/health", {
      headers: { Origin: "http://localhost:5173" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      environment: env.PRODUCT_ENVIRONMENT,
      status: "ok",
    });
  });

  it("rejects unknown browser origins", async () => {
    const response = await SELF.fetch("https://example.com/health", {
      headers: { Origin: "https://untrusted.example" },
    });

    expect(response.status).toBe(403);
  });
});
