// Потребитель из другого хоста: зовёт echo через границу процессов и пишет в лог, когда поставщик пропадает и возвращается.
export default {
  async activate(ctx) {
    const echo = () => ctx.contracts.get('demo.echo');
    ctx.log(`ответ: ${await echo().say('привет')}, probe в ${process.pid}`);
    ctx.contracts.onChange('demo.echo', () => ctx.log(`echo ${echo() ? 'вернулся' : 'пропал'}`));
  },
};
