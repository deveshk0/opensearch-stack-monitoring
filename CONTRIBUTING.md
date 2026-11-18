# Contributing

Keep changes scoped to one behavior and include a regression test for nontrivial fixes. Build targets are OpenSearch Dashboards **3.7.0, 3.8.0, 3.9.0, and 3.10.0**. Exact official checkout and Node pins live in `scripts/host-version.sh`; the default is 3.9.0. Each target must pass its own build and integration checks before it is advertised as supported.

```sh
export OSD_VERSION=3.9.0
bash scripts/bootstrap.sh
source scripts/host-version.sh
export PATH="$NODE_BIN:$PATH"
npm test
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_monitoring*.py'
bash scripts/build-plugin.sh
node "$OSD_HOST/node_modules/typescript/bin/tsc" \
  --project "$OSD_HOST/plugins/stack_monitoring/tsconfig.json" --noEmit
```

Bootstrap checks the exact official commit and Node archive checksum. Unit tests use the host's installed dependencies. The isolated UI tests exercise React effects with controlled HTTP responses; they do not log in to a real cluster. The build uses the official plugin helpers and checks that the ZIP includes the repository LICENSE and NOTICE.

[CI](.github/workflows/ci.yml) runs those checks on Ubuntu 24.04. Its cache is tied to the exact host/toolchain pins and contains dependency downloads, not a prior plugin build. Each version also runs `scripts/check-compatibility.py` on a fresh secured Docker pair, including the real setup button and populated charts using pinned Playwright/Chrome, permission denial, collector scope, and restart persistence. The release job requires all matrix jobs to pass for the revision being published.

`check-compatibility.py` creates and cleans up only uniquely named disposable Docker resources. Set `PLAYWRIGHT_MODULE` to the installed Playwright module to include browser checks (CI requires this). Other live scripts in `scripts/check-*.py` and `scripts/check-*.cjs` have different effects. Some change self-monitoring or themes, restart Dashboards, create test indices, or remove test findings. Read the script first and run it only against an authorized disposable installation. Existing results in [verification](docs/verification.md) are historical evidence, not verification of a new commit.

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

The release job requires all four checked Linux archives, stamps their package metadata with the release version while preserving host compatibility and compiled code, and publishes `stack-monitoring-VERSION.zip` for each host plus a combined `SHA256SUMS`. The legacy `stack-monitoring.zip` asset is identical to the 3.9.0 archive. Source metadata remains the development baseline; the installed ZIP records the release version. No version-bump commit or personal access token is needed. Only the release job has repository write permission.

Releases target the exact checked commit. A rerun leaves an already published release unchanged and can finish an interrupted draft for the same commit. If a draft upload fails, rerun its failed job before releasing a later commit. If `main` still points to the failed commit, **Actions → Plugin checks → Run workflow → main** also retries publication; otherwise rerun the original failed job. Main runs are not interrupted by newer pushes; GitHub can replace pending runs during a burst, so changes can be grouped into the next successful release. An older run cannot publish after a newer tagged release.
