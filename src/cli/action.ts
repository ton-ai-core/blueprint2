import chalk from 'chalk';

import { UIProvider } from '../ui/UIProvider';
import { Args, Runner, RunnerContext } from './Runner';
import { runners } from './actionRunners';
import { findScripts, selectFile } from '../utils';
import { createNetworkProvider } from '../network/createNetworkProvider';

export const action: Runner = async (args: Args, ui: UIProvider, context: RunnerContext) => {
    // Проверяем, есть ли аргументы после 'action'
    if (args._.length < 2) {
        showActionHelp(ui);
        return;
    }

    const actionName = args._[1]; // Первый аргумент после 'action'

    // Отладочный вывод
    ui.write(chalk.blue(`Debug: actionName = "${actionName}"`));
    ui.write(chalk.blue(`Debug: Available runners: ${Object.keys(runners).join(', ')}`));
    ui.write(chalk.blue(`Debug: Is runner available: ${!!runners[actionName]}`));

    // Специальная обработка для команды "run"
    if (actionName === 'run') {
        // Если это команда "run", обрабатываем её особым образом
        const scriptName = args._.length >= 3 ? args._[2] : undefined;

        try {
            // Находим скрипт
            const scripts = await findScripts();

            // Если имя скрипта указано, проверяем его существование
            if (scriptName) {
                const scriptExists = scripts.some((script) => script.name === scriptName);
                if (!scriptExists) {
                    const availableScripts = scripts.map((script) => script.name);
                    ui.write(
                        chalk.redBright(`"${scriptName}" not found, but available: ${availableScripts.join(', ')}`),
                    );
                    process.exit(1);
                    return;
                }

                // Выбираем скрипт
                const selectedFile = await selectFile(scripts, {
                    ui,
                    hint: scriptName,
                });

                const finalScriptName = selectedFile.name;
                const mod = selectedFile.module;

                if (typeof mod?.run !== 'function') {
                    throw new Error(`Function \`run\` is missing in script ${finalScriptName}!`);
                }

                // Создаем провайдер сети
                const networkProvider = await createNetworkProvider(ui, args, context.config);

                // Передаем позиционные аргументы (все после имени скрипта)
                const scriptArgs = args._.slice(3);

                try {
                    await mod.run(networkProvider, scriptArgs);
                    ui.write(chalk.green(`Script ${finalScriptName} executed successfully.`));
                } catch (e) {
                    ui.write(
                        chalk.redBright(`Error executing script ${finalScriptName}: ${(e as Error).message || e}`),
                    );
                    process.exit(1);
                }

                return;
            } else {
                // Если имя скрипта не указано, выводим список доступных скриптов
                const availableScripts = scripts.map((script) => script.name);
                ui.write(
                    chalk.yellow(`Please specify a script name. Available scripts: ${availableScripts.join(', ')}`),
                );
                process.exit(1);
                return;
            }
        } catch (error) {
            ui.write(chalk.redBright(`Error running script: ${(error as Error).message}`));
            process.exit(1);
            return;
        }
    }

    // Для всех остальных команд используем стандартный подход
    const runner = runners[actionName];
    if (!runner) {
        ui.write(chalk.redBright(`Error: action "${actionName}" not found.`));
        showActionHelp(ui);
        process.exit(1);
        return;
    }

    // Создаем новый объект аргументов для runner'а
    // Важно: для правильной работы с getEntityName, первый элемент массива '_'
    // должен быть именем команды (например, 'run', 'build'), а второй - аргументом
    const actionArgs: Args = {
        ...args,
        _: [actionName, ...args._.slice(2)], // [команда, ...аргументы]
    };

    // Теперь запускаем runner с правильными аргументами
    await runner(actionArgs, ui, context);
};

function showActionHelp(ui: UIProvider) {
    ui.write(chalk.cyanBright('Available actions:'));

    // Выводим список доступных действий
    Object.keys(runners)
        .sort()
        .forEach((name) => {
            ui.write(`  ${chalk.greenBright(name)}`);
        });

    ui.write('\nUsage: blueprint action [ACTION_NAME] [OPTIONS]');
    ui.write('Example: blueprint action build MyContract');
    ui.write('\nActions directly execute the operation without running npm lifecycle hooks.');
}
