import { describe, expect, it } from 'vitest';
import * as channelModule from '../../../src/bot/channel.js';

describe('Lark SDK logger noise filtering', () => {
  it('recognizes the SDK warning emitted when markdown stream updates are abandoned', () => {
    const isMarkdownStreamUpdateFailure = (
      channelModule as {
        isMarkdownStreamUpdateFailure?: (args: unknown[]) => boolean;
      }
    ).isMarkdownStreamUpdateFailure;

    expect(
      isMarkdownStreamUpdateFailure?.([
        '[stream] update failed',
        new Error('CardKit HTTP 500'),
      ]),
    ).toBe(true);
    expect(isMarkdownStreamUpdateFailure?.(['[card-stream] update failed'])).toBe(false);
  });

  it('suppresses optional wiki-node permission failures that fall back to the original file token', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        [
          {
            message: 'Request failed with status code 400',
            config: {
              method: 'get',
              url: 'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node',
            },
            response: {
              data: {
                code: 99991672,
                msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
              },
            },
          },
          {
            code: 99991672,
            msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
          },
        ],
      ]),
    ).toBe(true);
  });

  it('keeps unrelated permission failures visible', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        {
          message: 'Request failed with status code 400',
          config: {
            method: 'post',
            url: 'https://open.feishu.cn/open-apis/im/v1/messages',
          },
          response: {
            data: {
              code: 99991672,
              msg: 'Access denied.',
            },
          },
        },
      ]),
    ).toBe(false);
  });
});
