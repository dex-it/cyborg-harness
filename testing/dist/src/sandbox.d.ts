export interface Sandbox {
    /** Каталог после `realpath`: шлюз `ctx.os` отдаёт пути именно так. */
    readonly root: string;
    /** Путь внутри песочницы. */
    path(...parts: string[]): string;
    [Symbol.asyncDispose](): Promise<void>;
}
/** Временный каталог, снимаемый через `await using`. На macOS `tmpdir()` - симлинк `/var` -> `/private/var`, поэтому без `realpath` пути не совпали бы с областями шлюза. */
export declare function sandbox(prefix?: string): Promise<Sandbox>;
