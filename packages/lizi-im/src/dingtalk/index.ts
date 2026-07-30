import {
  DWClient,
  TOPIC_ROBOT,
  type DWClientDownStream,
} from "dingtalk-stream";

import { BaseIM } from "../BaseIM.js";
import type { ChannelIM, ImFinalOutput } from "../channelIM.js";
import type {
  IMCardActionEvent,
  IMHost,
  IMMessageEvent,
  IMStatus,
  InteractiveCardSpec,
  SendFileResult,
  StreamingTextHandle,
} from "../types.js";
import {
  DingTalkApiClient,
  type DingTalkFetch,
  type DingTalkOutboundTarget,
} from "./api.js";
import { decodeLaneUserId, encodeLaneUserId } from "./codec.js";
import {
  imageAttachment,
  parseInboundContent,
  parseInboundEnvelope,
  type DingTalkInboundEnvelope,
} from "./inbound.js";

const APP_KEY_SECRET = "dingtalk-bot-app-key";
const APP_SECRET_SECRET = "dingtalk-bot-app-secret";
const OWNER_USER_ID_SECRET = "dingtalk-bot-owner-user-id";
const DEDUP_TTL_MS = 5 * 60 * 1_000;
const DEDUP_CAPACITY = 2_048;
const STATUS_POLL_MS = 2_000;
const INTERACTION_TIMEOUT_MS = 30 * 60 * 1_000;
const OUTBOUND_CHUNK_SIZE = 3_500;
const REGISTRATION_TIMEOUT_MS = 10_000;

type MessageHandler = (event: IMMessageEvent) => void;
type StatusHandler = (status: IMStatus) => void;

export interface DingTalkStreamClient {
  readonly connected: boolean;
  readonly registered: boolean;
  readonly config: { autoReconnect?: boolean };
  registerCallbackListener(
    topic: string,
    callback: (message: DWClientDownStream) => void,
  ): DingTalkStreamClient;
  connect(): Promise<void>;
  disconnect(): void;
  socketCallBackResponse(messageId: string, result: unknown): void;
}

export interface DingTalkIMOptions {
  fetcher?: DingTalkFetch;
  clientFactory?: (credentials: {
    appKey: string;
    appSecret: string;
  }) => DingTalkStreamClient;
}

export interface DingTalkPublicState {
  status: IMStatus;
  appKey: string | null;
  hasSecret: boolean;
  ownerUserId: string | null;
}

interface Credentials {
  appKey: string;
  appSecret: string;
}

interface PendingReply<T = unknown> {
  parse(text: string): T | null;
  resolve(value: T): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class DingTalkIM extends BaseIM implements ChannelIM {
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly targetByUserId = new Map<string, DingTalkOutboundTarget>();
  private readonly laneQueues = new Map<string, Promise<void>>();
  private readonly seenMessageIds = new Map<string, number>();
  private readonly pendingReplies = new Map<string, PendingReply>();

  private status: IMStatus = { kind: "idle" };
  private client: DingTalkStreamClient | null = null;
  private api: DingTalkApiClient | null = null;
  private appKey = "";
  private ownerUserId = "";
  private connectionVersion = 0;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    host: IMHost,
    private readonly options: DingTalkIMOptions = {},
  ) {
    super("dingtalk", host);
  }

  async init(): Promise<void> {
    const credentials = this.readCredentials();
    this.ownerUserId =
      this.host.secrets.read(OWNER_USER_ID_SECRET)?.trim() ?? "";
    if (!credentials) {
      this.setStatus({ kind: "idle" });
      return;
    }
    try {
      await this.connect(credentials);
    } catch (error) {
      this.setStatus({
        kind: "error",
        reason: safeConnectionError(error),
      });
    }
  }

  async dispose(): Promise<void> {
    this.connectionVersion += 1;
    this.stopStatusMonitor();
    this.client?.disconnect();
    this.client = null;
    this.api?.close();
    this.api = null;
    this.targetByUserId.clear();
    this.laneQueues.clear();
    this.seenMessageIds.clear();
    this.rejectPendingReplies("DINGTALK_DISCONNECTED");
    this.setStatus({ kind: "idle" });
  }

