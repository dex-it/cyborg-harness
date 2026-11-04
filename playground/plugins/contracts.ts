declare module '@cyborg/contracts' {
  interface Contracts {
    'demo.echo': { 1: Echo };
  }
}

export interface Echo {
  say(text: string): Promise<string>;
}
