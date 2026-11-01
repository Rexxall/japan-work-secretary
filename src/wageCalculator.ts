import { moment, Moment } from './time';
import { JapanWorkSecretarySettings } from './settings';
import { HolidayUtility } from './holidayUtility';
import { getStoreWageBand } from './data';

export interface WageResult {
    totalHours: number;
    wageAmount: number;
    /** The break is not confirmed yet, so hours and pay are counted without it; `ifBreak` has them with it deducted. */
    breakUnconfirmed: boolean;
    /** The minimum break the employer must give (Labour Standards Act art. 34): 45 min over 6 h, 60 min over 8 h. */
    requiredBreakMinutes: number;
    /** Hours and pay with the break deducted: the entered minutes, or the legal minimum when none were entered. */
    ifBreak?: { breakMinutes: number; totalHours: number; wageAmount: number };
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
     * Wage for one shift: time bands, holiday bonus, daily overtime and commuting.
     * A confirmed break is deducted. An unconfirmed one is not, because the legal minimum is something the
     * employer must give, not proof it was taken; counting the shift as scheduled is the stricter reading for
     * the 28-hour check. The figures with the break deducted come back in `ifBreak`.
     * Without `breakConfirmed`, entered minutes count as confirmed and no entry as unconfirmed.
     */
    public calculateShiftWage(date: string, startTime: string, endTime: string, isPaidLeave: boolean = false, customBreakMinutes?: number, storeName: string = '', breakConfirmed?: boolean): WageResult {
        const wageBand = getStoreWageBand(this.settings, storeName, date);
        if (isPaidLeave) {
            return {
                totalHours: 8,
                wageAmount: Math.floor(8 * Number(wageBand.baseWage)),
                breakUnconfirmed: false,
                requiredBreakMinutes: 0
            };
        }

        const startMoment = this.parseTime(date, startTime);
        const endMoment = this.parseTime(date, endTime);
        if (endMoment.isBefore(startMoment)) endMoment.add(1, 'day');
        const totalMinutes = endMoment.diff(startMoment, 'minutes');

        const required = requiredBreakMinutes(totalMinutes);
        const entered = customBreakMinutes !== undefined && customBreakMinutes >= 0 ? customBreakMinutes : undefined;
        const confirmed = breakConfirmed ?? entered !== undefined;
        if (confirmed) {
            return { ...this.pay(startMoment, totalMinutes, entered ?? 0, date, storeName), breakUnconfirmed: false, requiredBreakMinutes: required };
        }
        const asScheduled = this.pay(startMoment, totalMinutes, 0, date, storeName);
        const assumed = Math.min(entered ?? required, totalMinutes);
        return {
            ...asScheduled,
            breakUnconfirmed: assumed > 0,
            requiredBreakMinutes: required,
            ifBreak: assumed > 0 ? { breakMinutes: assumed, ...this.pay(startMoment, totalMinutes, assumed, date, storeName) } : undefined
        };
    }

    /** Hours and pay for a shift of `totalMinutes` from `startMoment`, with `breakMinutes` taken out of its middle. */
    private pay(startMoment: Moment, totalMinutes: number, breakMinutes: number, date: string, storeName: string): { totalHours: number; wageAmount: number } {
        const wageBand = getStoreWageBand(this.settings, storeName, date);
        // A break longer than the shift itself would give negative hours and wages.
        breakMinutes = Math.min(breakMinutes, totalMinutes);
        const actualWorkingHours = (totalMinutes - breakMinutes) / 60;
        const breakStartMinute = Math.floor(totalMinutes / 2) - Math.floor(breakMinutes / 2);
        const breakEndMinute = breakStartMinute + breakMinutes;
        // 2. Pay minute by minute. Time bands: morning 05:00–09:00, day 09:00–17:00, evening 17:00–22:00,
        // late night 22:00–05:00 (the legal late-night hours). The store's Sunday and holiday bonus and the
        // statutory rest-day premium both go by the calendar day each minute falls on, so a shift that runs
        // past midnight into a holiday gets them only for the hours after midnight.
        const rates = {
            morning: Number(wageBand.morningWage),
            base: Number(wageBand.baseWage),
            evening: Number(wageBand.eveningWage),
            night: Number(wageBand.nightWage)
        };
        const storeBonus = Number(wageBand.holidayBonus) || 0;
        const restDay = Number(this.settings.statutoryRestDay ?? -1);
        const restDayPremium = rates.base * Math.max(0, (Number(this.settings.restDayWorkRate) || 1) - 1);
        const dayCache = new Map<string, { bonus: number, premium: number }>();
        const dayExtras = (m: Moment) => {
            const key = m.format('YYYY-MM-DD');
            let extras = dayCache.get(key);
            if (!extras) {
                extras = {
                    bonus: HolidayUtility.isSundayOrHoliday(m, this.settings.customHolidays || []) ? storeBonus : 0,
                    premium: restDay >= 0 && m.day() === restDay ? restDayPremium : 0
                };
                dayCache.set(key, extras);
            }
            return extras;
        };

        // Summed per minute in yen-per-hour units and divided once, so floating error cannot cost a yen at the floor.
        let rateMinutes = 0;
        const currentMoment = startMoment.clone();
        for (let i = 0; i < totalMinutes; i++) {
            if (i < breakStartMinute || i >= breakEndMinute) {
                const hour = currentMoment.hour();
                const rate = hour >= 5 && hour < 9 ? rates.morning
                    : hour >= 9 && hour < 17 ? rates.base
                        : hour >= 17 && hour < 22 ? rates.evening
                            : rates.night;
                const { bonus, premium } = dayExtras(currentMoment);
                rateMinutes += rate + bonus + premium;
            }
            currentMoment.add(1, 'minute');
        }

        let totalWage = rateMinutes / 60;

        // 4. Overtime Logic (Single shift fallback)
        if (actualWorkingHours > 8) {
            const otHours = actualWorkingHours - 8;
            const otPremium = otHours * Number(wageBand.baseWage) * (Number(this.settings.overtimeRate) - 1);
            totalWage += otPremium;
        }

        totalWage += (Number(wageBand.commutingAllowance) || 0);

        return {
            totalHours: Math.round(actualWorkingHours * 100) / 100,
            wageAmount: Math.floor(totalWage + 1e-9)
        };
    }
}
