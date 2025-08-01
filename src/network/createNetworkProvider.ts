import path from 'path';

import arg from 'arg';
import {
    Address,
    Cell,
    comment,
    Contract,
    ContractProvider,
    ContractState,
    Dictionary,
    loadMessage,
    openContract,
    OpenedContract,
    Sender,
    SenderArguments,
    SendMode,
    Slice,
    StateInit,
    toNano,
    Transaction,
    TupleItem,
} from '@ton/core';
import { parseFullConfig, TonClient, TonClient4 } from '@ton/ton';
import { ContractAdapter } from '@ton-api/ton-adapter';
import { TonApiClient } from '@ton-api/client';
import { mnemonicToPrivateKey } from '@ton/crypto';
import axios, { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { LiteClient, LiteRoundRobinEngine, LiteSingleEngine } from 'ton-lite-client';

import {
    getExplorerLink,
    getTransactionLink,
    getNormalizedExtMessageHash,
    oneOrZeroOf,
    sleep,
    getExplorerTxLink,
} from '../utils';
import { DeeplinkProvider } from './send/DeeplinkProvider';
import { TonConnectProvider } from './send/TonConnectProvider';
import { UIProvider } from '../ui/UIProvider';
import { BlueprintTonClient, NetworkProvider, SenderWithSendResult } from './NetworkProvider';
import { SendProvider } from './send/SendProvider';
import { FSStorage } from './storage/FSStorage';
import { TEMP_DIR } from '../paths';
import { MnemonicProvider } from './send/MnemonicProvider';
import { Config } from '../config/Config';
import { CustomNetwork } from '../config/CustomNetwork';
import { Network } from './Network';
import { WalletVersion } from './send/wallets';

const TONAPI_MAINNET = 'https://tonapi.io';
const TONAPI_TESTNET = 'https://testnet.tonapi.io';
const MAX_TONAPI_ATTEMPTS = 5;

const INITIAL_DELAY = 400;
const MAX_ATTEMPTS = 4;
const CONFIG_ADDRESS = Address.parse('-1:5555555555555555555555555555555555555555555555555555555555555555');

export const argSpec = {
    '--mainnet': Boolean,
    '--testnet': Boolean,
    '--custom': String,
    '--custom-type': String,
    '--custom-version': String,
    '--custom-key': String,

    '--tonconnect': Boolean,
    '--deeplink': Boolean,
    '--mnemonic': Boolean,

    '--tonscan': Boolean,
    '--tonviewer': Boolean,
    '--toncx': Boolean,
    '--dton': Boolean,
};

export type Args = arg.Result<typeof argSpec>;

type Explorer = 'tonscan' | 'tonviewer' | 'toncx' | 'dton';

type ContractProviderFactory = (params: { address: Address; init?: StateInit | null }) => ContractProvider;

// Расширяем тип ContractAdapter, добавляя отсутствующие свойства
interface ExtendedTonApiClient {
    blockchain: {
        getAccountTransactions: (
            address: string,
            options: { limit: number },
        ) => Promise<{ transactions: Array<Record<string, unknown>> }>;
    };
}

interface ExtendedContractAdapter extends ContractAdapter {
    client: ExtendedTonApiClient;
}

// Изменяем подход к типизации TonClient, вместо расширения интерфейса используем привидение типа
type _TransactionOptions = {
    limit: number;
    lt?: string;
    hash?: string;
    to_lt?: string;
    inclusive?: boolean;
    archival?: boolean;
};

// Определяем структуру для fees
interface TransactionFees {
    gas_fee?: string | bigint;
    storage_fee?: string | bigint;
    forward_fee?: string | bigint;
    total_fee?: string | bigint;
    total_fees?: string | bigint;
}

// Определяем минимальную структуру транзакции
type TransactionType = {
    hash?: string | (() => Buffer<ArrayBufferLike>);
    transaction_id?: { hash: string | (() => Buffer<ArrayBufferLike>); lt: string | bigint | (() => bigint) };
    lt?: string | bigint | (() => bigint);
    utime?: number;
    timestamp?: number;
    total_fees?: string | bigint;
    fees?: TransactionFees;
    status?: string;
    compute?: {
        exit_code?: number;
        exit_arg?: number | string;
        gas_used?: number | string;
        vm_steps?: number | string;
    };
    success?: boolean;
    aborted?: boolean;
};

class SendProviderSender implements SenderWithSendResult {
    #provider: SendProvider;
    readonly address?: Address;

    #lastSendResult?: unknown;
    get lastSendResult() {
        return this.#lastSendResult;
    }

    constructor(provider: SendProvider) {
        this.#provider = provider;
        this.address = provider.address();
    }

    async send(args: SenderArguments): Promise<void> {
        if (args.bounce !== undefined) {
            console.warn(
                "Warning: blueprint's Sender does not support `bounce` flag, because it is ignored by all used Sender APIs",
            );
            console.warn('To silence this warning, change your `bounce` flags passed to Senders to unset or undefined');
        }

        if (!(args.sendMode === undefined || args.sendMode === SendMode.PAY_GAS_SEPARATELY)) {
            throw new Error('Deployer sender does not support `sendMode` other than `PAY_GAS_SEPARATELY`');
        }

        this.#lastSendResult = await this.#provider.sendTransaction(
            args.to,
            args.value,
            args.body ?? undefined,
            args.init ?? undefined,
        );
    }
}

