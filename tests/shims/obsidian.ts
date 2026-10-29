// Tests run in Node, where the Obsidian app is not available. Only what the tested modules use.
// moment is installed with the obsidian package (its own dependency), the same library Obsidian ships.
import moment from 'moment';
export { moment };
export function requestUrl(): never {
    throw new Error('No network in tests.');
}
