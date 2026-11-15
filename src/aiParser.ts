import { Shift, StoreConfig, normalizeStoreConfigs } from './data';
import { AiError } from './ai/kit';
import type { AiClient, AiSlot, ContentPart } from './vendor/rex-ai-kit/index';
import { getProvider } from './vendor/rex-ai-kit/index';

/** Fields the model is asked for; everything else is worked out locally. */
export interface ParsedShiftDraft {
    date: string;
    startTime: string;
    endTime: string;
    storeName: string;
}

/**
 * Turn the model's reply into shift drafts. Rows with a malformed date or time are
 * dropped rather than guessed, because a wrong shift is worse than a missing one.
 */
export function parseShiftReply(reply: string, normalizeStoreName: (name: string) => string): ParsedShiftDraft[] {
    const cleaned = reply.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed: unknown = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error('The reply was not a list of shifts.');
    const drafts: ParsedShiftDraft[] = [];
    for (const item of parsed as unknown[]) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const date = typeof row.date === 'string' ? row.date.trim() : '';
        const startTime = typeof row.startTime === 'string' ? row.startTime.trim().padStart(5, '0') : '';
        const endTime = typeof row.endTime === 'string' ? row.endTime.trim().padStart(5, '0') : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) continue;
        drafts.push({ date, startTime, endTime, storeName: normalizeStoreName(typeof row.storeName === 'string' ? row.storeName : '') });
    }
    return drafts;
}

export function draftToShift(draft: ParsedShiftDraft): Shift {
    return { id: crypto.randomUUID(), ...draft, calculatedWage: 0, calculatedHours: 0 };
}

export class AIParser {
    private storeConfigs: StoreConfig[];

    constructor(private client: AiClient, private slot: AiSlot, storeConfigs: StoreConfig[] = [], private now: Date = new Date()) {
        this.storeConfigs = normalizeStoreConfigs(storeConfigs);
    }

    private get parsePrompt(): string {
        const storeLines = this.storeConfigs.map(store =>
            `- "${store.name}" aliases: ${store.aliases.map(alias => `"${alias}"`).join(', ')}`
        ).join('\n');

        return `
    You extract part-time shift schedules from a message, a table or a photo of a roster.
    Known stores and aliases:
    ${storeLines}

    Output a JSON object {"shifts": [ … ]} whose items have these string keys:
    - "date": "YYYY-MM-DD". If the year is missing, assume ${this.now.getFullYear()}.
    - "startTime": "HH:mm", 24-hour.
    - "endTime": "HH:mm", 24-hour.
    - "storeName": one of the known store names above.

    Example:
    {"shifts": [{ "date": "${this.now.getFullYear()}-03-21", "startTime": "17:00", "endTime": "20:45", "storeName": "${this.storeConfigs[0]?.name || 'Store A'}" }]}

    Output only the JSON, without code fences. If there are no shifts, output {"shifts": []}.
    `;
    }

    private normalizeStoreName(rawStoreName: string): string {
        const normalized = (rawStoreName || '').trim();
        const match = this.storeConfigs.find(store =>
            store.name === normalized || store.aliases.includes(normalized)
        );
        return match?.name || normalized || this.storeConfigs[0].name;
    }

    /** Parse an image already read from the vault, as base64. */
    public async parseImage(base64Image: string, mimeType: string, signal?: AbortSignal): Promise<ParsedShiftDraft[]> {
        return this.generate([{ type: 'text', text: this.parsePrompt }, { type: 'image', mime: mimeType, data: base64Image }], signal);
    }

    public async parseText(text: string, signal?: AbortSignal): Promise<ParsedShiftDraft[]> {
        return this.generate(`${this.parsePrompt}\n\nHere is the text to parse:\n\n${text}`, signal);
    }

    private async generate(content: string | ContentPart[], signal?: AbortSignal): Promise<ParsedShiftDraft[]> {
        const local = !!getProvider(this.slot.provider)?.localAgent;
        const reply = await this.client.complete(this.slot, { messages: [{ role: 'user', content }], json: true, signal, timeoutMs: local ? 180_000 : 90_000 });
        const provider = this.client.provider(this.slot).name;
        return parseShiftReply(JSON.stringify(parseJsonArray(reply.text, provider)), name => this.normalizeStoreName(name));
    }
}

/** Strips code fences and pulls the first JSON array out of a reply, bare or wrapped in an object. */
export function parseJsonArray(reply: string, provider?: string): unknown[] {
    const cleaned = reply.replace(/```(?:json)?/g, '').trim();
    const bad = () => new AiError('Unreadable reply', 'bad-response', undefined, undefined, provider);
    let parsed: unknown;
    try { parsed = JSON.parse(cleaned); } catch { throw bad(); }
    if (Array.isArray(parsed)) return parsed as unknown[];
    if (parsed && typeof parsed === 'object') {
        const inner = Object.values(parsed).find((v): v is unknown[] => Array.isArray(v));
        return inner ?? [parsed];
    }
    throw bad();
}
