import { moment as obsidianMoment } from 'obsidian';

/**
 * The parts of moment.js this plugin uses. Obsidian ships moment at runtime, but its typings come from the
 * separate `moment` package; spelling the API out here keeps every call typed wherever those typings are missing.
 */
/** Units for adding, subtracting and measuring time. */
export type DurationUnit = 'minute' | 'minutes' | 'hour' | 'day' | 'days' | 'week' | 'month' | 'months' | 'year';
/** Units for snapping and comparing; adds the ISO week, which starts on Monday. */
export type TimeUnit = DurationUnit | 'isoWeek';
export type MomentInput = Moment | Date | string | number;

export interface Moment {
	format(format?: string): string;
	clone(): Moment;
	add(amount: number, unit: DurationUnit): Moment;
	subtract(amount: number, unit: DurationUnit): Moment;
	startOf(unit: TimeUnit): Moment;
	endOf(unit: TimeUnit): Moment;
	diff(other: Moment, unit: DurationUnit): number;
	isValid(): boolean;
	isSame(other: Moment, unit?: TimeUnit): boolean;
	isBefore(other: Moment, unit?: TimeUnit): boolean;
	isAfter(other: Moment, unit?: TimeUnit): boolean;
	isSameOrBefore(other: Moment, unit?: TimeUnit): boolean;
	isSameOrAfter(other: Moment, unit?: TimeUnit): boolean;
	isBetween(from: Moment, to: Moment, unit: TimeUnit, inclusivity: '()' | '[)' | '(]' | '[]'): boolean;
	toISOString(): string;
	year(): number;
	month(): number;
	date(): number;
	date(day: number): Moment;
	day(): number;
	isoWeekday(): number;
	hour(): number;
	hours(): number;
	minutes(): number;
}

export interface MomentFactory {
	(input?: MomentInput, format?: string, strict?: boolean): Moment;
	weekdays(): string[];
	weekdaysShort(): string[];
}

export const moment = obsidianMoment as unknown as MomentFactory;

/** Fails the build if Obsidian's moment drops a method used here or stops accepting one of these units. */
type ObsidianMoment = ReturnType<typeof obsidianMoment>;
export type MomentShapeCheck = keyof Moment extends keyof ObsidianMoment
	? keyof MomentFactory extends keyof typeof obsidianMoment
		? TimeUnit extends Parameters<ObsidianMoment['startOf']>[0]
			? DurationUnit extends NonNullable<Parameters<ObsidianMoment['diff']>[1]> ? true : never
			: never
		: never
	: never;
export const momentShapeMatches: MomentShapeCheck = true;