  registerIpc(): void {
    this.host.ipc.handle("dingtalkBot:get-state", () => this.getPublicState());
    this.host.ipc.handle("dingtalkBot:save", async (payload) => {
      const record = isRecord(payload) ? payload : {};
      const appKey =
        typeof record.appKey === "string" ? record.appKey.trim() : "";
      const appSecret =
        typeof record.appSecret === "string" ? record.appSecret.trim() : "";
      if (
        !appKey ||
        !appSecret ||
        appKey.length > 256 ||
        appSecret.length > 512
      ) {
        throw new Error("[INVALID_PAYLOAD] appKey and appSecret required");
      }
      return this.runInAccountScope(() =>
        this.saveAndConnect({ appKey, appSecret }),
      );
    });
    this.host.ipc.handle("dingtalkBot:reconnect", async () => {
      return this.runInAccountScope(async () => {
        const credentials = this.readCredentials();
        if (!credentials) throw new Error("DINGTALK_CREDENTIALS_MISSING");
        await this.connect(credentials);
        return this.getPublicState();
      });
    });
    this.host.ipc.handle("dingtalkBot:clear", async () => {
      await this.clearAndDisconnect();
      return { ok: true };
    });
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  onCardAction(handler: (event: IMCardActionEvent) => void): () => void {
    void handler;
    return () => undefined;
  }

  getStatus(): IMStatus {
    return this.status;
  }

  getPublicState(): DingTalkPublicState {
    const credentials = this.readCredentials();
    return {
      status: this.status,
      appKey: credentials?.appKey ?? null,
      hasSecret: Boolean(credentials),
      ownerUserId: this.host.secrets.read(OWNER_USER_ID_SECRET)?.trim() || null,
    };
  }

  async sendText(userId: string, text: string): Promise<{ messageId: string }> {
    const api = this.requireApi();
    const target = this.resolveTarget(userId);
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      await api.sendText(target, chunk);
    }
    return { messageId: `out:${Date.now().toString(36)}` };
  }

  sendMarkdownText(
    userId: string,
    markdown: string,
  ): Promise<{ messageId: string }> {
    return this.sendText(userId, markdown);
  }

  async sendFile(
    _userId: string,
    _absPath: string,
    _displayName?: string,
  ): Promise<SendFileResult> {
    return { ok: false, reason: "SEND_FAIL" };
  }

  sendInteractiveCard(
    _userId: string,
    _spec: InteractiveCardSpec,
  ): Promise<{ messageId: string }> {
    return Promise.reject(new Error("DINGTALK_RICH_OUTPUT_UNSUPPORTED"));
  }

  updateInteractiveCard(
    _messageId: string,
    _spec: InteractiveCardSpec,
  ): Promise<void> {
    return Promise.reject(new Error("DINGTALK_RICH_OUTPUT_UNSUPPORTED"));
  }

  patchMarkdownCard(_messageId: string, _markdown: string): Promise<void> {
    return Promise.reject(new Error("DINGTALK_RICH_OUTPUT_UNSUPPORTED"));
  }

  startStreamingText(
    _userId: string,
    _initial?: string,
    _opts?: { threadTs?: string },
  ): Promise<StreamingTextHandle> {
    return Promise.reject(new Error("DINGTALK_RICH_OUTPUT_UNSUPPORTED"));
  }

  async commitFinal(output: ImFinalOutput): Promise<void> {
    await this.sendText(output.userId, normalizeFinalText(output.text));
  }

  async requestTextReply<T>(
    userId: string,
    prompt: string,
    parse: (text: string) => T | null,
    timeoutMs = INTERACTION_TIMEOUT_MS,
  ): Promise<T> {
    if (this.pendingReplies.has(userId)) {
      throw new Error("DINGTALK_INTERACTION_ALREADY_PENDING");
    }
    let resolveReply!: (value: T) => void;
    let rejectReply!: (error: Error) => void;
    const reply = new Promise<T>((resolve, reject) => {
      resolveReply = resolve;
      rejectReply = reject;
    });
    const timer = setTimeout(() => {
      this.pendingReplies.delete(userId);
      rejectReply(new Error("DINGTALK_INTERACTION_TIMEOUT"));
    }, timeoutMs);
    const pending: PendingReply<T> = {
      parse,
      resolve: resolveReply,
      reject: rejectReply,
      timer,
    };
    this.pendingReplies.set(userId, pending as PendingReply);
    try {
      await this.sendText(userId, prompt);
    } catch (error) {
      if (this.pendingReplies.get(userId) === pending) {
        this.pendingReplies.delete(userId);
      }
      clearTimeout(pending.timer);
      throw error;
    }
    return reply;
  }

