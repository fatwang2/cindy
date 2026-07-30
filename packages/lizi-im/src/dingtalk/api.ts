const ACCESS_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const DOWNLOAD_URL =
  "https://api.dingtalk.com/v1.0/robot/messageFiles/download";
const DIRECT_SEND_URL =
  "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
const GROUP_SEND_URL = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 30_000;

export type DingTalkFetch = typeof fetch;

interface AccessTokenCache {
  value: string;
  expiresAt: number;
}

export interface DingTalkOutboundTarget {
  kind: "direct" | "group";
  id: string;
  sessionWebhook: string | null;
  sessionWebhookExpiresAt: number | null;
}

export class DingTalkApiClient {
  private accessToken: AccessTokenCache | null = null;
  private readonly activeRequests = new Set<AbortController>();
  private closed = false;

  constructor(
    private readonly appKey: string,
    private readonly appSecret: string,
    private readonly fetcher: DingTalkFetch = fetch,
  ) {}

  clearAccessToken(): void {
    this.accessToken = null;
  }

  close(): void {
    this.closed = true;
    this.accessToken = null;
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
  }

  async sendText(target: DingTalkOutboundTarget, text: string): Promise<void> {
    if (target.sessionWebhook && this.isWebhookUsable(target)) {
      try {
        await this.postJson(target.sessionWebhook, {
          msgtype: "text",
          text: { content: text },
        });
        return;
      } catch {
        // The proactive API is the durable fallback after a session webhook expires.
      }
    }

    const token = await this.getAccessToken();
    const body =
      target.kind === "group"
        ? {
            robotCode: this.appKey,
            openConversationId: target.id,
            msgKey: "sampleText",
            msgParam: JSON.stringify({ content: text }),
          }
        : {
            robotCode: this.appKey,
            userIds: [target.id],
            msgKey: "sampleText",
            msgParam: JSON.stringify({ content: text }),
          };
    await this.postJson(
      target.kind === "group" ? GROUP_SEND_URL : DIRECT_SEND_URL,
      body,
      token,
    );
  }

  async downloadImage(
    downloadCode: string,
  ): Promise<{ buffer: Uint8Array; mimeType: string }> {
    const token = await this.getAccessToken();
    const response = await this.postJson(
      DOWNLOAD_URL,
      { downloadCode, robotCode: this.appKey },
      token,
    );
    const downloadUrl = stringField(response, "downloadUrl");
    if (!downloadUrl)
      throw new Error("dingtalk media response missing downloadUrl");
    const parsed = new URL(downloadUrl);
    if (!isAllowedMediaHost(parsed)) {
      throw new Error("dingtalk media response returned an untrusted URL");
    }

    const res = await this.fetchWithTimeout(downloadUrl, { redirect: "error" });
    if (!res.ok)
      throw new Error(`dingtalk media download failed: HTTP ${res.status}`);
    const declaredLength = Number(res.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_IMAGE_BYTES) {
      throw new Error("dingtalk media exceeds the image size limit");
    }
    const bytes = await readBodyLimited(res, MAX_IMAGE_BYTES);
    if (bytes.byteLength === 0) {
      throw new Error("dingtalk media has an invalid image size");
    }
    const mimeType = detectImageMime(bytes);
    if (!mimeType) {
      throw new Error("dingtalk media is not an image");
    }
    return { buffer: bytes, mimeType };
  }

  private isWebhookUsable(target: DingTalkOutboundTarget): boolean {
    if (!target.sessionWebhook) return false;
    let url: URL;
    try {
      url = new URL(target.sessionWebhook);
    } catch {
      return false;
    }
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "api.dingtalk.com" &&
        url.hostname !== "oapi.dingtalk.com")
    )
      return false;
    return (
      target.sessionWebhookExpiresAt === null ||
      target.sessionWebhookExpiresAt > Date.now()
    );
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > Date.now()) {
      return this.accessToken.value;
    }
    const body = await this.postJson(ACCESS_TOKEN_URL, {
      appKey: this.appKey,
      appSecret: this.appSecret,
    });
    const value = stringField(body, "accessToken");
    if (!value) throw new Error("dingtalk access token response is invalid");
    const expiresIn = numberField(body, "expireIn") ?? 7_200;
    this.accessToken = {
      value,
      expiresAt: Date.now() + Math.max(60, expiresIn) * 1_000,
    };
    return value;
  }

  private async postJson(
    url: string,
    body: Record<string, unknown>,
    accessToken?: string,
  ): Promise<unknown> {
    const res = await this.fetchWithTimeout(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { "x-acs-dingtalk-access-token": accessToken } : {}),
      },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => null)) as unknown;
    if (!res.ok)
      throw new Error(`dingtalk API request failed: HTTP ${res.status}`);
    if (isRecord(payload)) {
      const code = payload.code;
      const legacyCode = payload.errcode;
      if (
        (typeof code === "string" && code && code !== "0") ||
        (typeof code === "number" && code !== 0) ||
        (typeof legacyCode === "string" && legacyCode && legacyCode !== "0") ||
        (typeof legacyCode === "number" && legacyCode !== 0)
      ) {
        throw new Error("dingtalk API request returned an error");
      }
    }
    return payload;
  }

  private async fetchWithTimeout(
    input: Parameters<DingTalkFetch>[0],
    init: Parameters<DingTalkFetch>[1],
  ): Promise<Response> {
    if (this.closed) throw new Error("dingtalk API client is closed");
    const controller = new AbortController();
    this.activeRequests.add(controller);
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      return await this.fetcher(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      this.activeRequests.delete(controller);
    }
  }
}

function isAllowedMediaHost(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "dingtalk.com" ||
    hostname.endsWith(".dingtalk.com") ||
    hostname === "aliyuncs.com" ||
    hostname.endsWith(".aliyuncs.com") ||
    hostname === "alicdn.com" ||
    hostname.endsWith(".alicdn.com")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  return typeof value[key] === "string" && value[key] ? value[key] : null;
}

function numberField(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  return typeof value[key] === "number" && Number.isFinite(value[key])
    ? value[key]
    : null;
}

async function readBodyLimited(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("dingtalk media exceeds the image size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function detectImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)))
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}
