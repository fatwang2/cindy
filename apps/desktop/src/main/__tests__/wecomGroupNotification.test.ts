import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  net: { fetch: vi.fn() },
  safeStorage: {},
  app: {},
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock('../im/ownerScopedStorage', () => ({
  ownerScopedImSecrets: {
    read: vi.fn(() => null),
    write: vi.fn(() => true),
    remove: vi.fn(),
  },
}));
vi.mock('../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

import { WecomGroupNotificationService, __testing } from '../wecomGroupNotification';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createSecrets(initial: string | null = null) {
  let value = initial;
  return {
    read: vi.fn(() => value),
    write: vi.fn((_name: string, next: string) => {
      value = next;
      return true;
    }),
    remove: vi.fn(() => {
      value = null;
    }),
  };
}

describe('WeCom group notification security boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts only the official HTTPS webhook endpoint with one key parameter', () => {
    expect(() =>
      __testing.parseWebhookUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0123456789'),
    ).not.toThrow();
    for (const invalid of [
      'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x',
      'https://evil.example/cgi-bin/webhook/send?key=x',
      'https://qyapi.weixin.qq.com.evil.example/cgi-bin/webhook/send?key=x',
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x&next=https://evil.example',
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send',
    ]) {
      expect(() => __testing.parseWebhookUrl(invalid)).toThrow('WECOM_GROUP_WEBHOOK_INVALID');
    }
  });

  it('splits UTF-8 text without breaking code points or exceeding the byte limit', () => {
    const chunks = __testing.splitUtf8('企'.repeat(20), 10);
    expect(chunks.join('')).toBe('企'.repeat(20));
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 10)).toBe(true);
  });

  it('tests before persisting and never exposes the stored URL', async () => {
    const fetchImpl = vi.fn(async () => response({ errcode: 0, errmsg: 'ok' }));
    const secrets = createSecrets();
    const service = new WecomGroupNotificationService(fetchImpl, secrets);

    const state = await service.saveAndTest(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh',
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh',
      expect.objectContaining({ method: 'POST', redirect: 'manual' }),
    );
    expect(secrets.write).toHaveBeenCalledOnce();
    expect(state).toEqual({ configured: true, maskedKey: '••••efgh' });
    expect(JSON.stringify(service.getState())).not.toContain('abcdefgh');
  });

  it('does not persist a webhook when the test call fails', async () => {
    const fetchImpl = vi.fn(async () => response({ errcode: 93000, errmsg: 'invalid' }));
    const secrets = createSecrets();
    const service = new WecomGroupNotificationService(fetchImpl, secrets);

    await expect(
      service.saveAndTest('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh'),
    ).rejects.toThrow('WECOM_GROUP_SEND_FAILED:93000');
    expect(secrets.write).not.toHaveBeenCalled();
  });

  it('does not persist a tested webhook after the account boundary changes', async () => {
    let release: (() => void) | undefined;
    let current = true;
    const fetchImpl = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return response({ errcode: 0, errmsg: 'ok' });
    });
    const secrets = createSecrets();
    const service = new WecomGroupNotificationService(fetchImpl, secrets);

    const saving = service.saveAndTest(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh',
      () => current,
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    current = false;
    release?.();

    await expect(saving).rejects.toThrow('IM account changed');
    expect(secrets.write).not.toHaveBeenCalled();
  });

  it('rejects redirects instead of following a changed destination', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://evil.example' },
        }),
    );
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh';
    const service = new WecomGroupNotificationService(fetchImpl, createSecrets(url));

    await expect(service.test()).rejects.toThrow('WECOM_GROUP_REDIRECT_REJECTED');
  });

  it('serializes concurrent publishes to preserve message order', async () => {
    const releases: Array<() => void> = [];
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      await new Promise<void>((resolve) => releases.push(resolve));
      return response({ errcode: 0 });
    });
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh';
    const service = new WecomGroupNotificationService(fetchImpl, createSecrets(url));

    const first = service.publishMarkdown('first');
    const second = service.publishMarkdown('second');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await Promise.all([first, second]);

    expect(bodies[0]).toContain('first');
    expect(bodies[1]).toContain('second');
  });
});
