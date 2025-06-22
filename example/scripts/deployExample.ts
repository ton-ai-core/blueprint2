import { toNano } from '@ton/core';
import { Example } from '../wrappers/Example';
import { NetworkProvider } from '@ton-ai-core/blueprint';

export async function run(provider: NetworkProvider) : Promise<void> {
    const exampleContract = await Example.fromInit();
    const example = provider.open(exampleContract as any);

    await example.send(
        provider.sender(),
        {
            value: toNano('0.05'),
        },
        null,
    );

    await provider.waitForDeploy(example.address);

    console.log(`✅ Example contract deployed at address: ${example.address.toString()}`);
}
