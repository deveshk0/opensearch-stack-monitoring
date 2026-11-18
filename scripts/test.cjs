const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const host = execFileSync("bash", [path.join(__dirname, "host-version.sh")], { encoding: "utf8" }).trim();
const dependencies = path.join(host, "node_modules");
const ts = require(path.join(dependencies, "typescript"));
for (const folder of ["common", "server"]) {
  const output = path.join(".cache/test-build", folder);
  fs.mkdirSync(output, { recursive: true });
  for (const name of fs.readdirSync(`stack_monitoring/${folder}`).filter(n => n.endsWith(".json"))) {
    fs.copyFileSync(`stack_monitoring/${folder}/${name}`, path.join(output, name));
  }
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
        esModuleInterop: true,
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
    NODE_PATH: dependencies,
  },
});
process.exitCode = result.status ?? 1;
