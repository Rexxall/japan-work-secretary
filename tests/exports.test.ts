import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayNote, buildShiftsIcs } from '../src/exportShifts';
import { parseShiftReply } from '../src/aiParser';
import { Shift } from '../src/data';

const shift = (id: string, date: string, startTime: string, endTime: string, storeName: string, hours: number, wage: number, isPaidLeave = false): Shift =>
    ({ id, date, startTime, endTime, storeName, calculatedHours: hours, calculatedWage: wage, isPaidLeave });

test('pay note lists every shift, totals by store and the overtime part', () => {
    const shifts = [
        shift('b', '2026-10-22', '17:00', '22:00', 'Store A', 4.25, 6000),
        shift('a', '2026-10-21', '09:00', '13:00', 'Cafe | Two', 4, 5000),
        shift('c', '2026-10-23', '00:00', '00:00', 'Store A', 0, 8000, true)
    ];
    const note = buildPayNote(shifts, '2026-10-21', '2026-11-20', 19500, new Date('2026-11-21T00:00:00Z'));
    assert.match(note, /^---\ntype: japan-work-pay-summary/);
    assert.match(note, /estimated_pay: 19500/);
    assert.match(note, /8\.25 h over 2 shifts/);
    assert.match(note, /including ¥500 overtime/);
    assert.match(note, /Cafe \\\| Two/);
    assert.ok(note.indexOf('2026-10-21') < note.indexOf('| 2026-10-22'));
    assert.match(note, /Paid leave/);
});

test('pay note for an empty period says so', () => {
    const note = buildPayNote([], '2026-10-21', '2026-11-20', 0, new Date());
    assert.match(note, /No shifts in this period/);
    assert.doesNotMatch(note, /## By store/);
});

test('ics: Japan time zone, overnight shifts end the next day, paid leave skipped, stable UID', () => {
    const ics = buildShiftsIcs([
        shift('n1', '2026-12-31', '22:00', '02:00', 'Night, Store', 4, 7000),
        shift('p1', '2027-01-02', '00:00', '00:00', 'Store A', 0, 8000, true)
    ], '打工', new Date('2026-12-01T00:00:00Z'));
    assert.match(ics, /DTSTART;TZID=Asia\/Tokyo:20261231T220000/);
    assert.match(ics, /DTEND;TZID=Asia\/Tokyo:20270101T020000/);
    assert.match(ics, /UID:jws-n1/);
    assert.match(ics, /SUMMARY:打工: Night\\, Store/);
    assert.doesNotMatch(ics, /jws-p1/);
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test('AI reply: malformed rows are dropped, times padded, stores normalized', () => {
    const reply = '```json\n[{"date":"2026-11-03","startTime":"9:00","endTime":"13:30","storeName":"A"},{"date":"11/04","startTime":"10:00","endTime":"12:00"},"x"]\n```';
    const drafts = parseShiftReply(reply, name => (name === 'A' ? 'Store A' : name));
    assert.deepEqual(drafts, [{ date: '2026-11-03', startTime: '09:00', endTime: '13:30', storeName: 'Store A' }]);
    assert.throws(() => parseShiftReply('{"date":"2026-11-03"}', n => n));
});
