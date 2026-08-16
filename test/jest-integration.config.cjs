module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/integration/**/*.integration.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.check.json' }],
  },
  moduleNameMapper: {
    '^@rag/(.+)$': '<rootDir>/libs/$1/src',
    '^uuid$': '<rootDir>/test/mocks/uuid.cjs',
  },
};
