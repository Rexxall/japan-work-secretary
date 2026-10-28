import { requestUrl } from 'obsidian';
import { Shift, StoreConfig, normalizeStoreConfigs } from './data';

const GEMINI_MODEL = 'gemini-2.5-flash';

/** Fields the model is asked for; everything else is worked out locally. */
export interface ParsedShiftDraft {
    date: string;
    startTime: string;
    endTime: string;
    storeName: string;
}

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

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

    constructor(private apiKey: string, storeConfigs: StoreConfig[] = [], private now: Date = new Date()) {
        if (!apiKey) throw new Error('Add a Gemini API key in settings first.');
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
    public async parseImage(base64Image: string, mimeType: string): Promise<ParsedShiftDraft[]> {
        return this.generate([{ text: this.parsePrompt }, { inlineData: { data: base64Image, mimeType } }]);
    }

    public async parseText(text: string): Promise<ParsedShiftDraft[]> {
        return this.generate([{ text: this.parsePrompt }, { text: `Here is the text to parse:\n\n${text}` }]);
    }

    private async generate(parts: GeminiPart[]): Promise<ParsedShiftDraft[]> {
        // The key goes in a header, never in the URL, so it does not end up in logs or error messages.
        const response = await requestUrl({
            url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
            method: 'POST',
            contentType: 'application/json',
            headers: { 'x-goog-api-key': this.apiKey },
            body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } }),
            throw: false
        });
        if (response.status >= 400) {
            let detail: string | undefined;
            try { detail = (response.json as { error?: { message?: string } } | undefined)?.error?.message; } catch { detail = undefined; }
            throw new Error(`Gemini request failed (${response.status})${detail ? `: ${detail}` : ''}`);
        }
        const body = response.json as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const reply = (body.candidates?.[0]?.content?.parts ?? []).map(part => part.text ?? '').join('');
        if (!reply) throw new Error('Gemini returned no text.');
        return parseShiftReply(reply, name => this.normalizeStoreName(name));
    }
}
