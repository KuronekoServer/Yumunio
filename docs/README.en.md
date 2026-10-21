# Yumunio documentation

Yumunio is a self-hostable workspace for notes, pages and databases. AI generation is outside the current scope. [日本語](README.md)

| Goal | Guide |
| --- | --- |
| Host with Docker | [Docker guide, Japanese](hosting/docker.md); the downloadable hosting archive also includes English instructions |
| Host on Cloudflare | [Workers guide, Japanese](hosting/cloudflare.md) |
| Contribute a translation | [Translate through GitHub](community-translations.en.md) |
| Learn the editor | [Editing basics, Japanese](editing-basics.md) |
| Understand automatic updates and page loading | [Live synchronization and performance, Japanese](live-synchronization.md) |
| Arrange blocks and resize columns | [Block sizes and layouts, Japanese](block-layout.md) |
| Organize nested pages and teamspaces | [Page hierarchy and ordering, Japanese](page-tree.md) |
| Embed a database and edit a row beside the list | [Inline databases and record details, Japanese](inline-databases.md) |
| Apply a record template | [Database templates and automatic properties, Japanese](database-templates.md) |
| Reuse shared content across pages | [Synced blocks, Japanese](synced-blocks.md) |
| Contribute UI transitions | [Motion and accessibility policy, Japanese](ui-motion.md) |
| Connect an application | [API, MCP and Webhooks, Japanese](integrations.md), [OpenAPI](../openapi.yaml) |
| Check current limitations | [Feature coverage, Japanese](feature-coverage.md) |
| Contribute code or documentation | [Contributing, Japanese](../CONTRIBUTING.md) |

Public amd64 and arm64 images are available at [Docker Hub](https://hub.docker.com/r/kuronekoserver/yumunio). To try Yumunio locally, run:

```sh
docker pull kuronekoserver/yumunio:latest
docker run -d --name yumunio --restart unless-stopped -p 127.0.0.1:8788:8788 -v yumunio-data:/app/.data kuronekoserver/yumunio:latest
docker logs yumunio
```

Open the Start setup link from the log. The application generates its internal credentials automatically. Keep the `yumunio-data` volume when updating. Docker Run and Compose use different default volume names, so keep the same launch method and storage after setup. For Compose, follow the [Docker guide](hosting/docker.md) using the repository's Compose files or the hosting archive when available. Set `YUMUNIO_PUBLIC_ORIGIN` to your HTTPS origin before the first start when hosting publicly. Preserve the installation directory and persistent volumes when updating.

For Cloudflare, use the Deploy to Cloudflare button in the [README](../README.md). Enable R2 in your Cloudflare account first. The template provisions D1 and private R2 storage and generates the installation credentials. Complete setup using the link in the deployment log. The deployment uses resources in your account; check the provider's current limits and prices.

The project is under development. A successful local test is separate from CI, publication of an image or archive, and verification of your running instance. Translation proposals are reviewed on GitHub; no external translation-service account is required.