class WrappedContractProvider implements ContractProvider {
    #address: Address;
    #provider: ContractProvider;
    #init?: StateInit | null;
    #factory: ContractProviderFactory;

    constructor(address: Address, factory: ContractProviderFactory, init?: StateInit | null) {
        this.#address = address;
        this.#provider = factory({ address, init });
        this.#init = init;
        this.#factory = factory;
    }

    async getState() {
        return await this.#provider.getState();
    }

    async get(name: string, args: TupleItem[]) {
        return await this.#provider.get(name, args);
    }

    async external(message: Cell) {
        return await this.#provider.external(message);
    }

    async internal(
        via: Sender,
        args: {
            value: string | bigint;
            bounce: boolean | undefined | null;
            sendMode?: SendMode;
            body: string | Cell | undefined | null;
        },
    ) {
        const init = this.#init && (await this.getState()).state.type !== 'active' ? this.#init : undefined;

        return await via.send({
            to: this.#address,
            value: typeof args.value === 'string' ? toNano(args.value) : args.value,
            sendMode: args.sendMode,
            bounce: args.bounce,
            init,
            body: typeof args.body === 'string' ? comment(args.body) : args.body,
        });
    }

    open<T extends Contract>(contract: T): OpenedContract<T> {
        return openContract(
            contract,
            (params) => new WrappedContractProvider(params.address, this.#factory, params.init),
        );
    }

    getTransactions(address: Address, lt: bigint, hash: Buffer, limit?: number): Promise<Transaction[]> {
        return this.#provider.getTransactions(address, lt, hash, limit);
    }
}

class NetworkProviderImpl implements NetworkProvider {
    #tc: BlueprintTonClient;
    #sender: SenderWithSendResult;
    #network: Network;
    #explorer: Explorer;
    #ui: UIProvider;

    constructor(
        tc: BlueprintTonClient,
        sender: SenderWithSendResult,
        network: Network,
        explorer: Explorer,
        ui: UIProvider,
    ) {
        this.#tc = tc;
        this.#sender = sender;
        this.#network = network;
        this.#explorer = explorer;
        this.#ui = ui;
    }

    network(): 'mainnet' | 'testnet' | 'custom' {
        return this.#network;
    }

    explorer(): 'tonscan' | 'tonviewer' | 'toncx' | 'dton' {
        return this.#explorer;
    }

    sender(): SenderWithSendResult {
        return this.#sender;
    }

    api(): BlueprintTonClient {
        return this.#tc;
    }

    provider(address: Address, init?: StateInit | null): ContractProvider {
        const factory = (params: { address: Address; init?: StateInit | null }) =>
            this.#tc.provider(
                params.address,
                params.init && {
                    ...params.init,
                    data: params.init.data ?? undefined,
                    code: params.init.code ?? undefined,
                },
            );
        return new WrappedContractProvider(address, factory, init);
    }

