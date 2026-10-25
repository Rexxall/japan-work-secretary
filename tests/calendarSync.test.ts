import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCalendarSyncFingerprint,
    buildCalendarSyncStateKey,
    collectCalendarSyncShifts,
    findCalendarSyncOrphans,
    planCalendarSync
} from '../src/calendarSyncPlanner';
import { JapanWorkSecretaryData, RecurringShift, Shift, buildRecurringInstanceId } from '../src/data';
import { MacCalendarSync, normalizeCalendarDeleteAction, normalizeCalendarSyncAction } from '../src/macCalendarSync';

function shift(overrides: Partial<Shift> = {}): Shift {
    return {
        id: 'shift-1',
        date: '2026-09-04',
        startTime: '16:00',
        endTime: '20:00',
        storeName: 'Store B',
        calculatedHours: 4,
        calculatedWage: 6050,
        ...overrides
    };
}

function data(overrides: Partial<JapanWorkSecretaryData> = {}): JapanWorkSecretaryData {
    return {
        shifts: [],
        recurringShifts: [],
        shiftTemplates: [],
        exchangeRates: {},
        calendarSyncState: {},
        lastSyncTime: null,
        lastSyncAttemptTime: null,
        ...overrides
    };
}

function recurringFactory(date: string, rule: RecurringShift): Shift {
    return shift({
        id: buildRecurringInstanceId(rule.id, date),
        date,
        startTime: rule.startTime,
        endTime: rule.endTime,
        storeName: rule.storeName
    });
}

test('fingerprint tracks Calendar fields but ignores wage bookkeeping', () => {
    const original = shift();
    const fingerprint = buildCalendarSyncFingerprint(original, 'Arubaito');

    assert.equal(
        buildCalendarSyncFingerprint({ ...original, calculatedWage: 9999, isSynced: false }, 'Arubaito'),
        fingerprint
    );
    assert.notEqual(buildCalendarSyncFingerprint({ ...original, endTime: '21:00' }, 'Arubaito'), fingerprint);
    assert.notEqual(buildCalendarSyncFingerprint(original, 'Second Calendar'), fingerprint);
});

test('smart plan skips matching fingerprints and queues new or changed shifts', () => {
    const unchanged = shift({ id: 'unchanged' });
    const changed = shift({ id: 'changed', endTime: '21:00' });
    const newShift = shift({ id: 'new' });
    const calendarName = 'Arubaito';
    const state = {
        [buildCalendarSyncStateKey('unchanged', calendarName)]: {
            fingerprint: buildCalendarSyncFingerprint(unchanged, calendarName),
            syncedAt: '2026-08-01T00:00:00.000Z',
            calendarName
        },
        [buildCalendarSyncStateKey('changed', calendarName)]: {
            fingerprint: buildCalendarSyncFingerprint({ ...changed, endTime: '20:00' }, calendarName),
            syncedAt: '2026-08-01T00:00:00.000Z',
            calendarName
        }
    };

    const plan = planCalendarSync([unchanged, changed, newShift], state, calendarName, false);
    assert.deepEqual(plan.skipped.map(item => item.shift.id), ['unchanged']);
    assert.deepEqual(plan.toSync.map(item => item.shift.id), ['changed', 'new']);
});

test('legacy isSynced without a fingerprint is reconciled once', () => {
    const legacy = shift({ isSynced: true });
    const plan = planCalendarSync([legacy], {}, 'Arubaito', false);
    assert.equal(plan.toSync.length, 1);
    assert.equal(plan.skipped.length, 0);
});

test('legacy unscoped fingerprints remain readable for one-time metadata migration', () => {
    const item = shift();
    const calendarName = 'Arubaito';
    const state = {
        [item.id]: {
            fingerprint: buildCalendarSyncFingerprint(item, calendarName),
            syncedAt: '2026-08-01T00:00:00.000Z'
        }
    };

    const plan = planCalendarSync([item], state, calendarName, false);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.toSync.length, 0);
});

