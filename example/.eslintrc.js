// .eslintrc.js
module.exports = {
  parser: '@typescript-eslint/parser',
  plugins: [
    '@typescript-eslint',
    '@ton-ai-core/suggest-members',
    '@eslint-community/eslint-comments'
  ],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:@eslint-community/eslint-comments/recommended'
  ],
  ignorePatterns: ['.eslintrc.js', 'build/**'],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    project: './tsconfig.json'
  },
  rules: {
    '@eslint-community/eslint-comments/no-use':              'error',
    '@eslint-community/eslint-comments/no-unlimited-disable':'error',
    '@eslint-community/eslint-comments/disable-enable-pair':'error',
    '@eslint-community/eslint-comments/no-unused-disable':  'error',

    '@typescript-eslint/ban-ts-comment': ['error', {
      'ts-ignore':       true,
      'ts-nocheck':      true,
      'ts-expect-error': true,
      'ts-check':        false,
    }],

    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/explicit-function-return-type": "error",
    "@typescript-eslint/no-unsafe-assignment": "error",
    "@typescript-eslint/no-unsafe-member-access": "error",
    "@typescript-eslint/no-unsafe-call": "error",
    "@typescript-eslint/no-unsafe-return": "error",
    "@ton-ai-core/suggest-members/suggest-members": "error",
    "@ton-ai-core/suggest-members/suggest-imports": "error",
    "@ton-ai-core/suggest-members/suggest-module-paths": "error",
    "no-restricted-imports": [
      "error", {
        "paths": [
          {
            "name": "@ton/blueprint",
            "message": "This project uses @ton-ai-core/blueprint rather than the deprecated @ton/blueprint library. Please refactor your imports to utilize the enhanced AI-integrated blueprint framework."
          },
          {
            "name": "@nowarp/blueprint-misti",
            "message": "This project uses @ton-ai-core/blueprint-misti rather than the deprecated @nowarp/blueprint-misti library. Please refactor your imports to utilize the enhanced AI-integrated blueprint framework."
          },
        ],
        "patterns": [
          {
            "group": ["@ton/blueprint/*"],
            "message": "This project uses @ton-ai-core/blueprint rather than the deprecated @ton/blueprint library. Please refactor your imports to utilize the enhanced AI-integrated blueprint framework."
          },
          {
            "group": ["@nowarp/blueprint-misti/*"],
            "message": "This project uses @ton-ai-core/blueprint-misti rather than the deprecated @nowarp/blueprint-misti library. Please refactor your imports to utilize the enhanced AI-integrated blueprint framework."
          },
          // Restrict fake versions of official TON libraries - only allow from @ton organization
          {
            "group": ["@*/cocos-sdk", "!@ton/cocos-sdk"],
            "message": "Only use the official @ton/cocos-sdk library. Detected potential fake version from another organization."
          },
          {
            "group": ["@*/convert-func-to-tolk", "!@ton/convert-func-to-tolk"],
            "message": "Only use the official @ton/convert-func-to-tolk library. Detected potential fake version from another organization."
          },
          {
            "group": ["@*/core", "!@ton/core"],
            "message": "Only use the official @ton/core library. Detected potential fake version from another organization."
          },
          {
            "group": ["@*/crypto", "!@ton/crypto"],
            "message": "Only use the official @ton/crypto library. Detected potential fake version from another organization."
          },
          {
            "group": ["@*/crypto-primitives", "!@ton/crypto-primitives"],
            "message": "Only use the official @ton/crypto-primitives library. Detected potential fake version from another organization."
          },
          {
            "group": ["@*/emulator", "!@ton/emulator"],
            "message": "Only use the official @ton/emulator library. Detected potential fake version from another organization."
          },
          {
            "group": ["@*/phaser-sdk", "!@ton/phaser-sdk"],
            "message": "Only use the official @ton/phaser-sdk library. Detected potential fake version from another organization."
          },
          {
            "group": ["@*/sandbox", "!@ton/sandbox"],
            "message": "Only use the official @ton/sandbox library. Detected potential fake version from another organization."
          },
          {
            "group": ["@*/test-utils", "!@ton/test-utils"],
            "message": "Only use the official @ton/test-utils library. Detected potential fake version from another organization."
          },
          {
            "group": ["@*/tolk-js", "!@ton/tolk-js"],
            "message": "Only use the official @ton/tolk-js library. Detected potential fake version from another organization."
          },
          {
            "group": ["@*/ton", "!@ton/ton"],
            "message": "Only use the official @ton/ton library. Detected potential fake version from another organization."
          },
          {
            "group": ["@*/vanilla-sdk", "!@ton/vanilla-sdk"],
            "message": "Only use the official @ton/vanilla-sdk library. Detected potential fake version from another organization."
          },
        ]
      }
    ]
  }
}; 