import path from 'path';
import unixPath from 'path/posix';
import { lstat, mkdir, open, readdir, readFile, access } from 'fs/promises';
import { constants as fsConstants } from 'fs';

import arg from 'arg';
import { Project } from '@tact-lang/compiler';

import { getConfig } from '../config/utils';
import { getRootTactConfig, TactConfig, updateRootTactConfig } from '../config/tact.config';
import { Args, extractFirstArg, Runner } from './Runner';
import { executeTemplate, TEMPLATES_DIR } from '../template';
import { assertValidContractName, selectOption, toSnakeCase } from '../utils';
import { UIProvider } from '../ui/UIProvider';
import { buildOne } from '../build';
import { helpArgs, helpMessages, templateTypes } from './constants';

async function createFile(templatePath: string, realPath: string, replaces: { [k: string]: string }) {
    const template = (await readFile(templatePath)).toString('utf-8');
    const lines = template.split('\n');
    const fileName = executeTemplate(lines.shift()!, replaces);
    const contents = executeTemplate(lines.join('\n'), replaces);

    const p = path.join(realPath, fileName);
    const file = await open(p, 'a+');
    if ((await file.stat()).size > 0) {
        console.warn(`${p} already exists, not changing.`);
        await file.close();
        return;
    }

    await file.writeFile(contents);
    await file.close();
}

async function createFiles(templatePath: string, realPath: string, replaces: { [k: string]: string }) {
    const contents = await readdir(templatePath);

    for (const file of contents) {
        const tp = path.join(templatePath, file);
        const rp = path.join(realPath, file);
        if ((await lstat(tp)).isDirectory()) {
            await createFiles(tp, rp, replaces);
        } else {
            await mkdir(path.dirname(rp), {
                recursive: true,
            });
            await createFile(tp, realPath, replaces);
        }
    }
}

function getFileExtension(lang: string): string {
    if (lang === 'func') return 'fc';
    if (lang === 'tolk') return 'tolk';
    return 'tact';
}

function addToTactConfig(contractName: string, contractPath: string) {
    const tactConfig = getRootTactConfig();
    const projectConfig = {
        name: contractName,
        path: contractPath,
        output: path.join('build', contractName),
        options: {
            debug: false,
            external: false,
        },
        mode: 'full',
    } satisfies Project;

    const newConfig: TactConfig = {
        ...tactConfig,
        projects: [...tactConfig.projects, projectConfig],
    };
    updateRootTactConfig(newConfig);
}

export const create: Runner = async (_args: Args, ui: UIProvider) => {
    const requiredFiles = ['package.json', 'package-lock.json', 'README.md', 'tsconfig.json'];
    for (const file of requiredFiles) {
        try {
            await access(path.join(process.cwd(), file), fsConstants.F_OK);
        } catch {
            ui.write(
                `\nBefore using 'npx blueprint create', you must initialize the project with 'npm create ton-ai@latest' or 'npx create-ton-ai@latest'.\n`,
            );
            return;
        }
    }

    // Check for @ton-ai-core/blueprint in package.json
    try {
        const pkgPath = path.join(process.cwd(), 'package.json');
        const pkgRaw = await readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(pkgRaw);
        const hasBlueprint =
            (pkg.dependencies && pkg.dependencies['@ton-ai-core/blueprint']) ||
            (pkg.devDependencies && pkg.devDependencies['@ton-ai-core/blueprint']) ||
            (pkg.peerDependencies && pkg.peerDependencies['@ton-ai-core/blueprint']);
        if (!hasBlueprint) {
            ui.write(
                `\nBefore using 'npx blueprint create', you must initialize the project with 'npm create ton-ai@latest' or 'npx create-ton-ai@latest'.\n`,
            );
            return;
        }
    } catch (_e) {
        ui.write(
            `\nBefore using 'npx blueprint create', you must initialize the project with 'npm create ton-ai@latest' or 'npx create-ton-ai@latest'.\n`,
        );
        return;
    }

    let localArgs: {
        _: string[];
        '--type'?: string;
        '--help'?: boolean;
    };
    try {
        localArgs = arg({
            '--type': String,
            ...helpArgs,
        });
    } catch (_e) {
        const msg = _e && typeof _e === 'object' && 'message' in _e ? (_e as { message: string }).message : String(_e);
        if (msg.includes('unknown or unexpected option')) {
            const availableFlags = ['--type', '--help'].join(', ');
            ui.write(msg);
            ui.write('Available options: ' + availableFlags);
            process.exit(1);
        } else {
            throw _e;
        }
    }

    if (localArgs['--help']) {
        ui.write(helpMessages['create']);
        return;
    }

    const name = extractFirstArg(localArgs) ?? (await ui.input('Contract name (PascalCase)'));
    assertValidContractName(name);

    let which: string;
    const defaultType = 'tact-empty';
    if (localArgs['--type']) {
        which = localArgs['--type'];

        if (!templateTypes.some((t) => t.value === which)) {
            throw new Error(
                `Invalid type: ${which}. Available options: ${templateTypes.map((t) => t.value).join(', ')}`,
            );
        }
    } else {
        which = (
            await selectOption(templateTypes, {
                ui,
                msg: 'What type of contract do you want to create?',
                hint: defaultType,
            })
        ).value;
    }

    const [lang, template] = which.split('-');

    const snakeName = toSnakeCase(name);
    const contractPath = unixPath.join('contracts', snakeName + '.' + getFileExtension(lang));

    const replaces = {
        name,
        loweredName: name.substring(0, 1).toLowerCase() + name.substring(1),
        snakeName,
        contractPath,
    };

    const config = await getConfig();

    if (lang === 'tact') {
        await createFiles(path.join(TEMPLATES_DIR, lang, template), process.cwd(), replaces);
        addToTactConfig(name, contractPath);
        await buildOne(name, ui);
    } else {
        const commonPath = config?.separateCompilables ? 'common' : 'not-separated-common';
        await createFiles(path.join(TEMPLATES_DIR, lang, commonPath), process.cwd(), replaces);
        await createFiles(path.join(TEMPLATES_DIR, lang, template), process.cwd(), replaces);
    }
};