    async isContractDeployed(address: Address): Promise<boolean> {
        return (await this.#tc.provider(address).getState()).state.type === 'active';
    }

    async verifyTransactionStatus(
        address: Address,
    ): Promise<{ success: boolean; error?: string; tx?: TransactionType }> {
        try {
            const client = this.#tc;
            let txs: TransactionType[] = [];
            let attempts = 0;
            const limit = 1;

            if (client instanceof ContractAdapter) {
                while (attempts < MAX_TONAPI_ATTEMPTS) {
                    try {
                        const extendedClient = client as ExtendedContractAdapter;
                        const resp = await extendedClient.client.blockchain.getAccountTransactions(address.toString(), {
                            limit,
                        });
                        txs = (resp.transactions as unknown as TransactionType[]) || [];
                        if (txs.length > 0) break;
                    } catch (_e) {
                        // Игнорируем ошибку и повторяем попытку
                    }
                    await sleep(2000);
                    attempts++;
                }
            } else if (client instanceof TonClient || client instanceof TonClient4) {
                while (attempts < MAX_TONAPI_ATTEMPTS) {
                    try {
                        // Вместо приведения типов используем проверенный метод с правильными аргументами
                        // TonClient и TonClient4 имеют разные сигнатуры для getTransactions
                        if (client instanceof TonClient) {
                            txs = (await client.getTransactions(address, {
                                limit,
                                // Другие параметры могут быть добавлены при необходимости
                            })) as unknown as TransactionType[];
                        } else {
                            // Для TonClient4 используем правильную сигнатуру метода
                            txs = (await (client as TonClient4).getAccountTransactions(
                                address,
                                0n,
                                Buffer.alloc(32),
                            )) as unknown as TransactionType[];
                        }
                        if (txs.length > 0) break;
                    } catch (_e) {
                        // Игнорируем ошибку и повторяем попытку
                    }
                    await sleep(2000);
                    attempts++;
                }
            } else {
                return { success: true };
            }

            if (txs.length > 0) {
                const tx = txs[0];
                const exitCode = tx.compute?.exit_code;
                const exitArg = tx.compute?.exit_arg;

                let txHash = tx.hash || tx.transaction_id?.hash;
                if (typeof txHash === 'function') {
                    try {
                        txHash = txHash().toString('hex');
                    } catch (_e) {
                        txHash = undefined;
                    }
                }

                let lt = tx.lt || tx.transaction_id?.lt;
                if (typeof lt === 'function') {
                    try {
                        lt = lt();
                    } catch (_e) {
                        lt = undefined;
                    }
                }

                const timestamp = tx.utime || tx.timestamp;
                const fees = tx.total_fees || tx.fees;
                const status = tx.status;
                let explorerTxLink = '';
                if (txHash && this.#network && this.#explorer) {
                    explorerTxLink = getExplorerTxLink(
                        typeof txHash === 'string' ? txHash : '',
                        this.#network,
                        this.#explorer,
                    );
                }
                if (
                    (typeof status === 'string' && status === 'failed') ||
                    (exitCode !== undefined && exitCode !== 0 && exitCode !== 1)
                ) {
                    let errorMsg = `Transaction failed.\n`;
                    errorMsg += `Exit code: ${exitCode ?? 'unknown'}\n`;
                    if (exitArg !== undefined) errorMsg += `Exit arg: ${exitArg}\n`;
                    if (status) errorMsg += `Status: ${status}\n`;
                    if (txHash) errorMsg += `Tx hash: ${txHash}\n`;
                    if (lt) errorMsg += `LT: ${lt}\n`;
                    if (timestamp) errorMsg += `Timestamp: ${new Date(timestamp * 1000).toISOString()}\n`;
                    if (fees) errorMsg += `Fees: ${JSON.stringify(fees)}\n`;
                    if (explorerTxLink) errorMsg += `Explorer: ${explorerTxLink}\n`;
                    return {
                        success: false,
                        error: errorMsg,
                        tx: tx,
                    };
                }
                return { success: true, tx: tx };
            }
            return { success: true };
        } catch (error) {
            console.warn('Failed to verify transaction status via TonClient/TonApiClient:', error);
            return { success: true };
        }
    }

    async getConfig(address: Address = CONFIG_ADDRESS) {
        const state = await this.getContractState(address);
        if (state.state.type !== 'active' || !state.state.data) {
            throw new Error('Configuration contract not active');
        }

        const paramsDict = Cell.fromBoc(state.state.data)[0]
            .beginParse()
            .loadRef()
            .beginParse()
            .loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());

        const params = new Map<number, Slice>();
        for (const [key, value] of paramsDict) {
            params.set(key, value.beginParse());
        }

        return parseFullConfig(params);
    }

