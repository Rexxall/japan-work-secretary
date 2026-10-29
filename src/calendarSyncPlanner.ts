import { moment } from 'obsidian';
import {
    CalendarSyncRecord,
    JapanWorkSecretaryData,
    RecurringShift,
    Shift,
    buildRecurringInstanceId
} from './data';

export type CalendarSyncMode = 'smart' | 'range' | 'full';

export interface CalendarSyncPlanItem {
    shift: Shift;
    fingerprint: string;
}

export interface CalendarSyncPlan {
    toSync: CalendarSyncPlanItem[];
    skipped: CalendarSyncPlanItem[];
}

export interface CalendarSyncOrphan {
    shift: Shift;
    record: CalendarSyncRecord;
}

export type RecurringShiftFactory = (date: string, recurringShift: RecurringShift) => Shift;

const FINGERPRINT_VERSION = 'jws-calendar-v1';

export function buildCalendarSyncStateKey(shiftId: string, calendarName: string): string {
    return `${encodeURIComponent(calendarName.trim())}::${shiftId}`;
}

export function getCalendarSyncRecord(
    syncState: Record<string, CalendarSyncRecord>,
    shiftId: string,
    calendarName: string
): CalendarSyncRecord | undefined {
    const scoped = syncState[buildCalendarSyncStateKey(shiftId, calendarName)];
    if (scoped) return scoped;

    // Backward compatibility for early fingerprint builds that keyed by shift ID.
    const legacy = syncState[shiftId];
    if (!legacy) return undefined;
    if (legacy.calendarName && legacy.calendarName.trim() !== calendarName.trim()) return undefined;
    return legacy;
}

/**
 * Only include fields that affect the Calendar event. Wage and bookkeeping
 * changes should not trigger a calendar rewrite.
 */
export const DEFAULT_EVENT_TITLE_PREFIX = '打工';

export function buildCalendarSyncFingerprint(
    shift: Shift,
    calendarName: string,
    titlePrefix: string = DEFAULT_EVENT_TITLE_PREFIX
): string {
    const fields: string[] = [
        FINGERPRINT_VERSION,
        calendarName.trim(),
        shift.date,
        shift.startTime,
        shift.endTime,
        shift.storeName
    ];
    // Only add the prefix when it differs from the original default, so
    // fingerprints saved by earlier versions stay valid.
    const prefix = (titlePrefix ?? DEFAULT_EVENT_TITLE_PREFIX).trim();
    if (prefix !== DEFAULT_EVENT_TITLE_PREFIX) fields.push(`title:${prefix}`);
    return JSON.stringify(fields);
}

export function invalidateCalendarSyncRecord(
    syncState: Record<string, CalendarSyncRecord>,
    shiftId: string,
    calendarName: string
): void {
    delete syncState[buildCalendarSyncStateKey(shiftId, calendarName)];
    const legacy = syncState[shiftId];
    if (!legacy?.calendarName || legacy.calendarName.trim() === calendarName.trim()) {
        delete syncState[shiftId];
    }
}

function isDateInRange(date: string, startDate: string, endDate: string): boolean {
    return date >= startDate && date <= endDate;
}

/**
 * Collect manual shifts plus expanded recurring instances for a date range.
 * Smart/full sync retain the legacy behavior of including every manual shift,
 * while range sync limits manual shifts to the visible range.
 */
