import { Args, Runner } from './Runner';
import { findCompiles, selectOption, selectFile } from '../utils';
import { UIProvider } from '../ui/UIProvider';
import arg from 'arg';
import { buildAll, buildOne } from '../build';
import { helpArgs, helpMessages } from './constants';
import { getEntityName } from '../utils/cliUtils';

export function extractBuildFile(args: Args): string | undefined {
    return args._.length > 1 && args._[1]?.length > 0 ? args._[1] : undefined;
}

export async function selectContract(ui: UIProvider, hint?: string ): Promise<string>;
export async function selectContract(ui: UIProvider, hint?: string, withAllOption?: boolean): Promise<string | string[]>;
export async function selectContract(ui: UIProvider, hint?: string, withAllOption: boolean = false):  Promise<string | string[]> {
    const compiles = await findCompiles();
    const contracts = compiles.map(compile => compile.name);
    const options = contracts.map<{ name: string; value: string }>((contract) => ({name: contract, value: contract}));

    if (hint) {
        const found = compiles.find(c => c.name.toLowerCase() === hint.toLowerCase());
        if (!found) {
            const availableNames = contracts.join(', ');
            throw new Error(`"${hint}" not found, but available: ${availableNames}`);
        }
        ui.write(`Using contract: ${found.name}`);
        return found.name;
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
        await buildAll(ui);
    } else {
        const selected = await selectContract(ui, extractBuildFile(args), true);

        if (typeof selected === 'string') {
            await buildOne(selected, ui);
        } else {
            await buildAll(ui);
        }
    }
};
