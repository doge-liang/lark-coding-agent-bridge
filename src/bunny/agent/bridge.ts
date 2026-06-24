import {
  BUNNY_AGENT_MANIFEST,
  BUNNY_SYSTEM_PROMPT,
  type BunnySkillName,
} from './manifest';
import type { BunnyAgentAction } from './cards';

export const BUNNY_SCOPE_SUFFIX = ':bunny';

export interface BunnyPromptProfile {
  id: 'bunny';
  displayName: 'Bunny';
  baseAgent: 'codex';
  systemPrompt: string;
  manifest: typeof BUNNY_AGENT_MANIFEST;
  callbackContract: {
    eventPrefix: '[bunny-skill]';
    stateChangingActionsRequireExplicitSkill: true;
  };
}

export interface BunnySkillEventInput {
  action: BunnyAgentAction;
  skill?: BunnySkillName;
  source: 'lark-menu' | 'lark-card';
  confirmed?: boolean;
}

export function bunnyScopeFor(scope: string): string {
  return isBunnyScope(scope) ? scope : `${scope}${BUNNY_SCOPE_SUFFIX}`;
}

export function isBunnyScope(scope: string): boolean {
  return scope.endsWith(BUNNY_SCOPE_SUFFIX);
}

export function bunnyPromptProfile(): BunnyPromptProfile {
  return {
    id: 'bunny',
    displayName: 'Bunny',
    baseAgent: 'codex',
    systemPrompt: BUNNY_SYSTEM_PROMPT,
    manifest: BUNNY_AGENT_MANIFEST,
    callbackContract: {
      eventPrefix: '[bunny-skill]',
      stateChangingActionsRequireExplicitSkill: true,
    },
  };
}

export function bunnySkillEventContent(input: BunnySkillEventInput): string {
  return `[bunny-skill] ${JSON.stringify({
    domain: 'bunny',
    action: input.action,
    ...(input.skill ? { skill: input.skill } : {}),
    source: input.source,
    confirmed: input.confirmed === true,
  })}`;
}
