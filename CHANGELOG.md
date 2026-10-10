# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Native MonitorFlare webhook adapter for `monitor.down`, `monitor.warning`, and `monitor.up` events
- Optional `thread_id` query parameter on `POST /v1/notify` to choose a Telegram forum topic for that request
- `notification_failed` logs include Telegram's error code and description when a delivery is rejected; callers still receive only `telegram_error`

## [0.1.0] - 2026-09-17

### Added

- Stateless Cloudflare Worker with public health and authenticated notification endpoints
- Exact plain-text pass-through and allowlisted JSON presentation options
- Secret-controlled Telegram destination and optional forum topic support
- Request and message size limits, safe errors, structured logging, and request IDs
- Cloudflare-runtime test suite, strict type checking, linting, and GitHub Actions CI
- Deployment, security, contribution, and project documentation
