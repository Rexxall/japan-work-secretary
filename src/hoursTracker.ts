import { moment } from 'obsidian';
import { Shift } from './data';

export interface HoursLimitResult {
    totalHoursLast7Days: number;
    remainingHours: number;
    isOverLimit: boolean;
}

export interface VacationPeriod {
    start: string; // YYYY-MM-DD
    end: string;   // YYYY-MM-DD
}

export interface VacationDayResult {
    date: string;
    hours: number;
}

/**
 * Parse lines like "2026-08-01~2026-09-30" (also accepts "~", "～", "-" or "to").
 * Invalid lines are skipped.
 */
export function parseVacationPeriods(lines: string[]): VacationPeriod[] {
    const periods: VacationPeriod[] = [];
    for (const raw of lines || []) {
        const match = (raw || '').trim().match(/^(\d{4}-\d{2}-\d{2})\s*(?:~|～|to|-)\s*(\d{4}-\d{2}-\d{2})$/);
        if (!match) continue;
        const [start, end] = match[1] <= match[2] ? [match[1], match[2]] : [match[2], match[1]];
        periods.push({ start, end });
    }
    return periods;
}

export class HoursTracker {
    private MAX_HOURS = 28;
    public static readonly VACATION_DAILY_MAX = 8;

    constructor(private vacationPeriods: VacationPeriod[] = []) {}

    /** Long school vacations use a daily 8-hour limit instead of the weekly 28 hours. */
    public isVacationDay(date: string): boolean {
        return this.vacationPeriods.some(p => date >= p.start && date <= p.end);
    }

    /** Days inside a vacation period whose total hours exceed 8. */
    public findVacationDaysOverLimit(shifts: Shift[]): VacationDayResult[] {
        const byDate: Record<string, number> = {};
        for (const shift of shifts) {
            if (shift.isPaidLeave || !this.isVacationDay(shift.date)) continue;
            byDate[shift.date] = (byDate[shift.date] || 0) + (shift.calculatedHours || 0);
        }
        return Object.keys(byDate)
            .filter(date => byDate[date] > HoursTracker.VACATION_DAILY_MAX)
            .sort()
            .map(date => ({ date, hours: Math.round(byDate[date] * 100) / 100 }));
    }

    /**
     * Calculate total hours worked in the last 7 days from an anchor date
     * Usually the anchor date is "today" or a specific checking date
     */
    public checkRolling7DaysLimit(shifts: Shift[], anchorDateStr: string = moment().format('YYYY-MM-DD')): HoursLimitResult {
        const anchorDate = moment(anchorDateStr, 'YYYY-MM-DD');
        const sevenDaysAgo = anchorDate.clone().subtract(6, 'days'); // Inclusive of today, 7 days total

        let totalHours = 0;

        for (const shift of shifts) {
            const shiftDate = moment(shift.date, 'YYYY-MM-DD');
            if (shiftDate.isBetween(sevenDaysAgo, anchorDate, 'day', '[]')) { // '[]' means inclusive
                if (!shift.isPaidLeave) {
                    totalHours += shift.calculatedHours;
                }
            }
        }

        return {
            totalHoursLast7Days: Math.round(totalHours * 100) / 100,
            remainingHours: Math.max(0, Math.round((this.MAX_HOURS - totalHours) * 100) / 100),
            isOverLimit: totalHours > this.MAX_HOURS
        };
    }

    /**
     * Calculate total hours worked in the next 7 days from an anchor date (inclusive).
     * Useful for forecasting hours.
     */
    public checkNext7DaysLimit(shifts: Shift[], anchorDateStr: string = moment().format('YYYY-MM-DD')): HoursLimitResult {
        const anchorDate = moment(anchorDateStr, 'YYYY-MM-DD');
        const sixDaysLater = anchorDate.clone().add(6, 'days'); // Inclusive of start day, 7 days total

        let totalHours = 0;

        for (const shift of shifts) {
            const shiftDate = moment(shift.date, 'YYYY-MM-DD');
            if (shiftDate.isBetween(anchorDate, sixDaysLater, 'day', '[]')) {
                if (!shift.isPaidLeave) {
                    totalHours += shift.calculatedHours;
                }
            }
        }

        return {
            totalHoursLast7Days: Math.round(totalHours * 100) / 100,
            remainingHours: Math.max(0, Math.round((this.MAX_HOURS - totalHours) * 100) / 100),
            isOverLimit: totalHours > this.MAX_HOURS
        };
    }