export function collectCalendarSyncShifts(
    data: JapanWorkSecretaryData,
    startDate: string,
    endDate: string,
    includeAllManualShifts: boolean,
    createRecurringShift: RecurringShiftFactory
): Shift[] {
    const selectedManualShifts = data.shifts
        .filter(shift => !shift.isSample && (includeAllManualShifts || isDateInRange(shift.date, startDate, endDate)))
        .map(shift => ({ ...shift }));

    const shifts = [...selectedManualShifts];
    const rangeStart = moment(startDate, 'YYYY-MM-DD', true);
    const rangeEnd = moment(endDate, 'YYYY-MM-DD', true);

    if (!rangeStart.isValid() || !rangeEnd.isValid() || rangeStart.isAfter(rangeEnd, 'day')) {
        throw new Error(`Invalid calendar sync range: ${startDate} to ${endDate}`);
    }

    const curr = rangeStart.clone();
    while (curr.isSameOrBefore(rangeEnd, 'day')) {
        const dateStr = curr.format('YYYY-MM-DD');
        const recurrences = data.recurringShifts.filter(rule => rule.dayOfWeek === curr.day());

        for (const rule of recurrences) {
            if (rule.startDate && dateStr < rule.startDate) continue;
            if (rule.endDate && dateStr > rule.endDate) continue;
            if (rule.exceptions?.includes(dateStr)) continue;

            const exactManualOverrideExists = data.shifts.some(shift =>
                shift.date === dateStr &&
                shift.startTime === rule.startTime &&
                shift.endTime === rule.endTime &&
                shift.storeName === rule.storeName
            );

            if (!exactManualOverrideExists) {
                shifts.push(createRecurringShift(dateStr, rule));
            }
        }

        curr.add(1, 'day');
    }

    const uniqueById = new Map<string, Shift>();
    shifts.forEach(shift => uniqueById.set(shift.id, shift));
    return Array.from(uniqueById.values())
        .sort((a, b) => `${a.date}${a.startTime}${a.id}`.localeCompare(`${b.date}${b.startTime}${b.id}`));
}

export function createRecurringCalendarShift(
    date: string,
    recurringShift: RecurringShift,
    calculatedHours: number,
    calculatedWage: number
): Shift {
    return {
        id: buildRecurringInstanceId(recurringShift.id, date),
        date,
        startTime: recurringShift.startTime,
        endTime: recurringShift.endTime,
        storeName: recurringShift.storeName,
        calculatedHours,
        calculatedWage
    };
}

export function planCalendarSync(
    shifts: Shift[],
    syncState: Record<string, CalendarSyncRecord>,
    calendarName: string,
    force: boolean,
    titlePrefix: string = DEFAULT_EVENT_TITLE_PREFIX
): CalendarSyncPlan {
    const plan: CalendarSyncPlan = { toSync: [], skipped: [] };

    for (const shift of shifts) {
        const item = {
            shift,
            fingerprint: buildCalendarSyncFingerprint(shift, calendarName, titlePrefix)
        };
        const previous = getCalendarSyncRecord(syncState, shift.id, calendarName);

        if (!force && previous?.status !== 'failed' && previous?.fingerprint === item.fingerprint) {
            plan.skipped.push(item);
        } else {
            plan.toSync.push(item);
        }
    }

    return plan;
}

/**
 * Find Calendar events previously managed by the plugin that are no longer in
 * the desired source data. Range sync only reconciles its visible dates;
 * smart/full also reconcile all manual records while keeping recurring cleanup
 * within the bounded recurring horizon.
 */
export function findCalendarSyncOrphans(
    desiredShifts: Shift[],
    syncState: Record<string, CalendarSyncRecord>,
    calendarName: string,
    startDate: string,
    endDate: string,
    includeAllManualShifts: boolean
): CalendarSyncOrphan[] {
    const desiredIds = new Set(desiredShifts.map(shift => shift.id));
    const normalizedCalendarName = calendarName.trim();
    const orphans: CalendarSyncOrphan[] = [];

    Object.values(syncState).forEach(record => {
        if (!record.shift || !record.source) return;
        if (desiredIds.has(record.shift.id)) return;
        if ((record.calendarName || '').trim() !== normalizedCalendarName) return;

        const inRange = isDateInRange(record.shift.date, startDate, endDate);
        const shouldReconcile = record.source === 'manual'
            ? includeAllManualShifts || inRange
            : inRange;
        if (!shouldReconcile) return;

        orphans.push({
            record,
            shift: {
                ...record.shift,
                calculatedHours: 0,
                calculatedWage: 0
            }
        });
    });

    return orphans.sort((a, b) =>
        `${a.shift.date}${a.shift.startTime}${a.shift.id}`.localeCompare(
            `${b.shift.date}${b.shift.startTime}${b.shift.id}`
        )
    );
}
