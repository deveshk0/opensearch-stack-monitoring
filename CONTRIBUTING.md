# Contributing

Keep changes scoped to one behavior and include a regression test for nontrivial fixes. The plugin targets OpenSearch Dashboards **3.9.0**, commit `def668b5c4ad825dfff980ed0951cca07aa0ac4b`, with Node **22.23.0**. Do not change the target version without rebuilding and checking the integration against that host.

```sh
bash scripts/bootstrap.sh
export PATH="$PWD/.cache/node-v22.23.0-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')/bin:$PATH"
npm test
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_monitoring*.py'
bash scripts/build-plugin.sh
node .cache/OpenSearch-Dashboards/node_modules/typescript/bin/tsc \
  --project .cache/OpenSearch-Dashboards/plugins/stack_monitoring/tsconfig.json --noEmit
```

Bootstrap checks the exact official commit and Node archive checksum. Unit tests use the host's installed dependencies. The isolated UI tests exercise React effects with controlled HTTP responses; they do not log in to a real cluster. The build uses the official plugin helpers and checks that the ZIP includes the repository LICENSE and NOTICE.

[CI](.github/workflows/ci.yml) runs those checks on Ubuntu 24.04. Its cache is tied to the exact host/toolchain pins and contains dependency downloads, not a prior plugin build. The release job requires those checks to pass for the revision being published.

Live scripts in `scripts/check-*.py` and `scripts/check-*.cjs` have different effects. Some change self-monitoring or themes, restart Dashboards, create test indices, or remove test findings. Read the script first and run it only against an authorized disposable installation. Existing results in [verification](docs/verification.md) are historical evidence, not verification of a new commit.

Do not commit `.opensearch.env`, credentials, cookies, generated archives, host dependencies, or customer data. Explain changes to storage mappings, retention, permissions, and operator recovery in the installation documentation. Use private reporting for vulnerabilities; see [SECURITY.md](SECURITY.md).

Original plugin code is Apache-2.0. By submitting a contribution, you agree to license it under that license. Host dependencies retain their own licenses; see [NOTICE](NOTICE).

## Commit messages

Use Conventional Commits for commits and pull request titles: `type: summary` or `type(scope): summary`.

- `feat`: new functionality.
- `fix`: a bug fix.
- `docs`: documentation only.
- `test`: tests only.
- `ci`: CI workflow changes.
- `build`: build tooling or dependencies.
- `refactor`: restructuring without a behavior change.
- `perf`: performance improvements.
- `chore`: other maintenance.

Examples:

```text
feat: add OpenSearch stack monitoring plugin
fix(collector): recover after a settings read failure
docs: explain monitoring index retention
ci: verify the plugin on Linux
```

Use an imperative summary. Mark breaking changes with `!` after the type/scope and explain the migration in a `BREAKING CHANGE:` footer.


## Releases

Pushes and merges to `main` publish a release after the Linux checks succeed. Pull requests and other branches only run checks. The first release is `v1.0.0`; subsequent versions use all commit messages since the previous release:

- A `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer or `type!:` / `type(scope)!:` header increments the major version.
- A `feat:` / `feat(scope):` header increments the minor version.
- Other changes, including documentation and CI, increment the patch version.

The largest change wins. For squash merges, put the semantic summary in the PR title and preserve breaking-change footers in the final commit message.

The release job downloads the checked Linux artifact, stamps its two package metadata files with the release version, preserves host compatibility and compiled code, and publishes `stack-monitoring.zip` plus `SHA256SUMS`. Source metadata remains the development baseline; the installed ZIP records the release version. No version-bump commit or personal access token is needed. Only the release job has repository write permission.

Releases target the exact checked commit. A rerun leaves an already published release unchanged and can finish an interrupted draft for the same commit. If a draft upload fails, rerun its failed job before releasing a later commit. If `main` still points to the failed commit, **Actions → Plugin checks → Run workflow → main** also retries publication; otherwise rerun the original failed job. Main runs are not interrupted by newer pushes; GitHub can replace pending runs during a burst, so changes can be grouped into the next successful release. An older run cannot publish after a newer tagged release.
