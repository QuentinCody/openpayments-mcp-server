/**
 * Chunking engine for storing large content in SQLite-backed Durable Objects.
 *
 * Splits large JSON/text content into 16KB chunks stored in SQLite tables,
 * returning a compact reference string instead of the raw content.
 */
export interface ChunkMetadata {
    contentId: string;
    totalChunks: number;
    originalSize: number;
    contentType: "json" | "text";
    compressed: boolean;
}
export interface SqlExec {
    exec: (query: string, ...bindings: unknown[]) => {
        toArray(): Array<Record<string, unknown>>;
        one?: () => Record<string, unknown> | undefined;
    };
}
export declare class ChunkingEngine {
    private readonly CHUNK_SIZE_THRESHOLD;
    private readonly CHUNK_SIZE;
    shouldChunk(content: string): boolean;
    isContentReference(value: unknown): boolean;
    extractContentId(reference: string): string;
    createContentReference(metadata: ChunkMetadata): string;
    smartJsonStringify(obj: unknown, sql: SqlExec): Promise<string>;
    smartJsonParse(value: string, sql: SqlExec): Promise<unknown>;
    private generateContentId;
    private splitIntoChunks;
    private ensureTables;
    storeChunkedContent(content: string, contentType: "json" | "text", sql: SqlExec): Promise<ChunkMetadata>;
    retrieveChunkedContent(contentId: string, sql: SqlExec): Promise<string | null>;
}
//# sourceMappingURL=chunking.d.ts.map