    async getContractState(address: Address): Promise<ContractState> {
        return await this.#tc.provider(address).getState();
    }

    async waitForDeploy(address: Address, attempts: number = 20, sleepDuration: number = 2000) {
        if (attempts <= 0) {
            throw new Error('Attempt number must be positive');
        }

        for (let i = 1; i <= attempts; i++) {
            this.#ui.setActionPrompt(`Awaiting contract deployment... [Attempt ${i}/${attempts}]`);
            const isDeployed = await this.isContractDeployed(address);

            if (isDeployed) {
                this.#ui.setActionPrompt(`Contract detected. Waiting for transaction confirmation...`);
                await sleep(3000);

                const txStatus = await this.verifyTransactionStatus(address);

                if (!txStatus.success) {
                    this.#ui.clearActionPrompt();
                    this.#ui.write(`⚠️ Contract deployed but transaction failed:\n${txStatus.error}`);
                    throw new Error(`Transaction failed:\n${txStatus.error}`);
                }

                this.#ui.clearActionPrompt();
                this.#ui.write(`✅ Contract deployed at address ${address.toString()}`);
                this.#ui.write(
                    `You can view it at ${getExplorerLink(address.toString(), this.#network, this.#explorer)}`,
                );
                if (txStatus.tx) {
                    const tx = txStatus.tx;

                    let txHash = tx.hash || tx.transaction_id?.hash;
                    if (typeof txHash === 'function') {
                        try {
                            txHash = txHash().toString('hex');
                        } catch (_e) {
                            txHash = undefined;
                        }
                    }

                    // If we have the transaction hash, check its status directly via TonAPI
                    if (txHash) {
                        this.#ui.setActionPrompt(`Verifying transaction status...`);
                        const specificTxStatus = await this.verifyTransactionByHash(
                            typeof txHash === 'string' ? txHash : '',
                        );

                        // If TonAPI returned an error for this transaction, report it
                        if (!specificTxStatus.success) {
                            this.#ui.clearActionPrompt();
                            this.#ui.write(
                                `⚠️ Warning: Transaction verification via TonAPI indicates problems:\n${specificTxStatus.error}`,
                            );
                            // Do not interrupt execution, as the contract is already deployed
                        } else if (specificTxStatus.tx) {
                            // If we got more accurate information, use it
                            tx.status = specificTxStatus.tx.status;
                            tx.compute = specificTxStatus.tx.compute;
                            tx.success = specificTxStatus.tx.success;
                            tx.aborted = specificTxStatus.tx.aborted;
                            // Update detailed information if available
                            if (specificTxStatus.tx.fees) tx.fees = specificTxStatus.tx.fees;
                            if (specificTxStatus.tx.utime) tx.utime = specificTxStatus.tx.utime;
                        }
                        this.#ui.clearActionPrompt();
                    }

                    let lt = tx.lt || tx.transaction_id?.lt;
                    if (typeof lt === 'function') {
                        try {
                            lt = lt();
                        } catch (_e) {
                            lt = undefined;
                        }
                    }

                    const timestamp = tx.utime || tx.timestamp;
                    const fees = tx.total_fees || tx.fees;
                    let explorerTxLink = '';
                    if (txHash && this.#network && this.#explorer) {
                        explorerTxLink = getExplorerTxLink(
                            typeof txHash === 'string' ? txHash : '',
                            this.#network,
                            this.#explorer,
                        );
                    }

                    // Form detailed transaction information
                    let info = '';
                    if (txHash) info += `Tx hash: ${txHash}\n`;
                    if (lt) info += `LT: ${lt}\n`;
                    if (timestamp) info += `Timestamp: ${new Date(timestamp * 1000).toISOString()}\n`;

                    // Add transaction status
                    if (tx.success !== undefined) {
                        info += `Success: ${tx.success}\n`;
                    }

                    // Add exit code if available
                    if (tx.compute?.exit_code !== undefined) {
                        info += `Exit code: ${tx.compute.exit_code}\n`;
                    }

                    // Add status (nonexist → active and so on)
                    if (tx.status) {
                        info += `Status: ${tx.status}\n`;
                    }

                    // Add aborted flag
                    if (tx.aborted !== undefined) {
                        info += `Aborted: ${tx.aborted}\n`;
                    }

                    // Add information about gas and VM steps
                    if (tx.compute?.gas_used !== undefined) {
                        info += `Gas used: ${tx.compute.gas_used}\n`;
                    }

                    if (tx.compute?.vm_steps !== undefined) {
                        info += `VM steps: ${tx.compute.vm_steps}\n`;
                    }

                    // Add detailed information about fees
                    if (fees) {
                        if (typeof fees === 'object' && fees !== null) {
                            // Output detailed information about different types of fees
                            const feesObj = fees as TransactionFees;
                            if (feesObj.gas_fee) info += `Gas fee: ${feesObj.gas_fee}\n`;
                            if (feesObj.storage_fee) info += `Storage fee: ${feesObj.storage_fee}\n`;
                            if (feesObj.forward_fee) info += `Forward fee: ${feesObj.forward_fee}\n`;
                            if (feesObj.total_fee || feesObj.total_fees)
                                info += `Total fee: ${feesObj.total_fee || feesObj.total_fees}\n`;
                        } else {
                            info += `Fees: ${fees}\n`;
                        }
                    }

                    if (explorerTxLink) info += `Explorer: ${explorerTxLink}\n`;
                    if (info) this.#ui.write(info);
                }
                return;
            }
            await sleep(sleepDuration);
        }

        this.#ui.clearActionPrompt();
        throw new Error("Contract was not deployed. Check your wallet's transactions");
    }

    private obtainInMessageHash() {
        const { lastSendResult } = this.#sender;
        if (
            typeof lastSendResult === 'object' &&
            lastSendResult !== null &&
            'boc' in lastSendResult &&
            typeof lastSendResult.boc === 'string'
        ) {
            const cell = Cell.fromBase64(lastSendResult.boc);
            const extMessage = loadMessage(cell.beginParse());
            return getNormalizedExtMessageHash(extMessage);
        }

        throw new Error('Not implemented');
    }

    private async getLastTransactions(address: Address): Promise<Transaction[]> {
        if (this.#tc instanceof TonClient) {
            return this.#tc.getTransactions(address, { limit: 100, archival: true }); // without archival not working with tonclient
        }

        const provider = this.#tc.provider(address);
        const { last } = await provider.getState();
        if (!last) {
            return [];
        }

        return provider.getTransactions(address, last.lt, last.hash);
    }

    private async isTransactionApplied(
        address: Address,
        targetInMessageHash: Buffer,
    ): Promise<{ isApplied: false } | { isApplied: true; transaction: Transaction }> {
        const provider = this.#tc.provider(address);
        const { last } = await provider.getState();
        if (!last) {
            return { isApplied: false };
        }

        let lastTxs: Transaction[];
        try {
            lastTxs = await this.getLastTransactions(address);
        } catch (_) {
            return { isApplied: false };
        }

        for (const transaction of lastTxs) {
            if (transaction.inMessage?.info.type !== 'external-in') {
                continue;
            }
            const inMessageHash = getNormalizedExtMessageHash(transaction.inMessage);
            if (inMessageHash.equals(targetInMessageHash)) {
                return { isApplied: true, transaction };
            }
        }

        return { isApplied: false };
    }

    async waitForLastTransaction(waitAttempts: number = 20, sleepDuration: number = 2000): Promise<void> {
        let attempts = waitAttempts;

        if (attempts <= 0) {
            throw new Error('Attempt number must be positive');
        }
        if (!this.#sender.address) {
            throw new Error('Sender must have an address');
        }

        const inMessageHash = this.obtainInMessageHash();

        for (let i = 1; i <= attempts; i++) {
            this.#ui.setActionPrompt(`Awaiting transaction... [Attempt ${i}/${attempts}]`);
            const result = await this.isTransactionApplied(this.#sender.address, inMessageHash);
            if (result.isApplied) {
                const { transaction } = result;
                this.#ui.clearActionPrompt();
                this.#ui.write(`Transaction ${inMessageHash.toString('hex')} successfully applied!`);
                this.#ui.write(
                    `You can view it at ${getTransactionLink(
                        {
                            ...transaction,
                            hash: transaction.hash(),
                            address: this.#sender.address,
                        },
                        this.#network,
                        this.#explorer,
                    )}`,
                );
                return;
            }

            await sleep(sleepDuration);
        }

        throw new Error("Transaction was not applied. Check your wallet's transactions");
    }

    /**
     * @deprecated
     *
     * Use your Contract's `sendDeploy` method (or similar) together with `waitForDeploy` instead.
     */
    async deploy(contract: Contract, value: bigint, body?: Cell, waitAttempts: number = 10) {
        const isDeployed = await this.isContractDeployed(contract.address);
        if (isDeployed) {
            throw new Error('Contract is already deployed!');
        }

        if (!contract.init) {
            throw new Error('Contract has no init!');
        }

        await this.#sender.send({
            to: contract.address,
            value,
            body,
            init: contract.init,
        });

        if (waitAttempts <= 0) return;

        await this.waitForDeploy(contract.address, waitAttempts);
    }

    open<T extends Contract>(contract: T): OpenedContract<T> {
        return openContract(contract, (params) => this.provider(params.address, params.init ?? null));
    }

    ui(): UIProvider {
        return this.#ui;
    }

    // Modifying verifyTransactionByHash method to return more information
    async verifyTransactionByHash(txHash: string): Promise<{ success: boolean; error?: string; tx?: any }> {
        try {
            // Use TonAPI to check transaction status
            const apiUrl = this.#network === 'mainnet' ? TONAPI_MAINNET : TONAPI_TESTNET;
            if (this.#network === 'custom') {
                return { success: true }; // Cannot check status for custom networks
            }

            let response;
            try {
                response = await axios.get(`${apiUrl}/v2/blockchain/transactions/${txHash}`);
            } catch (e) {
                // Add API error details if available
                const errorDetails = e instanceof Error ? e.message : String(e);
                return { success: false, error: `Transaction not found or API error: ${errorDetails}` };
            }

            const tx = response.data;
            if (!tx) {
                return { success: false, error: 'Transaction not found (empty response)' };
            }

            // Check transaction status more accurately, using snake_case from API
            const exitCode = tx.compute_phase?.exit_code; // snake_case
            const computeSuccess = tx.compute_phase?.success; // snake_case
            const txSuccessOverall = tx.success === true; // Overall transaction success
            const isFailedCompute =
                (exitCode !== undefined && exitCode !== 0 && exitCode !== 1) || computeSuccess === false;
            const isFailedOverall = txSuccessOverall === false;

            // If transaction failed, create a detailed error message
            if (isFailedCompute || isFailedOverall) {
                let errorMsg = `Transaction FAILED.\n`;

                // Add exit code if available
                if (exitCode !== undefined) {
                    errorMsg += `Exit code: ${exitCode}\n`;
                } else {
                    errorMsg += `Exit code: unknown\n`;
                }

                // Add compute.success if available
                if (computeSuccess !== undefined) {
                    errorMsg += `Compute success: ${computeSuccess}\n`;
                }

                // Add overall transaction success
                errorMsg += `Overall success: ${txSuccessOverall}\n`;

                const exitArg = tx.compute_phase?.exit_arg; // snake_case
                if (exitArg !== undefined) errorMsg += `Exit arg: ${exitArg}\n`;
                if (tx.status) errorMsg += `Status: ${tx.status}\n`; // Status from API
                if (tx.aborted !== undefined) errorMsg += `Aborted: ${tx.aborted}\n`;
                if (tx.compute_phase?.gas_used) errorMsg += `Gas used: ${tx.compute_phase.gas_used}\n`; // snake_case
                if (tx.compute_phase?.vm_steps) errorMsg += `VM steps: ${tx.compute_phase.vm_steps}\n`; // snake_case

                // Add full JSON response at the end
                errorMsg += `\n--- Full API Response: ---\n${JSON.stringify(tx, null, 2)}`;

                return {
                    success: false,
                    error: errorMsg,
                    tx,
                };
            }

            return { success: true, tx };
        } catch (error) {
            console.warn('Failed to verify transaction by hash:', error);
            const errorDetails = error instanceof Error ? error.message : String(error);
            return { success: false, error: `Error verifying transaction: ${errorDetails}` };
        }
    }
}

