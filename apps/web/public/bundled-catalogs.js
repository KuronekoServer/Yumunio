import manifest from './locale-manifest.json' with {type:'json'};
import workspaceJa from './workspace-locales/ja.json' with {type:'json'};
import workspaceEn from './workspace-locales/en.json' with {type:'json'};
import collectionsJa from './collections-locales/ja.json' with {type:'json'};
import collectionsEn from './collections-locales/en.json' with {type:'json'};

// Content-hashed browser chunks carry the same GitHub-managed dictionaries.
// Community languages still load through the normal manifest and fallback rules.
export const bundledLocaleManifest=manifest;
export const workspaceCatalogs={ja:workspaceJa,en:workspaceEn};
export const collectionsCatalogs={ja:collectionsJa,en:collectionsEn};