test('Friday 16:00-20:00 to 16:00-21:00 is detected as a change', () => {
    const oldShift = shift({ endTime: '20:00' });
    const updatedShift = shift({ endTime: '21:00' });
    const state = {
        [oldShift.id]: {
            fingerprint: buildCalendarSyncFingerprint(oldShift, 'Arubaito'),
            syncedAt: '2026-08-01T00:00:00.000Z'
        }
    };
    assert.equal(planCalendarSync([updatedShift], state, 'Arubaito', false).toSync.length, 1);
});

test('a failed sync record is retained but Smart retries it', () => {
    const item = shift();
    const calendarName = 'Arubaito';
    const key = buildCalendarSyncStateKey(item.id, calendarName);
    const state = {
        [key]: {
            fingerprint: buildCalendarSyncFingerprint(item, calendarName),
            syncedAt: '2026-08-01T00:00:00.000Z',
            status: 'failed' as const,
            failedAt: '2026-08-02T00:00:00.000Z',
            calendarName,
            source: 'manual' as const,
            shift: {
                id: item.id,
                date: item.date,
                startTime: item.startTime,
                endTime: item.endTime,
                storeName: item.storeName
            }
        }
    };

    assert.equal(planCalendarSync([item], state, calendarName, false).toSync.length, 1);
    assert.equal(
        findCalendarSyncOrphans([], state, calendarName, '2026-09-01', '2026-09-30', true).length,
        1
    );
});

test('range collection is inclusive and respects recurring bounds, exceptions, and manual override', () => {
    const manualAtStart = shift({ id: 'manual-start', date: '2026-09-01' });
    const manualOverride = shift({ id: 'manual-override', date: '2026-09-04' });
    const manualAtEnd = shift({ id: 'manual-end', date: '2026-09-18' });
    const outside = shift({ id: 'outside', date: '2026-09-19' });
    const rule: RecurringShift = {
        id: 'friday-rule',
        dayOfWeek: 5,
        startTime: '16:00',
        endTime: '20:00',
        storeName: 'Store B',
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        exceptions: ['2026-09-11']
    };

    const collected = collectCalendarSyncShifts(
        data({
            shifts: [manualAtStart, manualOverride, manualAtEnd, outside],
            recurringShifts: [rule]
        }),
        '2026-09-01',
        '2026-09-18',
        false,
        recurringFactory
    );

    assert.deepEqual(
        collected.map(item => item.id).sort(),
        ['manual-end', 'manual-override', 'manual-start'].sort()
    );
});

test('recurring instances use stable IDs and full mode ignores matching fingerprints', () => {
    const rule: RecurringShift = {
        id: 'friday-rule',
        dayOfWeek: 5,
        startTime: '16:00',
        endTime: '21:00',
        storeName: 'Store B',
        startDate: '2026-09-01',
        endDate: '2026-09-30'
    };
    const collected = collectCalendarSyncShifts(
        data({ recurringShifts: [rule] }),
        '2026-09-18',
        '2026-09-18',
        false,
        recurringFactory
    );
    assert.equal(collected[0].id, buildRecurringInstanceId(rule.id, '2026-09-18'));

    const fingerprint = buildCalendarSyncFingerprint(collected[0], 'Arubaito');
    const plan = planCalendarSync(
        collected,
        { [collected[0].id]: { fingerprint, syncedAt: '2026-08-01T00:00:00.000Z' } },
        'Arubaito',
        true
    );
    assert.equal(plan.toSync.length, 1);
    assert.equal(plan.skipped.length, 0);
});

