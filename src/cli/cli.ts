#!/usr/bin/env node
import path from 'path';
import { readFile } from 'fs/promises';
import { execSync, ExecSyncOptions } from 'child_process';

import * as dotenv from 'dotenv';
import arg from 'arg';
import chalk from 'chalk';

dotenv.config();

import { snapshot } from './snapshot';
import { create } from './create';
import { run } from './run';
import { build } from './build';
import { set } from './set';
import { test } from './test';
import { verify } from './verify';
import { convert } from './convert';
import { additionalHelpMessages, help } from './help';
import { helpMessages } from './constants';
import { pack } from './pack';
import { InquirerUIProvider } from '../ui/InquirerUIProvider';
import { argSpec, Runner, RunnerContext } from './Runner';
import { getConfig } from '../config/utils';
import { rename } from './rename';
import * as _pkgManagerService from '../pkgManager/service';
import { UIProvider } from '../ui/UIProvider';
import { action } from './action';

// Импортируем команды и действия отдельно
const commands: Record<string, Runner> = {
    create,
    run,
    build,
    set,
    test,
    help,
    verify,
    convert,
    rename,
    pack,
    snapshot,
    action, // Добавляем новую команду action
};

// Helper function to find and run npm lifecycle hooks
// Checks standard hooks first, then standard hooks with arg patterns, then fully custom hooks.
export async function runNpmHook(
    hookType: 'pre' | 'post',
    actualCommand: string, // The actual command invoked (e.g., 'run', 'build')
    actualArg: string | undefined, // The actual first argument passed (e.g., 'deploy-staging')
    ui: UIProvider,
): Promise<{ ran: boolean; success: boolean }> {
    let packageJson: { blueprint?: Record<string, string>; scripts?: Record<string, string> };
    try {
        const packageJsonPath = path.join(process.cwd(), 'package.json');
        const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
        packageJson = JSON.parse(packageJsonContent);
    } catch (_error) {
        return { ran: false, success: true }; // Ignore if no package.json
    }

    // Check scripts in "blueprint" section first
    const scriptsSection = packageJson?.blueprint;

    if (!scriptsSection) {
        return { ran: false, success: true }; // No scripts defined
    }

    // --- 1. Check standard hook (no arg) ---
    const standardHookName = `${hookType}${actualCommand}`;
    if (actualArg === undefined && scriptsSection[standardHookName]) {
        // Standard hook exists and no argument was passed
        ui.write(
            chalk.blue(
                `Executing standard ${hookType}-hook from blueprint section: ${chalk.bold(standardHookName)}...`,
            ),
        );
        try {
            // Get the command from the blueprint section
            const scriptContent = scriptsSection[standardHookName];

            // Prepare environment for the hook script
            const hookEnv = { ...process.env };

            // Execute the command directly
            try {
                execSync(scriptContent, {
                    stdio: 'inherit',
                    env: hookEnv,
                } as ExecSyncOptions);

                ui.write(chalk.green(`Standard ${hookType}-hook script "${standardHookName}" finished successfully.`));
                return { ran: true, success: true }; // Standard hook executed, finish.
            } catch (error) {
                if (error && typeof error === 'object' && 'status' in error) {
                    const status = (error as { status: number }).status;
                    ui.write(
                        chalk.redBright(
                            `Standard ${hookType}-hook script "${standardHookName}" failed with exit code ${status}.`,
                        ),
                    );
                    return { ran: true, success: false };
                }
                throw error;
            }
        } catch (error) {
            ui.write(
                chalk.redBright(`Failed to execute standard ${hookType}-hook script "${standardHookName}": ${error}`),
            );
            return { ran: true, success: false };
        }
    }

    // --- 2. Check standard hook + arg pattern (e.g., prebuild\w+) ---
    if (actualArg !== undefined) {
        // Only check this if an argument was actually passed
        for (const scriptKey in scriptsSection) {
            if (scriptKey.startsWith(standardHookName) && scriptKey !== standardHookName) {
                // Potential match like "prebuild\w+"
                const argPattern = scriptKey.substring(standardHookName.length);

                // Skip if pattern is empty
                if (!argPattern) continue;

                try {
                    const argRegex = new RegExp(`^${argPattern}$`);
                    if (argRegex.test(actualArg)) {
                        // Found a match for argument pattern!
                        ui.write(
                            chalk.blue(
                                `Executing matching ${hookType}-hook from blueprint section: ${chalk.bold(scriptKey)} (command: "${actualCommand}", arg_pattern: "${argPattern}")...`,
                            ),
                        );
                        try {
                            // Get the command from the blueprint section
                            const scriptContent = scriptsSection[scriptKey];

                            // Prepare environment for the hook script
                            const hookEnv = { ...process.env };
                            if (actualArg !== undefined) {
                                // Pass arg for script to use
                                hookEnv.BLUEPRINT_SCRIPT_NAME = actualArg;
                            }

                            // Execute the command directly
                            try {
                                execSync(scriptContent, {
                                    stdio: 'inherit',
                                    env: hookEnv,
                                } as ExecSyncOptions);

                                ui.write(chalk.green(`${hookType}-hook script "${scriptKey}" finished successfully.`));
                                return { ran: true, success: true }; // Executed, finish.
                            } catch (error) {
                                if (error && typeof error === 'object' && 'status' in error) {
                                    const status = (error as { status: number }).status;
                                    ui.write(
                                        chalk.redBright(
                                            `${hookType}-hook script "${scriptKey}" failed with exit code ${status}.`,
                                        ),
                                    );
                                    return { ran: true, success: false };
                                }
                                throw error;
                            }
                        } catch (error) {
                            ui.write(
                                chalk.redBright(`Failed to execute ${hookType}-hook script "${scriptKey}": ${error}`),
                            );
                            return { ran: true, success: false };
                        }
                    }
                } catch (e) {
                    ui.write(
                        chalk.yellow(`Warning: Invalid regex for argument pattern in script key "${scriptKey}": ${e}`),
                    );
                    // Continue searching other keys
                }
            }
        }
    }

    return { ran: false, success: true }; // No matching hook script found
}

