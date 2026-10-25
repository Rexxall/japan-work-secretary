import { execFile } from 'child_process';

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

export class SecureSecretStore {
    public static async getGeminiApiKey(): Promise<string> {
        return runSecurity(['find-generic-password', '-s', SERVICE_NAME, '-a', GEMINI_ACCOUNT, '-w']);
    }

    public static async setGeminiApiKey(apiKey: string): Promise<void> {
        await runSecurity([
            'add-generic-password',
            '-s', SERVICE_NAME,
            '-a', GEMINI_ACCOUNT,
            '-w', apiKey,
            '-U'
        ]);
    }

    public static async deleteGeminiApiKey(): Promise<void> {
        await runSecurity(['delete-generic-password', '-s', SERVICE_NAME, '-a', GEMINI_ACCOUNT]);
    }
}
