import arg from 'arg';
import chalk from 'chalk';

import { UIProvider } from '../ui/UIProvider';
import { Args, Runner, RunnerContext } from './Runner';
import { helpArgs } from './constants';
import { runners } from './actionRunners';

export const action: Runner = async (args: Args, ui: UIProvider, context: RunnerContext) => {
    const localArgs = arg(
        {
            ...helpArgs,
        },
        {
            permissive: true,
            argv: args._.slice(1), // Пропускаем 'action'
        },
    );

    if (localArgs['--help'] || localArgs._.length === 0) {
        showActionHelp(ui);
        return;
    }

    const actionName = localArgs._[0];

    // Находим подходящий runner для этого действия
    const runner = runners[actionName];
    if (!runner) {
        ui.write(chalk.redBright(`Error: action "${actionName}" not found.`));
        showActionHelp(ui);
        process.exit(1);
        return;
    }

    // Передаем аргументы исходному runner'у, но удаляем первый аргумент (название действия)
    const actionArgs = { ...args, _: [actionName, ...localArgs._.slice(1)] };

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
