import { CustomNetwork } from './CustomNetwork';
import { Plugin } from './Plugin';

export interface Config {
    /**
     * Optional array of plugins to extend or customize the behavior.
     * Plugins can provide additional tooling.
     *
     * @example
     * import { Config } from '@ton-ai-core/blueprint';
     * import { ScaffoldPlugin } from 'blueprint-scaffold';
     *
     * export const config: Config = {
     *     plugins: [new ScaffoldPlugin()],
     * };
     */
    plugins?: Plugin[];

    /**
     * Specifies the target network for deployment or interaction.
     *
     * @example Custom network
     * import { Config } from '@ton-ai-core/blueprint';
     *
     * export const config: Config = {
     *     network: {
     *         endpoint: 'https://toncenter.com/api/v2/jsonRPC',
     *         type: 'mainnet',
     *         version: 'v2',
     *         key: 'YOUR_API_KEY',
     *     },
     * };
     */
    network?: 'mainnet' | 'testnet' | CustomNetwork;

    /**
     * If true, keeps compilable files (`*.compile.ts`) in a separate directory `compilables`.
     * When false or unset, compilables are stored in `wrappers` directory.
     *
     * @default false
     */
    separateCompilables?: boolean;

    /**
     * HTTP request timeout in milliseconds.
     *
     * @example
     * export const config: Config = {
     *     requestTimeout: 10000 // 10 seconds
     * };
     */
    requestTimeout?: number;

    /**
     * If true, the `wrappers`/`compilables` directory will be searched recursively for contracts.
     *
     * @default false
     */
    recursiveWrappers?: boolean;

    /**
     * Custom manifest URL for TonConnect provider.
     *
     * @example
     * export const config: Config = {
     *     manifestUrl: 'https://yourdomain.com/custom-manifest.json',
     * };
     *
     * @default https://raw.githubusercontent.com/ton-ai-core/blueprint2/main/tonconnect/manifest.json
     */
    manifestUrl?: string;
}
