import { GoogleGenAI } from '@google/genai';
import { Shift, StoreConfig, normalizeStoreConfigs } from './data';
import * as fs from 'fs';

export class AIParser {
    private ai: GoogleGenAI;
    private storeConfigs: StoreConfig[];

    private get parsePrompt(): string {
        const storeLines = this.storeConfigs.map(store =>
            `- "${store.name}" aliases: ${store.aliases.map(alias => `"${alias}"`).join(', ')}`
        ).join('\n');

        return `
    You are a helpful assistant that extracts shift schedule information from images.
    The images contain a table or handwritten notes with shift schedules.
    The primary store is "まいばすけっと" (Mai Basket).
    Known stores and aliases:
    ${storeLines}
    
    Please extract the shift data and output it as a pure JSON array of objects.
    Each object must have the following string keys strictly formatted:
    - "date": The date of the shift in "YYYY-MM-DD" format. If the year is not present, assume 2026.
    - "startTime": The start time in "HH:mm" 24-hour format.
    - "endTime": The end time in "HH:mm" 24-hour format.
    - "storeName": The name of the store, normalized to one of the known store names above.
    
    Example output format:
    [
      {
        "date": "2026-03-21",
        "startTime": "17:00",
        "endTime": "20:45",
        "storeName": "${this.storeConfigs[0]?.name || 'Store A'}"
      }
    ]
    
    Do not include markdown blocks like \`\`\`json in your response. Output *only* the raw JSON.
    `;
    }

    constructor(apiKey: string, storeConfigs: StoreConfig[] = []) {
        this.ai = new GoogleGenAI({ apiKey: apiKey });
        this.storeConfigs = normalizeStoreConfigs(storeConfigs);
    }

    private normalizeStoreName(rawStoreName: string): string {
        const normalized = (rawStoreName || '').trim();
        const match = this.storeConfigs.find(store =>
            store.name === normalized || store.aliases.includes(normalized)
        );
        return match?.name || normalized || this.storeConfigs[0].name;
    }

    /**
     * Parse an image from the local filesystem
     * @param imagePath Absolute path to the image
     * @param mimeType e.g., 'image/jpeg' or 'image/png'
     */
    public async parseLocalImage(imagePath: string, mimeType: string): Promise<Shift[]> {
        console.log(`Parsing image at path: ${imagePath}`);
        try {
            const imageBuffer = await fs.promises.readFile(imagePath);
            const base64Image = imageBuffer.toString('base64');
            
            const response = await this.ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [
                    {
                        role: 'user',
                        parts: [
                            { text: this.parsePrompt },
                            {
                                inlineData: {
                                    data: base64Image,
                                    mimeType: mimeType
                                }
                            }
                        ]
                    }
                ],
                config: {
                    temperature: 0.1,
                }
            });

            const textResponse = response.text;
            if (!textResponse) {
                throw new Error("No text response from Gemini.");
            }
            
            // Clean up potentially unformatted response
            const cleanedText = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsedData = JSON.parse(cleanedText);
            
            if (!Array.isArray(parsedData)) {
                throw new Error("Parsed data is not an array.");
            }
            
            const shifts: Shift[] = parsedData.map(item => ({
                id: crypto.randomUUID(), // Generate unique ID
                date: item.date,
                startTime: item.startTime,
                endTime: item.endTime,
                storeName: this.normalizeStoreName(item.storeName),
                // These will be calculated later
                calculatedWage: 0, 
                calculatedHours: 0
            }));
            
            return shifts;
        } catch (error) {
            console.error("Error parsing image with Gemini:", error);
            throw error;
        }
    }
    /**
     * Parse text directly using Gemini
     * @param text The text containing shift information
     */
    public async parseText(text: string): Promise<Shift[]> {
        console.log("Parsing text for shifts...");
        try {
            const response = await this.ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [
                    {
                        role: 'user',
                        parts: [
                            { text: this.parsePrompt },
                            { text: `Here is the text to parse: \n\n${text}` }
                        ]
                    }
                ],
                config: {
                    temperature: 0.1,
                }
            });

            const textResponse = response.text;
            if (!textResponse) {
                throw new Error("No text response from Gemini.");
            }
            
            const cleanedText = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsedData = JSON.parse(cleanedText);
            
            if (!Array.isArray(parsedData)) {
                throw new Error("Parsed data is not an array.");
            }
            
            return parsedData.map(item => ({
                id: crypto.randomUUID(),
                date: item.date,
                startTime: item.startTime,
                endTime: item.endTime,
                storeName: this.normalizeStoreName(item.storeName),
                calculatedWage: 0, 
                calculatedHours: 0
            }));
        } catch (error) {
            console.error("Error parsing text with Gemini:", error);
            throw error;
        }
    }
}