async function createMnemonicProvider(client: BlueprintTonClient, ui: UIProvider, network: Network) {
    // Access environment variables using indexer notation to avoid TypeScript errors
    const mnemonic = process.env['WALLET_MNEMONIC'] || '';
    const walletVersion = process.env['WALLET_VERSION'] || '';

    if (mnemonic.length === 0 || walletVersion.length === 0) {
        throw new Error(
            'Mnemonic deployer was chosen, but env variables WALLET_MNEMONIC and WALLET_VERSION are not set',
        );
    }
    const keyPair = await mnemonicToPrivateKey(mnemonic.split(' '));
    return new MnemonicProvider({
        version: walletVersion.toLowerCase() as WalletVersion,
        client,
        secretKey: keyPair.secretKey,
        ui,
        network,
    });
}

function intToIP(int: number): string {
    const part1 = int & 255;
    const part2 = (int >> 8) & 255;
    const part3 = (int >> 16) & 255;
    const part4 = (int >> 24) & 255;
    return `${(part4 + 256) % 256}.${(part3 + 256) % 256}.${(part2 + 256) % 256}.${(part1 + 256) % 256}`;
}

async function buildLiteClient(configEndpoint: string) {
    const { data } = await axios.get(configEndpoint);
    if (!Array.isArray(data.liteservers)) {
        throw new Error(
            `Invalid liteclient configuration on ${configEndpoint}. Use https://ton.org/testnet-global.config.json for testnet or https://ton.org/global.config.json for mainnet.`,
        );
    }

    const engines = data.liteservers.map((server: any) => {
        if (
            typeof server?.ip !== 'number' ||
            typeof server?.port !== 'number' ||
            typeof server?.id !== 'object' ||
            typeof server?.id?.key !== 'string'
        ) {
            throw new Error(`Invalid liteclient configuration on ${configEndpoint}`);
        }
        return new LiteSingleEngine({
            host: `tcp://${intToIP(server.ip)}:${server.port}`,
            publicKey: Buffer.from(server.id.key, 'base64'),
        });
    });

    const engine = new LiteRoundRobinEngine(engines);
    return new LiteClient({ engine });
}

