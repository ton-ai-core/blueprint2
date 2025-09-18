import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

import chalk from 'chalk';

import {
    doCompile,
    extractCompilableConfig,
    getCompilerConfigForContract,
    getCompilerOptions,
    libraryCellFromCode,
} from './compile/compile';
import { BUILD_DIR } from './paths';
import { UIProvider } from './ui/UIProvider';
import { findCompiles, findContracts } from './utils';
import { getRootTactConfig } from './config/tact.config';

export async function buildOne(contract: string, ui?: UIProvider) {
    ui?.write(`Build script running, compiling ${contract}`);

    const buildArtifactPath = path.join(BUILD_DIR, `${contract}.compiled.json`);

    try {
        await fs.unlink(buildArtifactPath);
        // eslint-disable-next-line no-empty
    } catch (_) {}

    ui?.setActionPrompt('⏳ Compiling...');
    try {
        const config = await getCompilerConfigForContract(contract);
        const compilerOptions = await getCompilerOptions(config);
        ui?.write(`🔧 Using ${compilerOptions.lang} version ${compilerOptions.version}...`);

        // Build raw code cell by default
        const result = await doCompile(contract, { buildLibrary: false });

        if (result.lang === 'tact') {
            for (const [k, v] of result.fs) {
                await fs.mkdir(path.dirname(k), {
                    recursive: true,
                });
                await fs.writeFile(k, v);
            }

            if (result.options !== undefined && result.options?.debug === true) {
                ui?.clearActionPrompt();
                ui?.write(
                    '\n⚠️ Make sure to disable debug mode in contract wrappers before doing production deployments!',
                );
            }
        }

        let libAttributes:
            | {
                  libraryHash: string;
                  libraryBoc: string;
              }
            | undefined;

        const cell = result.code;

        // If build was configured as library, add attributes
        if ('buildLibrary' in config && config.buildLibrary === true) {
            const libCell = libraryCellFromCode(cell);
            libAttributes = {
                libraryHash: libCell.hash().toString('hex'),
                libraryBoc: libCell.toBoc().toString('hex'),
            };
        }

        const rHash = cell.hash();
        const res = {
            hash: rHash.toString('hex'),
            hashBase64: rHash.toString('base64'),
            hex: cell.toBoc().toString('hex'),
            ...libAttributes,
        };
        ui?.clearActionPrompt();
        if (result.lang === 'tolk') {
            ui?.write(`\n${result.stderr}`);
        }
        ui?.write('\n✅ Compiled successfully!');

        await fs.mkdir(BUILD_DIR, { recursive: true });

        await fs.writeFile(buildArtifactPath, JSON.stringify(res));
        if (result.lang === 'func' || result.lang === 'tolk') {
            const fiftFilepath = path.join(BUILD_DIR, contract, `${contract}.fif`);
            await fs.mkdir(path.join(BUILD_DIR, contract), { recursive: true });
            await fs.writeFile(fiftFilepath, result.fiftCode);
        }

        // Сначала сообщаем о записи основного артефакта
        ui?.write(`\n✅ Wrote compilation artifact to ${path.relative(process.cwd(), buildArtifactPath)}`);

        // Показываем содержимое директории контракта в виде дерева
        ui?.write('\n📦 Build artifacts:');

        // Выводим корневой файл .compiled.json
        ui?.write(`├── 📄 ${path.basename(buildArtifactPath)}`);

        // Затем проверяем и выводим содержимое директории контракта
        const contractDir = path.join(BUILD_DIR, contract);
        if (existsSync(contractDir)) {
            try {
                const files = await fs.readdir(contractDir);

                // Сортируем файлы для более организованного вывода
                const sortedFiles = files.sort();

                // Группируем файлы по типу (расширению)
                const fileGroups: Record<string, string[]> = {};

                for (const file of sortedFiles) {
                    const ext = path.extname(file);
                    if (!fileGroups[ext]) {
                        fileGroups[ext] = [];
                    }
                    fileGroups[ext].push(file);
                }

                // Выводим директорию контракта
                ui?.write(`└── 📁 ${contract}/`);

                // Выводим файлы по группам
                const extensions = Object.keys(fileGroups).sort();
                for (let i = 0; i < extensions.length; i++) {
                    const ext = extensions[i];
                    const files = fileGroups[ext];

                    for (let j = 0; j < files.length; j++) {
                        const file = files[j];
                        const isLast = i === extensions.length - 1 && j === files.length - 1;
                        const prefix = isLast ? '    └── ' : '    ├── ';

                        // Выбираем иконку в зависимости от типа файла
                        let icon = '📄';
                        if (ext === '.abi') icon = '📋';
                        else if (ext === '.code.boc') icon = '📦';
                        else if (ext === '.ts') icon = '📝';
                        else if (ext === '.fif') icon = '🔧';

                        ui?.write(`${prefix}${icon} ${file}`);
                    }
                }
            } catch (_err) {
                // Игнорируем ошибки чтения директории
            }
        }
    } catch (e) {
        if (ui) {
            ui?.clearActionPrompt();
            ui?.write((e as Error).toString());
            process.exit(1);
        } else {
            throw e;
        }
    }
}

