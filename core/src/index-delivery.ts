// Публичный вход ядра для сборки и запуска поставки (Node): список файлов и хешей встроенных плагинов (delivery.json). Только именованные экспорты; перечень сверяет core/test/public-api.test.ts.
export { DELIVERY_FILE, readDelivery, verifyDelivery, writeDelivery } from './delivery.ts';

export type { DeliveryManifest } from './delivery.ts';
