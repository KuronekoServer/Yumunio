# Yumunio documentation

Yumunio is a self-hostable workspace for notes, pages and databases. AI generation is outside the current scope. [日本語](README.md)

| Goal | Guide |
| --- | --- |
| Host with Docker | [Docker guide, Japanese](hosting/docker.md); the downloadable hosting archive also includes English instructions |
| Host on Cloudflare | [Workers guide, Japanese](hosting/cloudflare.md) |
| Contribute a translation | [Translate through GitHub](community-translations.en.md) |
| Learn the editor | [Editing basics, Japanese](editing-basics.md) |
| Connect an application | [API, MCP and Webhooks, Japanese](integrations.md), [OpenAPI](../openapi.yaml) |
| Check current limitations | [Feature coverage, Japanese](feature-coverage.md) |
| Contribute code or documentation | [Contributing, Japanese](../CONTRIBUTING.md) |

For Docker, extract the hosting archive, run `docker compose pull`, `docker compose up -d`, then `docker compose logs yumunio`. Open the Start setup link from the log. The application generates its internal credentials automatically. Set `YUMUNIO_PUBLIC_ORIGIN` to your HTTPS origin before the first start when hosting publicly. Preserve the installation directory and persistent volumes when updating.

For Cloudflare, use the Deploy to Cloudflare button in the [README](../README.md). Enable R2 in your Cloudflare account first. The template provisions D1 and private R2 storage and generates the installation credentials. Complete setup using the link in the deployment log. The deployment uses resources in your account; check the provider's current limits and prices.

The project is under development. A successful local test is separate from CI, publication of an image or archive, and verification of your running instance. Translation proposals are reviewed on GitHub; no external translation-service account is required.
