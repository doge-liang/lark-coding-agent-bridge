export type BunnyPostKind = 'single' | 'thread';
export type BunnyPostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'skipped';

export interface BunnySettings {
  paused: boolean;
  livePublishing: boolean;
  dailyPostLimit: number;
  threadCadenceDays: number;
  firstLiveWeekDailyLimit: number;
  dryRunDays: number;
  dailyCreditBudget: number;
  timezone: string;
}

export interface BunnyRuntimeConfig {
  baseUrl: string;
  xBearerToken?: string;
  llm?: {
    endpoint: string;
    apiKey: string;
    model: string;
  };
}

export interface BunnyCandidate {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  summary: string;
  discoveredAt: string;
}

export interface BunnyTopic {
  id: string;
  candidateId: string;
  title: string;
  url: string;
  summary: string;
  score: number;
  reason: string;
  createdAt: string;
}

export interface BunnyDraft {
  id: string;
  topicId: string;
  kind: BunnyPostKind;
  chineseNote: string;
  englishText: string;
  sourceUrl: string;
  status: BunnyPostStatus;
  qualityFailure?: string;
  createdAt: string;
}

export interface BunnyScheduledPost {
  id: string;
  draftId: string;
  postKey: string;
  publishAt: string;
  status: BunnyPostStatus;
  xPostId?: string;
  xPostUrl?: string;
  errorMessage?: string;
}

export interface BunnyStatus {
  paused: boolean;
  livePublishing: boolean;
  queuedPosts: number;
  lastPublishedAt?: string;
  lastError?: string;
  dailyCreditBudget: number;
}

export interface BunnyToday {
  scheduled: BunnyScheduledPost[];
  drafts: BunnyDraft[];
}
