import moment from 'moment';
import { JapanWorkSecretarySettings } from './settings';
import { HolidayUtility } from './holidayUtility';
import { getStoreWageBand } from './data';

export interface WageResult {
    totalHours: number;
    wageAmount: number;
}

export class WageCalculator {
    settings: JapanWorkSecretarySettings;

    constructor(settings: JapanWorkSecretarySettings) {
        this.settings = settings;
    }

    /**
     * Parse time string HH:mm into moment object on a specific date
     */
    private parseTime(date: string, timeStr: string): moment.Moment {
        return moment(`${date} ${timeStr}`, 'YYYY-MM-DD HH:mm');
    }

    /**
     * Calculate wage for a single shift based on Mai Basket rules
     */
    public calculateShiftWage(date: string, startTime: string, endTime: string, isPaidLeave: boolean = false, customBreakMinutes?: number, storeName: string = ''): WageResult {
        const wageBand = getStoreWageBand(this.settings, storeName, date);
        if (isPaidLeave) {
            return {
                totalHours: 8,
                wageAmount: Math.floor(8 * Number(wageBand.baseWage))
            };
        }

        let startMoment = this.parseTime(date, startTime);
        let endMoment = this.parseTime(date, endTime);

        if (endMoment.isBefore(startMoment)) {
            endMoment.add(1, 'day');
        }

        const totalMinutes = endMoment.diff(startMoment, 'minutes');
        let totalHours = totalMinutes / 60;

        // 1. Calculate break duration
        let breakMinutes = 0;
        if (customBreakMinutes !== undefined && customBreakMinutes >= 0) {
            breakMinutes = customBreakMinutes;
        } else {
            if (totalHours > 8) breakMinutes = 60;
            else if (totalHours > 6) breakMinutes = 45;
        }
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
            wageAmount: Math.floor(totalWage)
        };
    }
}
