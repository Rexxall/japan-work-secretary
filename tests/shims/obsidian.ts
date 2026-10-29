// Tests run in Node, where the Obsidian app is not available. Only what the tested modules use.
// moment is installed with the obsidian package (its own dependency), the same library Obsidian ships.
import moment from 'moment';
export { moment };
export function getLanguage(): string {
    return 'en';
}
/** Tests that need a reply set `net.handler`; otherwise there is no network. */
export const net: { handler: null | ((request: { url: string; method: string; headers: Record<string, string>; body?: string }) => unknown) } = { handler: null };
export function requestUrl(request: { url: string; method: string; headers: Record<string, string>; body?: string }): Promise<unknown> {
    if (!net.handler) throw new Error('No network in tests.');
    return Promise.resolve(net.handler(request));
}
