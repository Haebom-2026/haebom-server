/**
 * 함수별 번들: src/functions/<fn>/index.ts → dist/<fn>/index.mjs → dist/<fn>.zip
 * Terraform 은 dist/<fn>.zip 을 그대로 배포한다 (filebase64sha256 로 변경 감지).
 * 코드가 같으면 zip 해시도 같도록 파일 시각을 고정하고 zip -X 로 부가 정보를 뺀다.
 */
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { readdir, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const FIXED_TIME = new Date("2000-01-01T00:00:00Z");

const root = path.resolve(import.meta.dirname, "..");
const functionsDir = path.join(root, "src/functions");
const outRoot = path.join(root, "dist");

const functions = (await readdir(functionsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

await rm(outRoot, { recursive: true, force: true });

await Promise.all(
  functions.map((name) =>
    build({
      entryPoints: [path.join(functionsDir, name, "index.ts")],
      outfile: path.join(outRoot, name, "index.mjs"),
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      sourcemap: true,
      sourcesContent: false,
      legalComments: "none",
      logLevel: "warning",
      // 번들에 CJS 의존성이 섞여도 require 가 동작하도록.
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
    }),
  ),
);

for (const name of functions) {
  const dir = path.join(outRoot, name);
  const files = ["index.mjs", "index.mjs.map"];
  await Promise.all(files.map((file) => utimes(path.join(dir, file), FIXED_TIME, FIXED_TIME)));
  await run("zip", ["-X", "-q", path.join(outRoot, `${name}.zip`), ...files], { cwd: dir });
}

console.log(`built ${functions.length} functions: ${functions.join(", ")}`);
