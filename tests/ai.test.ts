import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error: the test shim, aliased to 'obsidian', adds a way to answer requests.
import { net } from 'obsidian';
import { AIParser } from '../src/aiParser';
import { collectCalendarSyncShifts } from '../src/calendarSyncPlanner';
import { cloneDefaultStoreConfigs, JapanWorkSecretaryData } from '../src/data';

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

test('rosters go to the chosen OpenAI-compatible service, with the key in a header', async () => {
    let seen: { url: string; headers: Record<string, string>; body?: string } | undefined;
    net.handler = (request: { url: string; headers: Record<string, string>; body?: string }) => {
        seen = request;
        // json_object mode: some services wrap the list in an object.
        return { status: 200, text: '', json: { choices: [{ message: { content: '{"shifts":[{"date":"2026-11-02","startTime":"9:00","endTime":"15:00","storeName":"X"}]}' } }] } };
    };
    const parser = new AIParser({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'TEST-KEY' }, cloneDefaultStoreConfigs());
    const drafts = await parser.parseText('11/2 9-15');
    net.handler = null;
    assert.equal(seen?.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(seen?.headers.Authorization, 'Bearer TEST-KEY');
    assert.ok(!seen?.url.includes('TEST-KEY'));
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].startTime, '09:00');
});

test('without a key nothing is sent', async () => {
    let calls = 0;
    net.handler = () => { calls++; return {}; };
    const parser = new AIParser({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '' });
    await assert.rejects(parser.parseText('x'), (e: Error) => /API key|API 密钥/.test(e.message));
    net.handler = null;
    assert.equal(calls, 0);
});

test('sample shifts are never synced to the calendar', () => {
    const data: JapanWorkSecretaryData = {
        shifts: [
            { id: 'a', date: '2026-11-02', startTime: '09:00', endTime: '15:00', storeName: 'S', calculatedHours: 6, calculatedWage: 1 },
            { id: 'sample-2026-11-03', date: '2026-11-03', startTime: '09:00', endTime: '15:00', storeName: 'Sample store', calculatedHours: 6, calculatedWage: 1, isSample: true }
        ],
        recurringShifts: [], shiftTemplates: [], exchangeRates: {}, calendarSyncState: {}, lastSyncTime: null
    } as unknown as JapanWorkSecretaryData;
    const synced = collectCalendarSyncShifts(data, '2026-11-01', '2026-11-30', true, () => { throw new Error('no recurring'); });
    assert.deepEqual(synced.map(s => s.id), ['a']);
});
