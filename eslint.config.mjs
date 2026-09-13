import obsidian from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

// Mirrors the Obsidian marketplace review bot config:
// obsidian.configs.recommended + type-checked obsidianmd rules + TS project service.
export default [
	...obsidian.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: obsidian.ruleConfigs.recommendedTypeChecked
	}
];
