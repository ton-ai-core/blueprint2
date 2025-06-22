#!/usr/bin/env node
import path from 'path';
import { readFile } from 'fs/promises';
import { spawnSync } from 'child_process';

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
import * as pkgManagerService from '../pkgManager/service';
import { UIProvider } from '../ui/UIProvider';

const runners: Record<string, Runner> = {
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
};

// Helper function to find and run npm lifecycle hooks
// Checks standard hooks first, then standard hooks with arg patterns, then fully custom hooks.
export async function runNpmHook(
    hookType: 'pre' | 'post',
    actualCommand: string, // The actual command invoked (e.g., 'run', 'build')
    actualArg: string | undefined, // The actual first argument passed (e.g., 'deploy-staging')
    ui: UIProvider,
): Promise<{ ran: boolean; success: boolean }> {
    console.log('FUNCTION CALLED: runNpmHook');
    console.log(`Parameters: hookType=${hookType}, actualCommand=${actualCommand}, actualArg=${actualArg}`);
    console.log(`Environment: BLUEPRINT_SCRIPT_NAME=${process.env.BLUEPRINT_SCRIPT_NAME}`);

    // Отладочный вывод
    ui.write(
        chalk.yellow(`DEBUG: runNpmHook called with hookType=${hookType}, command=${actualCommand}, arg=${actualArg}`),
    );

    let packageJson: any;
    try {
        const packageJsonPath = path.join(process.cwd(), 'package.json');
        const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
        packageJson = JSON.parse(packageJsonContent);
    } catch (_error) {
        return { ran: false, success: true }; // Ignore if no package.json
    }

    if (!packageJson?.scripts) {
        return { ran: false, success: true }; // No scripts defined
    }

    // --- 1. Check standard hook (no arg) ---
    const standardHookName = `${hookType}${actualCommand}`;
    if (actualArg === undefined && packageJson.scripts[standardHookName]) {
        // Standard hook exists and no argument was passed
        const packageManager = pkgManagerService.detectPackageManager();
        ui.write(
            chalk.blue(
                `Executing standard ${hookType}-hook: ${chalk.bold(`${packageManager} run ${standardHookName}`)}...`,
            ),
        );
        try {
            // Standard hooks likely don't contain regex chars, but escaping doesn't hurt
            const escapedStandardHookName = standardHookName.replace(/\\/g, '\\\\');
            // No argument to pass for standard hooks triggered without args
            const result = pkgManagerService.runCommand('run', [escapedStandardHookName]);
            if (result.status !== 0) {
                ui.write(
                    chalk.redBright(
                        `Standard ${hookType}-hook script "${standardHookName}" failed with exit code ${result.status}.`,
                    ),
                );
                return { ran: true, success: false };
            }
            ui.write(
                chalk.green(
                    `Standard ${hookType}-hook script "${standardHookName}" finished successfully using ${packageManager}.`,
                ),
            );
            return { ran: true, success: true }; // Standard hook executed, finish.
        } catch (error) {
            ui.write(
                chalk.redBright(`Failed to execute standard ${hookType}-hook script "${standardHookName}": ${error}`),
            );
            return { ran: true, success: false };
        }
    }

    // --- 2. Check standard hook + arg pattern (e.g., prebuild\w+ or postbuild:\w+) ---
    if (actualArg !== undefined) {
        // Only check this if an argument was actually passed
        for (const scriptKey in packageJson.scripts) {
            if (scriptKey.startsWith(standardHookName) && scriptKey !== standardHookName) {
                // Potential match like "prebuild\w+" or "postbuild:\w+"
                let argPattern = scriptKey.substring(standardHookName.length);

                // If pattern starts with ':', remove it for regex matching
                if (argPattern.startsWith(':')) {
                    argPattern = argPattern.substring(1);
                }

                if (!argPattern) continue; // Skip if pattern is empty after removing colon

                try {
                    const argRegex = new RegExp(`^${argPattern}$`);
                    if (argRegex.test(actualArg)) {
                        // Found a match for argument pattern!
                        const packageManager = pkgManagerService.detectPackageManager();
                        // Use the original scriptKey (e.g., "postbuild:\w+") for execution message and command
                        ui.write(
                            chalk.blue(
                                `Executing matching ${hookType}-hook: ${chalk.bold(`${packageManager} run ${scriptKey}`)} (command: "${actualCommand}", arg_pattern: "${argPattern}")...`,
                            ),
                        );
                        try {
                            // Prepare environment for the hook script
                            const hookEnv = { ...process.env };
                            if (actualArg !== undefined) {
                                // Pass arg even if not used by specific hook
                                hookEnv.BLUEPRINT_SCRIPT_NAME = actualArg;
                            }
                            // Escape backslashes in the script key for shell execution
                            const escapedScriptKey = scriptKey.replace(/\\/g, '\\\\');
                            const result = pkgManagerService.runCommand('run', [escapedScriptKey], { env: hookEnv });

                            if (result.status !== 0) {
                                ui.write(
                                    chalk.redBright(
                                        `${hookType}-hook script "${scriptKey}" failed with exit code ${result.status}.`,
                                    ),
                                );
                                return { ran: true, success: false };
                            }
                            ui.write(
                                chalk.green(
                                    `${hookType}-hook script "${scriptKey}" finished successfully using ${packageManager}.`,
                                ),
                            );
                            return { ran: true, success: true }; // Executed, finish.
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

    // --- 3. Check fully custom hooks (e.g., pre:build:.*) ---
    const customHookPrefix = `${hookType}:`; // e.g., 'pre:'
    // Iterate through all script keys in package.json
    for (const scriptKey in packageJson.scripts) {
        if (scriptKey.startsWith(customHookPrefix)) {
            const patternPart = scriptKey.substring(customHookPrefix.length);
            const lastColonIndex = patternPart.lastIndexOf(':');

            let commandPattern: string;
            let argPattern: string | null;

            if (lastColonIndex !== -1) {
                commandPattern = patternPart.substring(0, lastColonIndex);
                argPattern = patternPart.substring(lastColonIndex + 1);
            } else {
                // Case like "prebuild" (no argument pattern specified)
                commandPattern = patternPart;
                argPattern = null;
            }

            if (!commandPattern) continue; // Skip if command pattern is empty (e.g., "pre::something")

            try {
                const commandRegex = new RegExp(`^${commandPattern}$`);

                // Check if command matches
                if (commandRegex.test(actualCommand)) {
                    let argMatches = false;
                    if (argPattern === null) {
                        // If no arg pattern, match only if no arg was passed
                        argMatches = actualArg === undefined;
                    } else if (actualArg !== undefined) {
                        // If arg pattern exists and arg was passed, test regex
                        try {
                            const argRegex = new RegExp(`^${argPattern}$`);
                            argMatches = argRegex.test(actualArg);
                        } catch (e) {
                            ui.write(
                                chalk.yellow(
                                    `Warning: Invalid regex for argument pattern in script key "${scriptKey}": ${e}`,
                                ),
                            );
                            continue; // Skip this key if arg regex is invalid
                        }
                    } // Else: argPattern exists, but no actualArg was passed -> no match

                    if (argMatches) {
                        // Found the first matching hook key for both command and argument
                        const packageManager = pkgManagerService.detectPackageManager();
                        ui.write(
                            chalk.blue(
                                `Executing matching ${hookType}-hook: ${chalk.bold(`${packageManager} run ${scriptKey}`)} (cmd_pattern: "${commandPattern}", arg_pattern: "${argPattern ?? 'null'}")...`,
                            ),
                        );
                        try {
                            // Prepare environment for the hook script
                            const hookEnv = { ...process.env };
                            if (actualArg !== undefined) {
                                hookEnv.BLUEPRINT_SCRIPT_NAME = actualArg;
                            }
                            // Escape backslashes in the script key for shell execution
                            const escapedScriptKey = scriptKey.replace(/\\/g, '\\\\');
                            const result = pkgManagerService.runCommand('run', [escapedScriptKey], { env: hookEnv });

                            if (result.status !== 0) {
                                ui.write(
                                    chalk.redBright(
                                        `${hookType}-hook script "${scriptKey}" failed with exit code ${result.status}.`,
                                    ),
                                );
                                return { ran: true, success: false };
                            }
                            ui.write(
                                chalk.green(
                                    `${hookType}-hook script "${scriptKey}" finished successfully using ${packageManager}.`,
                                ),
                            );
                            return { ran: true, success: true }; // Return after executing the first match
                        } catch (error) {
                            ui.write(
                                chalk.redBright(`Failed to execute ${hookType}-hook script "${scriptKey}": ${error}`),
                            );
                            return { ran: true, success: false };
                        }
                    }
                }
            } catch (e) {
                // Ignore invalid regex patterns for the command part
                ui.write(chalk.yellow(`Warning: Invalid regex for command pattern in script key "${scriptKey}": ${e}`));
            }
        }
    }

    // Отладочный вывод всех ключей в секции blueprint
    ui.write(chalk.yellow(`DEBUG: Available hooks: ${Object.keys(packageJson.blueprint).join(', ')}`));

    // Дополнительный отладочный вывод для хуков с регулярными выражениями
    ui.write(chalk.yellow(`DEBUG: Looking for hooks with regex patterns...`));
    for (const key in packageJson.blueprint) {
        if (/\\w/.test(key)) {
            ui.write(chalk.yellow(`DEBUG: Found hook with regex pattern: ${key}`));

            // Проверяем, начинается ли ключ с нужного префикса
            const prefixWithoutDash = `${hookType}${actualCommand}:`;
            const prefixWithoutColon = `${hookType}${actualCommand}`;
            if (key.startsWith(prefixWithoutDash)) {
                ui.write(chalk.yellow(`DEBUG: Hook ${key} matches prefix ${prefixWithoutDash}`));
            } else if (key.startsWith(prefixWithoutColon)) {
                ui.write(chalk.yellow(`DEBUG: Hook ${key} matches prefix ${prefixWithoutColon}`));
            }
        }
    }

    // Проверяем формат с регулярными выражениями (prerun:\w+)
    if (actualArg !== undefined) {
        // Формат без дефиса (например, prerun:deploy\w+)
        const prefixWithoutDash = `${hookType}${actualCommand}:`;
        ui.write(chalk.yellow(`DEBUG: Looking for hooks starting with prefix: ${prefixWithoutDash}`));

        for (const key in packageJson.blueprint) {
            if (key.startsWith(prefixWithoutDash)) {
                const patternPart = key.substring(prefixWithoutDash.length);
                ui.write(chalk.yellow(`DEBUG: Found key ${key} with pattern part: ${patternPart}`));

                try {
                    const argRegex = new RegExp(`^${patternPart}$`);
                    ui.write(chalk.yellow(`DEBUG: Testing arg "${actualArg}" against regex: ^${patternPart}$`));
                    if (argRegex.test(actualArg)) {
                        // Нашли совпадение!
                        const hookCommand = packageJson.blueprint[key];
                        ui.write(
                            chalk.blue(
                                `Executing blueprint ${hookType}-hook with pattern: ${chalk.bold(hookCommand)} (pattern: "${patternPart}")`,
                            ),
                        );

                        // Заменяем $BLUEPRINT_SCRIPT_NAME на фактическое имя скрипта/контракта
                        const processedCommand = actualArg
                            ? hookCommand.replace(/\$BLUEPRINT_SCRIPT_NAME/g, actualArg)
                            : hookCommand;

                        // Подготовка окружения для хука
                        const env = { ...process.env };
                        if (actualArg) {
                            env.BLUEPRINT_SCRIPT_NAME = actualArg;
                        }

                        // Запускаем хук напрямую через shell
                        const result = spawnSync(processedCommand, [], {
                            shell: true,
                            stdio: 'inherit',
                            cwd: process.cwd(),
                            env,
                        });

                        if (result.status !== 0) {
                            ui.write(
                                chalk.redBright(
                                    `Blueprint ${hookType}-hook "${processedCommand}" failed with exit code ${result.status}.`,
                                ),
                            );
                            return { ran: true, success: false };
                        }

                        ui.write(
                            chalk.green(`Blueprint ${hookType}-hook "${processedCommand}" finished successfully.`),
                        );
                        return { ran: true, success: true };
                    }
                } catch (e) {
                    ui.write(chalk.yellow(`Warning: Invalid regex pattern in hook key "${key}": ${e}`));
                    // Продолжаем проверку других ключей
                }
            }
        }

        // Проверяем формат с регулярными выражениями без двоеточия (prebuild\w+)
        const prefixWithoutColon = `${hookType}${actualCommand}`;
        ui.write(chalk.yellow(`DEBUG: Looking for hooks starting with prefix without colon: ${prefixWithoutColon}`));

        // Отладочный вывод всех ключей в секции blueprint
        ui.write(chalk.yellow(`DEBUG: All blueprint keys: ${Object.keys(packageJson.blueprint).join(', ')}`));

        for (const key in packageJson.blueprint) {
            // Проверяем, что ключ начинается с префикса
            if (key.startsWith(prefixWithoutColon)) {
                ui.write(chalk.yellow(`DEBUG: Found key starting with ${prefixWithoutColon}: ${key}`));

                // Проверяем, содержит ли ключ регулярное выражение
                if (/\\w/.test(key)) {
                    ui.write(chalk.yellow(`DEBUG: Key contains regex pattern: ${key}`));

                    try {
                        // Извлекаем регулярное выражение из ключа
                        // Например, из "prebuild\\w+" получаем "\\w+"
                        const regexPart = key.substring(prefixWithoutColon.length);
                        ui.write(chalk.yellow(`DEBUG: Extracted regex part: ${regexPart}`));

                        // Создаем регулярное выражение для проверки аргумента
                        const argRegex = new RegExp(`^${regexPart}$`);
                        ui.write(chalk.yellow(`DEBUG: Testing arg "${actualArg}" against regex: ^${regexPart}$`));

                        if (actualArg && argRegex.test(actualArg)) {
                            ui.write(
                                chalk.green(`DEBUG: Argument "${actualArg}" matches regex pattern "${regexPart}"`),
                            );

                            // Нашли совпадение!
                            const hookCommand = packageJson.blueprint[key];
                            ui.write(
                                chalk.blue(
                                    `Executing blueprint ${hookType}-hook with pattern (no colon): ${chalk.bold(hookCommand)} (pattern: "${regexPart}")`,
                                ),
                            );

                            // Заменяем $BLUEPRINT_SCRIPT_NAME на фактическое имя скрипта/контракта
                            const processedCommand = actualArg
                                ? hookCommand.replace(/\$BLUEPRINT_SCRIPT_NAME/g, actualArg)
                                : hookCommand;

                            // Подготовка окружения для хука
                            const env = { ...process.env };
                            if (actualArg) {
                                env.BLUEPRINT_SCRIPT_NAME = actualArg;
                            }

                            // Запускаем хук напрямую через shell
                            const result = spawnSync(processedCommand, [], {
                                shell: true,
                                stdio: 'inherit',
                                cwd: process.cwd(),
                                env,
                            });

                            if (result.status !== 0) {
                                ui.write(
                                    chalk.redBright(
                                        `Blueprint ${hookType}-hook "${processedCommand}" failed with exit code ${result.status}.`,
                                    ),
                                );
                                return { ran: true, success: false };
                            }

                            ui.write(
                                chalk.green(`Blueprint ${hookType}-hook "${processedCommand}" finished successfully.`),
                            );
                            return { ran: true, success: true };
                        } else {
                            ui.write(
                                chalk.yellow(
                                    `DEBUG: Argument "${actualArg}" does NOT match regex pattern "${regexPart}"`,
                                ),
                            );
                        }
                    } catch (e) {
                        ui.write(chalk.yellow(`Warning: Invalid regex pattern in hook key "${key}": ${e}`));
                        // Продолжаем проверку других ключей
                    }
                } else {
                    ui.write(chalk.yellow(`DEBUG: Key does not contain regex pattern: ${key}`));
                }
            }
        }
    }

    return { ran: false, success: true }; // No matching hook script found
}

// Функция для проверки наличия хуков в секции blueprint package.json
export async function checkBlueprintHooks(
    hookType: 'pre' | 'post',
    command: string,
    arg: string | undefined,
    ui: UIProvider,
): Promise<boolean> {
    console.log('FUNCTION CALLED: checkBlueprintHooks');
    console.log(`Parameters: hookType=${hookType}, command=${command}, arg=${arg}`);
    console.log(`Environment: BLUEPRINT_SCRIPT_NAME=${process.env.BLUEPRINT_SCRIPT_NAME}`);

    // Проверяем, вызвана ли команда через `action`
    const invokedFromAction = process.argv.slice(2).includes('action');
    if (invokedFromAction) {
        ui.write(chalk.gray(`Invoked via action command; skipping ${hookType}-hooks for ${command}.`));
        return true; // Возвращаем true, чтобы продолжить выполнение
    }

    // Отладочный вывод для проверки аргументов
    ui.write(
        chalk.yellow(`DEBUG: checkBlueprintHooks called with hookType=${hookType}, command=${command}, arg=${arg}`),
    );
    console.log(`DEBUG: checkBlueprintHooks called with hookType=${hookType}, command=${command}, arg=${arg}`);

    // Отладочный вывод для проверки переменной окружения
    ui.write(
        chalk.yellow(
            `DEBUG: checkBlueprintHooks - Environment variable BLUEPRINT_SCRIPT_NAME=${process.env.BLUEPRINT_SCRIPT_NAME}`,
        ),
    );
    console.log(
        `DEBUG: checkBlueprintHooks - Environment variable BLUEPRINT_SCRIPT_NAME=${process.env.BLUEPRINT_SCRIPT_NAME}`,
    );

    let packageJson: any;
    try {
        const packageJsonPath = path.join(process.cwd(), 'package.json');
        const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
        packageJson = JSON.parse(packageJsonContent);
    } catch (_error) {
        return false; // Ignore if no package.json
    }

    if (!packageJson?.blueprint) {
        return false; // No blueprint section defined
    }

    // Отладочный вывод всех ключей в секции blueprint
    ui.write(chalk.yellow(`DEBUG: Available hooks: ${Object.keys(packageJson.blueprint).join(', ')}`));
    console.log(`DEBUG: Available hooks: ${Object.keys(packageJson.blueprint).join(', ')}`);

    // Проверяем формат с регулярными выражениями (prerun:\w+)
    ui.write(chalk.yellow(`DEBUG: Looking for hooks with regex patterns...`));
    console.log(`DEBUG: Looking for hooks with regex patterns...`);

    // Сначала проверяем точное совпадение
    const exactHookName = `${hookType}${command}`;
    if (packageJson.blueprint[exactHookName]) {
        ui.write(chalk.yellow(`DEBUG: Found exact match hook: ${exactHookName}`));
        console.log(`DEBUG: Found exact match hook: ${exactHookName}`);

        const hookCommand = packageJson.blueprint[exactHookName];
        ui.write(chalk.blue(`Executing blueprint ${hookType}-hook: ${chalk.bold(hookCommand)}`));

        // Заменяем $BLUEPRINT_SCRIPT_NAME на фактическое имя скрипта/контракта
        const processedCommand = arg ? hookCommand.replace(/\$BLUEPRINT_SCRIPT_NAME/g, arg) : hookCommand;

        // Подготовка окружения для хука
        const env = { ...process.env };
        if (arg) {
            env.BLUEPRINT_SCRIPT_NAME = arg;
        }

        // Запускаем хук напрямую через shell
        const result = spawnSync(processedCommand, [], {
            shell: true,
            stdio: 'inherit',
            cwd: process.cwd(),
            env,
        });

        if (result.status !== 0) {
            ui.write(
                chalk.redBright(
                    `Blueprint ${hookType}-hook "${processedCommand}" failed with exit code ${result.status}.`,
                ),
            );
            return false;
        }

        ui.write(chalk.green(`Blueprint ${hookType}-hook "${processedCommand}" finished successfully.`));
        return true;
    }

    // Затем проверяем регулярные выражения
    for (const key in packageJson.blueprint) {
        // Проверяем формат с регулярными выражениями (например, prebuild\w+)
        if (key.startsWith(hookType + command) && key !== exactHookName) {
            ui.write(chalk.yellow(`DEBUG: Found hook with regex pattern: ${key}`));
            console.log(`DEBUG: Found hook with regex pattern: ${key}`);

            // Извлекаем часть с регулярным выражением
            const regexPart = key.substring((hookType + command).length);

            // Проверяем, начинается ли с двоеточия
            const hasColon = regexPart.startsWith(':');
            const cleanRegexPart = hasColon ? regexPart.substring(1) : regexPart;

            ui.write(chalk.yellow(`DEBUG: Hook ${key} matches prefix ${hookType}${command}`));
            console.log(`DEBUG: Hook ${key} matches prefix ${hookType}${command}`);

            if (cleanRegexPart) {
                try {
                    const argRegex = new RegExp(`^${cleanRegexPart}$`);

                    // Если аргумент не передан, но регулярное выражение требует его, пропускаем
                    if (!arg) {
                        ui.write(
                            chalk.yellow(
                                `DEBUG: No argument provided, but regex pattern requires it: ${cleanRegexPart}`,
                            ),
                        );
                        console.log(`DEBUG: No argument provided, but regex pattern requires it: ${cleanRegexPart}`);
                        continue;
                    }

                    ui.write(chalk.yellow(`DEBUG: Testing argument "${arg}" against regex: ^${cleanRegexPart}$`));
                    console.log(`DEBUG: Testing argument "${arg}" against regex: ^${cleanRegexPart}$`);

                    if (argRegex.test(arg)) {
                        ui.write(chalk.green(`DEBUG: Argument "${arg}" matches regex pattern "${cleanRegexPart}"`));
                        console.log(`DEBUG: Argument "${arg}" matches regex pattern "${cleanRegexPart}"`);

                        // Нашли совпадение!
                        const hookCommand = packageJson.blueprint[key];
                        ui.write(
                            chalk.blue(`Executing blueprint ${hookType}-hook with pattern: ${chalk.bold(hookCommand)}`),
                        );

                        // Заменяем $BLUEPRINT_SCRIPT_NAME на фактическое имя скрипта/контракта
                        const processedCommand = hookCommand.replace(/\$BLUEPRINT_SCRIPT_NAME/g, arg);

                        // Подготовка окружения для хука
                        const env = { ...process.env };
                        env.BLUEPRINT_SCRIPT_NAME = arg;

                        // Запускаем хук напрямую через shell
                        const result = spawnSync(processedCommand, [], {
                            shell: true,
                            stdio: 'inherit',
                            cwd: process.cwd(),
                            env,
                        });

                        if (result.status !== 0) {
                            ui.write(
                                chalk.redBright(
                                    `Blueprint ${hookType}-hook "${processedCommand}" failed with exit code ${result.status}.`,
                                ),
                            );
                            return false;
                        }

                        ui.write(
                            chalk.green(`Blueprint ${hookType}-hook "${processedCommand}" finished successfully.`),
                        );
                        return true;
                    } else {
                        ui.write(
                            chalk.yellow(`DEBUG: Argument "${arg}" does NOT match regex pattern "${cleanRegexPart}"`),
                        );
                        console.log(`DEBUG: Argument "${arg}" does NOT match regex pattern "${cleanRegexPart}"`);
                    }
                } catch (e) {
                    ui.write(chalk.yellow(`Warning: Invalid regex pattern in hook key "${key}": ${e}`));
                    console.log(`Warning: Invalid regex pattern in hook key "${key}": ${e}`);
                    // Продолжаем проверку других ключей
                }
            }
        }
    }

    return false; // No matching hook script found
}

async function executeBlueprintCommand(
    commandToRun: string,
    originalCommandName: string,
    ui: UIProvider,
    args: arg.Result<any>,
): Promise<boolean> {
    try {
        const firstArg = args._.length > 1 ? args._[1] : undefined;

        ui.write(chalk.yellow(`DEBUG: executeBlueprintCommand with command=${originalCommandName}, arg=${firstArg}`));
        console.log(`DEBUG: executeBlueprintCommand with command=${originalCommandName}, arg=${firstArg}`);

        ui.write(
            chalk.yellow(
                `DEBUG: executeBlueprintCommand - Environment variable BLUEPRINT_SCRIPT_NAME=${process.env.BLUEPRINT_SCRIPT_NAME}`,
            ),
        );
        console.log(
            `DEBUG: executeBlueprintCommand - Environment variable BLUEPRINT_SCRIPT_NAME=${process.env.BLUEPRINT_SCRIPT_NAME}`,
        );

        // Если у нас есть аргумент (имя контракта/скрипта), устанавливаем переменную окружения
        if (firstArg) {
            process.env.BLUEPRINT_SCRIPT_NAME = firstArg;
            ui.write(chalk.yellow(`DEBUG: executeBlueprintCommand - Setting BLUEPRINT_SCRIPT_NAME to ${firstArg}`));
            console.log(`DEBUG: executeBlueprintCommand - Setting BLUEPRINT_SCRIPT_NAME to ${firstArg}`);

            // --- Pre-hook Execution ---
            const blueprintPreHookResult = await checkBlueprintHooks('pre', originalCommandName, firstArg, ui);
            ui.write(
                chalk.yellow(
                    `DEBUG: executeBlueprintCommand - checkBlueprintHooks returned: ${blueprintPreHookResult}`,
                ),
            );
            console.log(`DEBUG: executeBlueprintCommand - checkBlueprintHooks returned: ${blueprintPreHookResult}`);

            // Вызываем стандартные npm-хуки
            const preHookResult = await runNpmHook('pre', commandToRun, firstArg, ui);
            if (!preHookResult.success) {
                ui.write(chalk.redBright(`Aborting command due to pre-hook failure.`));
                process.exit(1);
            }
            // --- End Pre-hook ---
        } else {
            console.log(
                `DEBUG: executeBlueprintCommand - No argument provided, skipping pre-hooks until interactive selection`,
            );
        }

        // Запускаем основную команду
        await runners[commandToRun](args, ui, {});

        // После выполнения основной команды, переменная окружения BLUEPRINT_SCRIPT_NAME должна быть установлена
        // из интерактивного режима в самой команде (build.ts, run.ts, test.ts)
        const scriptName = process.env.BLUEPRINT_SCRIPT_NAME;
        console.log(`DEBUG: executeBlueprintCommand - After runner, BLUEPRINT_SCRIPT_NAME=${scriptName}`);

        // Если имя скрипта/контракта не было установлено в основной команде, пропускаем post-хуки
        if (!scriptName) {
            console.log(
                `DEBUG: executeBlueprintCommand - BLUEPRINT_SCRIPT_NAME not set after runner, skipping post-hooks`,
            );
            return true;
        }

        // --- Post-hook Execution ---
        // Вызываем стандартные npm-хуки
        const postHookResult = await runNpmHook('post', commandToRun, scriptName, ui);
        if (!postHookResult.success) {
            // Don't exit, just warn if post-hook fails
            ui.write(chalk.yellowBright('Warning: post-hook script failed.'));
        }

        // Вызываем blueprint post-хуки
        const blueprintPostHookResult = await checkBlueprintHooks('post', originalCommandName, scriptName, ui);
        ui.write(
            chalk.yellow(
                `DEBUG: executeBlueprintCommand - post checkBlueprintHooks returned: ${blueprintPostHookResult}`,
            ),
        );
        console.log(`DEBUG: executeBlueprintCommand - post checkBlueprintHooks returned: ${blueprintPostHookResult}`);
        // --- End Post-hook ---

        return true;
    } catch (e) {
        if (e && typeof e === 'object' && 'message' in e) {
            console.error((e as any).message);
        } else {
            console.error(e);
        }
        process.exit(1);
        return false;
    }
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

    let effectiveRunners: Record<string, Runner> = {};

    const runnerContext: RunnerContext = {};

    const config = await getConfig();

    try {
        runnerContext.config = config;

        for (const plugin of config?.plugins ?? []) {
            for (const runner of plugin.runners()) {
                effectiveRunners[runner.name] = runner.runner;
                additionalHelpMessages[runner.name] = runner.help;
            }
        }
    } catch (e) {
        // if plugin.runners() throws
        console.error('Could not load one or more plugins');
        console.error(e);
    }

    effectiveRunners = {
        ...effectiveRunners,
        ...runners,
    };

    const command = args._[0];

    const runner = effectiveRunners[command];
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

    const ui = new InquirerUIProvider();

    try {
        await executeBlueprintCommand(command, command, ui, args);
    } catch (e) {
        if (e && typeof e === 'object' && 'message' in e) {
            console.error((e as any).message);
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
    console.log(chalk.bold.whiteBright(`Blueprint - TON Smart Contract Development Environment`));
    console.log(chalk.gray(`Usage: blueprint [command] [args]`));
    console.log(``);
    console.log(chalk.whiteBright(`Commands:`));

    console.log(
        chalk.cyanBright(`  blueprint build`) + `\t` + chalk.whiteBright(`compiles contracts to build/ directory`),
    );
    console.log(`\t\t\t` + chalk.gray(`blueprint build ContractName`));

    console.log(
        chalk.cyanBright(`  blueprint create`) + `\t` + chalk.whiteBright(`creates a new contract from template`),
    );
    console.log(`\t\t\t` + chalk.gray(`blueprint create ContractName`));

    console.log(
        chalk.cyanBright(`  blueprint run `) +
            `\t` +
            chalk.whiteBright(`runs a script from 'scripts' directory (eg. a deploy script)`),
    );
    console.log(`\t\t\t` + chalk.gray(`blueprint run deployContractName`));

    console.log(
        chalk.cyanBright(`  blueprint help`) +
            `\t` +
            chalk.whiteBright(`shows more detailed help, also see https://github.com/ton-ai-core/blueprint2`),
    );
    console.log(`\t\t\t` + chalk.gray(`blueprint help`));

    console.log(``);
}
