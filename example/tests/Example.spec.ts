import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { Example } from '../wrappers/Example';
import '@ton/test-utils';

describe('Example', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let example: SandboxContract<Example>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        example = blockchain.openContract(await Example.fromInit());

        deployer = await blockchain.treasury('deployer');

        const deployResult = await example.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            null,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: example.address,
            deploy: true,
            success: true,
        });
    });

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and example are ready to use
    });
});
