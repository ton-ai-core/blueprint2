import path from 'path';

import { build, createVirtualFileSystem, Options, Project, stdLibFiles } from '@tact-lang/compiler';
import { Cell } from '@ton/core';

import { BUILD_DIR } from '../../paths';
import { OverwritableVirtualFileSystem } from './OverwritableVirtualFileSystem';
import { TactCompilerConfig, TactLegacyCompilerConfig } from './config';
import { getRootTactConfig } from '../../config/tact.config';

export type TactCompileResult = {
    lang: 'tact';
    fs: Map<string, Buffer>;
    code: Cell;
    options?: Options;
    version: string;
};

function findTactBoc(fs: Map<string, Buffer>): Cell {
    let buf: Buffer | undefined = undefined;
    for (const [k, v] of fs) {
        if (k.endsWith('.code.boc')) {
            buf = v;
            break;
        }
    }
    if (buf === undefined) {
        throw new Error('Could not find boc in tact compilation result');
    }
    return Cell.fromBoc(buf)[0];
}

export function getTactConfigForContract(name: string): TactCompilerConfig | undefined {
    const config = getRootTactConfig();
    const projects = config.projects.filter((project) => project.name === name);
    if (!projects.length) {
        return;
    }

    return {
        ...config,
        projects,
    };
}

function getRootTactConfigOptionsForContract(name: string): Options | undefined {
    const filteredTactConfig = getTactConfigForContract(name);

    if (!filteredTactConfig) {
        return;
    }
    const [project] = filteredTactConfig.projects;

    return project?.options;
}

export async function getTactVersion() {
    const packageJsonPath = require.resolve('@tact-lang/compiler/package.json');
    const { version } = await import(packageJsonPath);
    return version;
}

function isLegacyTactConfig(config: TactLegacyCompilerConfig | TactCompilerConfig): config is TactLegacyCompilerConfig {
    return 'lang' in config;
}

export function extractContractConfig(config: TactCompilerConfig, name: string): Project {
    const project = config.projects.find((p) => p.name === name);

    if (!project) {
        throw new Error(`Config for project ${name} not found`);
    }

    return project;
}

function getTactBuildProject(config: TactLegacyCompilerConfig | TactCompilerConfig, name: string): Project {
    if (isLegacyTactConfig(config)) {
        const rootConfigOptions = getRootTactConfigOptionsForContract(name);
        return {
            name: 'tact',
            path: config.target,
            output: path.join(BUILD_DIR, name),
            options: { ...rootConfigOptions, ...config.options },
        };
    }

    return extractContractConfig(config, name);
}

export async function doCompileTact(
    config: TactLegacyCompilerConfig | TactCompilerConfig,
    name: string,
): Promise<TactCompileResult> {
    const fs = new OverwritableVirtualFileSystem(process.cwd());

    const buildConfig = {
        config: getTactBuildProject(config, name),
        stdlib: createVirtualFileSystem('@stdlib', stdLibFiles),
        project: fs,
    };

    // Completely silence all console output from the compiler
    const originalConsoleError = console.error;
    const originalConsoleLog = console.log;
    const capturedErrors: string[] = [];

    console.error = (...args: unknown[]) => {
        // Capture error messages for later processing
        const errorText = args.join(' ');
        capturedErrors.push(errorText);
    };

    // Also silence any console.log from the compiler
    console.log = (..._: unknown[]) => {
        // intentionally noop
    };

    try {
        const res = await build(buildConfig);
        if (!res.ok) {
            throw new Error('Could not compile tact');
        }
        const code = findTactBoc(fs.overwrites);

        return {
            lang: 'tact',
            fs: fs.overwrites,
            code,
            options: buildConfig.config.options,
            version: await getTactVersion(),
        };
    } catch (error) {
        if (capturedErrors.length > 0) {
            const fullOutput = capturedErrors.join('\n');
            const errorStartIndex = fullOutput.indexOf('Error:');

            if (errorStartIndex !== -1) {
                // Found the start of the error message
                const fromError = fullOutput.substring(errorStartIndex);
                // Find the start of the stack trace, which usually starts with "at"
                const stackTraceStartIndex = fromError.search(/\n\s*at /);

                let prettyError: string;
                if (stackTraceStartIndex !== -1) {
                    // Cut off the stack trace to get the clean, multi-line error
                    prettyError = fromError.substring(0, stackTraceStartIndex).trim();
                } else {
                    // No stack trace found, just use the message
                    prettyError = fromError.trim();
                }

                // The message from the compiler already includes "Error: ", so we remove it
                // to avoid duplication when it's printed later.
                if (prettyError.startsWith('Error: ')) {
                    prettyError = prettyError.substring('Error: '.length);
                }

                const newError = new Error(prettyError);
                newError.stack = undefined; // Ensure no stack is attached
                throw newError;
            }
        }

        // Fallback to the original error if parsing fails for any reason
        let fallbackMessage: string;
        if (error instanceof Error) {
            fallbackMessage = error.message;
        } else {
            fallbackMessage = String(error);
        }

        // Simple fallback for "Could not compile"
        if (fallbackMessage === 'Could not compile tact' && capturedErrors.length > 0) {
            fallbackMessage = capturedErrors[0].split('\n')[0].trim();
        }

        const fallbackError = new Error(fallbackMessage);
        fallbackError.stack = undefined;
        throw fallbackError;
    } finally {
        // Restore console functions
        console.error = originalConsoleError;
        console.log = originalConsoleLog;
    }
}
