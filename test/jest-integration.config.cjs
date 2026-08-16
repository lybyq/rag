module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/integration/**/*.integration.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.check.json' }],
  },
  moduleNameMapper: {
    '^@rag/contracts-internal/(.+)$': '<rootDir>/libs/contracts/src/internal/$1',
    '^@rag/(.+)$': '<rootDir>/libs/$1/src',
    '^uuid$': '<rootDir>/test/mocks/uuid.cjs',
  },
};