test('orphaned recurring instances are scoped and returned for Calendar deletion', () => {
    const recurringId = buildRecurringInstanceId('old-rule', '2026-09-11');
    const oldShift = shift({ id: recurringId, date: '2026-09-11' });
    const calendarName = 'Arubaito';
    const state = {
        [buildCalendarSyncStateKey(recurringId, calendarName)]: {
            fingerprint: buildCalendarSyncFingerprint(oldShift, calendarName),
            syncedAt: '2026-08-01T00:00:00.000Z',
            calendarName,
            source: 'recurring' as const,
            shift: {
                id: oldShift.id,
                date: oldShift.date,
                startTime: oldShift.startTime,
                endTime: oldShift.endTime,
                storeName: oldShift.storeName
            }
        }
    };

    assert.equal(
        findCalendarSyncOrphans([], state, calendarName, '2026-09-01', '2026-09-30', false).length,
        1
    );
    assert.equal(
        findCalendarSyncOrphans([], state, calendarName, '2026-10-01', '2026-10-31', false).length,
        0
    );
});

test('calendar-scoped state does not classify a desired shift as an orphan', () => {
    const calendarName = 'Arubaito';
    const desired = shift({ id: 'still-scheduled' });
    const state = {
        [buildCalendarSyncStateKey(desired.id, calendarName)]: {
            fingerprint: buildCalendarSyncFingerprint(desired, calendarName),
            syncedAt: '2026-08-01T00:00:00.000Z',
            calendarName,
            source: 'manual' as const,
            shift: {
                id: desired.id,
                date: desired.date,
                startTime: desired.startTime,
                endTime: desired.endTime,
                storeName: desired.storeName
            }
        }
    };

    assert.equal(
        findCalendarSyncOrphans([desired], state, calendarName, '2026-09-01', '2026-09-30', true).length,
        0
    );
});

test('Calendar result values map to created and updated', () => {
    assert.equal(normalizeCalendarSyncAction('Synced'), 'created');
    assert.equal(normalizeCalendarSyncAction('Created'), 'created');
    assert.equal(normalizeCalendarSyncAction('Updated'), 'updated');
    assert.throws(() => normalizeCalendarSyncAction('Unknown'), /Unexpected Calendar sync result/);
    assert.equal(normalizeCalendarDeleteAction('Deleted'), 'deleted');
    assert.equal(normalizeCalendarDeleteAction('Not found'), 'not-found');
});

test('Calendar deletion targets only the plugin event marker', async () => {
    const service = new MacCalendarSync('Arubaito') as any;
    let capturedScript = '';
    let capturedArgs: string[] = [];
    service.executeAppleScript = async (script: string, args: string[]) => {
        capturedScript = script;
        capturedArgs = args;
        return 'Deleted';
    };

    assert.equal(await service.deleteShift(shift()), 'deleted');
    assert.deepEqual(capturedArgs, ['Arubaito', 'JWS_SHIFT_ID:shift-1']);
    assert.match(capturedScript, /description is eventMarker/);
    assert.doesNotMatch(capturedScript, /dayEvents|theSummary/);
});

test('batch sync continues after an item fails and returns accurate counts', async () => {
    const service = new MacCalendarSync('Arubaito');
    const actions = new Map<string, 'created' | 'updated' | Error>([
        ['created', 'created'],
        ['failed', new Error('boom')],
        ['updated', 'updated']
    ]);
    service.syncShift = async (item: Shift) => {
        const action = actions.get(item.id);
        if (action instanceof Error) throw action;
        if (!action) throw new Error('missing action');
        return action;
    };

    const result = await service.syncMultipleShifts([
        shift({ id: 'created' }),
        shift({ id: 'failed' }),
        shift({ id: 'updated' })
    ]);

    assert.deepEqual(
        { created: result.created, updated: result.updated, failed: result.failed },
        { created: 1, updated: 1, failed: 1 }
    );
    assert.equal(result.items.length, 3);
});

test('fingerprint ignores the default title prefix but changes with a custom one', () => {
    const base: Shift = { id: 'p1', date: '2026-10-01', startTime: '10:00', endTime: '14:00', storeName: 'Store A', calculatedWage: 0, calculatedHours: 4 };
    const legacy = buildCalendarSyncFingerprint(base, 'Work');
    assert.equal(buildCalendarSyncFingerprint(base, 'Work', '打工'), legacy);
    assert.notEqual(buildCalendarSyncFingerprint(base, 'Work', 'シフト'), legacy);
});
