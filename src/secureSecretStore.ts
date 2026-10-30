import { execFile } from './shell';

const SERVICE_NAME = 'obsidian-japan-work-secretary';
const GEMINI_ACCOUNT = 'gemini-api-key';

function runSecurity(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('/usr/bin/security', args, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr.trim() || error.message));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

/** Read-only: used once to move a key saved by versions before 1.4.0 into Obsidian's secret storage. */
export class SecureSecretStore {
    public static async getGeminiApiKey(): Promise<string> {
        return runSecurity(['find-generic-password', '-s', SERVICE_NAME, '-a', GEMINI_ACCOUNT, '-w']);
    }

}
