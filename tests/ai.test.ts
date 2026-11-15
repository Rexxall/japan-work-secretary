import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error: the test shim, aliased to 'obsidian', adds a way to answer requests.
import { net } from 'obsidian';
import { AIParser } from '../src/aiParser';
import { DEFAULT_AI, migrateAiSettings, preferReadableKey } from '../src/ai/migrate';
import { createAiClient, describeAiError } from '../src/ai/kit';
import { collectCalendarSyncShifts } from '../src/calendarSyncPlanner';
import { cloneDefaultStoreConfigs, JapanWorkSecretaryData } from '../src/data';

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

type Seen = { url: string; headers: Record<string, string>; body?: string };
const keys = (map: Record<string, string>) => ({ getSecret: (n: string) => map[n] ?? null });
const reply = (content: string) => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content } }] }) });

test('rosters go to the chosen service, with the key read from the Keychain into a header', async () => {
    let seen: Seen | undefined;
    net.handler = (request: Seen) => {
        seen = request;
        return reply('{"shifts":[{"date":"2026-11-02","startTime":"9:00","endTime":"15:00","storeName":"X"}]}');
    };
    const client = createAiClient(keys({ 'deepseek-api-key': 'TEST-KEY' }), undefined);
    const drafts = await new AIParser(client, { provider: 'deepseek', model: 'deepseek-flash' }, cloneDefaultStoreConfigs()).parseText('11/2 9-15');
    net.handler = null;
    assert.equal(seen?.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(seen?.headers.Authorization, 'Bearer TEST-KEY');
    assert.ok(!seen?.url.includes('TEST-KEY'));
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].startTime, '09:00');
});

test('a key name the user typed is still read; Anthropic gets its own API', async () => {
    let seen: Seen | undefined;
    net.handler = (request: Seen) => {
        seen = request;
        return { status: 200, text: JSON.stringify({ content: [{ type: 'text', text: '{"shifts":[]}' }] }) };
    };
    const client = createAiClient(keys({ claude: 'A-KEY' }), undefined);
    await new AIParser(client, { provider: 'anthropic', model: 'claude-haiku-5-5', secretName: 'claude' }).parseText('x');
    net.handler = null;
    assert.equal(seen?.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(seen?.headers['x-api-key'], 'A-KEY');
});

test('without a key nothing is sent, and the message says what to do', async () => {
    let calls = 0;
    net.handler = () => { calls++; return {}; };
    const client = createAiClient(keys({}), undefined);
    const err: unknown = await new AIParser(client, { provider: 'openai', model: 'gpt-6-luna' }).parseText('x').catch((e: unknown) => e);
    net.handler = null;
    assert.equal(calls, 0);
    assert.match(describeAiError(err), /^OpenAI: No API key selected\. Pick one from the Keychain/);
});

test('settings before 1.9.0 become one slot', () => {
    // Never set up (the shape in daily use): the new default.
    const unset = { aiProvider: 'deepseek', aiBaseUrl: '', aiModel: '', aiSecretName: '', calendarName: 'Work' };
    assert.deepEqual(migrateAiSettings(unset), DEFAULT_AI);
    assert.deepEqual(Object.keys(unset), ['calendarName'], 'old fields are removed');
    // A service the user set up keeps its key name, model and proxy address.
    assert.deepEqual(migrateAiSettings({ aiProvider: 'deepseek', aiBaseUrl: '', aiModel: 'deepseek-v4-pro', aiSecretName: 'my-deepseek' }), { provider: 'deepseek', model: 'deepseek-v4-pro', secretName: 'my-deepseek' });
    assert.deepEqual(migrateAiSettings({ aiProvider: 'custom', aiBaseUrl: 'http://localhost:2048/v1', aiModel: 'm', aiSecretName: 'proxy' }), { provider: 'custom', model: 'm', secretName: 'proxy', baseUrl: 'http://localhost:2048/v1' });
    // Shared key names are not stored twice; an empty model gets the provider's pick.
    assert.deepEqual(migrateAiSettings({ aiProvider: 'gemini', aiBaseUrl: '', aiModel: '', aiSecretName: 'gemini-api-key' }), { provider: 'gemini', model: 'gemini-3.5-flash-lite' });
    // Before 1.5.0: Gemini only.
    assert.deepEqual(migrateAiSettings({ geminiSecretName: 'old-gemini' }), { provider: 'gemini', model: 'gemini-3.5-flash-lite', secretName: 'old-gemini' });
    // Already new: unchanged.
    assert.deepEqual(migrateAiSettings({ ai: { provider: 'codex', model: 'gpt-6-luna' } }), { provider: 'codex', model: 'gpt-6-luna' });
});

test('a key name that holds nothing falls back to the shared key; a readable one is kept', () => {
    const slot = { provider: 'openai', model: 'gpt-6-luna', secretName: 'gone' };
    assert.equal(preferReadableKey(slot, keys({ 'openai-api-key': 'k' })), true);
    assert.equal(slot.secretName, undefined);
    const kept = { provider: 'openai', model: 'gpt-6-luna', secretName: 'mine' };
    assert.equal(preferReadableKey(kept, keys({ mine: 'x', 'openai-api-key': 'k' })), false);
    assert.equal(kept.secretName, 'mine');
});

test('a photo sent to a program on this computer is refused before it runs, with the next step', async () => {
    const client = createAiClient(keys({}), undefined);
    const err: unknown = await new AIParser(client, { provider: 'claude-code', model: 'haiku' }).parseImage('AAAA', 'image/png').catch((e: unknown) => e);
    assert.match(describeAiError(err), /computer|Obsidian on a computer|images/);
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