/**
 * Выполняет скрипт из package.json
 * @returns true если скрипт был найден и выполнен, false в противном случае
 */
async function runPackageScript(command: string, args: string[], ui: UIProvider): Promise<boolean> {
    try {
        // Используем process.cwd() для определения текущей директории
        const packageJsonPath = path.join(process.cwd(), 'package.json');
        const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(packageJsonContent);

        // Проверяем наличие скрипта с именем команды в секции blueprint
        if (packageJson.blueprint && packageJson.blueprint[command]) {
            ui.write(
                chalk.blue(`Executing script from blueprint section (${packageJsonPath}): ${chalk.bold(command)}`),
            );

            // Проверяем наличие пре-хука перед выполнением скрипта
            ui.write(chalk.gray(`Checking for pre-hook for command '${command}'...`));
            try {
                const preHookResult = await runNpmHook('pre', command, undefined, ui);
                if (!preHookResult.success) {
                    ui.write(chalk.redBright(`Aborting command due to pre-hook failure.`));
                    process.exit(1); // Abort if pre-hook failed
                }
            } catch (e) {
                ui.write(chalk.redBright(`Error during pre-hook execution check: ${(e as Error).message || e}`));
                process.exit(1);
            }

            // Подготавливаем аргументы для передачи скрипту
            const scriptArgs = args.length > 0 ? ` ${args.join(' ')}` : '';

            // Получаем команду из секции blueprint
            const scriptContent = packageJson.blueprint[command];

            try {
                // Заменяем плейсхолдер %scriptArgs% на реальные аргументы, если он есть
                const finalScriptContent = scriptContent.includes('%scriptArgs%')
                    ? scriptContent.replace(/%scriptArgs%/g, args.join(' '))
                    : scriptContent + scriptArgs;

                // Выполняем команду напрямую
                execSync(finalScriptContent, {
                    stdio: 'inherit',
                    env: process.env,
                    cwd: process.cwd(), // Важно: используем текущую директорию
                } as ExecSyncOptions);

                ui.write(chalk.green(`Script "${command}" finished successfully.`));

                // Проверяем наличие пост-хука после выполнения скрипта
                ui.write(chalk.gray(`Checking for post-hook for command '${command}'...`));
                try {
                    const postHookResult = await runNpmHook('post', command, undefined, ui);
                    if (!postHookResult.success) {
                        ui.write(chalk.yellowBright(`Warning: post-hook script failed.`));
                    }
                } catch (e) {
                    ui.write(
                        chalk.yellowBright(`Warning: Error during post-hook execution: ${(e as Error).message || e}`),
                    );
                }

                return true;
            } catch (error) {
                if (error && typeof error === 'object' && 'status' in error) {
                    const status = (error as { status: number }).status;
                    ui.write(chalk.redBright(`Script "${command}" failed with exit code ${status}.`));
                    process.exit(status);
                }
                throw error;
            }
        }
    } catch (error) {
        // Если не удалось прочитать package.json или выполнить скрипт
        ui.write(chalk.yellow(`Warning: Could not run script "${command}" from package.json: ${error}`));
    }

    return false;
}

