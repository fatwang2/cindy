import { ipcMain, net } from 'electron';

import {
  captureImAccountGeneration,
  ImAccountScopeClosedError,
  isImAccountGenerationCurrent,
  runInImAccountGeneration,
} from './im/accountBoundary';
import { ownerScopedImSecrets } from './im/ownerScopedStorage';
import { createLogger } from './logger';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer';

const log = createLogger('wecom-group-notification');
const WEBHOOK_SECRET_NAME = 'wecom-group-webhook-url';
const WEBHOOK_HOST = 'qyapi.weixin.qq.com';
const WEBHOOK_PATH = '/cgi-bin/webhook/send';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_MARKDOWN_BYTES = 4_000;

export interface WecomGroupNotificationState {
  configured: boolean;
  maskedKey?: string;
}

export interface WecomGroupNotificationPublisher {
  publishMarkdown(markdown: string): Promise<void>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type SecretStore = Pick<typeof ownerScopedImSecrets, 'read' | 'write' | 'remove'>;

function parseWebhookUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2_048) {
    throw new Error('WECOM_GROUP_WEBHOOK_INVALID');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('WECOM_GROUP_WEBHOOK_INVALID');
  }

  const queryNames = [...url.searchParams.keys()];
  const key = url.searchParams.get('key');
  if (
    url.protocol !== 'https:' ||
    url.hostname !== WEBHOOK_HOST ||
    url.port !== '' ||
    url.pathname !== WEBHOOK_PATH ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    queryNames.length !== 1 ||
    queryNames[0] !== 'key' ||
    !key ||
    key.length > 256
  ) {
    throw new Error('WECOM_GROUP_WEBHOOK_INVALID');
  }
  return url;
}

function maskWebhookKey(url: URL): string {
  const key = url.searchParams.get('key') ?? '';
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}

function splitUtf8(text: string, maxBytes = MAX_MARKDOWN_BYTES): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const char of text) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function readResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error('WECOM_GROUP_RESPONSE_TOO_LARGE');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts).toString('utf8');
}

export class WecomGroupNotificationService implements WecomGroupNotificationPublisher {
  private publishTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => net.fetch(input, init),
    private readonly secrets: SecretStore = ownerScopedImSecrets,
  ) {}

  getState(): WecomGroupNotificationState {
    const stored = this.secrets.read(WEBHOOK_SECRET_NAME);
    if (!stored) return { configured: false };
    try {
      return { configured: true, maskedKey: maskWebhookKey(parseWebhookUrl(stored)) };
    } catch {
      log.warn('stored webhook URL is invalid; treating it as unconfigured');
      return { configured: false };
    }
  }

  async saveAndTest(
    rawUrl: string,
    isAccountCurrent: () => boolean = () => true,
  ): Promise<WecomGroupNotificationState> {
    const url = parseWebhookUrl(rawUrl);
    await this.enqueue(() => {
      if (!isAccountCurrent()) throw new ImAccountScopeClosedError();
      return this.send(url, 'Cindy 企业微信群通知测试成功');
    });
    if (!isAccountCurrent()) {
      throw new ImAccountScopeClosedError();
    }
    if (!this.secrets.write(WEBHOOK_SECRET_NAME, url.toString())) {
      throw new Error('WECOM_GROUP_WEBHOOK_SAVE_FAILED');
    }
    return { configured: true, maskedKey: maskWebhookKey(url) };
  }

  async test(): Promise<void> {
    const url = this.requireStoredUrl();
    await this.enqueue(() => this.send(url, 'Cindy 企业微信群通知测试成功'));
  }

  clear(): WecomGroupNotificationState {
    this.secrets.remove(WEBHOOK_SECRET_NAME);
    return { configured: false };
  }

  async publishMarkdown(markdown: string): Promise<void> {
    return this.enqueue(async () => {
      const url = this.requireStoredUrl();
      const chunks = splitUtf8(markdown.trim() || 'Cindy 通知');
      for (const chunk of chunks) {
        await this.send(url, chunk);
      }
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.publishTail
      .catch(() => {
        // A failed notification must not block later notifications.
      })
      .then(operation);
    this.publishTail = queued;
    return queued;
  }

  private requireStoredUrl(): URL {
    const stored = this.secrets.read(WEBHOOK_SECRET_NAME);
    if (!stored) throw new Error('WECOM_GROUP_WEBHOOK_NOT_CONFIGURED');
    return parseWebhookUrl(stored);
  }

  private async send(url: URL, markdown: string): Promise<void> {
    const response = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: markdown } }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('WECOM_GROUP_REDIRECT_REJECTED');
    }

    const responseText = await readResponseText(response);
    let result: { errcode?: unknown; errmsg?: unknown } = {};
    try {
      result = JSON.parse(responseText) as typeof result;
    } catch {
      throw new Error('WECOM_GROUP_RESPONSE_INVALID');
    }
    if (!response.ok || result.errcode !== 0) {
      const code = typeof result.errcode === 'number' ? result.errcode : response.status;
      throw new Error(`WECOM_GROUP_SEND_FAILED:${code}`);
    }
  }
}

export const wecomGroupNotificationService = new WecomGroupNotificationService();

export function initWecomGroupNotificationIpc(): void {
  ipcMain.handle('wecomGroupNotification:get-state', (event) => {
    assertTrustedAppRendererEvent(event);
    return wecomGroupNotificationService.getState();
  });
  ipcMain.handle('wecomGroupNotification:save-and-test', async (event, webhookUrl: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof webhookUrl !== 'string') throw new TypeError('webhookUrl must be a string');
    const accountGeneration = captureImAccountGeneration();
    if (accountGeneration === null) throw new ImAccountScopeClosedError();
    return runInImAccountGeneration(accountGeneration, () =>
      wecomGroupNotificationService.saveAndTest(webhookUrl, () =>
        isImAccountGenerationCurrent(accountGeneration),
      ),
    );
  });
  ipcMain.handle('wecomGroupNotification:test', async (event) => {
    assertTrustedAppRendererEvent(event);
    await wecomGroupNotificationService.test();
    return { ok: true as const };
  });
  ipcMain.handle('wecomGroupNotification:clear', (event) => {
    assertTrustedAppRendererEvent(event);
    return wecomGroupNotificationService.clear();
  });
}

export const __testing = {
  parseWebhookUrl,
  splitUtf8,
};
