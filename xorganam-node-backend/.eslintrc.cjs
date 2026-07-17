module.exports = {
  root: true,
  env: {
    node: true,
    es2024: true
  },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  extends: ['eslint:recommended', 'prettier'],
  rules: {
    'no-console': 'off',
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
  },
  globals: {
    describe: 'readonly',
    it: 'readonly',
    before: 'readonly',
    after: 'readonly',
    beforeEach: 'readonly',
    afterEach: 'readonly'
  }
}
