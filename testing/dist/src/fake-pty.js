/** Псевдотерминал без ОС: тест сам пишет вывод и завершает процесс. */
export function fakePty() {
    const procs = [];
    return {
        procs,
        spawn(file, args, options) {
            const data = new Set();
            const exits = new Set();
            const proc = {
                pid: 1000 + procs.length,
                file,
                args,
                options,
                writes: [],
                resizes: [],
                onData: (l) => (data.add(l), { dispose: () => data.delete(l) }),
                onExit: (l) => (exits.add(l), { dispose: () => exits.delete(l) }),
                write: (d) => void proc.writes.push(d),
                resize: (c, r) => void proc.resizes.push([c, r]),
                kill(signal) {
                    proc.killed = signal ?? 'SIGHUP';
                },
                emit: (d) => {
                    for (const l of data)
                        l(d);
                },
                exit: (code) => {
                    for (const l of exits)
                        l({ exitCode: code });
                },
            };
            procs.push(proc);
            // Вывод сразу после запуска: проверяет, что хост не теряет его до подписки плагина.
            setImmediate(() => proc.emit('$ '));
            return proc;
        },
    };
}
