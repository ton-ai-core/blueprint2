import { execSync as _execSync } from 'child_process';
import process from 'process';
import _path from 'path';

import arg from 'arg';
import chalk from 'chalk';

import { Args, extractFirstArg as _extractFirstArg, Runner, RunnerContext } from './Runner';
import { createNetworkProvider, argSpec } from '../network/createNetworkProvider';
import { findScripts, selectFile } from '../utils';
import { getEntityName } from '../utils/cliUtils';
import { UIProvider } from '../ui/UIProvider';
import { helpArgs, helpMessages } from './constants';
import * as _pkgManagerService from '../pkgManager/service';
import { runNpmHook, checkBlueprintHooks } from './cli';

export const run: Runner = async (_args: Args, ui: UIProvider, context: RunnerContext) => {
    // Отладочный вывод для проверки аргументов
    ui.write(chalk.yellow(`DEBUG: run.ts received args: ${JSON.stringify(_args._)}`));
    console.log(`DEBUG: run.ts received args: ${JSON.stringify(_args._)}`);
    console.log(`DEBUG: run.ts - Environment variable BLUEPRINT_SCRIPT_NAME=${process.env.BLUEPRINT_SCRIPT_NAME}`);

    let localArgs: Args;
    try {
        localArgs = arg({
            ...argSpec,
            ...helpArgs,
        });
    } catch (e) {
        const msg = e && typeof e === 'object' && 'message' in e ? (e as any).message : String(e);
        if (msg.includes('unknown or unexpected option')) {
            const availableFlags = Object.keys(argSpec).join(', ');
            ui.write(msg);
            ui.write('Available options: ' + availableFlags);
            process.exit(1);
        } else {
            throw e;
        }
    }
    if ((localArgs as any)['--help']) {
        ui.write(helpMessages['run']);
        return;
    }

    // Если аргументы пришли из команды action, используем их напрямую
    // В этом случае первым аргументом будет "run", а вторым - имя скрипта
    let scriptName: string | undefined;
    if (_args._.length >= 2 && _args._[0] === 'run') {
        scriptName = _args._[1];
        ui.write(chalk.gray(`Using script name from action command: ${scriptName}`));
        console.log(`DEBUG: run.ts - Using script name from action command: ${scriptName}`);
    } else {
        // Стандартный способ получения имени скрипта
        scriptName = await getEntityName(
            localArgs._,
            undefined, // Interactive mode is not needed here, selectFile handles it
        );
        // Если из аргументов была получена строка, совпадающая с именем команды,
        // сбрасываем её, чтобы перейти в интерактивный режим выбора скрипта.
        if (scriptName === _args._[0]) {
            scriptName = undefined;
        }
        console.log(`DEBUG: run.ts - Using script name from standard flow: ${scriptName}`);
    }

    // Если имя скрипта не было передано, запрашиваем его интерактивно
    if (!scriptName) {
        scriptName = (
            await selectFile(await findScripts(), {
                ui,
                hint: scriptName,
            })
        ).name;
        console.log(`DEBUG: run.ts - Using script name from interactive selection: ${scriptName}`);
    }

    // Передаем имя скрипта в переменные окружения
    process.env.BLUEPRINT_SCRIPT_NAME = scriptName;
    console.log(`DEBUG: run.ts - Setting BLUEPRINT_SCRIPT_NAME to ${scriptName}`);
    ui.write(
        chalk.yellow(
            `DEBUG: run.ts - Environment variable BLUEPRINT_SCRIPT_NAME set to: ${process.env.BLUEPRINT_SCRIPT_NAME}`,
        ),
    );

    // Теперь, когда у нас есть имя скрипта, вызываем pre-хуки
    ui.write(chalk.yellow(`DEBUG: run.ts - About to call checkBlueprintHooks with pre, run, ${scriptName}`));
    console.log(`DEBUG: run.ts - About to call checkBlueprintHooks with pre, run, ${scriptName}`);
    const blueprintPreHookResult = await checkBlueprintHooks('pre', 'run', scriptName, ui);
    ui.write(chalk.yellow(`DEBUG: run.ts - checkBlueprintHooks returned: ${blueprintPreHookResult}`));
    console.log(`DEBUG: run.ts - checkBlueprintHooks returned: ${blueprintPreHookResult}`);

    ui.write(chalk.yellow(`DEBUG: run.ts - About to call runNpmHook with pre, run, ${scriptName}`));
    console.log(`DEBUG: run.ts - About to call runNpmHook with pre, run, ${scriptName}`);
    const preHookResult = await runNpmHook('pre', 'run', scriptName, ui);
    ui.write(chalk.yellow(`DEBUG: run.ts - runNpmHook returned: ${JSON.stringify(preHookResult)}`));
    console.log(`DEBUG: run.ts - runNpmHook returned: ${JSON.stringify(preHookResult)}`);

    if (!preHookResult.success) {
        ui.write(chalk.redBright(`Aborting command due to pre-run hook failure.`));
        process.exit(1);
    }

    const mod = (await selectFile(await findScripts(), { ui, hint: scriptName })).module;

    if (typeof mod?.run !== 'function') {
        throw new Error(`Function \`run\` is missing in script ${scriptName}!`);
    }

    const networkProvider = await createNetworkProvider(ui, localArgs, context.config);

    // Pass positional arguments (everything after the script name)
    const scriptArgs = localArgs._.slice(2);

    try {
        await mod.run(networkProvider, scriptArgs);

        ui.write(chalk.yellow(`DEBUG: run.ts - About to call checkBlueprintHooks with post, run, ${scriptName}`));
        console.log(`DEBUG: run.ts - About to call checkBlueprintHooks with post, run, ${scriptName}`);
        const blueprintPostHookResult = await checkBlueprintHooks('post', 'run', scriptName, ui);
        ui.write(chalk.yellow(`DEBUG: run.ts - checkBlueprintHooks returned: ${blueprintPostHookResult}`));
        console.log(`DEBUG: run.ts - checkBlueprintHooks returned: ${blueprintPostHookResult}`);

        ui.write(chalk.yellow(`DEBUG: run.ts - About to call runNpmHook with post, run, ${scriptName}`));
        console.log(`DEBUG: run.ts - About to call runNpmHook with post, run, ${scriptName}`);
        const postHookResult = await runNpmHook('post', 'run', scriptName, ui);
        ui.write(chalk.yellow(`DEBUG: run.ts - runNpmHook returned: ${JSON.stringify(postHookResult)}`));
        console.log(`DEBUG: run.ts - runNpmHook returned: ${JSON.stringify(postHookResult)}`);

        if (!postHookResult.success) {
            ui.write(chalk.yellowBright(`Warning: post-run hook script failed.`));
        }
    } catch (e) {
        ui.write(chalk.redBright(`Error executing script ${scriptName}: ${(e as Error).message || e}`));
        process.exit(1);
    }
};
