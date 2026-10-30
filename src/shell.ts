import { execFile as nodeExecFile } from 'child_process';

/**
 * Node's execFile, typed for the one way this plugin calls it: a fixed macOS binary, an argument list and text output.
 * Node's typings are a dev dependency, so the signature is spelled out here.
 */
export type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
export type ExecFile = (file: string, args: string[], callback: ExecFileCallback) => unknown;

export const execFile = nodeExecFile as unknown as ExecFile;

/** Fails the build if Node's execFile stops accepting this call. */
export type ExecFileShapeCheck = typeof nodeExecFile extends ExecFile ? true : never;
export const execFileShapeMatches: ExecFileShapeCheck = true;
