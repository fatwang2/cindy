import { describe, expect, it, vi } from "vitest";
import type { DWClientDownStream } from "dingtalk-stream";

import type { IMHost, IMMessageEvent } from "../../types.js";
import { DingTalkIM, type DingTalkStreamClient } from "../index.js";

class FakeClient implements DingTalkStreamClient {
  connected = false;
  registered = false;
  config = { autoReconnect: true };
  callback: ((message: DWClientDownStream) => void) | null = null;
  acknowledgements: Array<{ messageId: string; result: unknown }> = [];

  registerCallbackListener(
    _topic: string,
    callback: (message: DWClientDownStream) => void,
  ): DingTalkStreamClient {
    this.callback = callback;
    return this;
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.registered = true;
  }

  disconnect(): void {
    this.connected = false;
    this.registered = false;
  }

  socketCallBackResponse(messageId: string, result: unknown): void {
    this.acknowledgements.push({ messageId, result });
  }

  emit(payload: Record<string, unknown>, callbackId = "callback-1"): void {
    this.callback?.({
      headers: { messageId: callbackId },
      data: JSON.stringify(payload),
    } as DWClientDownStream);
  }
}

function makeHost() {
  const secrets = new Map<string, string>([
    ["dingtalk-bot-app-key", "app-key"],
    ["dingtalk-bot-app-secret", "app-secret"],
  ]);
  const handlers = new Map<string, (payload?: unknown) => unknown>();
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const host: IMHost = {
    secrets: {
      write: (key, value) => {
        secrets.set(key, value);
        return true;
      },
      read: (key) => secrets.get(key) ?? null,
      remove: (key) => void secrets.delete(key),
      isAvailable: () => true,
    },
    ipc: {
      handle: (channel, handler) => void handlers.set(channel, handler),
      broadcast: (channel, payload) =>
        void broadcasts.push({ channel, payload }),
    },
    paths: { feishuMediaDir: "/unused" },
    httpPostForm: async () => ({ status: 200, body: {} }),
  };
  return { host, secrets, handlers, broadcasts };
}

function directMessage(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: "direct-chat",
    conversationType: "1",
    msgId: "message-1",
    msgtype: "text",
    robotCode: "app-key",
    senderId: "sender-id",
    senderStaffId: "owner-1",
    senderNick: "Owner",
    text: { content: "hello" },
    ...overrides,
  };
}

describe("DingTalkIM", () => {
  it("claims the first direct sender, acknowledges immediately, and drops other direct users", async () => {
    const { host, secrets } = makeHost();
    const client = new FakeClient();
    const im = new DingTalkIM(host, { clientFactory: () => client });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));
    await im.init();

    client.emit(directMessage());
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(client.acknowledgements).toEqual([
      { messageId: "callback-1", result: { success: true } },
    ]);
    expect(secrets.get("dingtalk-bot-owner-user-id")).toBe("owner-1");
    expect(received[0]).toMatchObject({
      channelName: "dingtalk",
      senderId: "owner-1",
      text: "hello",
    });

    client.emit(
      directMessage({
        msgId: "message-2",
        senderStaffId: "other-user",
        text: { content: "ignored" },
      }),
      "callback-2",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(1);
  });

  it("routes mentioned group messages to one lane with speaker metadata", async () => {
    const { host } = makeHost();
    const client = new FakeClient();
    const im = new DingTalkIM(host, { clientFactory: () => client });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));
    await im.init();
    client.emit(directMessage());
    await vi.waitFor(() => expect(received).toHaveLength(1));

    client.emit(
      directMessage({
        conversationId: "group/a",
        conversationType: "2",
        msgId: "group-message-1",
        senderStaffId: "guest-1",
        senderNick: "Guest",
        isInAtList: true,
        text: { content: "group question" },
      }),
      "callback-2",
    );
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toMatchObject({
      senderId: "g/group%2Fa",
      chatId: "group/a",
      text: "group question",
      speaker: { id: "guest-1", name: "Guest", isOwner: false },
    });
  });

  it("does not expose the app secret through public state", async () => {
    const { host } = makeHost();
    const client = new FakeClient();
    const im = new DingTalkIM(host, { clientFactory: () => client });
    im.registerIpc();
    await im.init();
    const state = im.getPublicState();
    expect(state).toEqual({
      status: { kind: "connected", appId: "app-key" },
      appKey: "app-key",
      hasSecret: true,
      ownerUserId: null,
    });
    expect(state).not.toHaveProperty("appSecret");
  });

  it("does not emit a slow media callback after the connection is disposed", async () => {
    const { host, secrets } = makeHost();
    secrets.set("dingtalk-bot-owner-user-id", "owner-1");
    host.media = {
      getCachedImage: vi.fn(async () => null),
      cacheImage: vi.fn(async () => ({
        absPath: "/media/image.png",
        url: "cindy-media://image.png",
      })),
      resolveMediaUrl: vi.fn(() => null),
    };
    let releaseDownload!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: "token", expireIn: 7200 })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            downloadUrl: "https://media.dingtalk.com/image.png",
          }),
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseDownload = resolve;
          }),
      );
    const client = new FakeClient();
    const im = new DingTalkIM(host, { clientFactory: () => client, fetcher });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));
    await im.init();

    client.emit(
      directMessage({
        msgId: "picture-1",
        msgtype: "picture",
        content: { downloadCode: "download-1" },
      }),
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    await im.dispose();
    releaseDownload(
      new Response(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(0);
  });

  it("preserves arrival order while an earlier image is downloading", async () => {
    const { host, secrets } = makeHost();
    secrets.set("dingtalk-bot-owner-user-id", "owner-1");
    host.media = {
      getCachedImage: vi.fn(async () => null),
      cacheImage: vi.fn(async () => ({
        absPath: "/media/image.png",
        url: "cindy-media://image.png",
      })),
      resolveMediaUrl: vi.fn(() => null),
    };
    let releaseDownload!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: "token", expireIn: 7200 })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            downloadUrl: "https://media.dingtalk.com/image.png",
          }),
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseDownload = resolve;
          }),
      );
    const client = new FakeClient();
    const im = new DingTalkIM(host, { clientFactory: () => client, fetcher });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));
    await im.init();

    client.emit(
      directMessage({
        msgId: "picture-1",
        msgtype: "picture",
        content: { downloadCode: "download-1" },
      }),
      "callback-picture",
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    client.emit(
      directMessage({
        msgId: "text-2",
        text: { content: "after image" },
      }),
      "callback-text",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(0);

    releaseDownload(
      new Response(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    );
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received.map((event) => event.messageId)).toEqual([
      "picture-1",
      "text-2",
    ]);
  });
});
