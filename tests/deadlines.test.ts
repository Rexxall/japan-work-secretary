import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketOf, calendarDaysLeft, groupByBucket, parseDue, workingDaysLeft } from '../src/deadlines';

// Friday 2026-11-20, 15:00. Monday 11-23 is 勤労感謝の日.
const now = new Date(2026, 10, 20, 15, 0);
const holidays = new Set(['2026-11-23']);
const isHoliday = (d: string) => holidays.has(d);

test('deadlines are read as written', () => {
	assert.deepEqual(parseDue('2026-11-24'), { date: new Date(2026, 10, 24), allDay: true });
	assert.equal(parseDue('2026-11-24 17:00')?.allDay, false);
	assert.equal(parseDue('2026-13-01'), null);
	assert.equal(parseDue('soon'), null);
	assert.equal(parseDue(20261124), null);
});

test('weeks start on Monday; a time earlier today is already overdue', () => {
	assert.equal(bucketOf(parseDue('2026-11-19')!, now), 'overdue');
	assert.equal(bucketOf(parseDue('2026-11-20 09:00')!, now), 'overdue');
	assert.equal(bucketOf(parseDue('2026-11-20 18:00')!, now), 'today');
	assert.equal(bucketOf(parseDue('2026-11-20')!, now), 'today');
	assert.equal(bucketOf(parseDue('2026-11-22')!, now), 'thisWeek');
	assert.equal(bucketOf(parseDue('2026-11-23')!, now), 'nextWeek');
	assert.equal(bucketOf(parseDue('2026-11-29')!, now), 'nextWeek');
	assert.equal(bucketOf(parseDue('2026-11-30')!, now), 'later');
});

test('working days skip the weekend and holidays', () => {
	assert.equal(workingDaysLeft(parseDue('2026-11-23')!, now, isHoliday), 0);
	assert.equal(workingDaysLeft(parseDue('2026-11-24')!, now, isHoliday), 1);
	assert.equal(workingDaysLeft(parseDue('2026-11-27')!, now, isHoliday), 4);
	assert.equal(workingDaysLeft(parseDue('2026-11-20')!, now, isHoliday), 0);
	assert.equal(workingDaysLeft(parseDue('2026-11-10')!, now, isHoliday), 0);
	assert.equal(calendarDaysLeft(parseDue('2026-11-24')!, now), 4);
	assert.equal(calendarDaysLeft(parseDue('2026-11-18')!, now), -2);
});

test('each week holds its deadlines earliest first', () => {
	const items = ['2026-11-26', '2026-11-18', '2026-11-24', '2026-11-21', '2026-11-16'].map(text => ({ item: text, due: parseDue(text)! }));
	const groups = groupByBucket(items, now);
	assert.deepEqual(groups.get('overdue'), ['2026-11-16', '2026-11-18']);
	assert.deepEqual(groups.get('thisWeek'), ['2026-11-21']);
	assert.deepEqual(groups.get('nextWeek'), ['2026-11-24', '2026-11-26']);
	assert.deepEqual(groups.get('today'), []);
});
