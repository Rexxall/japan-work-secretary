import { defaultModel, getProvider, resolveProvider, slotFromEndpoint, type AiSlot, type KeyStore } from '../vendor/rex-ai-kit/index';

/** What a new install, or one that never set up AI, starts with. */
export const DEFAULT_AI: AiSlot = { provider: 'openai', model: 'gpt-6-luna' };

/** AI fields before 1.9.0, read only here. */
export interface LegacyAiSettings {
    /** Before 1.5.0 the only service was Gemini, with its key under this name. */
    geminiSecretName?: string;
    aiProvider?: string;
    aiBaseUrl?: string;
    aiModel?: string;
    aiSecretName?: string;
}

const LEGACY_FIELDS: (keyof LegacyAiSettings)[] = ['geminiSecretName', 'aiProvider', 'aiBaseUrl', 'aiModel', 'aiSecretName'];

/**
 * The old service, address, model and Keychain name as one slot. Nothing set up (no key name, model or
 * address) starts on the new default. A key name the user typed is kept, so nothing has to be re-entered.
 * Pure; removes the old fields from `saved`.
 */
export function migrateAiSettings(saved: LegacyAiSettings & { ai?: AiSlot }): AiSlot {
    const old = { ...saved };
    for (const field of LEGACY_FIELDS) delete saved[field];
    if (old.ai && typeof old.ai === 'object' && typeof old.ai.provider === 'string') return { ...old.ai };
    if (old.geminiSecretName && !old.aiSecretName) return withModel(slotFromEndpoint({ provider: 'gemini', secretName: old.geminiSecretName }));
    if (!old.aiSecretName?.trim() && !old.aiModel?.trim() && !old.aiBaseUrl?.trim()) return { ...DEFAULT_AI };
    return withModel(slotFromEndpoint({ url: old.aiBaseUrl, provider: old.aiProvider, model: old.aiModel, secretName: old.aiSecretName }));
}

/** An empty model meant "the service's suggested one"; write that down. */
function withModel(slot: AiSlot): AiSlot {
    if (!slot.model) {
        const p = getProvider(slot.provider);
        if (p) slot.model = defaultModel(p, 'cheap');
    }
    return slot;
}

/** A saved Keychain name that holds nothing, while the shared name does, is dropped so the shared key is used. */
export function preferReadableKey(slot: AiSlot, store: Pick<KeyStore, 'getSecret'>): boolean {
    const shared = resolveProvider({ provider: slot.provider }).secretName;
    if (!slot.secretName || !shared || read(store, slot.secretName) || !read(store, shared)) return false;
    delete slot.secretName;
    return true;
}

function read(store: Pick<KeyStore, 'getSecret'>, name: string): string {
    try {
        return store.getSecret(name)?.trim() ?? '';
    } catch {
        return '';
    }
}
