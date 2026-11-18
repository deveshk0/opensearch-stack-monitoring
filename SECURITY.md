# Security

Checked host versions and required Security configuration are listed in the [compatibility matrix](docs/installation.md#compatibility). Each plugin ZIP targets one exact Dashboards version. There is no security support SLA or claim that the local Docker example is ready for an Internet-facing deployment.

Report suspected vulnerabilities privately to the repository maintainer. Use the repository's **Security → Report a vulnerability** facility when available. If a private reporting channel is not configured, ask the maintainer to establish one before sharing exploit details. No dedicated security email address is currently published.

Include the plugin commit/version, host version, affected route or permission boundary, a minimal reproduction, and the expected versus actual access. Remove passwords, cookies, authorization headers, private logs, and customer data. Do not post working credentials or sensitive reproductions in public issues.

The local Compose stack uses bundled demo certificates, disables server certificate verification, and serves the browser over HTTP on loopback. Do not expose it. For another installation, use verified TLS, secure cookies, separate collector and human identities, and the scoped provisioner described in [installation](docs/installation.md). Monitoring history includes infrastructure names, addresses, metrics, and optionally logs; grant read access accordingly.

The plugin samples the cluster it depends on. It cannot replace independent outage monitoring. Run one collector per cluster, retain its unique Dashboards instance identity, and stop a former owner before manually releasing its collection lock.
