/**
 * У stdout и stderr приложения может пропасть читатель (закрыли терминал, вышел скрипт, запустивший приложение):
 * запись журнала тогда падает с EPIPE, и Electron показывает окно «Uncaught Exception» на каждый такой процесс.
 * Журналу окно ошибки не нужно: EPIPE глотаем, остальные ошибки канала не прячем.
 */
export function quietPipes(streams: readonly NodeJS.WritableStream[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') throw error;
    });
  }
}
