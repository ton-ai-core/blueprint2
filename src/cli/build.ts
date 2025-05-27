import arg from 'arg';

import { findContracts, selectOption } from '../utils';
import { UIProvider } from '../ui/UIProvider';
import { buildAll, buildOne } from '../build';
import { helpArgs, helpMessages } from './constants';
import { Args, extractFirstArg, Runner } from './Runner';
import { runNpmHook } from './cli';
import chalk from 'chalk';

export async function selectContract(ui: UIProvider, hint?: string ): Promise<string>;
export async function selectContract(ui: UIProvider, hint?: string, withAllOption?: boolean): Promise<string | string[]>;
export async function selectContract(ui: UIProvider, hint?: string, withAllOption: boolean = false):  Promise<string | string[]> {
    const contracts = await findContracts();
    const options = contracts.map<{ name: string; value: string }>((contract) => ({ name: contract, value: contract }));

    if (hint) {
        const found = contracts.find(c => c.toLowerCase() === hint.toLowerCase());
        if (!found) {
            const availableNames = contracts.join(', ');
            throw new Error(`"${hint}" not found, but available: ${availableNames}`);
        }
        ui.write(`Using contract: ${found}`);
        return found;
    }

    const allContractsValue = 'all_contracts';
    if (withAllOption) {
        const allContractsOption = {
            name: 'All Contracts',
            value: allContractsValue,
        }
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
        try {
            const preHookResult = await runNpmHook('pre', 'build', undefined, ui);
            if (!preHookResult.success) {
                ui.write(chalk.redBright('Aborting command due to pre-build hook failure.'));
                process.exit(1);
            }
        } catch (e) {
            ui.write(chalk.redBright(`Error during pre-build hook execution check: ${(e as Error).message || e}`));
            process.exit(1);
        }

        await buildAll(ui);

        ui.write(chalk.magentaBright('[build.ts] buildAll finished. Preparing to check post-hook...'));
        try {
            const postHookResult = await runNpmHook('post', 'build', undefined, ui);
            if (!postHookResult.success) {
                ui.write(chalk.yellowBright(`Warning: post-build hook script failed.`));
            }
        } catch (e) {
            ui.write(chalk.yellowBright(`Warning: Error during post-build hook execution check: ${(e as Error).message || e}`));
        }
    } else {
        const selected = await selectContract(ui, extractFirstArg(args), true);

        if (typeof selected === 'string') {
            const contractName = selected;
            ui.write(chalk.gray(`Checking for pre-hook for command 'build' with argument '${contractName}'...`));
            try {
                const preHookResult = await runNpmHook('pre', 'build', contractName, ui);
                if (!preHookResult.success) {
                    ui.write(chalk.redBright(`Aborting command due to pre-build:${contractName} hook failure.`));
                    process.exit(1);
                }
            } catch (e) {
                ui.write(chalk.redBright(`Error during pre-hook execution check: ${(e as Error).message || e}`));
                process.exit(1);
            }

            try {
                await buildOne(contractName, ui);

                ui.write(chalk.gray(`Build for ${contractName} successful. Checking for post-hook...`));
                try {
                    const postHookResult = await runNpmHook('post', 'build', contractName, ui);
                    if (!postHookResult.success) {
                        ui.write(chalk.yellowBright(`Warning: post-build:${contractName} hook script failed.`));
                    }
                } catch (e) {
                    ui.write(chalk.yellowBright(`Warning: Error during post-hook execution check: ${(e as Error).message || e}`));
                }
            } catch (e) {
                 ui.write(chalk.redBright(`Error during build execution for ${contractName}: ${(e as Error).message || e}`));
                 process.exit(1);
            }
        } else {
            ui.write(chalk.gray('Running build for all contracts (selected interactively)...'));
            try {
                const preHookResult = await runNpmHook('pre', 'build', undefined, ui);
                if (!preHookResult.success) {
                    ui.write(chalk.redBright('Aborting command due to pre-build hook failure.'));
                    process.exit(1);
                }
            } catch (e) {
                ui.write(chalk.redBright(`Error during pre-build hook execution check: ${(e as Error).message || e}`));
                process.exit(1);
            }

            await buildAll(ui);

            ui.write(chalk.magentaBright('[build.ts] buildAll (interactive) finished. Preparing to check post-hook...'));
            try {
                const postHookResult = await runNpmHook('post', 'build', undefined, ui);
                if (!postHookResult.success) {
                    ui.write(chalk.yellowBright(`Warning: post-build hook script failed.`));
                }
            } catch (e) {
                ui.write(chalk.yellowBright(`Warning: Error during post-hook execution check: ${(e as Error).message || e}`));
            }
        }
    }
};
