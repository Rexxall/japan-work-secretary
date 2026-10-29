// Data saved by 1.1.x (the shape of a real file, every value made up) loads without loss.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateIncomeAlerts } from '../src/incomeAlerts';
import { getStoreWageBand, normalizeStoreConfigs } from '../src/data';

test('1.1.x on/off switches become the three income alerts, keeping which were on', () => {
    const alerts = migrateIncomeAlerts({ taxWall88k: true, taxWall103k: false, taxWall130k: true });
    assert.deepEqual(alerts.map(a => [a.amount, a.period, a.enabled]), [[88000, 'monthly', true], [1030000, 'annual', false], [1300000, 'annual', true]]);
});

test('alerts saved by a newer version are kept as they are', () => {
    const alerts = migrateIncomeAlerts({ incomeAlerts: [{ label: 'Mine', amount: 500000, period: 'annual', enabled: true }], taxWall88k: false });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].label, 'Mine');
});

test('1.1.x stores with a dated raise keep the old rate before the date and the new one after', () => {
    const legacyStore = {
        id: 'store-1', name: 'Cafe Test', aliases: ['Cafe Test', 'カフェ', 'CT'], shortName: 'CT', colorClass: 'store-0',
        baseWage: 1460, morningWage: 1600, eveningWage: 1530, nightWage: 1825, holidayBonus: 50, commutingAllowance: 0,
        effectiveFrom: '2026-05-21',
        wageBands: [
            { effectiveFrom: '0000-01-01', baseWage: 1370, morningWage: 1510, eveningWage: 1440, nightWage: 1720, holidayBonus: 50, commutingAllowance: 0 },
            { effectiveFrom: '2026-05-21', baseWage: 1460, morningWage: 1600, eveningWage: 1530, nightWage: 1825, holidayBonus: 50, commutingAllowance: 0 }
        ]
    };
    const settings = { baseWage: 1, morningWage: 1, eveningWage: 1, nightWage: 1, holidayBonus: 0, commutingAllowance: 0, storeConfigs: normalizeStoreConfigs([legacyStore]) };
    assert.equal(getStoreWageBand(settings, 'カフェ', '2026-05-20').baseWage, 1370);
    assert.equal(getStoreWageBand(settings, 'CT', '2026-05-21').baseWage, 1460);
    assert.equal(settings.storeConfigs[0].aliases.length, 3);
});
