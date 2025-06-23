import { build } from './build';
import { create } from './create';
import { run } from './run';
import { set } from './set';
import { test } from './test';
import { verify } from './verify';
import { convert } from './convert';
import { help } from './help';
import { pack } from './pack';
import { snapshot } from './snapshot';
import { rename } from './rename';
import { Runner } from './Runner';

// Экспортируем все доступные действия
export const runners: Record<string, Runner> = {
    create,
    run,
    build,
    set,
    test,
    help,
    verify,
    convert,
    rename,
    pack,
    snapshot,
};
