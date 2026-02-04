import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
	{
		ignores: ['node_modules', 'dist', '.wrangler', '**/.wrangler']
	},
	js.configs.recommended,
	tseslint.configs.strictTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				project: ['./tsconfig.json'],
				tsconfigRootDir: new URL('.', import.meta.url).pathname
			}
		},
		rules: {
			'no-throw-literal': 'off',
			'@typescript-eslint/only-throw-error': 'error',
			'@typescript-eslint/no-deprecated': 'error'
		}
	}
);