  private async saveAndConnect(
    credentials: Credentials,
  ): Promise<DingTalkPublicState> {
    if (!this.host.secrets.isAvailable()) {
      throw new Error("DINGTALK_SECURE_STORAGE_UNAVAILABLE");
    }

    const previous = this.readCredentials();
    const previousOwner = this.host.secrets.read(OWNER_USER_ID_SECRET);
    try {
      await this.connect(credentials);
      if (!this.writeCredentials(credentials)) {
        throw new Error("DINGTALK_CREDENTIAL_SAVE_FAILED");
      }
      if (previous?.appKey !== credentials.appKey) {
        this.host.secrets.remove(OWNER_USER_ID_SECRET);
        this.ownerUserId = "";
      }
      return this.getPublicState();
    } catch (error) {
      this.restoreSecret(APP_KEY_SECRET, previous?.appKey ?? null);
      this.restoreSecret(APP_SECRET_SECRET, previous?.appSecret ?? null);
      this.restoreSecret(OWNER_USER_ID_SECRET, previousOwner);
      this.ownerUserId = previousOwner?.trim() ?? "";
      if (previous) {
        try {
          await this.connect(previous);
        } catch {
          // The original error is more useful to the Settings surface.
        }
      } else {
        await this.stopConnection();
        this.setStatus({ kind: "idle" });
      }
      throw error;
    }
  }

  private async clearAndDisconnect(): Promise<void> {
    await this.stopConnection();
    this.host.secrets.remove(APP_KEY_SECRET);
    this.host.secrets.remove(APP_SECRET_SECRET);
    this.host.secrets.remove(OWNER_USER_ID_SECRET);
    this.ownerUserId = "";
    this.targetByUserId.clear();
    this.seenMessageIds.clear();
    this.rejectPendingReplies("DINGTALK_CREDENTIALS_CLEARED");
    this.setStatus({ kind: "idle" });
  }

  private async connect(credentials: Credentials): Promise<void> {
    await this.stopConnection();
    const version = this.connectionVersion;
    this.setStatus({ kind: "connecting" });
    const client = (this.options.clientFactory ?? defaultClientFactory)(
      credentials,
    );
    client.config.autoReconnect = false;
    client.registerCallbackListener(TOPIC_ROBOT, (message) => {
      this.ackDownstream(client, message);
      if (version !== this.connectionVersion) return;
      const accountToken = this.host.accountScope?.capture();
      if (this.host.accountScope && accountToken === null) return;
      void this.acceptDownstream(message, version, accountToken);
    });
    await client.connect();
    if (version !== this.connectionVersion) {
      client.disconnect();
      throw new Error("DINGTALK_CONNECTION_REPLACED");
    }
    if (!client.connected || !(await waitForRegistration(client))) {
      client.disconnect();
      throw new Error("DINGTALK_CONNECTION_FAILED");
    }
    client.config.autoReconnect = true;
    this.client = client;
    this.appKey = credentials.appKey;
    this.api = new DingTalkApiClient(
      credentials.appKey,
      credentials.appSecret,
      this.options.fetcher,
    );
    this.setStatus({ kind: "connected", appId: credentials.appKey });
    this.startStatusMonitor(version);
  }

  private async stopConnection(): Promise<void> {
    this.connectionVersion += 1;
    this.stopStatusMonitor();
    const client = this.client;
    this.client = null;
    this.api?.close();
    this.api = null;
    client?.disconnect();
    this.targetByUserId.clear();
    this.laneQueues.clear();
    this.seenMessageIds.clear();
    this.rejectPendingReplies("DINGTALK_CONNECTION_REPLACED");
  }

  private startStatusMonitor(version: number): void {
    this.stopStatusMonitor();
    this.statusTimer = setInterval(() => {
      if (version !== this.connectionVersion || !this.client) return;
      if (this.client.connected && this.client.registered) {
        if (this.status.kind !== "connected") {
          this.setStatus({ kind: "connected", appId: this.appKey });
        }
      } else if (this.status.kind === "connected") {
        this.setStatus({ kind: "connecting" });
      }
    }, STATUS_POLL_MS);
  }

  private stopStatusMonitor(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
  }

