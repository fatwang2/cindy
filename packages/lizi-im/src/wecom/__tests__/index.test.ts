import { describe, expect, it, vi } from "vitest";

import type { IMHost, IMMessageEvent } from "../../types.js";
import { decodeWecomLane } from "../codec.js";
import { WecomIM } from "../index.js";

type Handler = (...args: any[]) => void;

class FakeClient {
  readonly handlers = new Map<string, Handler[]>();
  readonly sendMessage = vi.fn(async () => ({}));
  readonly sendMediaMessage = vi.fn(async () => ({}));
  readonly replyStream = vi.fn(async () => ({}));
  readonly replyMedia = vi.fn(async () => ({}));
  readonly uploadMedia = vi.fn(async () => ({ media_id: "media-1" }));
  readonly downloadFile = vi.fn(async () => ({
    buffer: Buffer.from("image"),
    filename: "photo.jpg",
  }));
  isConnected = false;
  connectError: Error | null = null;

  on(event: string, handler: Handler) {
    const entries = this.handlers.get(event) ?? [];
    entries.push(handler);
    this.handlers.set(event, entries);
    return this;
  }

  connect() {
    if (this.connectError) throw this.connectError;
    this.isConnected = true;
    this.emit("authenticated");
    return this;
  }

  disconnect() {
    this.isConnected = false;
  }

  emit(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

function createHost() {
  const secrets = new Map<string, string>([
    ["wecom-bot-id", "bot-1"],
    ["wecom-bot-secret", "secret-1"],
  ]);
  const broadcasts: unknown[] = [];
  const host: IMHost = {
    secrets: {
      read: (name) => secrets.get(name) ?? null,
      write: (name, value) => {
        secrets.set(name, value);
        return true;
      },
      remove: (name) => void secrets.delete(name),
      isAvailable: () => true,
    },
    ipc: {
      handle: vi.fn(),
      broadcast: (_channel, payload) => broadcasts.push(payload),
    },
    paths: {
      feishuMediaDir: "unused",
      wecomMediaDir: "unused",
    },
    httpPostForm: async () => ({ status: 200, body: {} }),
  };
  return { host, secrets, broadcasts };
}

function message(args: {
  id: string;
  sender: string;
  text: string;
  chatId?: string;
}) {
  return {
    body: {
      msgid: args.id,
      aibotid: "bot-1",
      chattype: args.chatId ? "group" : "single",
      ...(args.chatId ? { chatid: args.chatId } : {}),
      from: { userid: args.sender },
      msgtype: "text",
      text: { content: args.text },
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("WecomIM routing and ownership", () => {
  it("TOFU-binds the first DM sender and only accepts that owner afterwards", async () => {
    const { host, secrets } = createHost();
    const client = new FakeClient();
    const im = new WecomIM(host, {
      clientFactory: () => client as never,
    });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit(
      "message.text",
      message({ id: "m1", sender: "owner", text: "hello" }),
    );
    client.emit(
      "message.text",
      message({ id: "m2", sender: "other", text: "blocked" }),
    );
    await flush();

    expect(secrets.get("wecom-owner-user-id")).toBe("owner");
    expect(received.map((event) => event.text)).toEqual(["hello"]);
  });

  it("routes owner group messages through an encoded lane and active fallback uses chatid", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit(
      "message.text",
      message({
        id: "m-group",
        sender: "owner",
        text: "group task",
        chatId: "chat-123",
      }),
    );
    await flush();

    const lane = received[0]!.senderId;
    expect(decodeWecomLane(lane)).toEqual({
      kind: "group",
      targetId: "chat-123",
    });
    await im.sendMarkdownText(lane, "**ack**");
    expect(client.replyStream).toHaveBeenCalledOnce();

    await im.sendMarkdownText(lane, "**active**");
    expect(client.sendMessage).toHaveBeenCalledWith("chat-123", {
      msgtype: "markdown",
      markdown: { content: "**active**" },
    });
  });

  it("deduplicates repeated callback message ids", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received = vi.fn();
    im.onMessage(received);

    await im.init();
    const frame = message({ id: "same", sender: "owner", text: "once" });
    client.emit("message.text", frame);
    client.emit("message.text", frame);
    await flush();

    expect(received).toHaveBeenCalledOnce();
  });

  it("surfaces a synchronous SDK startup failure instead of staying connecting", async () => {
    const { host } = createHost();
    const client = new FakeClient();
    client.connectError = new Error("invalid credentials");
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await expect(im.init()).resolves.toBeUndefined();

    expect(im.getStatus()).toEqual({
      kind: "error",
      reason: "invalid credentials",
    });
  });

  it("preserves arrival order when media download is slower than a following text message", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    let releaseDownload!: () => void;
    client.downloadFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDownload = () =>
            resolve({ buffer: Buffer.from("image"), filename: "photo.jpg" });
        }),
    );
    host.media = {
      getCachedImage: async () => null,
      cacheImage: async () => ({
        absPath: "C:\\managed\\photo.jpg",
        url: "cindy-media://image",
      }),
      resolveMediaUrl: () => null,
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: string[] = [];
    im.onMessage((event) =>
      received.push(event.text || event.attachments[0]?.kind || "empty"),
    );

    await im.init();
    client.emit("message.image", {
      body: {
        msgid: "image-first",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "image",
        image: { url: "https://example.invalid/image" },
      },
    });
    client.emit(
      "message.text",
      message({ id: "text-second", sender: "owner", text: "second" }),
    );
    await flush();
    expect(received).toEqual([]);

    releaseDownload();
    await flush();
    await flush();
    expect(received).toEqual(["image", "second"]);
  });
});
