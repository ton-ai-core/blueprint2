import { Address, Cell, StateInit } from '@ton/core';

export interface SendProvider {
    connect(): Promise<void>;
    sendTransaction(address: Address, amount: bigint, payload?: Cell, stateInit?: StateInit): Promise<unknown>;
    address(): Address | undefined;
}