  private ackDownstream(
    client: DingTalkStreamClient,
    message: DWClientDownStream,
  ): void {
    try {
      client.socketCallBackResponse(message.headers.messageId, {
        success: true,
      });
    } catch (error) {
      this.log.warn(
        `dingtalk callback acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async acceptDownstream(
    message: DWClientDownStream,
    connectionVersion: number,
    accountToken: unknown,
  ): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(message.data);
    } catch {
      this.log.warn("dingtalk callback contained invalid JSON");
      return;
    }
    const envelope = parseInboundEnvelope(raw);
    if (!envelope || envelope.robotCode !== this.appKey) return;
    if (this.isDuplicate(envelope.messageId)) return;

    const userId =
      envelope.conversationType === "2"
        ? encodeLaneUserId(envelope.conversationId)
        : envelope.senderId;
    this.rememberTarget(userId, envelope);
    const prior = this.laneQueues.get(userId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() =>
        this.runInCapturedAccountScope(accountToken, () =>
          this.processEnvelope(userId, envelope, connectionVersion),
        ),
      )
      .catch((error) => {
        this.log.warn(
          `dingtalk inbound processing failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.laneQueues.get(userId) === next)
          this.laneQueues.delete(userId);
      });
    this.laneQueues.set(userId, next);
    await next;
  }

  private async processEnvelope(
    userId: string,
    envelope: DingTalkInboundEnvelope,
    connectionVersion: number,
  ): Promise<void> {
    if (connectionVersion !== this.connectionVersion) return;
    const isGroup = envelope.conversationType === "2";
    if (!this.ownerUserId) {
      if (isGroup || !this.claimOwner(envelope.senderId)) return;
    }
    if (!isGroup && envelope.senderId !== this.ownerUserId) return;
    if (isGroup && !envelope.mentioned) return;

    const content = parseInboundContent(envelope);
    if (
      content.text &&
      this.tryResolvePendingReply(userId, envelope.senderId, content.text)
    ) {
      return;
    }

    const attachments = [];
    const unsupported = [...content.unsupported];
    for (const downloadCode of content.downloadCodes) {
      const attachment = await this.resolveImage(
        downloadCode,
        connectionVersion,
      ).catch((error) => {
        this.log.warn(
          `dingtalk image download failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
      if (attachment) attachments.push(attachment);
      else unsupported.push({ type: "picture", label: "图片（下载失败）" });
    }
    if (connectionVersion !== this.connectionVersion) return;

    const event: IMMessageEvent = {
      channelName: "dingtalk",
      senderId: userId,
      chatId: envelope.conversationId,
      contextId: this.appKey,
      messageId: envelope.messageId,
      text: content.text,
      ...(isGroup
        ? {
            speaker: {
              id: envelope.senderId,
              name: envelope.senderName,
              isOwner: envelope.senderId === this.ownerUserId,
            },
          }
        : {}),
      attachments,
      unsupported,
    };
    for (const handler of this.messageHandlers) {
      try {
        handler(event);
      } catch {
        // One consumer must not prevent the remaining subscribers from receiving the message.
      }
    }
  }

  private async resolveImage(downloadCode: string, connectionVersion: number) {
    if (connectionVersion !== this.connectionVersion) return null;
    const media = this.host.media;
    if (!media) return null;
    const cached = await media.getCachedImage("dingtalk", downloadCode);
    if (connectionVersion !== this.connectionVersion) return null;
    if (cached) {
      return imageAttachment(cached.absPath, cached.url, cached.mimeType);
    }
    const downloaded = await this.requireApi().downloadImage(downloadCode);
    if (connectionVersion !== this.connectionVersion) return null;
    const stored = await media.cacheImage({
      integration: "dingtalk",
      token: downloadCode,
      buffer: downloaded.buffer,
      mimeType: downloaded.mimeType,
    });
    return imageAttachment(stored.absPath, stored.url, downloaded.mimeType);
  }

  private tryResolvePendingReply(
    userId: string,
    senderId: string,
    text: string,
  ): boolean {
    const pending = this.pendingReplies.get(userId);
    if (!pending) return false;
    const lane = decodeLaneUserId(userId);
    if (lane && senderId !== this.ownerUserId) return true;
    const value = pending.parse(text);
    if (value === null) return true;
    this.pendingReplies.delete(userId);
    clearTimeout(pending.timer);
    pending.resolve(value);
    return true;
  }

  private claimOwner(senderId: string): boolean {
    if (!this.host.secrets.isAvailable()) return false;
    if (!this.host.secrets.write(OWNER_USER_ID_SECRET, senderId)) return false;
    this.ownerUserId = senderId;
    this.host.ipc.broadcast("dingtalkBot:owner-change", {
      ownerUserId: senderId,
    });
    return true;
  }

  private rememberTarget(
    userId: string,
    envelope: DingTalkInboundEnvelope,
  ): void {
    this.targetByUserId.set(userId, {
      kind: envelope.conversationType === "2" ? "group" : "direct",
      id:
        envelope.conversationType === "2"
          ? envelope.conversationId
          : envelope.senderId,
      sessionWebhook: envelope.sessionWebhook,
      sessionWebhookExpiresAt: envelope.sessionWebhookExpiresAt,
    });
  }

  private resolveTarget(userId: string): DingTalkOutboundTarget {
    const cached = this.targetByUserId.get(userId);
    if (cached) return cached;
    const lane = decodeLaneUserId(userId);
    return lane
      ? {
          kind: "group",
          id: lane.conversationId,
          sessionWebhook: null,
          sessionWebhookExpiresAt: null,
        }
      : {
          kind: "direct",
          id: userId,
          sessionWebhook: null,
          sessionWebhookExpiresAt: null,
        };
  }

  private isDuplicate(messageId: string): boolean {
    const now = Date.now();
    for (const [id, seenAt] of this.seenMessageIds) {
      if (now - seenAt > DEDUP_TTL_MS) this.seenMessageIds.delete(id);
    }
    if (this.seenMessageIds.has(messageId)) return true;
    this.seenMessageIds.set(messageId, now);
    while (this.seenMessageIds.size > DEDUP_CAPACITY) {
      const oldest = this.seenMessageIds.keys().next().value;
      if (!oldest) break;
      this.seenMessageIds.delete(oldest);
    }
    return false;
  }

  private setStatus(status: IMStatus): void {
    this.status = status;
    this.host.ipc.broadcast("dingtalkBot:status-change", { status });
    for (const handler of this.statusHandlers) {
      try {
        handler(status);
      } catch {
        // Status fan-out is best effort.
      }
    }
  }

  private readCredentials(): Credentials | null {
    const appKey = this.host.secrets.read(APP_KEY_SECRET)?.trim() ?? "";
    const appSecret = this.host.secrets.read(APP_SECRET_SECRET)?.trim() ?? "";
    return appKey && appSecret ? { appKey, appSecret } : null;
  }

  private writeCredentials(credentials: Credentials): boolean {
    const previousKey = this.host.secrets.read(APP_KEY_SECRET);
    const previousSecret = this.host.secrets.read(APP_SECRET_SECRET);
    if (!this.host.secrets.write(APP_KEY_SECRET, credentials.appKey))
      return false;
    if (this.host.secrets.write(APP_SECRET_SECRET, credentials.appSecret))
      return true;
    this.restoreSecret(APP_KEY_SECRET, previousKey);
    this.restoreSecret(APP_SECRET_SECRET, previousSecret);
    return false;
  }

  private restoreSecret(key: string, value: string | null): void {
    if (value === null) this.host.secrets.remove(key);
    else this.host.secrets.write(key, value);
  }

  private requireApi(): DingTalkApiClient {
    if (!this.api) throw new Error("DINGTALK_NOT_CONNECTED");
    return this.api;
  }

  private rejectPendingReplies(code: string): void {
    for (const pending of this.pendingReplies.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
    }
    this.pendingReplies.clear();
  }

  private async runInAccountScope<T>(operation: () => Promise<T>): Promise<T> {
    const scope = this.host.accountScope;
    if (!scope) return operation();
    const token = scope.capture();
    if (token === null)
      throw new Error("[IM_NOT_READY] IM account is not active");
    return scope.run(token, operation);
  }

  private async runInCapturedAccountScope<T>(
    token: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    const scope = this.host.accountScope;
    if (!scope) return operation();
    if (token === null || !scope.isCurrent(token)) {
      throw new Error("[IM_NOT_READY] IM account changed");
    }
    return scope.run(token, operation);
  }
}

export function createDingTalkIM(
  host: IMHost,
  options?: DingTalkIMOptions,
): DingTalkIM {
  return new DingTalkIM(host, options);
}

function defaultClientFactory(credentials: Credentials): DingTalkStreamClient {
  return new DWClient({
    clientId: credentials.appKey,
    clientSecret: credentials.appSecret,
    keepAlive: true,
    debug: false,
  });
}

function chunkText(text: string): string[] {
  const normalized = text.trim() || "（空回复）";
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > OUTBOUND_CHUNK_SIZE) {
    let splitAt = remaining.lastIndexOf("\n", OUTBOUND_CHUNK_SIZE);
    if (splitAt < OUTBOUND_CHUNK_SIZE / 2) splitAt = OUTBOUND_CHUNK_SIZE;
    if (
      splitAt > 0 &&
      /[\uD800-\uDBFF]/.test(remaining[splitAt - 1] ?? "") &&
      /[\uDC00-\uDFFF]/.test(remaining[splitAt] ?? "")
    ) {
      splitAt -= 1;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function normalizeFinalText(text: string): string {
  return text.trim() || "✅ 本轮已完成，没有文本输出。";
}

function safeConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "DINGTALK_CONNECTION_FAILED") {
    return "DINGTALK_CONNECTION_FAILED";
  }
  return "DINGTALK_CONNECTION_ERROR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function waitForRegistration(
  client: DingTalkStreamClient,
): Promise<boolean> {
  const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
  while (client.connected && !client.registered && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return client.connected && client.registered;
}
