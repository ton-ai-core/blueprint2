import arg from 'arg';
import chalk from 'chalk';

import { findContracts, selectOption } from '../utils';
import { UIProvider } from '../ui/UIProvider';
import { buildAll, buildOne } from '../build';
import { helpArgs, helpMessages } from './constants';
import { Args, extractFirstArg, Runner } from './Runner';

export async function selectContract(ui: UIProvider, hint?: string): Promise<string>;
export async function selectContract(
    ui: UIProvider,
    hint?: string,
    withAllOption?: boolean,
): Promise<string | string[]>;
export async function selectContract(
    ui: UIProvider,
    hint?: string,
    withAllOption: boolean = false,
): Promise<string | string[]> {
    const contracts = await findContracts();
    const options = contracts.map<{ name: string; value: string }>((contract) => ({ name: contract, value: contract }));

    if (hint) {
        const found = contracts.find((c) => c.toLowerCase() === hint.toLowerCase());
        if (!found) {
            const availableNames = contracts.join(', ');
            throw new Error(`"${hint}" not found, but available: ${availableNames}`);
        }
        ui.write(`Using contract: ${found}`);
        return found;
    }

    // If there's only one contract, automatically select it
    if (contracts.length === 1) {
        const contract = contracts[0];
        ui.write(`Using contract: ${contract}`);
        return contract;
    }

    const allContractsValue = 'all_contracts';
    if (withAllOption) {
        const allContractsOption = {
            name: 'All Contracts',
            value: allContractsValue,
        };
        options.push(allContractsOption);
    }

    const selectedOption = await selectOption(options, {
        msg: 'Select contract to use',
        ui,
    });

    if (selectedOption.value === allContractsValue) {
        return contracts;
    }

    return selectedOption.value;
}

export const build: Runner = async (args: Args, ui: UIProvider) => {
    const localArgs = arg({
        '--all': Boolean,
        ...helpArgs,
    });
    if (localArgs['--help']) {
        ui.write(helpMessages['build']);
        return;
    }

    if (localArgs['--all']) {
        ui.write(chalk.gray('Running build for all contracts...'));
        await buildAll(ui, true);
        ui.write(chalk.magentaBright('[build.ts] buildAll finished.'));
    } else {
        const selected = await selectContract(ui, extractFirstArg(args), true);

        if (typeof selected === 'string') {
            const contractName = selected;
            try {
                await buildOne(contractName, ui);
                ui.write(chalk.gray(`Build for ${contractName} successful.`));
            } catch (e) {
                ui.write(
                    chalk.redBright(`Error during build execution for ${contractName}: ${(e as Error).message || e}`),
                );
                process.exit(1);
            }
        } else {
            ui.write(chalk.gray('Running build for all contracts (selected interactively)...'));
            await buildAll(ui);
            ui.write(chalk.magentaBright('[build.ts] buildAll (interactive) finished.'));
        }
    }
};
