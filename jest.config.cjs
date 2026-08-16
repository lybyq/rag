module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/apps/**/*.spec.ts', '<rootDir>/libs/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/apps/web-console/'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.check.json' }],
  },
  moduleNameMapper: {
    '^@rag/contracts-internal/(.+)$': '<rootDir>/libs/contracts/src/internal/$1',
    '^@rag/(.+)$': '<rootDir>/libs/$1/src',
    '^uuid$': '<rootDir>/test/mocks/uuid.cjs',
  },
  collectCoverageFrom: ['libs/**/*.ts', 'apps/*/src/**/*.ts', '!**/main.ts', '!**/index.ts'],
  coverageDirectory: '<rootDir>/coverage/backend',
  clearMocks: true,
};
