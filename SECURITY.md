# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected:

- Authentication bypass
- Secret leakage
- Server-side request forgery (SSRF)
- Telegram bot token exposure

Please use GitHub private vulnerability reporting if it is enabled for this repository. If it is not enabled, contact the repository maintainer through a private channel listed on the maintainer's GitHub profile. This placeholder should be replaced with a project-specific private contact before publication.

Include the affected version, impact, reproduction steps, and any suggested mitigation. Do not include real production credentials or notification contents.

Maintainers should acknowledge a report promptly, investigate it privately, and coordinate disclosure after a fix is available. No response timeline is guaranteed for this volunteer project.

## Supported versions

Until the project reaches a stable release, only the latest released version receives security fixes.

## Secrets

Never commit `.dev.vars`, Worker secrets, Telegram bot tokens, gateway secrets, or real private chat IDs. Rotate exposed credentials immediately.
