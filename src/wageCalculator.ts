import { moment } from 'obsidian';
import type { Moment } from 'moment';
import { JapanWorkSecretarySettings } from './settings';
import { HolidayUtility } from './holidayUtility';
import { getStoreWageBand } from './data';

export interface WageResult {
    totalHours: number;
    wageAmount: number;
    /** No break was entered for a shift long enough to need one; hours are counted as scheduled. */
    breakMissing: boolean;
    /** The minimum break the employer must give (Labour Standards Act art. 34): 45 min over 6 h, 60 min over 8 h. */
    requiredBreakMinutes: number;
}

/** Minimum break for a shift of this length. A rule for the employer, not proof a break was taken. */
export function requiredBreakMinutes(shiftMinutes: number): number {
    if (shiftMinutes > 8 * 60) return 60;
    if (shiftMinutes > 6 * 60) return 45;
    return 0;
}

export class WageCalculator {
    settings: JapanWorkSecretarySettings;

    constructor(settings: JapanWorkSecretarySettings) {
        this.settings = settings;
    }

    /**
     * Parse time string HH:mm into moment object on a specific date
     */
    private parseTime(date: string, timeStr: string): Moment {
        return moment(`${date} ${timeStr}`, 'YYYY-MM-DD HH:mm');
    }

    /**
     * Wage for one shift: time bands, the entered break, holiday bonus, daily overtime and commuting.
     */
    public calculateShiftWage(date: string, startTime: string, endTime: string, isPaidLeave: boolean = false, customBreakMinutes?: number, storeName: string = ''): WageResult {
        const wageBand = getStoreWageBand(this.settings, storeName, date);
        if (isPaidLeave) {
            return {
                totalHours: 8,
                wageAmount: Math.floor(8 * Number(wageBand.baseWage)),
                breakMissing: false,
                requiredBreakMinutes: 0
            };
        }

        let startMoment = this.parseTime(date, startTime);
        let endMoment = this.parseTime(date, endTime);

        if (endMoment.isBefore(startMoment)) {
            endMoment.add(1, 'day');
        }

        const totalMinutes = endMoment.diff(startMoment, 'minutes');

        // 1. Break: only what was actually entered. The legal minimum is something the employer
        // must give, not proof that it was taken, so an unentered break is not deducted; the shift
        // is counted as scheduled (the stricter reading for the 28-hour check) and flagged.
        const required = requiredBreakMinutes(totalMinutes);
        const breakEntered = customBreakMinutes !== undefined && customBreakMinutes >= 0;
        let breakMinutes = breakEntered ? customBreakMinutes : 0;
        // A break longer than the shift itself would give negative hours and wages.
        breakMinutes = Math.min(breakMinutes, totalMinutes);
        
        const actualWorkingMinutes = totalMinutes - breakMinutes;
        const actualWorkingHours = actualWorkingMinutes / 60;

        const breakStartMinute = Math.floor(totalMinutes / 2) - Math.floor(breakMinutes / 2);
        const breakEndMinute = breakStartMinute + breakMinutes;

        // 2. Count minutes for each slot
        let morningMins = 0;
        let baseMins = 0;
        let eveningMins = 0;
        let nightMins = 0;

        let currentMoment = startMoment.clone();
        const isHoliday = HolidayUtility.isSundayOrHoliday(startMoment, this.settings.customHolidays || []);
        const bonus = isHoliday ? (Number(wageBand.holidayBonus) || 0) : 0;

        for (let i = 0; i < totalMinutes; i++) {
            if (i >= breakStartMinute && i < breakEndMinute) {
                currentMoment.add(1, 'minute');
                continue;
            }

            const hour = currentMoment.hour();

            if (hour >= 5 && hour < 9) {
                morningMins++;
            } else if (hour >= 9 && hour < 17) {
                baseMins++;
            } else if (hour >= 17 && hour < 22) {
                eveningMins++;
            } else {
                nightMins++;
            }

            currentMoment.add(1, 'minute');
        }

        // 3. Batch Multiplication
        const morningWage = Number(wageBand.morningWage) + bonus;
        const baseWage = Number(wageBand.baseWage) + bonus;
        const eveningWage = Number(wageBand.eveningWage) + bonus;
        const nightWage = Number(wageBand.nightWage) + bonus;

        let totalWage = (morningMins * morningWage + baseMins * baseWage + eveningMins * eveningWage + nightMins * nightWage) / 60;

        // 4. Overtime Logic (Single shift fallback)
        if (actualWorkingHours > 8) {
            const otHours = actualWorkingHours - 8;
            const otPremium = otHours * Number(wageBand.baseWage) * (Number(this.settings.overtimeRate) - 1);
            totalWage += otPremium;
        }

        totalWage += (Number(wageBand.commutingAllowance) || 0);

        return {
            totalHours: Math.round(actualWorkingHours * 100) / 100,
            wageAmount: Math.floor(totalWage),
            breakMissing: !breakEntered && required > 0,
            requiredBreakMinutes: required
        };
    }
}
