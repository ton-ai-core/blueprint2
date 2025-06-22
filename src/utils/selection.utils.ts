import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

import { UIProvider } from '../ui/UIProvider';
import { getRootTactConfig } from '../config/tact.config';
import { COMPILE_END, getCompilablesDirectory } from '../compile/compile';
import { File } from '../types/file';
import { SCRIPTS_DIR } from '../paths';
import { distinct } from './object.utils';
import { getConfig } from '../config/utils';
import { extractFile } from './file.utils';

export const findCompiles = async (directory?: string): Promise<File[]> => {
    const dir = directory ?? (await getCompilablesDirectory());
    if (!existsSync(dir)) {
        return [];
    }

    const files = await fs.readdir(dir, {
        recursive: (await getConfig())?.recursiveWrappers ?? false,
        withFileTypes: true,
    });
    const compilables = files.filter((file) => file.isFile() && file.name.endsWith(COMPILE_END));
    return compilables.map(extractFile).map((file) => ({
        path: path.join(file.path, file.name),
        name: file.name.slice(0, file.name.length - COMPILE_END.length),
    }));
};

/**
 * Find all physical contract files (.fc, .tact, .tolk) in the contracts directory
 */
export const findAllContractFiles = async (): Promise<string[]> => {
    const contractsDir = path.join(process.cwd(), 'contracts');

    if (!existsSync(contractsDir)) {
        return [];
    }

    const allFiles: string[] = [];

    // Recursively find all contract files
    const findFiles = async (dir: string) => {
        const files = await fs.readdir(dir, { withFileTypes: true });

        for (const file of files) {
            const filePath = path.join(dir, file.name);

            if (file.isDirectory()) {
                await findFiles(filePath);
            } else if (
                file.isFile() &&
                (file.name.endsWith('.fc') || file.name.endsWith('.tact') || file.name.endsWith('.tolk'))
            ) {
                // Extract contract name without extension
                const contractName = path.basename(file.name, path.extname(file.name));
                allFiles.push(contractName);
            }
        }
    };

    await findFiles(contractsDir);
    return distinct(allFiles);
};

export const findContracts = async () => {
    const compilables = await findCompiles();
    const tactRootConfig = getRootTactConfig();

    return distinct([
        ...compilables.map((file) => file.name),
        ...(tactRootConfig?.projects.map((project) => project.name) ?? []),
    ]);
};

export const findScripts = async (): Promise<File[]> => {
    const dirents = await fs.readdir(SCRIPTS_DIR, {
        recursive: true,
        withFileTypes: true,
    });
    const scripts = dirents.filter((dirent) => dirent.isFile() && dirent.name.endsWith('.ts'));

    return scripts
        .map(extractFile)
        .map((script) => ({
            name: path.join(script.path.slice(SCRIPTS_DIR.length + 1), path.parse(script.name).name),
            path: path.join(script.path, script.name),
        }))
        .sort((a, b) => (a.name >= b.name ? 1 : -1));
};

export async function selectOption(
    options: { name: string; value: string }[],
    opts: {
        ui: UIProvider;
        msg: string;
        hint?: string;
    },
) {
    if (opts.hint) {
        const found = options.find((o) => o.value === opts.hint);
        if (found === undefined) {
            throw new Error(`Could not find option '${opts.hint}'`);
        }
        return found;
    } else {
        return await opts.ui.choose(opts.msg, options, (o) => o.name);
    }
}

export async function selectFile(
    files: File[],
    opts: {
        ui: UIProvider;
        hint?: string;
        import?: boolean;
    },
) {
    let selected: File;

    if (opts.hint) {
        const found = files.find((f) => f.name.toLowerCase() === opts.hint?.toLowerCase());
        if (found === undefined) {
            const availableNames = files.map((f) => f.name).join(', ');
            throw new Error(`"${opts.hint}" not found, but available: ${availableNames}`);
        }
        selected = found;
        opts.ui.write(`Using file: ${selected.name}`);
    } else {
        if (files.length === 1) {
            selected = files[0];
            opts.ui.write(`Using file: ${selected.name}`);
        } else {
            selected = await opts.ui.choose('Choose file to use', files, (f) => f.name);
        }
    }

    return {
        ...selected,
        module: opts.import !== false ? await import(selected.path) : undefined,
    };
}
