import process from 'process';

import arg from 'arg';
import chalk from 'chalk';

import { findContracts, selectOption } from '../utils';
import { UIProvider } from '../ui/UIProvider';
import { buildAll, buildOne } from '../build';
import { helpMessages } from './constants';
import { Args, extractFirstArg, Runner, RunnerContext } from './Runner';
import { runNpmHook, checkBlueprintHooks } from './cli';

export async function selectContract(ui: UIProvider, hint?: string): Promise<string>;
export async function selectContract(ui: UIProvider, hint?: string, all?: boolean): Promise<string | 'all'>;
export async function selectContract(ui: UIProvider, hint?: string, all = false): Promise<string | 'all'> {
    const contracts = await findContracts();
    const options = all
        ? [...contracts.map((c) => ({ name: c, value: c })), { name: 'All Contracts', value: 'all' }]
        : contracts.map((c) => ({ name: c, value: c }));

    return (
        await selectOption(options, {
            ui,
            msg: 'Select contract to build:',
            hint,
        })
    ).value;
}

export const build: Runner = async (_args: Args, ui: UIProvider, _context: RunnerContext) => {
    console.log('FUNCTION CALLED: build');
    console.log(`Parameters: args=${JSON.stringify(_args._)}`);
    console.log(`Environment: BLUEPRINT_SCRIPT_NAME=${process.env.BLUEPRINT_SCRIPT_NAME}`);

    ui.write(chalk.yellow(`DEBUG: build.ts - build function called with args: ${JSON.stringify(_args._)}`));

    const localArgs = arg(
        {
            '--all': Boolean,
            '--help': Boolean,
        },
        {
            argv: _args._.slice(1),
        },
    );

    if (localArgs['--help']) {
        ui.write(helpMessages['build']);
        return;
    }

    if ((localArgs as any)['--all']) {
        ui.write('Building all contracts');
        try {
            // Устанавливаем переменную окружения для всех контрактов
            process.env.BLUEPRINT_SCRIPT_NAME = 'all';
            ui.write(chalk.yellow(`DEBUG: build.ts - Setting BLUEPRINT_SCRIPT_NAME to 'all'`));

            // Вызываем blueprint pre-хуки
            const blueprintPreHookResult = await checkBlueprintHooks('pre', 'build', undefined, ui);
            ui.write(chalk.yellow(`DEBUG: build.ts - checkBlueprintHooks returned: ${blueprintPreHookResult}`));

            // Вызываем стандартные npm pre-хуки
            const preHookResult = await runNpmHook('pre', 'build', undefined, ui);
            if (!preHookResult.success) {
                ui.write(chalk.redBright('Aborting command due to pre-build hook failure.'));
                process.exit(1);
            }

            await buildAll(ui, true);

            // Вызываем стандартные npm post-хуки
            const postHookResult = await runNpmHook('post', 'build', undefined, ui);
            if (!postHookResult.success) {
                ui.write(chalk.yellowBright(`Warning: post-build hook script failed.`));
            }

            // Вызываем blueprint post-хуки
            const blueprintPostHookResult = await checkBlueprintHooks('post', 'build', undefined, ui);
            ui.write(chalk.yellow(`DEBUG: build.ts - post checkBlueprintHooks returned: ${blueprintPostHookResult}`));
        } catch (e) {
            ui.write(chalk.redBright(`Error during build: ${(e as Error).message || e}`));
            process.exit(1);
        }
        return;
    }

    // Если аргументы пришли из команды action, используем их напрямую
    // В этом случае первым аргументом будет "build", а вторым - имя контракта
    let contractName: string | undefined;
    if (_args._.length >= 2 && _args._[0] === 'build') {
        contractName = _args._[1];
        ui.write(chalk.yellow(`DEBUG: build.ts - Using contract name from action command: ${contractName}`));
    } else {
        // Стандартный способ получения имени контракта
        contractName = extractFirstArg(_args);
        ui.write(chalk.yellow(`DEBUG: build.ts - Using contract name from standard flow: ${contractName}`));
    }

    // Если имя контракта не было передано, запрашиваем его интерактивно
    if (!contractName) {
        contractName = await selectContract(ui, 'Select contract to build');
        ui.write(chalk.yellow(`DEBUG: build.ts - Using contract name from interactive selection: ${contractName}`));
    }

    ui.write(`Using contract: ${contractName}`);

    // Передаем имя контракта в переменные окружения
    process.env.BLUEPRINT_SCRIPT_NAME = contractName;
    ui.write(
        chalk.yellow(
            `DEBUG: build.ts - Environment variable BLUEPRINT_SCRIPT_NAME set to: ${process.env.BLUEPRINT_SCRIPT_NAME}`,
        ),
    );

    // Теперь, когда у нас есть имя контракта, вызываем pre-хуки
    ui.write(`Checking for pre-hook for command 'build' with argument '${contractName}'...`);
    ui.write(chalk.yellow(`DEBUG: build.ts - About to call checkBlueprintHooks with pre, build, ${contractName}`));
    console.log(`DEBUG: build.ts - About to call checkBlueprintHooks with pre, build, ${contractName}`);
    const blueprintPreHookResult = await checkBlueprintHooks('pre', 'build', contractName, ui);
    console.log(`DEBUG: build.ts - checkBlueprintHooks returned: ${blueprintPreHookResult}`);
    ui.write(chalk.yellow(`DEBUG: build.ts - checkBlueprintHooks returned: ${blueprintPreHookResult}`));

    ui.write(chalk.yellow(`DEBUG: build.ts - About to call runNpmHook with pre, build, ${contractName}`));
    const preHookResult = await runNpmHook('pre', 'build', contractName, ui);
    ui.write(chalk.yellow(`DEBUG: build.ts - runNpmHook returned: ${JSON.stringify(preHookResult)}`));

    if (!preHookResult.success) {
        ui.write(chalk.redBright(`Aborting command due to pre-build hook failure.`));
        process.exit(1);
    }

    ui.write(`Building contract ${contractName}`);

    try {
        await buildOne(contractName, ui);

        ui.write(chalk.yellow(`DEBUG: build.ts - About to call runNpmHook with post, build, ${contractName}`));
        const postHookResult = await runNpmHook('post', 'build', contractName, ui);
        ui.write(chalk.yellow(`DEBUG: build.ts - runNpmHook returned: ${JSON.stringify(postHookResult)}`));

        if (!postHookResult.success) {
            ui.write(chalk.yellowBright(`Warning: post-build hook script failed.`));
        }

        ui.write(chalk.yellow(`DEBUG: build.ts - About to call checkBlueprintHooks with post, build, ${contractName}`));
        const blueprintPostHookResult = await checkBlueprintHooks('post', 'build', contractName, ui);
        ui.write(chalk.yellow(`DEBUG: build.ts - checkBlueprintHooks returned: ${blueprintPostHookResult}`));
    } catch (e) {
        ui.write(chalk.redBright(`Error during build: ${(e as Error).message || e}`));
        process.exit(1);
    }
};
