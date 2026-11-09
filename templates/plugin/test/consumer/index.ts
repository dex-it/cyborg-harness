import type { PluginModule } from '@cyborg-harness/contracts';

// Потребитель контракта example.greeting: плагин только для теста, в поставку он не входит (каталог test/ сборка и проверка пропускают).
const consumer: PluginModule = {
  activate(ctx) {
    ctx.commands.register('consumer.ask', async (name) => {
      const greeting = ctx.contracts.get('example.greeting', 1);
      if (!greeting) throw new Error('поставщика example.greeting нет');
      return greeting.greet(String(name));
    });
    return undefined;
  },
};

export default consumer;