class NetworkProviderBuilder {
    constructor(
        private args: Args,
        private ui: UIProvider,
        private config?: Config,
        private allowCustom = true,
    ) {}

    async chooseNetwork(): Promise<Network> {
        let network = oneOrZeroOf({
            mainnet: this.args['--mainnet'],
            testnet: this.args['--testnet'],
            custom: this.args['--custom'] !== undefined,
        });

        if (network !== undefined) {
            return network;
        }

        if (this.config?.network !== undefined) {
            return typeof this.config.network === 'string' ? this.config.network : 'custom';
        }

        network = await this.ui.choose('Which network do you want to use?', ['mainnet', 'testnet', 'custom'], (c) => c);
        if (network === 'custom') {
            const defaultCustomEndpoint = 'http://localhost:8081/';
            this.args['--custom'] = (
                await this.ui.input(`Provide a custom API v2 endpoint (default is ${defaultCustomEndpoint})`)
            ).trim();
            if (this.args['--custom'] === '') this.args['--custom'] = defaultCustomEndpoint;
        }

        return network;
    }

    chooseExplorer(): Explorer {
        return (
            oneOrZeroOf({
                tonscan: this.args['--tonscan'],
                tonviewer: this.args['--tonviewer'],
                toncx: this.args['--toncx'],
                dton: this.args['--dton'],
            }) ?? 'tonscan'
        );
    }