async function buildContracts(contracts: string[], ui?: UIProvider) {
    for (const contract of contracts) {
        await buildOne(contract, ui);
    }
}

export async function buildAll(ui?: UIProvider, checkUnused: boolean = false) {
    const contracts = await findContracts();

    if (checkUnused) {
        // Проверка на наличие неиспользуемых контрактов
        const configuredContracts = await findContracts();
        const contractsDir = path.join(process.cwd(), 'contracts');

        if (existsSync(contractsDir)) {
            const files = await fs.readdir(contractsDir, { withFileTypes: true });

            // Получаем все файлы контрактов в директории contracts
            const contractFiles = files
                .filter(
                    (file) =>
                        file.isFile() &&
                        (file.name.endsWith('.fc') || file.name.endsWith('.tact') || file.name.endsWith('.tolk')),
                )
                .map((file) => path.basename(file.name, path.extname(file.name)));

            // Проверяем импорты в тактовых контрактах
            const importedContracts = new Set<string>();

            // Получаем все пути к контрактам из tact.config.json
            const tactConfig = getRootTactConfig();
            const configuredPaths = new Set<string>();

            // Добавляем пути из конфигурации tact
            for (const project of tactConfig.projects) {
                if (project.path) {
                    // Нормализуем путь и извлекаем имя файла без расширения
                    const normalizedPath = path.normalize(project.path);
                    const fileName = path.basename(normalizedPath, path.extname(normalizedPath));
                    configuredPaths.add(fileName.toLowerCase());
                }
            }

            for (const configuredContract of configuredContracts) {
                // Проверяем только для контрактов Tact
                const tactConfigProjects = getRootTactConfig().projects;
                const project = tactConfigProjects.find(
                    (p) => p.name.toLowerCase() === configuredContract.toLowerCase(),
                );

                if (project && existsSync(project.path)) {
                    try {
                        const content = await fs.readFile(project.path, 'utf-8');
                        // Ищем импорты вида import "./contract.tact"; или import "./contract";
                        const importRegex = /import\s+["']\.\/([\w_-]+)(?:\.tact)?[""];/g;
                        let match;

                        while ((match = importRegex.exec(content)) !== null) {
                            const importedContract = match[1];
                            importedContracts.add(importedContract.toLowerCase());
                        }
                    } catch (_e) {
                        // Игнорируем ошибки чтения файла
                    }
                }
            }

            // Преобразуем имена контрактов к нижнему регистру для регистронезависимого сравнения
            const configuredContractsLower = configuredContracts.map((c) => c.toLowerCase());

            const unusedContracts = contractFiles.filter((contract) => {
                const contractLower = contract.toLowerCase();
                return (
                    !configuredContractsLower.includes(contractLower) &&
                    !importedContracts.has(contractLower) &&
                    !configuredPaths.has(contractLower)
                );
            });

            if (unusedContracts.length > 0) {
                ui?.write(chalk.red('\n❌ Error: The following contracts are not properly configured:'));
                for (const contract of unusedContracts) {
                    ui?.write(chalk.red(`  - ${contract}`));
                }
                ui?.write(chalk.red('\nYou should either:'));
                ui?.write(chalk.red('  1. Add them to tact.config.json (for Tact contracts)'));
                ui?.write(chalk.red('  2. Create a .compile.ts file for them (for other languages)'));
                ui?.write(chalk.red('  3. Remove them if they are not needed'));
                ui?.write('');

                // Завершаем процесс с ошибкой
                process.exit(1);
            }
        }
    }

    await buildContracts(contracts, ui);
}

export async function buildAllTact(ui?: UIProvider) {
    const legacyTactContract = (await findCompiles())
        .filter((file) => extractCompilableConfig(file.path).lang === 'tact')
        .map((file) => file.name);

    const tactConfig = getRootTactConfig();
    const tactContracts = [...legacyTactContract, ...tactConfig.projects.map((project) => project.name)];

    await buildContracts(tactContracts, ui);
}
