import fs from 'node:fs';
import type { DingTalkIM, RichChannelIM } from '@cindy/im';
import { decodeDingTalkLaneUserId } from '@cindy/im';

import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { handleDingTalkTextInteraction } from './interaction';
import { createDingTalkTurnPermissionPolicy } from './permissionPolicy';
import { ui } from './uiText';

function ensureWorkingDir(appKey: string): string {
  const safeKey = appKey.replace(/[^a-zA-Z0-9_-]/g, '-').slice(-64) || 'bot';
  const dir = ownerScopedImUserDataPath('im-working-dir', `dingtalk-${safeKey}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionSafeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function sanitizeSpeaker(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value
    .replace(/[\u0000-\u001f\u007f\u200b]/g, ' ')
    .trim()
    .slice(0, 64);
}

export function buildDingTalkAdapter(
  dingtalkIm: DingTalkIM,
  config: ImOrchestratorConfig,
): ImChannelAdapter {
  return {
    channel: 'dingtalk',
    // The shared card-action subscription still expects the rich interface.
    // Normal turn output is discriminated below and never calls card methods.
    im: dingtalkIm as RichChannelIM,
    output: {
      kind: 'chunked-text',
      im: dingtalkIm,
      commitFinal: (output) => dingtalkIm.commitFinal(output),
    },
    config,
    ui,
    sessions: {
      source: 'dingtalk',
      sessionIdFor: (appKey, userId) =>
        `dingtalk_${sessionSafeUserId(appKey)}_${sessionSafeUserId(userId)}`,
      defaultTitle: (userId) =>
        decodeDingTalkLaneUserId(userId)
          ? `钉钉群聊 · ${userId.slice(-6)}`
          : `钉钉 · ${userId.slice(-6)}`,
      generatedTitlePrefix: '钉钉 · ',
      workspaceKind: 'dialogue',
      ensureWorkingDir,
      extraInsertColumns: (appKey, userId) => ({
        imBotContextId: appKey,
        imUserId: userId,
      }),
    },
    processingEmoji: '',
    buildVendorOptions: (userId) => ({ dingtalkChatId: userId, source: 'dingtalk' }),
    handleTextInteraction: (userId, request) =>
      handleDingTalkTextInteraction(dingtalkIm, userId, request),
    turnPermissionPolicyFor: (event) => createDingTalkTurnPermissionPolicy(event.messageId),
    prepareAgentTurnText: async (event) => {
      if (!event.speaker) return null;
      const speaker = sanitizeSpeaker(event.speaker.name);
      return {
        agentText: `[发言人] ${speaker} · id:${event.speaker.id}${event.speaker.isOwner ? ' · 主人' : ''}\n${event.text}`,
      };
    },
  };
}
