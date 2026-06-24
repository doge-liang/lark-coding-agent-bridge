export interface PlanScheduleInput {
  draftIds: string[];
  nowIso: string;
  dailyLimit: number;
}

export interface PlannedSchedule {
  draftId: string;
  publishAt: string;
}

const UTC_SLOTS = [12, 18];

export function planSchedule(input: PlanScheduleInput): PlannedSchedule[] {
  const now = new Date(input.nowIso);
  const day = utcDateKey(now);

  return input.draftIds.slice(0, input.dailyLimit).map((draftId, index) => {
    const hour = UTC_SLOTS[index] ?? UTC_SLOTS.at(-1) ?? 18;
    const publishAt = new Date(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);
    if (publishAt <= now) {
      publishAt.setUTCDate(publishAt.getUTCDate() + 1);
    }

    return { draftId, publishAt: publishAt.toISOString() };
  });
}

function utcDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
