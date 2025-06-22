// jest.config.ts
import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  preset: 'ts-jest',
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },

  testEnvironment: 'node',

  collectCoverage: true,
  collectCoverageFrom: [
    'wrappers/**/*.ts',
    'build/**/*.ts',
  ],

  coverageProvider: 'v8',

  coverageReporters: ['text'],

  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },

  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    'wrappers/.*\\.compile\\.ts$',
  ],
};

export default config;
