import { describe, expect, it } from 'vitest';
import {
  bunnyPromptProfile,
  bunnyScopeFor,
  bunnySkillEventContent,
  isBunnyScope,
} from '../../../src/bunny/agent/bridge';

describe('Bunny bridge adapter', () => {
  it('derives an isolated Bunny session scope from the chat scope', () => {
    expect(bunnyScopeFor('oc_dm')).toBe('oc_dm:bunny');
    expect(bunnyScopeFor('oc_group:thread_1')).toBe('oc_group:thread_1:bunny');
    expect(bunnyScopeFor('oc_dm:bunny')).toBe('oc_dm:bunny');
    expect(isBunnyScope('oc_dm')).toBe(false);
    expect(isBunnyScope('oc_dm:bunny')).toBe(true);
  });

  it('describes Bunny as a Codex-backed prompt profile', () => {
    const profile = bunnyPromptProfile();

    expect(profile).toMatchObject({
      id: 'bunny',
      displayName: 'Bunny',
      baseAgent: 'codex',
    });
    expect(profile.systemPrompt).toContain('AI tools media operator');
    expect(profile.callbackContract.eventPrefix).toBe('[bunny-skill]');
  });

  it('serializes explicit Bunny skill events for the Codex session', () => {
    expect(
      bunnySkillEventContent({
        action: 'research',
        skill: 'research_topics',
        source: 'lark-card',
      }),
    ).toBe(
      '[bunny-skill] {"domain":"bunny","action":"research","skill":"research_topics","source":"lark-card","confirmed":false}',
    );
  });
});
