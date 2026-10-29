import { Shift, StoreConfig, normalizeStoreConfigs } from './data';
import { AiTarget, CancelToken, ChatInput, chat, parseJsonArray } from './ai/providers';

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

    constructor(private target: AiTarget, storeConfigs: StoreConfig[] = [], private now: Date = new Date()) {
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

    Output a pure JSON array of objects with these string keys:
    - "date": "YYYY-MM-DD". If the year is missing, assume ${this.now.getFullYear()}.
    - "startTime": "HH:mm", 24-hour.
    - "endTime": "HH:mm", 24-hour.
    - "storeName": one of the known store names above.

    Example:
    [{ "date": "${this.now.getFullYear()}-03-21", "startTime": "17:00", "endTime": "20:45", "storeName": "${this.storeConfigs[0]?.name || 'Store A'}" }]

    Output only the JSON, without code fences. If there are no shifts, output [].
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
    public async parseImage(base64Image: string, mimeType: string, token?: CancelToken): Promise<ParsedShiftDraft[]> {
        return this.generate({ prompt: this.parsePrompt, image: { data: base64Image, mimeType }, json: true }, token);
    }

    public async parseText(text: string, token?: CancelToken): Promise<ParsedShiftDraft[]> {
        return this.generate({ prompt: `${this.parsePrompt}\n\nHere is the text to parse:\n\n${text}`, json: true }, token);
    }

    private async generate(input: ChatInput, token?: CancelToken): Promise<ParsedShiftDraft[]> {
        const reply = await chat(this.target, input, 90000, token);
        // json_object mode makes some services wrap the list in an object.
        return parseShiftReply(JSON.stringify(parseJsonArray(reply)), name => this.normalizeStoreName(name));
    }
}