    /**
     * Work permission for students: 28 hours a week, or 8 hours a day during the school's long
     * vacation. Every 7-day window that contains the anchor date is checked and the busiest is
     * reported. A window made only of vacation days is left to the 8-hour daily check. A window
     * that mixes term days and vacation days is held to 28 hours with all of its hours: the
     * official page does not say how such a week is counted, so the stricter reading is used
     * and the window is flagged.
     */
    public checkPeak7DayWindow(shifts: Shift[], anchorDateStr: string = moment().format('YYYY-MM-DD')): HoursLimitResult & { peakWindowStart: string, peakWindowEnd: string, mixesVacation: boolean } {
        const anchorDate = moment(anchorDateStr, 'YYYY-MM-DD');
        let maxHours = 0;
        let peakStart = '';
        let peakEnd = '';
        let peakMixed = false;

        for (let i = 0; i < 7; i++) {
            const start = anchorDate.clone().subtract(6 - i, 'days');
            const end = anchorDate.clone().add(i, 'days');
            let vacationDays = 0;
            for (let d = start.clone(); d.isSameOrBefore(end, 'day'); d.add(1, 'day')) {
                if (this.isVacationDay(d.format('YYYY-MM-DD'))) vacationDays++;
            }
            if (vacationDays === 7) continue;

            let currentWindowHours = 0;
            for (const shift of shifts) {
                const shiftDate = moment(shift.date, 'YYYY-MM-DD');
                if (shiftDate.isBetween(start, end, 'day', '[]') && !shift.isPaidLeave) {
                    currentWindowHours += shift.calculatedHours;
                }
            }

            if (currentWindowHours > maxHours) {
                maxHours = currentWindowHours;
                peakStart = start.format('YYYY-MM-DD');
                peakEnd = end.format('YYYY-MM-DD');
                peakMixed = vacationDays > 0;
            }
        }

        if (peakStart === '') {
            peakStart = anchorDate.clone().subtract(6, 'days').format('YYYY-MM-DD');
            peakEnd = anchorDate.format('YYYY-MM-DD');
        }

        return {
            totalHoursLast7Days: Math.round(maxHours * 100) / 100,
            remainingHours: Math.max(0, Math.round((this.MAX_HOURS - maxHours) * 100) / 100),
            isOverLimit: maxHours > this.MAX_HOURS,
            peakWindowStart: peakStart,
            peakWindowEnd: peakEnd,
            mixesVacation: peakMixed
        };
    }

    /**
     * Calculate total hours worked in a fixed week (Mon-Sun).
     * Japanese schools often use fixed weeks.
     */
    public checkFixedWeekLimit(shifts: Shift[], anchorDateStr: string = moment().format('YYYY-MM-DD')): HoursLimitResult {
        const anchorDate = moment(anchorDateStr, 'YYYY-MM-DD');
        // isoWeekday(1) is Monday, isoWeekday(7) is Sunday
        const startOfWeek = anchorDate.clone().startOf('isoWeek');
        const endOfWeek = anchorDate.clone().endOf('isoWeek');

        let totalHours = 0;

        for (const shift of shifts) {
            const shiftDate = moment(shift.date, 'YYYY-MM-DD');
            if (shiftDate.isBetween(startOfWeek, endOfWeek, 'day', '[]')) { 
                if (!shift.isPaidLeave) {
                    totalHours += shift.calculatedHours;
                }
            }
        }

        return {
            totalHoursLast7Days: Math.round(totalHours * 100) / 100,
            remainingHours: Math.max(0, Math.round((this.MAX_HOURS - totalHours) * 100) / 100),
            isOverLimit: totalHours > this.MAX_HOURS
        };
    }
}
