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

export const run: Runner = async (_args: Args, ui: UIProvider, context: RunnerContext) => {
    let localArgs: Args & { '--help'?: boolean };
    try {
        localArgs = arg({
            ...argSpec,
            ...helpArgs,
        });
    } catch (e) {
        const msg = e && typeof e === 'object' && 'message' in e ? (e as { message: string }).message : String(e);
        if (msg.includes('unknown or unexpected option')) {
            const availableFlags = Object.keys(argSpec).join(', ');
            ui.write(msg);
            ui.write('Available options: ' + availableFlags);
            process.exit(1);
        } else {
            throw e;
        }
    }
    if (localArgs['--help']) {
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

    // Хуки запускаются в cli.ts для всех команд, включая 'run'
    // Это позволяет избежать дублирования запуска хуков и обеспечивает единообразное поведение
    // для всех команд, независимо от того, найдены они в package.json или нет

    const networkProvider = await createNetworkProvider(ui, localArgs, context.config);

    // Pass positional arguments (everything after the script name)
    const scriptArgs = localArgs._.slice(2);

    try {
        await mod.run(networkProvider, scriptArgs);
        ui.write(chalk.gray(`Script ${finalScriptName} executed successfully.`));
    } catch (e) {
        ui.write(chalk.redBright(`Error executing script ${finalScriptName}: ${(e as Error).message || e}`));
        process.exit(1);
    }
};
