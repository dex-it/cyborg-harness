import type { PtyBackend, PtyProcess } from '@cyborg-harness/core';
export interface FakeProc extends PtyProcess {
    readonly file: string;
    readonly args: string[];
    readonly options: {
        cwd?: string;
        env: Record<string, string>;
        cols: number;
        rows: number;
    };
    readonly writes: string[];
    readonly resizes: [number, number][];
    killed?: string;
    emit(data: string): void;
    exit(code: number): void;
}
export type FakePty = PtyBackend & {
    procs: FakeProc[];
};
/** Псевдотерминал без ОС: тест сам пишет вывод и завершает процесс. */
export declare function fakePty(): FakePty;
