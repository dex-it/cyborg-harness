import { claimInstance } from '../../src/instance.ts';

/**
 * Участник гонки за экземпляр в отдельном процессе: `node instance-claimer.ts <каталог> <ключ> <метка>`.
 * Пишет в stdout `owner` или `handed`/`unresponsive`; владелец живёт, пока родитель не закроет stdin, и печатает каждый запрос от соседа.
 */
const [dir, key, label] = process.argv.slice(2) as [string, string, string];
const claim = await claimInstance(key, { from: label }, (asked) => process.stdout.write(`asked ${JSON.stringify(asked)}\n`), { dir, askTimeoutMs: 3000 });
process.stdout.write(`${claim.kind}\n`);
if (claim.kind === 'owner') {
  process.stdin.resume();
  process.stdin.on('end', () => {
    claim.close();
    process.exit(0);
  });
} else {
  process.exit(0);
}
