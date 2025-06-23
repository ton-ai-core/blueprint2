const base = require('@ton/toolchain');
const tsEslint = require('@ton/toolchain').tsEslint;
const suggestMembers = require('@ton-ai-core/eslint-plugin-suggest-members');

module.exports = [
    ...base,
    { ignores: ['example/**'] },
    {
        plugins: {
            '@typescript-eslint': tsEslint,
        },
        rules: {
            'no-console': 'off',
            'no-redeclare': 'off',
            '@typescript-eslint/no-redeclare': ['error'],
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
    {
        files: ['**/*.{ts,tsx}'],
        ignores: ['**/*.spec.ts', '**/*.fixture.ts'],
        plugins: {
            '@ton-ai-core/suggest-members': suggestMembers,
        },
        languageOptions: {
            parser: tsEslint.parser,
            parserOptions: {
                project: './tsconfig.json',
                ecmaVersion: 2020,
                sourceType: 'module',
            },
        },
        rules: {
            '@ton-ai-core/suggest-members/suggest-members': 'error',
        },
    },
];
