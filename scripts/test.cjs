const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ts = require("../.cache/OpenSearch-Dashboards/node_modules/typescript");
for (const folder of ["common", "server"]) {
  const output = path.join(".cache/test-build", folder);
  fs.mkdirSync(output, { recursive: true });
  for (const name of fs
    .readdirSync(`stack_monitoring/${folder}`)
    .filter((n) => n.endsWith(".ts"))) {
    const source = fs.readFileSync(
      `stack_monitoring/${folder}/${name}`,
      "utf8",
    );
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: name,
    });
    fs.writeFileSync(
      path.join(output, name.replace(/\.ts$/, ".js")),
      compiled.outputText,
    );
  }
}
const files = fs
  .readdirSync("stack_monitoring/test")
  .filter((n) => n.endsWith(".test.mjs"))
  .map((n) => `stack_monitoring/test/${n}`);
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_PATH: path.resolve(".cache/OpenSearch-Dashboards/node_modules"),
  },
});
process.exitCode = result.status ?? 1;
