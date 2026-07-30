import type { ImUiTextPack } from '../shared/types';
import { telegramUiText } from '../telegram/uiText';

/**
 * Shared IM control copy is channel-neutral apart from a small number of
 * route labels. Keep the DingTalk pack derived at the composition boundary so
 * fixes to permissions, model selection, and takeover guidance stay aligned.
 */
export const ui = replaceChannelLabel(telegramUiText) as ImUiTextPack;

function replaceChannelLabel(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replaceAll('Telegram', '钉钉').replaceAll('TG', '钉钉');
  }
  if (typeof value === 'function') {
    return (...args: unknown[]) =>
      replaceChannelLabel((value as (...input: unknown[]) => unknown)(...args));
  }
  if (Array.isArray(value)) return value.map(replaceChannelLabel);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, replaceChannelLabel(child)]),
  );
}