    async chooseSendProvider(network: Network, client: BlueprintTonClient): Promise<SendProvider> {
        let deployUsing = oneOrZeroOf({
            tonconnect: this.args['--tonconnect'],
            deeplink: this.args['--deeplink'],
            mnemonic: this.args['--mnemonic'],
        });

        if (!deployUsing) {
            deployUsing = (
                await this.ui.choose(
                    'Which wallet are you using?',
                    [
                        {
                            name: 'TON Connect compatible mobile wallet (example: Tonkeeper)',
                            value: 'tonconnect',
                        },
                        {
                            name: 'Create a ton:// deep link',
                            value: 'deeplink',
                        },
                        {
                            name: 'Mnemonic',
                            value: 'mnemonic',
                        },
                    ],
                    (c) => c.name,
                )
            ).value as any;
        }

        const storagePath = path.join(TEMP_DIR, network, deployUsing! + '.json');

        let provider: SendProvider;
        switch (deployUsing) {
            case 'deeplink':
                provider = new DeeplinkProvider(network, this.ui);
                break;
            case 'tonconnect':
                if (network === 'custom') throw new Error('Tonkeeper cannot work with custom network.');
                provider = new TonConnectProvider(
                    new FSStorage(storagePath),
                    this.ui,
                    network,
                    this.config?.manifestUrl,
                );
                break;
            case 'mnemonic':
                provider = await createMnemonicProvider(client, this.ui, network);
                break;
            default:
                throw new Error('Unknown deploy option');
        }

        return provider;
    }

