# Community translations

[日本語](community-translations.md) · [Documentation](README.en.md)

You can suggest translations through a GitHub pull request, using only your browser. No external translation account or local development environment is needed. Japanese is the source language; untranslated text falls back to English. User pages and attachments are never part of the translation catalogs.

## Edit a sentence on GitHub

1. Choose a screen: [common text](../apps/web/public/locales/en.json), [initial setup](../apps/web/public/setup-locales/en.json), [page editor](../apps/web/public/workspace-locales/en.json), [databases](../apps/web/public/collections-locales/en.json), or [preferences](../apps/web/public/prefs-locales/en.json). The corresponding `ja.json` contains the source text. Other screens are listed under `namespaces` in the [locale manifest](../apps/web/public/locale-manifest.json).
2. Open your language's JSON in the same folder and select the pencil button. Follow [GitHub's file editing instructions](https://docs.github.com/en/repositories/working-with-files/managing-files/editing-files) to create a fork or branch if needed.
3. Translate the values on the right. Keep the keys and placeholders such as `{name}` and `{count}`. Save JSON as UTF-8.
4. Select **Commit changes / Propose changes**, then open a pull request. Describe the language, screen, and reason for your change. If you edited only in the browser, say so; local checks are not required to propose a translation.
5. The **Translation review** check validates JSON, placeholders, and fallback behavior. Its Summary lists translation progress. Correct any errors reported in the check.

## Add a language with one sentence

Use **Add file → Create new file** to create, for example, `apps/web/public/setup-locales/fr.json`:

```json
{
  "title": "Bienvenue dans Yumunio"
}
```

One file is enough for a first PR. CI and the build generate the locale entry and empty catalogs for the remaining screens. Missing translations use English. Japanese and English must remain complete; other languages can be partial.

Use canonical BCP 47 filenames. Keep `zh-Hans` and `zh-Hant`, and `pt-PT` and `pt-BR`, separate. Text direction for right-to-left languages is derived during locale registration. Reviewed translations ship with a software release; existing installations receive them when their administrator updates Yumunio.

## Optional local checks

With Node.js 24.16.0 or later:

```sh
npm ci
npm run l10n:sync
npm run l10n:check
npm run l10n:report -- --markdown
npm run build
```

If you prefer not to edit JSON, open a [translation issue](https://github.com/KuronekoServer/Yumunio/issues/new?template=translation.yml) with the language, screen, current wording, and suggested wording. Exclude personal information and private documents.

Crowdin synchronization remains disabled. The normal contribution flow uses GitHub pull requests.
