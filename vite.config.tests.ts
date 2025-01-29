import { defineConfig } from 'vite';
import * as path from 'path';
import * as glob from 'glob';

export default defineConfig({
    build: {
        rollupOptions: {
            external: ["vscode"],
            input: Object.fromEntries(
                glob.sync("src/test/**/*.ts").map(file => [
                    path.relative(
                        "src",
                        file.slice(0, file.length - path.extname(file).length)
                    ),
                    file
                ])
            ),
            output: {
                format: 'cjs',
                entryFileNames: '[name].js'
            }
        },
        outDir: "out",
        sourcemap: true,
    },
});

