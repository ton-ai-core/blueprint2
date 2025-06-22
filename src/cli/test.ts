import process from 'process';

import arg from 'arg';
import chalk from 'chalk';

import { Runner } from './Runner';
import { helpArgs, helpMessages } from './constants';
import * as pkgManagerService from '../pkgManager/service';
import { runNpmHook, checkBlueprintHooks } from './cli';

export const test: Runner = async (args, ui) => {
    // Отладочный вывод для проверки аргументов
    ui.write(chalk.yellow(`DEBUG: test.ts received args: ${JSON.stringify(args._)}`));
    console.log(`DEBUG: test.ts received args: ${JSON.stringify(args._)}`);
    console.log(`DEBUG: test.ts - Environment variable BLUEPRINT_SCRIPT_NAME=${process.env.BLUEPRINT_SCRIPT_NAME}`);

    const localArgs = arg(helpArgs);
    if (localArgs['--help']) {
        ui.write(helpMessages['test']);
        return;
    }

    // Use positional arguments after the 'test' command
    const testArgs = args._.slice(1); // first argument is 'test', needs to be removed
    const testName = testArgs.join(' ');

    ui.write(chalk.yellow(`DEBUG: test.ts - Using test name: ${testName || '(all tests)'}`));
    console.log(`DEBUG: test.ts - Using test name: ${testName || '(all tests)'}`);

    // Передаем имя контракта в переменные окружения
    process.env.BLUEPRINT_SCRIPT_NAME = testName || 'all';
    ui.write(chalk.yellow(`DEBUG: test.ts - Setting BLUEPRINT_SCRIPT_NAME to: ${process.env.BLUEPRINT_SCRIPT_NAME}`));
    console.log(`DEBUG: test.ts - Setting BLUEPRINT_SCRIPT_NAME to: ${process.env.BLUEPRINT_SCRIPT_NAME}`);

    // Теперь, когда у нас есть имя теста, вызываем pre-хуки
    ui.write(chalk.yellow(`DEBUG: test.ts - About to call checkBlueprintHooks with pre, test, ${testName}`));
    console.log(`DEBUG: test.ts - About to call checkBlueprintHooks with pre, test, ${testName}`);
    const blueprintPreHookResult = await checkBlueprintHooks('pre', 'test', testName, ui);
    ui.write(chalk.yellow(`DEBUG: test.ts - checkBlueprintHooks returned: ${blueprintPreHookResult}`));
    console.log(`DEBUG: test.ts - checkBlueprintHooks returned: ${blueprintPreHookResult}`);

    ui.write(chalk.yellow(`DEBUG: test.ts - About to call runNpmHook with pre, test, ${testName}`));
    console.log(`DEBUG: test.ts - About to call runNpmHook with pre, test, ${testName}`);
    const preHookResult = await runNpmHook('pre', 'test', testName, ui);
    ui.write(chalk.yellow(`DEBUG: test.ts - runNpmHook returned: ${JSON.stringify(preHookResult)}`));
    console.log(`DEBUG: test.ts - runNpmHook returned: ${JSON.stringify(preHookResult)}`);

    if (!preHookResult.success) {
        ui.write(chalk.redBright(`Aborting command due to pre-test hook failure.`));
        process.exit(1);
    }

    ui.write(`Running tests ${testName ? `for ${testName}` : ''}`);

    try {
        // Use the service to run the test command with arguments
        const result = pkgManagerService.runCommand('test', testArgs);
        if (result.status !== 0) {
            // Exit with the same status code as the test runner if it failed
            process.exit(result.status ?? 1);
        }

        ui.write(chalk.yellow(`DEBUG: test.ts - About to call checkBlueprintHooks with post, test, ${testName}`));
        console.log(`DEBUG: test.ts - About to call checkBlueprintHooks with post, test, ${testName}`);
        const blueprintPostHookResult = await checkBlueprintHooks('post', 'test', testName, ui);
        ui.write(chalk.yellow(`DEBUG: test.ts - checkBlueprintHooks returned: ${blueprintPostHookResult}`));
        console.log(`DEBUG: test.ts - checkBlueprintHooks returned: ${blueprintPostHookResult}`);

        ui.write(chalk.yellow(`DEBUG: test.ts - About to call runNpmHook with post, test, ${testName}`));
        console.log(`DEBUG: test.ts - About to call runNpmHook with post, test, ${testName}`);
        const postHookResult = await runNpmHook('post', 'test', testName, ui);
        ui.write(chalk.yellow(`DEBUG: test.ts - runNpmHook returned: ${JSON.stringify(postHookResult)}`));
        console.log(`DEBUG: test.ts - runNpmHook returned: ${JSON.stringify(postHookResult)}`);

        if (!postHookResult.success) {
            ui.write(chalk.yellowBright(`Warning: post-test hook script failed.`));
        }
    } catch (e) {
        // Handle potential errors during command execution
        ui.write(chalk.redBright(`Failed to run test command: ${(e as Error).message || e}`));
        process.exit(1);
    }
};
