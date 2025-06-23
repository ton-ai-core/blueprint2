import arg from 'arg';
import chalk from 'chalk';

import { Runner } from './Runner';
import { helpArgs, helpMessages } from './constants';
import * as pkgManagerService from '../pkgManager/service';
import { runNpmHook } from './cli';

export const test: Runner = async (args, ui) => {
    const localArgs = arg(helpArgs);
    if (localArgs['--help']) {
        ui.write(helpMessages['test']);
        return;
    }

    // Use positional arguments after the 'test' command
    const testArgs = args._.slice(1); // first argument is 'test', needs to be removed

    try {
        // --- Pre-hook Execution ---
        ui.write(chalk.gray(`Checking for pre-hook for command 'test'...`));
        const preHookResult = await runNpmHook('pre', 'test', undefined, ui);
        if (!preHookResult.success) {
            ui.write(chalk.redBright(`Aborting test command due to pre-hook failure.`));
            process.exit(1); // Abort if pre-hook failed
        }
        // --- End Pre-hook ---

        // Use the service to run the test command with arguments
        const result = pkgManagerService.runCommand('test', testArgs);
        if (result.status !== 0) {
            // Exit with the same status code as the test runner if it failed
            process.exit(result.status ?? 1);
        }

        // --- Post-hook Execution ---
        ui.write(chalk.gray(`Checking for post-hook for command 'test'...`));
        const postHookResult = await runNpmHook('post', 'test', undefined, ui);
        if (!postHookResult.success) {
            // Don't exit, just warn if post-hook fails
            ui.write(chalk.yellowBright(`Warning: post-test hook script failed.`));
        }
        // --- End Post-hook ---
    } catch (e) {
        // Handle potential errors during command execution
        ui.write(chalk.redBright(`Failed to run test command: ${(e as Error).message || e}`));
        process.exit(1);
    }
};
