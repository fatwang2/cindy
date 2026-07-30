import { describe, expect, it, vi } from "vitest";

import { DingTalkApiClient } from "../api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("DingTalkApiClient", () => {
  it("never posts to an untrusted session webhook and falls back to the fixed API", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: "token", expireIn: 7200 }),
      )
      .mockResolvedValueOnce(jsonResponse({}));
    const api = new DingTalkApiClient("app-key", "app-secret", fetcher);

    await api.sendText(
      {
        kind: "direct",
        id: "owner-1",
        sessionWebhook: "https://example.invalid/collect",
        sessionWebhookExpiresAt: Date.now() + 60_000,
      },
      "hello",
    );

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.dingtalk.com/v1.0/oauth2/accessToken",
      "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
    ]);
  });

  it("rejects media download URLs outside the expected service domains", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: "token", expireIn: 7200 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ downloadUrl: "https://127.0.0.1/internal-resource" }),
      );
    const api = new DingTalkApiClient("app-key", "app-secret", fetcher);

    await expect(api.downloadImage("download-code")).rejects.toThrow(
      /untrusted URL/,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
