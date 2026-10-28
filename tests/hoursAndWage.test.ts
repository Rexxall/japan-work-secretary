// Checks for the 28-hour rule and the wage time bands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HoursTracker, parseVacationPeriods } from '../src/hoursTracker';
import { WageCalculator } from '../src/wageCalculator';
import { Shift } from '../src/data';

function shift(date: string, hours: number, overrides: Partial<Shift> = {}): Shift {
    return { id: date, date, startTime: '10:00', endTime: '14:00', storeName: '测试店', calculatedHours: hours, calculatedWage: 0, ...overrides };
}

// One store with simple, round wages so the expected numbers are easy to check by hand.
const settings: any = {
    baseWage: 1200, morningWage: 1300, eveningWage: 1440, nightWage: 1500, holidayBonus: 0, commutingAllowance: 0,
    overtimeRate: 1.25, customHolidays: [],
    // Give the store its own wage table; without one, the plugin falls back to the default store's table.
    storeConfigs: [{ name: '测试店', aliases: [], wageBands: [{ effectiveFrom: '2026-01-01', baseWage: 1200, morningWage: 1300, eveningWage: 1440, nightWage: 1500, holidayBonus: 0, commutingAllowance: 0 }] }]
};

test('exactly 28 hours in 7 days is allowed, 28.5 is over', () => {
    const tracker = new HoursTracker();
    const week = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'].map(d => shift(d, 4));
    const ok = tracker.checkRolling7DaysLimit(week, '2026-10-21');
    assert.equal(ok.totalHoursLast7Days, 28);
    assert.equal(ok.isOverLimit, false);
    assert.equal(ok.remainingHours, 0);
    const over = tracker.checkRolling7DaysLimit([...week, shift('2026-10-21', 0.5, { id: 'extra' })], '2026-10-21');
    assert.equal(over.isOverLimit, true);
});

test('a shift 7 days ago falls outside the rolling window', () => {
    const tracker = new HoursTracker();
    const result = tracker.checkRolling7DaysLimit([shift('2026-10-14', 8), shift('2026-10-21', 4)], '2026-10-21');
    assert.equal(result.totalHoursLast7Days, 4);
});

test('paid leave does not count toward the 28 hours', () => {
    const tracker = new HoursTracker();
    const result = tracker.checkRolling7DaysLimit([shift('2026-10-20', 8, { isPaidLeave: true }), shift('2026-10-21', 4)], '2026-10-21');
    assert.equal(result.totalHoursLast7Days, 4);
});

test('the peak window finds the heaviest 7 days around today', () => {
    const tracker = new HoursTracker();
    const shifts = [shift('2026-10-22', 10), shift('2026-10-24', 10), shift('2026-10-26', 10), shift('2026-10-14', 10)];
    const peak = tracker.checkPeak7DayWindow(shifts, '2026-10-21');
    assert.equal(peak.totalHoursLast7Days, 30);
    assert.equal(peak.isOverLimit, true);
});

test('daytime and evening hours use their own rates', () => {
    const calc = new WageCalculator(settings);
    assert.deepEqual(calc.calculateShiftWage('2026-10-21', '10:00', '14:00', false, undefined, '测试店'), { totalHours: 4, wageAmount: 4800, breakMissing: false, requiredBreakMinutes: 0 });
    // 16:00-17:00 at 1200, 17:00-20:00 at 1440
    assert.deepEqual(calc.calculateShiftWage('2026-10-21', '16:00', '20:00', false, undefined, '测试店'), { totalHours: 4, wageAmount: 1200 + 3 * 1440, breakMissing: false, requiredBreakMinutes: 0 });
});

test('an unentered break is not deducted; the shift counts as scheduled and is flagged', () => {
    const calc = new WageCalculator(settings);
    const missing = calc.calculateShiftWage('2026-10-21', '10:00', '17:00', false, undefined, '测试店');
    assert.equal(missing.totalHours, 7);
    assert.equal(missing.breakMissing, true);
    assert.equal(missing.requiredBreakMinutes, 45);
    const entered = calc.calculateShiftWage('2026-10-21', '10:00', '17:00', false, 45, '测试店');
    assert.equal(entered.totalHours, 6.25);
    assert.equal(entered.breakMissing, false);
    assert.equal(calc.calculateShiftWage('2026-10-21', '09:00', '18:30', false, undefined, '测试店').requiredBreakMinutes, 60);
    // Six hours or less needs no break, so nothing is flagged.
    assert.equal(calc.calculateShiftWage('2026-10-21', '10:00', '16:00', false, undefined, '测试店').breakMissing, false);
});

test('a break longer than the shift never makes hours negative', () => {
    const calc = new WageCalculator(settings);
    const result = calc.calculateShiftWage('2026-10-21', '10:00', '11:00', false, 90, '测试店');
    assert.equal(result.totalHours, 0);
    assert.equal(result.wageAmount, 0);
});

test('vacation days use the 8-hour daily limit and leave the 28-hour window', () => {
    const periods = parseVacationPeriods(['2026-08-01~2026-08-31', 'not a range', '2026-12-30 ～ 2026-12-25']);
    assert.deepEqual(periods, [
        { start: '2026-08-01', end: '2026-08-31' },
        { start: '2026-12-25', end: '2026-12-30' }
    ]);
    const tracker = new HoursTracker(periods);
    const shifts = ['2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17'].map(d => shift(d, 8));
    shifts.push(shift('2026-08-17', 1, { id: 'extra' }));
    // Every window around the 15th lies inside the vacation: only the daily limit applies.
    const peak = tracker.checkPeak7DayWindow(shifts, '2026-08-15');
    assert.equal(peak.totalHoursLast7Days, 0);
    assert.equal(peak.isOverLimit, false);
    assert.deepEqual(tracker.findVacationDaysOverLimit(shifts), [{ date: '2026-08-17', hours: 9 }]);
});

test('a week that mixes term days and vacation days is held to 28 hours with all its hours', () => {
    const tracker = new HoursTracker(parseVacationPeriods(['2026-08-01~2026-08-31']));
    const shifts = ['2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'].map(d => shift(d, 6));
    const peak = tracker.checkPeak7DayWindow(shifts, '2026-07-31');
    assert.equal(peak.totalHoursLast7Days, 36);
    assert.equal(peak.isOverLimit, true);
    assert.equal(peak.mixesVacation, true);
    // Term-only weeks are not flagged as mixed.
    const term = new HoursTracker([]).checkPeak7DayWindow(shifts.slice(0, 4), '2026-07-29');
    assert.equal(term.mixesVacation, false);
});
