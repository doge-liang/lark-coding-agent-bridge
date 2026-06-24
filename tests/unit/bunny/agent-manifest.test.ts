import { describe, expect, it } from 'vitest';
import {
  BUNNY_AGENT_MANIFEST,
  BUNNY_SKILL_DEFINITIONS,
  BUNNY_SYSTEM_PROMPT,
  type BunnySkillName,
} from '../../../src/bunny/agent/manifest';

describe('Bunny agent manifest', () => {
  it('defines Bunny as an explicit agent package', () => {
    expect(BUNNY_AGENT_MANIFEST.id).toBe('bunny');
    expect(BUNNY_AGENT_MANIFEST.displayName).toBe('Bunny');
    expect(BUNNY_SYSTEM_PROMPT).toContain('AI tools media operator');
    expect(BUNNY_SYSTEM_PROMPT).toContain('Do not publish from vague natural language');
  });

  it('registers every V1 business skill with explicit trigger semantics', () => {
    const names = new Set(BUNNY_SKILL_DEFINITIONS.map((skill) => skill.name));
    const expected: BunnySkillName[] = [
      'research_topics',
      'generate_drafts',
      'quality_check',
      'review_queue',
      'schedule_posts',
      'pause_publishing',
      'resume_publishing',
      'daily_report',
    ];
    expect(names).toEqual(new Set(expected));
    expect(BUNNY_SKILL_DEFINITIONS.every((skill) => skill.trigger === 'explicit')).toBe(true);
  });

  it('does not expose slash or CLI commands as skills', () => {
    const text = JSON.stringify(BUNNY_AGENT_MANIFEST);
    expect(text).not.toContain('/bunny');
    expect(text).not.toContain('lark-channel-bridge bunny');
  });
});
