#!/usr/bin/env node
import * as dotenv from 'dotenv';
dotenv.config();
import arg from 'arg';
import chalk from 'chalk';
import { create } from './create';
import { run } from './run';
import { build } from './build';
import { set } from './set';
import { test } from './test';
import { verify } from './verify';
import { convert } from './convert';
import {additionalHelpMessages, help} from './help';
import { helpMessages } from './constants';
import { InquirerUIProvider } from '../ui/InquirerUIProvider';
import { argSpec, Runner, RunnerContext } from './Runner';
import { getConfig } from '../config/utils';
import { spawnSync } from 'child_process';
import { readFile } from 'fs/promises';
import path from 'path';
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
};

// Helper function to find and run npm lifecycle hooks
// Checks standard hooks first, then standard hooks with arg patterns, then fully custom hooks.
export async function runNpmHook(
    hookType: 'pre' | 'post',
    actualCommand: string,       // The actual command invoked (e.g., 'run', 'build')
    actualArg: string | undefined, // The actual first argument passed (e.g., 'deploy-staging')
    ui: UIProvider
): Promise<{ ran: boolean; success: boolean }> {

    let packageJson: any;
    try {
        const packageJsonPath = path.join(process.cwd(), 'package.json');
        const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
        packageJson = JSON.parse(packageJsonContent);
    } catch (error) {
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
        ui.write(chalk.blue(`Executing standard ${hookType}-hook: ${chalk.bold(`${packageManager} run ${standardHookName}`)}...`));
        try {
            // Standard hooks likely don't contain regex chars, but escaping doesn't hurt
            const escapedStandardHookName = standardHookName.replace(/\\/g, '\\\\');
            // No argument to pass for standard hooks triggered without args
            const result = pkgManagerService.runCommand('run', [escapedStandardHookName]);
            if (result.status !== 0) {
                ui.write(chalk.redBright(`Standard ${hookType}-hook script "${standardHookName}" failed with exit code ${result.status}.`));
                return { ran: true, success: false };
            }
            ui.write(chalk.green(`Standard ${hookType}-hook script "${standardHookName}" finished successfully using ${packageManager}.`));
            return { ran: true, success: true }; // Standard hook executed, finish.
        } catch (error) {
            ui.write(chalk.redBright(`Failed to execute standard ${hookType}-hook script "${standardHookName}": ${error}`));
            return { ran: true, success: false };
        }
    }

    // --- 2. Check standard hook + arg pattern (e.g., prerun:deploy\w+) ---
    const standardHookPrefix = `${standardHookName}:`; // e.g., 'prerun:'
    if (actualArg !== undefined) { // Only check this if an argument was actually passed
        for (const scriptKey in packageJson.scripts) {
            if (scriptKey.startsWith(standardHookPrefix)) {
                const argPattern = scriptKey.substring(standardHookPrefix.length);
                if (!argPattern) continue; // Skip if pattern is empty (e.g., "prerun:")

                try {
                    const argRegex = new RegExp(`^${argPattern}$`);
                    if (argRegex.test(actualArg)) {
                        // Found a match!
                        const packageManager = pkgManagerService.detectPackageManager();
                        ui.write(chalk.blue(`Executing matching ${hookType}-hook: ${chalk.bold(`${packageManager} run ${scriptKey}`)} (command: "${actualCommand}", arg_pattern: "${argPattern}")...`));
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
                                ui.write(chalk.redBright(`${hookType}-hook script "${scriptKey}" failed with exit code ${result.status}.`));
                                return { ran: true, success: false };
                            }
                            ui.write(chalk.green(`${hookType}-hook script "${scriptKey}" finished successfully using ${packageManager}.`));
                            return { ran: true, success: true }; // Executed, finish.
                        } catch (error) {
                            ui.write(chalk.redBright(`Failed to execute ${hookType}-hook script "${scriptKey}": ${error}`));
                            return { ran: true, success: false };
                        }
                    }
                } catch (e) {
                    ui.write(chalk.yellow(`Warning: Invalid regex for argument pattern in script key "${scriptKey}": ${e}`));
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
                            ui.write(chalk.yellow(`Warning: Invalid regex for argument pattern in script key "${scriptKey}": ${e}`));
                            continue; // Skip this key if arg regex is invalid
                        }
                    } // Else: argPattern exists, but no actualArg was passed -> no match

                    if (argMatches) {
                        // Found the first matching hook key for both command and argument
                        const packageManager = pkgManagerService.detectPackageManager();
                        ui.write(chalk.blue(`Executing matching ${hookType}-hook: ${chalk.bold(`${packageManager} run ${scriptKey}`)} (cmd_pattern: "${commandPattern}", arg_pattern: "${argPattern ?? 'null'}")...`));
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
                                ui.write(chalk.redBright(`${hookType}-hook script "${scriptKey}" failed with exit code ${result.status}.`));
                                return { ran: true, success: false };
                            }
                            ui.write(chalk.green(`${hookType}-hook script "${scriptKey}" finished successfully using ${packageManager}.`));
                            return { ran: true, success: true }; // Return after executing the first match
                        } catch (error) {
                            ui.write(chalk.redBright(`Failed to execute ${hookType}-hook script "${scriptKey}": ${error}`));
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

    return { ran: false, success: true }; // No matching hook script found
}

async function main() {
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
            chalk.redBright(`Error: command ${command} not found.`) + `\nRunning ${chalk.cyanBright('blueprint help')}...`
        );
        const helpMessage = helpMessages['help'];
        console.log(helpMessage);
        process.exit(1);
        return;
    }

    const ui = new InquirerUIProvider();

    try {
        // --- Pre-hook execution ---
        let preHookRan = false;
        if (command !== 'run') { // Only run pre-hook here if NOT the 'run' command
            const preHookResult = await runNpmHook('pre', command, args._[1], ui);
            preHookRan = preHookResult.ran;
            if (!preHookResult.success) {
                ui.write(chalk.redBright('Aborting command due to pre-hook failure.'));
                process.exit(1); // Abort if pre-hook failed
            }
        }
        // --- End Pre-hook ---

        await runner(args, ui, runnerContext);

        // --- Post-hook execution ---
        if (command !== 'run') { // Only run post-hook here if NOT the 'run' command
            // Only run post-hook if pre-hook didn't fail (implied) and runner succeeded
            const postHookResult = await runNpmHook('post', command, args._[1], ui);
            if (!postHookResult.success) {
                // Don't exit, just warn if post-hook fails
                ui.write(chalk.yellowBright('Warning: post-hook script failed.'));
            }
        }
        // --- End Post-hook ---

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
        chalk.cyanBright(`  blueprint help`) +
            `\t` +
            chalk.whiteBright(`shows more detailed help, also see https://github.com/ton-org/blueprint`),
    );
    console.log(`\t\t\t` + chalk.gray(`blueprint help`));

    console.log(``);
}
