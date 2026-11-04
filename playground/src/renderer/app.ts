import type { PlaygroundApi } from '../main/preload.ts';
import { PluginsPanel } from './plugins-panel.ts';

const api = (window as unknown as { playground: PlaygroundApi }).playground;
void new PluginsPanel(api).refresh();
