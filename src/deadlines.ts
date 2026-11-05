/** Due dates for the deadline view: reading them, sorting them into weeks and counting working days. */

const MS_DAY = 24 * 60 * 60 * 1000;

/** A due date read from a note property. `allDay` is true when only a date was written. */
export interface Due {
	date: Date;
	allDay: boolean;
}

/** `2026-11-14`, `2026-11-14 17:00`, `2026-11-14T17:00`, a full ISO string or a Date; anything else is null. */
export function parseDue(raw: unknown): Due | null {
	if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? { date: raw, allDay: false } : null;
	if (typeof raw !== 'string') return null;
	const text = raw.trim();
	const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	if (day) {
		const date = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
		return date.getMonth() === Number(day[2]) - 1 ? { date, allDay: true } : null;
	}
	if (!/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(text)) return null;
	const date = new Date(text.replace(' ', 'T'));
	return Number.isFinite(date.getTime()) ? { date, allDay: false } : null;
}

export function ymd(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Monday of the week `date` falls in, as Japanese offices count weeks. */
function startOfWeek(date: Date): Date {
	const day = startOfDay(date);
	day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
	return day;
}

export type Bucket = 'overdue' | 'today' | 'thisWeek' | 'nextWeek' | 'later';
export const BUCKETS: Bucket[] = ['overdue', 'today', 'thisWeek', 'nextWeek', 'later'];

/** Overdue once the date (or the time, when one is given) has passed. */
export function bucketOf(due: Due, now: Date): Bucket {
	const today = startOfDay(now).getTime();
	const day = startOfDay(due.date).getTime();
	if (day < today || (!due.allDay && due.date.getTime() < now.getTime())) return 'overdue';
	if (day === today) return 'today';
	const nextWeek = startOfWeek(now).getTime() + 7 * MS_DAY;
	if (day < nextWeek) return 'thisWeek';
	if (day < nextWeek + 7 * MS_DAY) return 'nextWeek';
	return 'later';
}

/**
 * Working days left: weekdays that are not holidays, from tomorrow up to and including the due day.
 * Due tomorrow on a weekday is 1; due on Monday seen on Friday is 1. Past or today is 0.
 */
export function workingDaysLeft(due: Due, now: Date, isHoliday: (ymd: string) => boolean): number {
	const end = startOfDay(due.date);
	const day = startOfDay(now);
	let count = 0;
	// A year of days at most, so a typo like 2062 cannot stall the view.
	for (let i = 0; i < 400; i++) {
		day.setDate(day.getDate() + 1);
		if (day > end) break;
		const weekday = day.getDay();
		if (weekday !== 0 && weekday !== 6 && !isHoliday(ymd(day))) count++;
	}
	return count;
}

/** Calendar days from today to the due day; negative when it has passed. */
export function calendarDaysLeft(due: Due, now: Date): number {
	return Math.round((startOfDay(due.date).getTime() - startOfDay(now).getTime()) / MS_DAY);
}

/** Within each bucket, earliest first; overdue ones most overdue first. */
export function groupByBucket<T>(items: { item: T; due: Due }[], now: Date): Map<Bucket, T[]> {
	const groups = new Map<Bucket, T[]>();
	const sorted = [...items].sort((a, b) => a.due.date.getTime() - b.due.date.getTime());
	for (const bucket of BUCKETS) groups.set(bucket, []);
	for (const { item, due } of sorted) groups.get(bucketOf(due, now))?.push(item);
	return groups;
}