async function main() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('ts-node/register');

    const args = arg(argSpec, {
        permissive: true,
    });

    if (args._.length === 0) {
        showHelp();
        process.exit(0);
    }

    let effectiveCommands: Record<string, Runner> = {};

    const runnerContext: RunnerContext = {};

    const config = await getConfig();

    try {
        runnerContext.config = config;

        for (const plugin of config?.plugins ?? []) {
            for (const runner of plugin.runners()) {
                effectiveCommands[runner.name] = runner.runner;
                additionalHelpMessages[runner.name] = runner.help;
            }
        }
    } catch (e) {
        // if plugin.runners() throws
        console.error('Could not load one or more plugins');
        console.error(e);
    }

    effectiveCommands = {
        ...effectiveCommands,
        ...commands,
    };

    const command = args._[0];
    const ui = new InquirerUIProvider();

    // Если это команда action, вызываем ее напрямую, без проверки скриптов
    if (command === 'action') {
        const runner = effectiveCommands[command];
        if (!runner) {
            ui.write(chalk.redBright(`Error: command ${command} not found.`));
            showHelp();
            process.exit(1);
        }

        try {
            await runner(args, ui, runnerContext);
        } catch (e) {
            if (e && typeof e === 'object' && 'message' in e) {
                console.error((e as { message: string }).message);
            } else {
                console.error(e);
            }
            process.exit(1);
        }

        ui.close();
        return;
    }

    // Для всех остальных команд сначала пытаемся запустить скрипт из package.json
    // При этом пропускаем команду help, так как она должна работать без скриптов
    if (command !== 'help') {
        // Попытка запустить команду из package.json
        const scriptRan = await runPackageScript(command, args._.slice(1), ui);

        // Если скрипт был найден и выполнен, завершаем работу
        if (scriptRan) {
            ui.close();
            return;
        }
    }

    // Если скрипт не найден, ищем встроенную команду
    const runner = effectiveCommands[command];
    if (!runner) {
        console.log(
            chalk.redBright(`Error: command ${command} not found.`) +
                `\nRunning ${chalk.cyanBright('blueprint help')}...`,
        );
        const helpMessage = helpMessages['help'];
        console.log(helpMessage);
        process.exit(1);
        return;
    }

    try {
        // --- Pre-hook execution ---
        let _preHookRan = false;

        // Запускаем pre-hook без аргументов (например, prerun)
        ui.write(chalk.gray(`Checking for pre-hook for command '${command}'...`));
        const preHookResult = await runNpmHook('pre', command, undefined, ui);
        _preHookRan = preHookResult.ran;
        if (!preHookResult.success) {
            ui.write(chalk.redBright('Aborting command due to pre-hook failure.'));
            process.exit(1); // Прерываем, если pre-hook завершился с ошибкой
        }
        // --- End Pre-hook ---

        await runner(args, ui, runnerContext);

        // --- Post-hook execution ---
        // Запускаем post-hook без аргументов (например, postrun)
        ui.write(chalk.gray(`Checking for post-hook for command '${command}'...`));
        const postHookResult = await runNpmHook('post', command, undefined, ui);
        if (!postHookResult.success) {
            // Не выходим, просто предупреждаем, если post-hook завершился с ошибкой
            ui.write(chalk.yellowBright('Warning: post-hook script failed.'));
        }
        // --- End Post-hook ---
    } catch (e) {
        if (e && typeof e === 'object' && 'message' in e) {
            console.error((e as { message: string }).message);
        } else {
            console.error(e);
        }
        process.exit(1);
    }

    ui.close();
}

process.on('SIGINT', () => {
    process.exit(130);
});

main()
    //.catch(console.error)
    .then(() => process.exit(0));

function showHelp() {
    console.log(
        chalk.blueBright(`
     ____  _    _   _ _____ ____  ____  ___ _   _ _____ 
    | __ )| |  | | | | ____|  _ \\|  _ \\|_ _| \\ | |_   _|
    |  _ \\| |  | | | |  _| | |_) | |_) || ||  \\| | | |  
    | |_) | |__| |_| | |___|  __/|  _ < | || |\\  | | |  
    |____/|_____\\___/|_____|_|   |_| \\_\\___|_| \\_| |_|  `),
    );
    console.log(chalk.blue(`                     TON development for professionals`));
    console.log(``);
    console.log(` Usage: blueprint [OPTIONS] COMMAND [ARGS]`);
    console.log(``);
    console.log(
        chalk.cyanBright(`  blueprint create`) +
            `\t` +
            chalk.whiteBright(`create a new contract with .fc source, .ts wrapper, .spec.ts test`),
    );
    console.log(`\t\t\t` + chalk.gray(`blueprint create ContractName`));

    console.log(
        chalk.cyanBright(`  blueprint build`) +
            `\t` +
            chalk.whiteBright(`builds a contract that has a .compile.ts file`),
    );
    console.log(`\t\t\t` + chalk.gray(`blueprint build ContractName`));

    console.log(
        chalk.cyanBright(`  blueprint test`) +
            `\t` +
            chalk.whiteBright(`run the full project test suite with all .spec.ts files`),
    );
    console.log(`\t\t\t` + chalk.gray(`blueprint test`));

    console.log(
        chalk.cyanBright(`  blueprint run `) +
            `\t` +
            chalk.whiteBright(`runs a script from 'scripts' directory (eg. a deploy script)`),
    );
    console.log(`\t\t\t` + chalk.gray(`blueprint run deployContractName`));

    console.log(
        chalk.cyanBright(`  blueprint action`) +
            `\t` +
            chalk.whiteBright(`execute a command directly without running npm scripts`),
    );
    console.log(`\t\t\t` + chalk.gray(`blueprint action build ContractName`));

    console.log(
        chalk.cyanBright(`  blueprint help`) +
            `\t` +
            chalk.whiteBright(`shows more detailed help, also see https://github.com/ton-ai-core/blueprint2`),
    );
    console.log(`\t\t\t` + chalk.gray(`blueprint help`));

    console.log(``);
}
