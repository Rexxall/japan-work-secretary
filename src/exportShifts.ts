import { Shift } from './data';

function cell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function yen(amount: number): string {
    return `¥${Math.round(amount).toLocaleString('en-US')}`;
}

function sortShifts(shifts: Shift[]): Shift[] {
    return [...shifts].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}

/**
 * A note to check against the payslip (給与明細): every shift, totals by store, and
 * the period total including overtime, which is worked out across the whole period.
 */
export function buildPayNote(shifts: Shift[], start: string, end: string, totalWithOvertime: number, now: Date): string {
    const sorted = sortShifts(shifts);
    const worked = sorted.filter(s => !s.isPaidLeave);
    const hours = worked.reduce((sum, s) => sum + (s.calculatedHours || 0), 0);
    const byStore = new Map<string, { hours: number; pay: number; shifts: number }>();
    for (const shift of sorted) {
        const row = byStore.get(shift.storeName) ?? { hours: 0, pay: 0, shifts: 0 };
        row.hours += shift.isPaidLeave ? 0 : shift.calculatedHours || 0;
        row.pay += shift.calculatedWage || 0;
        row.shifts += 1;
        byStore.set(shift.storeName, row);
    }
    const shiftSum = sorted.reduce((sum, s) => sum + (s.calculatedWage || 0), 0);
    const overtime = Math.max(0, totalWithOvertime - Math.floor(shiftSum));

    const lines = [
        '---',
        'type: japan-work-pay-summary',
        `period_start: ${start}`,
        `period_end: ${end}`,
        `hours: ${Math.round(hours * 100) / 100}`,
        `estimated_pay: ${totalWithOvertime}`,
        `updated: ${now.toISOString()}`,
        '---',
        '',
        `# Pay ${start} to ${end}`,
        '',
        `- **Hours:** ${Math.round(hours * 100) / 100} h over ${worked.length} shift${worked.length === 1 ? '' : 's'}`,
        `- **Estimated pay:** ${yen(totalWithOvertime)}${overtime > 0 ? ` (including ${yen(overtime)} overtime)` : ''}`,
        '- An estimate from your wage settings. Compare it with your payslip (給与明細); tax and insurance are not deducted.',
        '',
        '## By store',
        '',
        '| Store | Shifts | Hours | Pay |',
        '| --- | ---: | ---: | ---: |',
        ...[...byStore.entries()].map(([store, row]) => `| ${cell(store)} | ${row.shifts} | ${Math.round(row.hours * 100) / 100} | ${yen(row.pay)} |`),
        '',
        '## Shifts',
        '',
        '| Date | Store | Time | Hours | Pay |',
        '| --- | --- | --- | ---: | ---: |',
        ...sorted.map(s => `| ${s.date} | ${cell(s.storeName)} | ${s.isPaidLeave ? 'Paid leave' : `${s.startTime}–${s.endTime}`} | ${Math.round((s.calculatedHours || 0) * 100) / 100} | ${yen(s.calculatedWage || 0)} |`),
        ''
    ];
    if (sorted.length === 0) lines.splice(lines.indexOf('## By store'), Infinity, 'No shifts in this period.', '');
    return lines.join('\n');
}

function icsEscape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Local wall-clock time in Japan, written with an explicit TZID so any calendar app places it correctly. */
function icsLocal(date: string, time: string, addDays = 0): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + addDays);
    const day = d.toISOString().slice(0, 10).replace(/-/g, '');
    return `${day}T${time.replace(':', '')}00`;
}

/**
 * Calendar file for apps other than macOS Calendar (Google Calendar, Outlook, phones).
 * Each event keeps the shift id as its UID, so importing again updates instead of duplicating.
 */
export function buildShiftsIcs(shifts: Shift[], titlePrefix: string, now: Date): string {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Japan Work Secretary//Obsidian//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VTIMEZONE',
        'TZID:Asia/Tokyo',
        'BEGIN:STANDARD',
        'DTSTART:19700101T000000',
        'TZOFFSETFROM:+0900',
        'TZOFFSETTO:+0900',
        'TZNAME:JST',
        'END:STANDARD',
        'END:VTIMEZONE'
    ];
    for (const shift of sortShifts(shifts)) {
        if (shift.isPaidLeave) continue;
        // A shift that ends at or before it starts runs past midnight.
        const overnight = shift.endTime <= shift.startTime;
        const title = titlePrefix ? `${titlePrefix}: ${shift.storeName}` : shift.storeName;
        lines.push(
            'BEGIN:VEVENT',
            `UID:jws-${shift.id}`,
            `DTSTAMP:${stamp}`,
            `DTSTART;TZID=Asia/Tokyo:${icsLocal(shift.date, shift.startTime)}`,
            `DTEND;TZID=Asia/Tokyo:${icsLocal(shift.date, shift.endTime, overnight ? 1 : 0)}`,
            `SUMMARY:${icsEscape(title)}`,
            `DESCRIPTION:${icsEscape(`${Math.round((shift.calculatedHours || 0) * 100) / 100} h`)}`,
            'END:VEVENT'
        );
    }
    lines.push('END:VCALENDAR');
    return `${lines.join('\r\n')}\r\n`;
}