    async build(): Promise<NetworkProvider> {
        let network = await this.chooseNetwork();
        const explorer = this.chooseExplorer();

        if (
            network !== 'custom' &&
            (this.args['--custom-key'] !== undefined ||
                this.args['--custom-type'] !== undefined ||
                this.args['--custom-version'] !== undefined)
        ) {
            throw new Error('Cannot use custom parameters with a non-custom network');
        }

        let tc;
        if (network === 'custom') {
            let configNetwork: CustomNetwork | undefined = undefined;
            if (this.config?.network !== undefined && typeof this.config.network !== 'string') {
                configNetwork = this.config.network;
            }
            if (this.args['--custom'] !== undefined) {
                const inputVer = this.args['--custom-version'];
                let version: CustomNetwork['version'] = undefined;
                if (inputVer !== undefined) {
                    version = inputVer.toLowerCase() as any; // checks come later
                }
                const inputType = this.args['--custom-type'];
                let type: CustomNetwork['type'] = undefined;
                if (inputType !== undefined) {
                    type = inputType as any; // checks come later
                }
                configNetwork = {
                    endpoint: this.args['--custom'],
                    version,
                    key: this.args['--custom-key'],
                    type,
                };
            }
            if (configNetwork === undefined) {
                throw new Error('Custom network is (somehow) undefined');
            }
            if (configNetwork.version === undefined || configNetwork.version === 'v2') {
                tc = new TonClient({
                    endpoint: configNetwork.endpoint,
                    apiKey: configNetwork.key,
                });
            } else if (configNetwork.version === 'v4') {
                if (configNetwork.key !== undefined) {
                    throw new Error('Cannot use a custom API key with a v4 API');
                }
                tc = new TonClient4({
                    endpoint: configNetwork.endpoint,
                });
            } else if (configNetwork.version === 'tonapi') {
                tc = new ContractAdapter(
                    new TonApiClient({
                        baseUrl: configNetwork.endpoint,
                        apiKey: configNetwork.key,
                    }),
                );
            } else if (configNetwork.version === 'liteclient') {
                tc = await buildLiteClient(configNetwork.endpoint);
            } else {
                throw new Error('Unknown API version: ' + configNetwork.version);
            }

            if (configNetwork.type !== undefined) {
                const ct = configNetwork.type.toLowerCase();
                if (!['mainnet', 'testnet', 'custom'].includes(ct)) {
                    throw new Error('Unknown network type: ' + ct);
                }
                network = ct as Network;
            } else if (!this.allowCustom) {
                throw new Error('The usage of this network provider requires either mainnet or testnet');
            }
        } else {
            const httpAdapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
                let r: AxiosResponse;
                let delay = INITIAL_DELAY;
                let attempts = 0;
                while (true) {
                    r = await axios({
                        ...config,
                        adapter: undefined,
                        validateStatus: (status: number) => (status >= 200 && status < 300) || status === 429,
                    });
                    if (r.status !== 429) {
                        return r;
                    }
                    await sleep(delay);
                    delay *= 2;
                    attempts++;
                    if (attempts >= MAX_ATTEMPTS) {
                        throw new Error('Max attempts reached');
                    }
                }
            };

            tc = new TonClient({
                endpoint:
                    network === 'mainnet'
                        ? 'https://toncenter.com/api/v2/jsonRPC'
                        : 'https://testnet.toncenter.com/api/v2/jsonRPC',
                httpAdapter,
            });
        }

        const sendProvider = await this.chooseSendProvider(network, tc);

        try {
            await sendProvider.connect();
        } catch (_) {
            console.error('Unable to connect to wallet.');
            process.exit(1);
        } finally {
            this.ui.setActionPrompt('');
        }

        const sender = new SendProviderSender(sendProvider);

        return new NetworkProviderImpl(tc, sender, network, explorer, this.ui);
    }
}

export async function createNetworkProvider(
    ui: UIProvider,
    args: Args,
    config?: Config,
    allowCustom = true,
): Promise<NetworkProvider> {
    return await new NetworkProviderBuilder(args, ui, config, allowCustom).build();
}
