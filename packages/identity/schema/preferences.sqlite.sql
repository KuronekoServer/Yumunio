-- Personal display preferences only; no workspace content or credentials.
CREATE TABLE IF NOT EXISTS yumunio_account_preferences (
 account_id TEXT NOT NULL PRIMARY KEY,
 revision INTEGER NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
 preferences_json TEXT NOT NULL CHECK (length(CAST(preferences_json AS BLOB)) <= 4096)
);
