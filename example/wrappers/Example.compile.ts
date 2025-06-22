import { CompilerConfig } from '@ton-ai-core/blueprint';

export const compile: CompilerConfig = {
    lang: 'tact',
    target: 'contracts/example.tact',
    options: {
        debug: true,
    },
};
