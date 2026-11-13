declare module '@cyborg-harness/contracts' {
  interface Contracts {
    'trust.vault': { 1: TrustVault };
  }
}

/** Контракт пробы доверия (TR-01): поставщик отдаёт данные полем `token` и методом `read`; сторонний плагин потребителем не объявлен. */
export interface TrustVault {
  readonly token: string;
  read(): Promise<string>;
}

/** Данные поставщика, которые чужому хосту видеть не нужно: проба ищет их в «сыром» канале нарушителя. */
export const VAULT_TOKEN = 'vault-data-of-bystander';
