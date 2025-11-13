import typescript from '@kaynooo/eslint/typescript'

export default typescript({
  mergeOptions: {
    ignores: ['**/*.md', 'README.md'],
    rules: {
      'unused-imports/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
})
