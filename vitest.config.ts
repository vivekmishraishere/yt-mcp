import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        testTimeout: 20_000,
        // OpenCV.js (WASM) is heavy: keep each test file in its own fork.
        pool: 'forks',
    },
});
