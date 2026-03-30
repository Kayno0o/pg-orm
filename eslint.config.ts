import typescript from '@kaynooo/eslint/typescript'

export default typescript({
  strict: true,
  mergeOptions: {
    rules: {
      'unused-imports/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'max-depth': ['warn', 4],
      'ts/no-empty-object-type': 'off',
      'e18e/prefer-static-regex': 'warn',
    },
  },
}, {
  ignores: ['./tests/**/*.ts', './benchmark.ts'],
  rules: {
    // 'complexity': ['warn', 20],
    'max-nested-callbacks': ['warn', 4],
    'max-lines-per-function': ['warn', { skipComments: true, skipBlankLines: true, max: 75 }],
    'max-params': ['warn', 5],
  },
})
