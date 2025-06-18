import { execSync as _execSync } from 'child_process';
import process from 'process';

import arg from 'arg';
import chalk from 'chalk';

import { Args, extractFirstArg as _extractFirstArg, Runner, RunnerContext } from './Runner';
import { createNetworkProvider, argSpec } from '../network/createNetworkProvider';
import { findScripts, selectFile } from '../utils';
import { getEntityName } from '../utils/cliUtils';
import { UIProvider } from '../ui/UIProvider';
import { helpArgs, helpMessages } from './constants';
import * as _pkgManagerService from '../pkgManager/service';
import { runNpmHook } from './cli';

export const run: Runner = async (_args: Args, ui: UIProvider, context: RunnerContext) => {
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

    const scriptName: string | undefined = await getEntityName(
        localArgs._,
        undefined, // Interactive mode is not needed here, selectFile handles it
    );
    const selectedFile = await selectFile(await findScripts(), {
        ui,
        hint: scriptName,
    });
    const finalScriptName = selectedFile.name;
    const mod = selectedFile.module;

    if (typeof mod?.run !== 'function') {
        throw new Error(`Function \`run\` is missing in script ${finalScriptName}!`);
    }

    ui.write(chalk.gray(`Checking for pre-hook for command 'run' with argument '${finalScriptName}'...`));
    // --- Pre-hook Execution (Moved Here) ---
    // Run pre-hook AFTER the script name is determined
    try {
        const preHookResult = await runNpmHook('pre', 'run', finalScriptName, ui);
        if (!preHookResult.success) {
            ui.write(chalk.redBright(`Aborting command due to pre-run:${finalScriptName} hook failure.`));
            process.exit(1); // Abort if pre-hook failed
        }
    } catch (e) {
        ui.write(chalk.redBright(`Error during pre-hook execution check: ${(e as Error).message || e}`));
        process.exit(1);
    }
    // --- End Pre-hook ---

    const networkProvider = await createNetworkProvider(ui, localArgs, context.config);

    // Pass positional arguments (everything after the script name)
    const scriptArgs = localArgs._.slice(2);

    try {
        await mod.run(networkProvider, scriptArgs);

        ui.write(chalk.gray(`Script ${finalScriptName} executed successfully. Checking for post-hook...`));
        // --- Post-hook Execution (Moved Here) ---
        try {
            const postHookResult = await runNpmHook('post', 'run', finalScriptName, ui);
            if (!postHookResult.success) {
                // Don't exit, just warn if post-hook fails
                ui.write(chalk.yellowBright(`Warning: post-run:${finalScriptName} hook script failed.`));
            }
        } catch (e) {
            ui.write(
                chalk.yellowBright(`Warning: Error during post-hook execution check: ${(e as Error).message || e}`),
            );
        }
        // --- End Post-hook ---
    } catch (e) {
        ui.write(chalk.redBright(`Error executing script ${finalScriptName}: ${(e as Error).message || e}`));
        process.exit(1);
    }
};
