import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        lib: {
            entry: "./src/extension.ts",
            formats: ["cjs"],
            fileName: "extension",
        },
        rollupOptions: {
            external: ["vscode"],
        },
        outDir: "out",
        sourcemap: true,
    },
});

