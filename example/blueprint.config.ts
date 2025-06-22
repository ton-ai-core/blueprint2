import { Config } from '@ton-ai-core/blueprint';
import { MistiPlugin } from '@ton-ai-core/blueprint-misti';
import { SandboxPlugin } from '@ton-ai-core/blueprint-sandbox';

export const config: Config = {
  plugins: [
    new MistiPlugin(),
    new SandboxPlugin(),
  ],
}; 