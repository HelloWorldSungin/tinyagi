import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '@tinyagi/core': path.resolve(__dirname, '../core/src/index.ts'),
        },
    },
    test: {
        globals: true,
        passWithNoTests: true,
        include: ['src/**/*.test.ts'],
    },
});
